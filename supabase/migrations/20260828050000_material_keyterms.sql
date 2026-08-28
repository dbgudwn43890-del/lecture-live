-- 자료에서 뽑은 전문용어. 색인할 때 이미 PDF 전체를 읽으므로 추가 호출은 없다.
-- 강의 소켓이 이 목록을 Deepgram keyterm으로 실어 보낸다 (PRD 36.3.1).
alter table public.material_documents
  add column if not exists keyterms text not null default '' check (length(keyterms) <= 2000);
