-- 구간 요약. 세 시간짜리 스크립트 전체를 질문마다 프롬프트에 넣으면 토큰이
-- 강의 길이에 비례해 늘고, 그 비용과 대기 시간을 학습자가 그대로 문다.
-- 10분마다 그 구간을 모델이 읽기 좋은 형태로 압축해 두고, 질문할 때는
-- 요약 전체 + 최근 구간 원문 + 질문과 맞는 구간 원문만 보낸다.
create table if not exists public.lecture_summaries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid references public.classrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 0부터. 한 수업은 3시간이 상한이고 창은 10분이므로 17이 마지막이다.
  window_index integer not null check (window_index between 0 and 17),
  start_ms integer not null check (start_ms between 0 and 10800000),
  end_ms integer not null check (end_ms between 0 and 10800000),
  text text not null check (length(text) between 1 and 4000),
  -- 요약한 구간에 실제로 들어 있던 원문 길이. 아꼈다고 말할 때 근거가 된다.
  source_characters integer not null default 0 check (source_characters >= 0),
  created_at timestamptz not null default now()
);

-- 한 창은 한 번만 요약한다. 재시도나 두 탭이 동시에 밀어도 두 벌이 생기지 않는다.
create unique index if not exists lecture_summaries_window
  on public.lecture_summaries (session_id, window_index);

alter table public.lecture_summaries enable row level security;

drop policy if exists lecture_summaries_owner on public.lecture_summaries;
create policy lecture_summaries_owner on public.lecture_summaries for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert on public.lecture_summaries to authenticated;
