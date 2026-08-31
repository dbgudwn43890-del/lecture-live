-- 자료는 강의실이 아니라 그 수업의 것이다.
-- 한 학기치 PDF 20개에서 뽑은 용어를 전부 keyterm으로 밀어 넣으면 400자 예산이
-- 지난주 어휘로 차 버려서, 정작 오늘 강의에 나오는 말이 잘린다. session_id가
-- 붙은 자료가 있으면 그것만 오늘의 어휘집이다.
--
-- null은 "아직 어느 수업에도 붙지 않은 자료"다. 수업을 시작하는 순간
-- lecture_sessions의 start 액션이 그것들을 새 세션으로 가져간다(수업 직전에
-- 올린 자료가 곧 그 수업 자료라는 뜻). 세션이 지워져도 자료는 강의실에 남아야
-- 하므로 cascade가 아니라 set null이다.
alter table public.material_documents
  add column if not exists session_id uuid references public.lecture_sessions(id) on delete set null;

create index if not exists material_documents_session_idx
  on public.material_documents (session_id)
  where session_id is not null;
