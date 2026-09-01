-- Detection, not prevention. The browser holds the STT socket directly, so a
-- hostile user can open the socket, stream audio, and never save a transcript
-- segment — escaping the per-segment meter. That abuse leaves a fingerprint in
-- tables we already have: a user who opens sockets but never saves a segment.
-- A real lecture saves a segment every few seconds — dozens per minute; an
-- abuser saves ~0. This aggregates both counts per user over a window so the
-- operator console can flag the ratio. Aggregating in Postgres (not by reading
-- rows into the app) is essential here: transcript_segments is the highest-
-- volume table and PostgREST silently caps a plain select at 1,000 rows, which
-- would undercount saves and make every heavy user look like an abuser.
create or replace function public.admin_abuse_signals(p_since timestamptz)
returns table (user_id uuid, sockets_opened integer, segments_saved integer)
language sql
stable
security definer
set search_path = ''
as $$
  with opens as (
    -- Each started recording opened at least one socket and drew a hold.
    -- Drafts never opened a socket, so they are excluded.
    select s.user_id, count(*)::integer as sockets_opened
    from public.lecture_sessions s
    where s.started_at >= p_since
      and s.status in ('recording', 'paused', 'completed')
    group by s.user_id
  ),
  saves as (
    select t.user_id, count(*)::integer as segments_saved
    from public.transcript_segments t
    where t.created_at >= p_since
    group by t.user_id
  )
  select
    coalesce(o.user_id, v.user_id) as user_id,
    coalesce(o.sockets_opened, 0) as sockets_opened,
    coalesce(v.segments_saved, 0) as segments_saved
  from opens o
  full join saves v on v.user_id = o.user_id;
$$;

-- Only the operator console (service role) reads this; it exposes every user's
-- activity, so it must never be callable by an ordinary signed-in user.
revoke all on function public.admin_abuse_signals(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_abuse_signals(timestamptz) to service_role;
