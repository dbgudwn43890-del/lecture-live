-- The billing clock (recorded_ms, recording_started_at, started_at, status,
-- duration_seconds, ended_at) was writable by any authenticated PostgREST
-- request: RLS only checks row ownership, and the broad table grant put no
-- limit on columns. Resetting recorded_ms/recording_started_at every minute
-- pinned consume_lecture_credits_elapsed at minute 0 — unlimited streaming on
-- one credit — and flipping status to 'completed' by hand could fire the
-- reconcile refund trigger at will.
--
-- Column-level grants narrow direct writes to what a learner actually edits
-- (a title; classroom moves go through move_lecture_session, which is
-- security definer). Every billing-column write already runs as security
-- definer (pause/resume/consume RPCs), on the service key (upload callback),
-- or has been moved to the admin client in /api/lecture-sessions.
revoke insert, update on public.lecture_sessions from authenticated;
grant update (title) on public.lecture_sessions to authenticated;
-- id stays server-generated so a charged session cannot be deleted and
-- re-inserted with a fresh clock under the same primary key.
grant insert (classroom_id, user_id, title, status, recording_started_at)
  on public.lecture_sessions to authenticated;
