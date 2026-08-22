create extension if not exists vector with schema extensions;

create table if not exists public.classrooms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  locale text not null default 'ko' check (locale in ('ko', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lecture_sessions (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  status text not null default 'recording' check (status in ('recording', 'completed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds between 0 and 10800),
  created_at timestamptz not null default now()
);

create table if not exists public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 2200),
  start_ms integer not null check (start_ms between 0 and 10800000),
  end_ms integer not null check (end_ms between 0 and 10800000),
  text text not null check (length(text) between 1 and 2000),
  created_at timestamptz not null default now(),
  unique (session_id, client_id)
);

create table if not exists public.lecture_chunks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  start_ms integer not null,
  end_ms integer not null,
  text text not null check (length(text) between 1 and 6000),
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lecture_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid not null references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_at_ms integer not null check (question_at_ms between 0 and 10800000),
  question text not null check (length(question) between 1 and 1000),
  answer text not null,
  provider text not null,
  model text not null,
  external_sources jsonb not null default '[]'::jsonb,
  lecture_sources jsonb not null default '[]'::jsonb,
  input_tokens integer,
  cached_input_tokens integer,
  cache_write_tokens integer,
  output_tokens integer,
  web_search_calls integer,
  created_at timestamptz not null default now()
);

create index if not exists classrooms_user_updated_idx on public.classrooms (user_id, updated_at desc);
create index if not exists lecture_sessions_classroom_started_idx on public.lecture_sessions (classroom_id, started_at desc);
create index if not exists transcript_segments_session_start_idx on public.transcript_segments (session_id, start_ms);
create index if not exists lecture_questions_session_created_idx on public.lecture_questions (session_id, created_at);
create index if not exists lecture_chunks_classroom_idx on public.lecture_chunks (classroom_id);

alter table public.classrooms enable row level security;
alter table public.lecture_sessions enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.lecture_chunks enable row level security;
alter table public.lecture_questions enable row level security;

drop policy if exists classrooms_owner on public.classrooms;
create policy classrooms_owner on public.classrooms for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists lecture_sessions_owner on public.lecture_sessions;
create policy lecture_sessions_owner on public.lecture_sessions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists transcript_segments_owner on public.transcript_segments;
create policy transcript_segments_owner on public.transcript_segments for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists lecture_chunks_owner_read on public.lecture_chunks;
create policy lecture_chunks_owner_read on public.lecture_chunks for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists lecture_questions_owner_read on public.lecture_questions;
create policy lecture_questions_owner_read on public.lecture_questions for select to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.classrooms to authenticated;
grant select, insert, update, delete on public.lecture_sessions to authenticated;
grant select, insert, update, delete on public.transcript_segments to authenticated;
grant select on public.lecture_chunks to authenticated;
grant select on public.lecture_questions to authenticated;

create or replace function public.match_lecture_chunks(
  p_user_id uuid,
  p_classroom_id uuid,
  p_session_id uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 5
) returns table (
  chunk_id uuid,
  session_id uuid,
  session_title text,
  start_ms integer,
  end_ms integer,
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
    c.session_id,
    s.title,
    c.start_ms,
    c.end_ms,
    c.text,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from public.lecture_chunks c
  join public.lecture_sessions s on s.id = c.session_id
  where c.user_id = p_user_id
    and c.classroom_id = p_classroom_id
    and c.session_id <> p_session_id
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 8);
$$;

revoke all on function public.match_lecture_chunks(uuid, uuid, uuid, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.match_lecture_chunks(uuid, uuid, uuid, extensions.vector, integer) to service_role;
