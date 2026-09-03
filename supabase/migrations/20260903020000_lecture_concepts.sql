-- 개념 카드 (2026-09-03): 노트 생성이 뽑아낸 과목별 핵심 용어.
-- 질문 컨텍스트에 정의를 수백 토큰으로 주입해 원문 의존과 환각을 줄인다.
create table if not exists public.lecture_concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  classroom_id uuid references public.classrooms(id) on delete cascade,
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  name text not null check (char_length(name) <= 120),
  definition text not null check (char_length(definition) <= 1000),
  evidence_ms integer,
  related text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (session_id, name)
);

create index if not exists lecture_concepts_classroom_idx
  on public.lecture_concepts (classroom_id, created_at desc);

alter table public.lecture_concepts enable row level security;

-- 소유자만. 쓰기는 노트 생성 라우트(세션 소유권을 exists로 재확인)만 지나간다.
create policy lecture_concepts_owner on public.lecture_concepts for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.lecture_sessions s
    where s.id = session_id and s.user_id = (select auth.uid())
  )
);

grant select, insert, delete on public.lecture_concepts to authenticated;
