-- UPL-01~07 (PRD 9.4, 15.7). 녹음 파일을 올려 실시간 강의와 같은 형식의
-- 스크립트를 만든다. 업로드 자체의 상태(uploading, queued, processing,
-- completed, failed, deleted)는 lecture_sessions가 아니라 여기에 둔다 —
-- 세션의 status는 크레딧 RPC가 'recording'인지 보고 판단하는 값이라
-- 새 상태를 끼워 넣으면 과금 경로가 조용히 바뀐다.
create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- UPL-04. 같은 업로드 요청이 두 번 도착해도 작업은 하나만 생긴다.
  idempotency_key text not null,
  object_key text,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'processing', 'completed', 'failed', 'deleted')),
  filename text not null check (length(filename) between 1 and 200),
  byte_size bigint not null check (byte_size between 0 and 1073741824),
  duration_ms integer check (duration_ms between 0 and 10800000),
  -- Deepgram이 콜백에 실어 돌려보내는 요청 식별자. 늦게 도착한 콜백이 어느
  -- 업로드의 것인지 대조한다.
  provider_request_id text,
  error_code text,
  -- UPL-05/UPL-06. 성공하면 즉시, 실패해도 24시간 뒤에는 원본이 사라져야 한다.
  delete_at timestamptz not null default now() + interval '24 hours',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uploads_user_idempotency
  on public.uploads (user_id, idempotency_key);
create index if not exists uploads_session_idx on public.uploads (session_id);
-- 만료 청소가 훑는 축: 아직 안 지운 것 중 기한이 지난 것.
create index if not exists uploads_sweep_idx on public.uploads (delete_at)
  where deleted_at is null;

alter table public.uploads enable row level security;

drop policy if exists uploads_owner on public.uploads;
create policy uploads_owner on public.uploads for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- 원본 음성 버킷. 비공개이고, 스크립트를 만든 뒤에는 비워진다(PRD 5.4).
-- 1GB 상한은 UPL-02와 같은 값이다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lecture-audio', 'lecture-audio', false, 1073741824,
  array['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
        'audio/wav', 'audio/x-wav', 'audio/webm', 'video/mp4', 'video/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 1073741824,
      allowed_mime_types = excluded.allowed_mime_types;

-- materials 버킷과 같은 규칙: 객체 이름의 첫 폴더가 소유자 uuid다.
drop policy if exists lecture_audio_owner on storage.objects;
create policy lecture_audio_owner on storage.objects for all to authenticated
using (bucket_id = 'lecture-audio' and (select auth.uid())::text = (storage.foldername(name))[1])
with check (bucket_id = 'lecture-audio' and (select auth.uid())::text = (storage.foldername(name))[1]);
