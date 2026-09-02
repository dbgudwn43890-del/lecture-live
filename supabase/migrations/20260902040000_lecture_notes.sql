-- 강의 종료 후 학습자가 요청하면 만드는 복습 노트. 세션당 하나.
create table if not exists public.lecture_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  content jsonb,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lecture_notes_user_idx on public.lecture_notes (user_id, created_at desc);

alter table public.lecture_notes enable row level security;

drop policy if exists lecture_notes_owner on public.lecture_notes;
create policy lecture_notes_owner on public.lecture_notes for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.lecture_notes to authenticated;
