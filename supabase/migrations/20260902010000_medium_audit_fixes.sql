-- Batch of MEDIUM audit findings: consent timestamps, uploads write access,
-- move_lecture_session's missing tables, and the billing hot-path index.

-- 1. consents.accepted_at was whatever the INSERT said it was — the table
-- exists to prove *when* an agreement happened, so the clock belongs to the
-- server, not the client.
create or replace function public.force_consent_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.accepted_at := now();
  return new;
end;
$$;

drop trigger if exists consents_force_accepted_at on public.consents;
create trigger consents_force_accepted_at
  before insert on public.consents
  for each row execute function public.force_consent_timestamp();

-- 2. uploads rows could be UPDATEd by their owner (default privileges + a
-- `for all` policy), letting delete_at be pushed past the 24-hour original-
-- audio deletion promise and provider_request_id be tampered with. Learners
-- only ever read this table; every write happens in /api/lecture-audio, which
-- now runs them on the service key.
drop policy if exists uploads_owner on public.uploads;
drop policy if exists uploads_owner_read on public.uploads;
create policy uploads_owner_read on public.uploads
  for select to authenticated
  using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.uploads from authenticated;

-- 3. lecture_summaries and lecture_reports were added after
-- move_lecture_session was written, so moving a lecture left them pointing at
-- the old classroom.
create or replace function public.move_lecture_session(
  p_session_id uuid,
  p_classroom_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_previous_classroom_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_classroom_id is not null and not exists (
    select 1 from public.classrooms c
    where c.id = p_classroom_id and c.user_id = v_user_id
  ) then
    raise exception 'CLASSROOM_NOT_FOUND';
  end if;

  select s.classroom_id into v_previous_classroom_id
  from public.lecture_sessions s
  where s.id = p_session_id and s.user_id = v_user_id
  for update;
  if not found then return false; end if;

  update public.lecture_sessions set classroom_id = p_classroom_id
  where id = p_session_id and user_id = v_user_id;
  update public.transcript_segments set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_chunks set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_questions set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_summaries set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_reports set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.classrooms set updated_at = now()
  where user_id = v_user_id and id in (v_previous_classroom_id, p_classroom_id);
  return true;
end;
$$;

-- 4. The trial-guard subquery in every consume_* call and the reconcile
-- trigger's group-by both scan lecture_credit_usage by grant_id, which had no
-- index — a seq scan inside a FOR UPDATE on the billing hot path.
create index if not exists lecture_credit_usage_grant_idx
  on public.lecture_credit_usage (grant_id);
