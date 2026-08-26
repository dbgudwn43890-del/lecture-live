-- can_ask_with_credits let a paid-for minute stand in for a balance, so that
-- any session still marked 'recording' allowed questions at zero credits. A
-- session only leaves 'recording' when a client says so, so an abandoned tab
-- left that door open permanently: record one minute, close the tab, then ask
-- forever. Bound the recording branch to a lecture that could still be live.
create or replace function public.can_ask_with_credits(
  p_session_id uuid,
  p_minute_index integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1
      from public.credit_grants g
      where g.user_id = (select auth.uid())
        and g.remaining_credits > 0
        and g.starts_at <= now()
        and g.expires_at > now()
        and g.revoked_at is null
    )
    or exists (
      select 1
      from public.lecture_sessions s
      join public.lecture_credit_usage u on u.session_id = s.id
      where s.id = p_session_id
        and s.user_id = (select auth.uid())
        and s.status = 'recording'
        and s.started_at > now() - interval '3 hours'
        and u.minute_index = p_minute_index
    )
  );
$$;

revoke all on function public.can_ask_with_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.can_ask_with_credits(uuid, integer) to authenticated;
