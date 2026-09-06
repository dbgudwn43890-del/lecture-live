-- Online lectures: a session records where its audio came from. Existing rows
-- were all microphone lectures (uploads are told apart by their audio row, not
-- by this column). Tab label / URL / screen data are never stored.
alter table public.lecture_sessions
  add column if not exists input_source text not null default 'microphone'
    check (input_source in ('microphone', 'browser-tab'));

-- A start whose response was lost must not create a second billed session.
-- The client sends one id per start attempt and retries with the same id; the
-- server returns the row that already exists instead of inserting again.
alter table public.lecture_sessions
  add column if not exists start_request_id uuid;

create unique index if not exists lecture_sessions_start_request_unique
  on public.lecture_sessions (user_id, start_request_id)
  where start_request_id is not null;
