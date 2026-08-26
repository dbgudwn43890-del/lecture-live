-- The classroom list built its per-lecture question counts by selecting every
-- question row the user had ever asked and tallying them in JS — on every
-- classroom page render and every /api/classrooms call. Count in Postgres.
create or replace view public.lecture_question_counts
with (security_invoker = true) as
  select session_id, count(*)::integer as question_count
  from public.lecture_questions
  group by session_id;

revoke all on public.lecture_question_counts from public, anon;
grant select on public.lecture_question_counts to authenticated;
