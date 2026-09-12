-- Direct private uploads bypass the web function request-body limit. Only the
-- server can allocate a path; the browser receives one expiring, non-upsert token.
alter table public.uploads add column if not exists transcription_language text;
alter table public.uploads add column if not exists source_byte_size bigint;
alter table public.uploads add column if not exists verification_claimed_at timestamptz;
alter table public.uploads add column if not exists verification_token uuid;

create table if not exists public.audio_upload_daily_budget (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  uploads integer not null check(uploads between 0 and 20),
  primary key(user_id,usage_date)
);
alter table public.audio_upload_daily_budget enable row level security;
revoke all on public.audio_upload_daily_budget from public,anon,authenticated;
grant all on public.audio_upload_daily_budget to service_role;

-- 200 MiB original + at most 256 MiB canonical output fits the decoder's disk.
update storage.buckets set file_size_limit=268435456 where id='lecture-audio';

create or replace function public.prepare_audio_upload_service(
  p_user_id uuid, p_classroom_id uuid, p_title text, p_filename text,
  p_byte_size bigint, p_language text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_upload public.uploads; v_session public.lecture_sessions; v_id uuid; v_day date:=(now() at time zone 'UTC')::date; v_count integer;
begin
  if p_user_id is null or p_byte_size is null or p_byte_size not between 1 and 209715200
    or p_title is null or length(p_title) not between 1 and 80 or p_filename is null or length(p_filename) not between 1 and 200
    or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 100
    or p_language is null or p_language not in ('default','ko','en','es','ja','zh','fr','de','pt','hi')
    then raise exception 'INVALID_AUDIO_UPLOAD'; end if;
  perform pg_advisory_xact_lock(hashtextextended('audio-upload:'||p_user_id::text,0));
  select * into v_upload from public.uploads where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found then
    if v_upload.status in ('failed','deleted') or (v_upload.status='uploading' and v_upload.delete_at<=now()) then
      -- Keep the failed lesson and deletion tracking, but allow selecting the
      -- same file again after a definite failure. Daily usage is not refunded.
      update public.uploads set idempotency_key='closed:'||gen_random_uuid()::text,status='failed' where id=v_upload.id;
    else
      select * into v_session from public.lecture_sessions where id=v_upload.session_id and user_id=p_user_id;
      if v_upload.source_byte_size is distinct from p_byte_size or v_upload.filename<>p_filename
        or v_upload.transcription_language is distinct from p_language then raise exception 'AUDIO_UPLOAD_CONFLICT'; end if;
      return jsonb_build_object('upload',to_jsonb(v_upload),'session',to_jsonb(v_session),'duplicate',true);
    end if;
  end if;
  if p_classroom_id is not null and not exists(select 1 from public.classrooms where id=p_classroom_id and user_id=p_user_id)
    then raise exception 'CLASSROOM_NOT_FOUND'; end if;
  select uploads into v_count from public.audio_upload_daily_budget where user_id=p_user_id and usage_date=v_day;
  if coalesce(v_count,0)>=20
    then raise exception 'AUDIO_UPLOAD_DAILY_LIMIT'; end if;
  if (select count(*) from public.uploads where user_id=p_user_id and status in ('uploading','queued','processing') and delete_at>now())>=2
    then raise exception 'AUDIO_UPLOAD_PENDING_LIMIT'; end if;
  -- Deleting a lecture must never replenish already issued upload tokens.
  insert into public.audio_upload_daily_budget(user_id,usage_date,uploads) values(p_user_id,v_day,1)
    on conflict(user_id,usage_date) do update set uploads=public.audio_upload_daily_budget.uploads+1;
  -- Uploaded audio has its own measured-duration reservation. It must not
  -- create a live-recording clock or stop an existing microphone session.
  insert into public.lecture_sessions(user_id,classroom_id,title,status,recording_started_at)
    values(p_user_id,p_classroom_id,p_title,'paused',null) returning * into v_session;
  v_id:=gen_random_uuid();
  insert into public.uploads(id,user_id,session_id,idempotency_key,object_key,filename,byte_size,source_byte_size,transcription_language)
    values(v_id,p_user_id,v_session.id,p_idempotency_key,p_user_id::text||'/'||v_id::text||'.source',p_filename,p_byte_size,p_byte_size,p_language)
    returning * into v_upload;
  return jsonb_build_object('upload',to_jsonb(v_upload),'session',to_jsonb(v_session),'duplicate',false);
end $$;

-- The ten-minute lease exceeds this route's five-minute function lifetime.
-- A crashed verifier can be retried without running two provider submissions.
create or replace function public.claim_audio_verification_service(p_user_id uuid,p_upload_id uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.uploads set verification_claimed_at=now(),verification_token=p_token
    where id=p_upload_id and user_id=p_user_id and status='uploading' and delete_at>now()
      and source_byte_size is not null
      and (verification_claimed_at is null or verification_claimed_at<now()-interval '10 minutes');
  return found;
end $$;

revoke all on function public.prepare_audio_upload_service(uuid,uuid,text,text,bigint,text,text), public.claim_audio_verification_service(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_audio_upload_service(uuid,uuid,text,text,bigint,text,text), public.claim_audio_verification_service(uuid,uuid,uuid) to service_role;
