-- L5 지연 실측 (PRD 36.3.4). 재설계는 이 수치를 본 뒤에 착수한다.
-- context_ms: 답변 준비 구간(스크립트 읽기·이전 수업·자료 검색)에 걸린 시간
-- first_token_ms: 요청 시작부터 첫 토큰이 나가기까지의 시간
alter table public.lecture_questions
  add column if not exists context_ms integer check (context_ms is null or context_ms between 0 and 600000),
  add column if not exists first_token_ms integer check (first_token_ms is null or first_token_ms between 0 and 600000);

-- 받아쓰기 한 구간의 왕복 시간. 클라이언트가 측정해 저장할 때 함께 보낸다.
alter table public.transcript_segments
  add column if not exists latency_ms integer check (latency_ms is null or latency_ms between 0 and 600000);

-- 파일럿 지표에 지연 중앙값을 더한다. 평균이 아니라 중앙값인 이유는
-- 한 번의 재연결 실패가 평균을 통째로 끌어올리기 때문이다.
create or replace view public.pilot_session_metrics
with (security_invoker = on) as
  select
    s.id as session_id,
    s.user_id,
    s.classroom_id,
    s.title,
    s.started_at,
    s.duration_seconds,
    (select count(*) from public.lecture_questions q where q.session_id = s.id) as question_count,
    (select count(*) from public.lecture_reports r where r.session_id = s.id and r.kind = 'stt_error') as stt_error_reports,
    (select count(*) from public.lecture_reports r where r.session_id = s.id and r.kind = 'context_miss') as context_miss_reports,
    (select percentile_cont(0.5) within group (order by t.latency_ms)
       from public.transcript_segments t where t.session_id = s.id and t.latency_ms is not null) as stt_latency_p50_ms,
    (select percentile_cont(0.5) within group (order by q.first_token_ms)
       from public.lecture_questions q where q.session_id = s.id and q.first_token_ms is not null) as first_token_p50_ms,
    (select percentile_cont(0.5) within group (order by q.context_ms)
       from public.lecture_questions q where q.session_id = s.id and q.context_ms is not null) as context_p50_ms
  from public.lecture_sessions s;

grant select on public.pilot_session_metrics to authenticated;
