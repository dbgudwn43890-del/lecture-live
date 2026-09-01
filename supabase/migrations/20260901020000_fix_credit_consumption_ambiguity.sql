-- The pause migration dropped the table alias from this update. Because the
-- function also returns a column named remaining_credits, PostgreSQL could not
-- decide whether the unqualified name meant the output variable or table
-- column (42702), blocking every new recording before its first audio token.
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
      and (
        g.plan_code <> 'trial'
        or not exists (
          select 1
          from public.lecture_credit_usage prior_usage
          where prior_usage.grant_id = g.id
            and prior_usage.session_id <> p_session_id
        )
      )
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
      update public.credit_grants as g
      set remaining_credits = g.remaining_credits - 1, updated_at = now()
      where g.id = v_grant_id;
    end if;
  end loop;

  select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
  from public.credit_grants g
  where g.user_id = v_user_id and g.starts_at <= now()
    and g.expires_at > now() and g.revoked_at is null;
  return query select v_remaining, true, p_minute_index;
end;
$$;
