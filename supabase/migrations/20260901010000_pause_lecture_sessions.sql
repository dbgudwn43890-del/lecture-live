-- A lecture used started_at as both its creation time and billing clock. That
-- made refreshes and breaks count as recorded audio. Keep the wall-clock start
-- for history, but meter only the accumulated active recording periods.
alter table public.lecture_sessions
  add column if not exists recorded_ms integer not null default 0
    check (recorded_ms between 0 and 10800000),
  add column if not exists recording_started_at timestamptz;

update public.lecture_sessions
set recorded_ms = least(10800000, greatest(0, duration_seconds * 1000)),
    -- Existing open browser sessions cannot tell us which wall-clock periods
    -- contained audio. Start their active clock at migration time rather than
    -- turning an overnight stale tab into a three-hour recording.
    recording_started_at = case when status = 'recording' then now() else null end;

alter table public.lecture_sessions
  drop constraint if exists lecture_sessions_status_check;
alter table public.lecture_sessions
  add constraint lecture_sessions_status_check
  check (status in ('draft', 'recording', 'paused', 'completed'));

create or replace function public.pause_lecture_session(p_session_id uuid)
returns table (status text, recorded_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recorded_ms integer;
begin
  update public.lecture_sessions s
  set recorded_ms = least(10800000, s.recorded_ms + greatest(0,
        floor(extract(epoch from (now() - coalesce(s.recording_started_at, s.started_at))) * 1000)::integer
      )),
      duration_seconds = least(10800, ceil((s.recorded_ms + greatest(0,
        floor(extract(epoch from (now() - coalesce(s.recording_started_at, s.started_at))) * 1000)::integer
      )) / 1000.0)::integer),
      recording_started_at = null,
      status = 'paused'
  where s.id = p_session_id
    and s.user_id = auth.uid()
    and s.status = 'recording'
  returning s.recorded_ms into v_recorded_ms;

  if v_recorded_ms is null then
    select s.recorded_ms into v_recorded_ms
    from public.lecture_sessions s
    where s.id = p_session_id and s.user_id = auth.uid() and s.status = 'paused';
  end if;
  if v_recorded_ms is null then raise exception 'LECTURE_NOT_RECORDING'; end if;
  return query select 'paused'::text, v_recorded_ms;
end;
$$;

create or replace function public.resume_lecture_session(p_session_id uuid)
returns table (status text, recorded_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recorded_ms integer;
begin
  update public.lecture_sessions s
  set status = 'recording', recording_started_at = now(), ended_at = null
  where s.id = p_session_id
    and s.user_id = auth.uid()
    and s.status = 'paused'
    and s.recorded_ms < 10800000
  returning s.recorded_ms into v_recorded_ms;
  if v_recorded_ms is null then raise exception 'LECTURE_NOT_PAUSED'; end if;
  return query select 'recording'::text, v_recorded_ms;
end;
$$;

revoke all on function public.pause_lecture_session(uuid) from public, anon, authenticated;
revoke all on function public.resume_lecture_session(uuid) from public, anon, authenticated;
grant execute on function public.pause_lecture_session(uuid) to authenticated;
grant execute on function public.resume_lecture_session(uuid) to authenticated;

create or replace function public.consume_lecture_credits_elapsed(p_session_id uuid)
returns table (remaining_credits integer, allowed boolean, charged_through integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elapsed_ms integer;
  v_minute_index integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;

  select least(10800000, s.recorded_ms + case
    when s.status = 'recording' then greatest(0,
      floor(extract(epoch from (now() - coalesce(s.recording_started_at, s.started_at))) * 1000)::integer)
    else 0 end)
  into v_elapsed_ms
  from public.lecture_sessions s
  where s.id = p_session_id
    and s.user_id = auth.uid()
    and s.status in ('recording', 'paused');

  if v_elapsed_ms is null then raise exception 'LECTURE_NOT_RECORDING'; end if;
  v_minute_index := least(179, greatest(0, floor(v_elapsed_ms / 60000.0)::integer));

  return query
  select c.remaining_credits, c.allowed, c.charged_through
  from public.consume_lecture_credits(p_session_id, v_minute_index) as c;
end;
$$;

-- Late final segments may arrive just after the pause RPC. They still belong
-- to the active period that was just metered, so allow the idempotent credit
-- function to accept a paused session too.
create or replace function public.consume_lecture_credits(
  p_session_id uuid,
  p_minute_index integer
)
returns table (remaining_credits integer, allowed boolean, charged_through integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_index integer;
  v_grant_id uuid;
  v_usage_id uuid;
  v_remaining integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_minute_index < 0 or p_minute_index > 179 then raise exception 'INVALID_MINUTE'; end if;
  if not exists (
    select 1 from public.lecture_sessions s
    where s.id = p_session_id and s.user_id = v_user_id
      and s.status in ('recording', 'paused')
  ) then raise exception 'LECTURE_NOT_RECORDING'; end if;

  for v_index in 0..p_minute_index loop
    if exists (
      select 1 from public.lecture_credit_usage u
      where u.session_id = p_session_id and u.minute_index = v_index
    ) then continue; end if;

    v_grant_id := null;
    select g.id into v_grant_id
    from public.credit_grants g
    where g.user_id = v_user_id
      and g.remaining_credits > 0
      and g.starts_at <= now()
      and g.expires_at > now()
      and g.revoked_at is null
    order by case when g.plan_code = 'trial' then 0 else 1 end, g.expires_at, g.created_at
    limit 1 for update;

    if v_grant_id is null then
      select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
      from public.credit_grants g
      where g.user_id = v_user_id and g.starts_at <= now()
        and g.expires_at > now() and g.revoked_at is null;
      return query select v_remaining, false, v_index - 1;
      return;
    end if;

    v_usage_id := null;
    insert into public.lecture_credit_usage (user_id, session_id, grant_id, minute_index)
    values (v_user_id, p_session_id, v_grant_id, v_index)
    on conflict (session_id, minute_index) do nothing
    returning id into v_usage_id;
    if v_usage_id is not null then
      update public.credit_grants
      set remaining_credits = remaining_credits - 1, updated_at = now()
      where id = v_grant_id;
    end if;
  end loop;

  select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
  from public.credit_grants g
  where g.user_id = v_user_id and g.starts_at <= now()
    and g.expires_at > now() and g.revoked_at is null;
  return query select v_remaining, true, p_minute_index;
end;
$$;

create or replace function public.can_ask_with_credits(p_session_id uuid, p_minute_index integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1 from public.credit_grants g
      where g.user_id = (select auth.uid()) and g.remaining_credits > 0
        and g.starts_at <= now() and g.expires_at > now() and g.revoked_at is null
    )
    or exists (
      select 1
      from public.lecture_sessions s
      join public.lecture_credit_usage u on u.session_id = s.id
      where s.id = p_session_id and s.user_id = (select auth.uid())
        and s.status in ('recording', 'paused')
        and s.recorded_ms + case when s.status = 'recording' then greatest(0,
          floor(extract(epoch from (now() - coalesce(s.recording_started_at, s.started_at))) * 1000)::integer
        ) else 0 end < 10800000
        and u.minute_index = p_minute_index
    )
  );
$$;

create or replace function public.reconcile_finished_lecture_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return record;
begin
  if old.status not in ('recording', 'paused') or new.status <> 'completed' then return new; end if;
  if new.recorded_ms = 0 and not exists (
    select 1 from public.lecture_credit_usage u
    where u.session_id = new.id and u.minute_index > 0
  ) then
    for v_return in
      select u.grant_id, count(*)::integer as credit_count
      from public.lecture_credit_usage u where u.session_id = new.id group by u.grant_id
    loop
      update public.credit_grants g
      set remaining_credits = least(g.granted_credits, g.remaining_credits + v_return.credit_count), updated_at = now()
      where g.id = v_return.grant_id;
    end loop;
    delete from public.lecture_credit_usage where session_id = new.id;
  end if;
  return new;
end;
$$;
