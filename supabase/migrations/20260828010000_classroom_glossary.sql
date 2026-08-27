-- L2 전공별 특화 용어집 (PRD 36.3.1). 강의실 속성이며, 인식 요청마다 함께 보낸다.
-- 배열이 아니라 원문 텍스트로 둔다: 학습자가 입력한 그대로 되돌려 보여줘야 하고,
-- 용어 분리 규칙은 app/lib/glossary.ts 한 곳에서만 정의한다.
alter table public.classrooms
  add column if not exists glossary text not null default ''
  check (length(glossary) <= 1200);
