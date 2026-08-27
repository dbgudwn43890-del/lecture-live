-- L4 강의 자료 연동 (PRD 36.3.2). 원본 파일은 저장하지 않는다.
-- 색인 시점에 페이지 텍스트로 변환한 결과와 벡터만 남기고 업로드본은 폐기한다.
create table if not exists public.material_documents (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null check (length(filename) between 1 and 200),
  page_count integer not null default 0 check (page_count between 0 and 500),
  created_at timestamptz not null default now()
);

create table if not exists public.material_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.material_documents(id) on delete cascade,
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  start_page integer not null check (start_page between 1 and 500),
  end_page integer not null check (end_page between 1 and 500),
  text text not null check (length(text) between 1 and 6000),
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

create index if not exists material_documents_classroom_idx on public.material_documents (classroom_id, created_at desc);
create index if not exists material_chunks_classroom_idx on public.material_chunks (classroom_id);

alter table public.material_documents enable row level security;
alter table public.material_chunks enable row level security;

drop policy if exists material_documents_owner on public.material_documents;
create policy material_documents_owner on public.material_documents for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists material_chunks_owner_read on public.material_chunks;
create policy material_chunks_owner_read on public.material_chunks for select to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, delete on public.material_documents to authenticated;
grant select on public.material_chunks to authenticated;

-- match_lecture_chunks와 같은 계약. 다른 점은 세션이 아니라 문서를 가리킨다는 것뿐이다.
create or replace function public.match_material_chunks(
  p_user_id uuid,
  p_classroom_id uuid,
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
    and c.classroom_id = p_classroom_id
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 6);
$$;

revoke all on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) to service_role;

-- 답변이 어떤 자료의 몇 쪽을 참고했는지 그대로 남긴다.
alter table public.lecture_questions
  add column if not exists material_sources jsonb not null default '[]'::jsonb;
