-- L1 파일럿 계측: 학습자가 직접 신고한 오인식과 맥락 실패를 남긴다.
-- 질문 빈도와 체류 시간은 이미 lecture_questions / lecture_sessions에 있으므로
-- 새로 수집하지 않고 아래 뷰에서 합산만 한다.
create table if not exists public.lecture_reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  classroom_id uuid references public.classrooms(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('stt_error', 'context_miss')),
  target_text text not null check (length(target_text) between 1 and 2000),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists lecture_reports_session_idx on public.lecture_reports (session_id, created_at);
create index if not exists lecture_reports_kind_idx on public.lecture_reports (kind, created_at desc);

alter table public.lecture_reports enable row level security;

drop policy if exists lecture_reports_owner on public.lecture_reports;
create policy lecture_reports_owner on public.lecture_reports for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert on public.lecture_reports to authenticated;

-- security_invoker: 뷰가 소유자 권한으로 남의 세션까지 보여주면 안 된다.
-- 각 정책이 그대로 적용되어 사용자는 자기 수업만, 운영자는 service_role로 전체를 본다.
create or replace view public.pilot_session_metrics
with (security_invoker = on) as
  select
    s.id as session_id,
    s.user_id,
    s.classroom_id,
    s.title,
    s.started_at,
    s.duration_seconds,
    (select count(*) from public.lecture_questions q where q.session_id = s.id) as question_count,
    (select count(*) from public.lecture_reports r where r.session_id = s.id and r.kind = 'stt_error') as stt_error_reports,
    (select count(*) from public.lecture_reports r where r.session_id = s.id and r.kind = 'context_miss') as context_miss_reports
  from public.lecture_sessions s;

grant select on public.pilot_session_metrics to authenticated;
