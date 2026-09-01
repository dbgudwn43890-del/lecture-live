-- LOW audit batch: missing indexes, one policy tightening, one belt-and-
-- suspenders revoke.

-- Admin abuse signals scan transcript_segments by created_at; the only index
-- was (session_id, start_ms).
create index if not exists transcript_segments_created_idx
  on public.transcript_segments (created_at);

-- classroom_id FKs with on delete set null walk these tables on every
-- classroom delete.
create index if not exists transcript_segments_classroom_idx
  on public.transcript_segments (classroom_id);
create index if not exists lecture_questions_classroom_idx
  on public.lecture_questions (classroom_id);

-- match_* RPCs order by cosine distance with no vector index — a full
-- distance scan per question. hnsw needs no row-count tuning up front.
create index if not exists lecture_chunks_embedding_idx
  on public.lecture_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists material_chunks_embedding_idx
  on public.material_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- The summaries owner policy only checked user_id, so knowing another
-- account's session UUID let you squat its (session_id, window) slots and
-- block their summary generation with unique-index collisions.
drop policy if exists lecture_summaries_owner on public.lecture_summaries;
create policy lecture_summaries_owner on public.lecture_summaries for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.lecture_sessions s
    where s.id = session_id and s.user_id = (select auth.uid())
  )
);

-- security_invoker + RLS already return zero rows to anon, but a view over
-- billing data deserves more than one fence.
revoke all on public.pilot_session_metrics from anon;
