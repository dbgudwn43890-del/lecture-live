-- Run only in a disposable PostgreSQL database; no service or customer data.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create table public.classrooms(id uuid primary key,user_id uuid references auth.users(id));
create table public.lecture_sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),classroom_id uuid references public.classrooms(id),title text,status text,recording_started_at timestamptz,started_at timestamptz default now(),ended_at timestamptz,duration_seconds integer default 0);
create table public.uploads(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),session_id uuid references public.lecture_sessions(id) on delete cascade,idempotency_key text not null,object_key text,filename text,byte_size bigint,status text default 'uploading',created_at timestamptz default now(),delete_at timestamptz default now()+interval '24 hours',unique(user_id,idempotency_key));
create table storage.buckets(id text primary key,file_size_limit bigint);
insert into storage.buckets values('lecture-audio',1073741824);
\ir ../../../supabase/migrations/20260911050000_audio_direct_upload.sql

insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into classrooms values('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222');
do $$
declare v_user uuid:='11111111-1111-4111-8111-111111111111'; v_other uuid:='22222222-2222-4222-8222-222222222222'; v_result jsonb; v_id uuid; v_new uuid;
begin
  if has_function_privilege('authenticated','public.prepare_audio_upload_service(uuid,uuid,text,text,bigint,text,text)','execute')
    or has_function_privilege('anon','public.claim_audio_verification_service(uuid,uuid,uuid)','execute')
    or has_table_privilege('authenticated','public.audio_upload_daily_budget','update') then raise exception 'client can manipulate direct upload gate'; end if;
  if (select file_size_limit from storage.buckets where id='lecture-audio')<>268435456 then raise exception 'bucket cap incorrect'; end if;
  begin
    perform prepare_audio_upload_service(v_user,'33333333-3333-4333-8333-333333333333','Lecture','lecture.wav',5000000,'en','foreign');
    raise exception 'foreign classroom accepted';
  exception when others then if sqlerrm<>'CLASSROOM_NOT_FOUND' then raise; end if; end;
  begin
    perform prepare_audio_upload_service(v_user,null,'Lecture','lecture.wav',209715201,'en','too-large');
    raise exception 'oversized source accepted';
  exception when others then if sqlerrm<>'INVALID_AUDIO_UPLOAD' then raise; end if; end;
  v_result:=prepare_audio_upload_service(v_user,null,'My lecture','lecture.wav',5000000,'en','retry-key');
  v_id:=(v_result->'upload'->>'id')::uuid;
  if v_result->'session'->>'title'<>'My lecture' or v_result->'session'->>'status'<>'paused'
    or v_result->'session'->>'recording_started_at' is not null then raise exception 'input title or recording lifecycle changed'; end if;
  if v_result->'upload'->>'object_key'<>v_user::text||'/'||v_id::text||'.source' then raise exception 'unsafe object path'; end if;
  v_result:=prepare_audio_upload_service(v_user,null,'My lecture','lecture.wav',5000000,'en','retry-key');
  if (v_result->'upload'->>'id')::uuid<>v_id or (select uploads from audio_upload_daily_budget where user_id=v_user)<>1 then raise exception 'retry duplicated upload or quota'; end if;
  if claim_audio_verification_service(v_other,v_id,gen_random_uuid()) then raise exception 'foreign verification claimed'; end if;
  if not claim_audio_verification_service(v_user,v_id,gen_random_uuid()) then raise exception 'first claim denied'; end if;
  if claim_audio_verification_service(v_user,v_id,gen_random_uuid()) then raise exception 'second verifier allowed'; end if;
  update uploads set verification_claimed_at=now()-interval '11 minutes' where id=v_id;
  if not claim_audio_verification_service(v_user,v_id,gen_random_uuid()) then raise exception 'crashed verifier cannot recover'; end if;
  update uploads set status='processing',verification_claimed_at=now()-interval '11 minutes' where id=v_id;
  if claim_audio_verification_service(v_user,v_id,gen_random_uuid()) then raise exception 'submitted upload reclaimed'; end if;
  update uploads set status='failed' where id=v_id;
  v_result:=prepare_audio_upload_service(v_user,null,'My lecture','lecture.wav',5000000,'en','retry-key');
  v_new:=(v_result->'upload'->>'id')::uuid;
  if v_id=v_new then raise exception 'failed same-file retry not recreated'; end if;
  delete from lecture_sessions where user_id=v_user;
  if (select uploads from audio_upload_daily_budget where user_id=v_user)<>2 then raise exception 'deletion restored storage budget'; end if;
  update audio_upload_daily_budget set uploads=20 where user_id=v_user;
  begin
    perform prepare_audio_upload_service(v_user,null,'Lecture','lecture.wav',5000000,'en','budget');
    raise exception 'daily storage budget bypassed';
  exception when others then if sqlerrm<>'AUDIO_UPLOAD_DAILY_LIMIT' then raise; end if; end;
  raise notice 'PASS: actual direct-upload migration, ownership, input bounds, idempotency, lease recovery, failed retry, deletion-safe daily budget';
end $$;
