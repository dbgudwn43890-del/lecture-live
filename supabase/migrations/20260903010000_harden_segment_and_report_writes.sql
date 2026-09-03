-- 보안 감사 후속 (2026-09-03).

-- 1) 스크립트 세그먼트 쓰기 잠금.
-- 분당 크레딧 미터는 /api/lecture-sessions의 segment 액션에서만 돈다.
-- authenticated에게 열려 있던 직접 PostgREST 쓰기는 그 미터를 우회해
-- 과금 없는 스크립트 저장을 허용했다. 이제 쓰기는 서비스 키 경유만.
-- 읽기는 소유자 RLS 그대로.
revoke insert, update, delete on public.transcript_segments from authenticated;

-- 2) 신고는 자기 세션에만.
-- 기존 정책은 user_id만 확인해, 남의 세션 UUID를 아는 계정이 그 세션에
-- 신고를 쌓아 파일럿 지표를 오염시킬 수 있었다. lecture_summaries가
-- 20260902030000에서 받은 것과 같은 소유권 exists 검사를 붙인다.
drop policy if exists lecture_reports_owner on public.lecture_reports;
create policy lecture_reports_owner on public.lecture_reports for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.lecture_sessions s
    where s.id = session_id and s.user_id = (select auth.uid())
  )
);
