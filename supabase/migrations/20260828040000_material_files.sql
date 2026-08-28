-- L4 강의 자료 원본 보관 (PRD 36.3.2 개정).
-- 20260828020000_lecture_materials.sql은 원본을 버리고 텍스트만 남겼다. 그러면
-- 답변이 근거로 삼은 슬라이드를 학습자에게 보여 줄 수 없어 "AI가 무엇을 보고
-- 답했는지"가 확인 불가능하다. 원본 PDF를 비공개 버킷에 두고 서명 URL로만 연다.

alter table public.material_documents add column if not exists storage_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('materials', 'materials', false, 20000000, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 20000000,
      allowed_mime_types = array['application/pdf'];

-- 객체 이름의 첫 폴더가 소유자 uuid다. 남의 폴더는 읽기도 쓰기도 막힌다.
drop policy if exists materials_owner on storage.objects;
create policy materials_owner on storage.objects for all to authenticated
using (bucket_id = 'materials' and (select auth.uid())::text = (storage.foldername(name))[1])
with check (bucket_id = 'materials' and (select auth.uid())::text = (storage.foldername(name))[1]);
