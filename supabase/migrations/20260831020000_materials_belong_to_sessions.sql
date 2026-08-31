-- 강의 자료는 강의실이 아니라 사용자가 열어 둔 수업에 붙는다.
alter table public.lecture_sessions drop constraint if exists lecture_sessions_status_check;
alter table public.lecture_sessions add constraint lecture_sessions_status_check
  check (status in ('draft', 'recording', 'completed'));

alter table public.material_documents alter column classroom_id drop not null;
alter table public.material_chunks alter column classroom_id drop not null;

alter table public.material_documents drop constraint if exists material_documents_classroom_id_fkey;
alter table public.material_documents add constraint material_documents_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;
alter table public.material_chunks drop constraint if exists material_chunks_classroom_id_fkey;
alter table public.material_chunks add constraint material_chunks_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;
alter table public.material_documents drop constraint if exists material_documents_session_id_fkey;
alter table public.material_documents add constraint material_documents_session_id_fkey
  foreign key (session_id) references public.lecture_sessions(id) on delete cascade;

-- 같은 자료 검색 함수 계약을 유지하되 두 번째 UUID를 수업 ID로 바꾼다.
-- material_chunks에 session_id를 중복 저장하지 않고 문서에서 읽는다.
drop function if exists public.match_material_chunks(uuid, uuid, extensions.vector, integer);
create or replace function public.match_material_chunks(
  p_user_id uuid,
  p_session_id uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 4
) returns table (
  chunk_id uuid,
  document_id uuid,
  filename text,
  start_page integer,
  end_page integer,
  text text,
  similarity double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    d.filename,
    c.start_page,
    c.end_page,
    c.text,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from public.material_chunks c
  join public.material_documents d on d.id = c.document_id
  where c.user_id = p_user_id
    and d.session_id = p_session_id
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 6);
$$;

revoke all on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) to service_role;
