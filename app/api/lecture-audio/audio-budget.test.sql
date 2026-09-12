-- Run only in a new, disposable PostgreSQL database. Synthetic fixtures; no provider calls.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create table public.lecture_sessions(id uuid primary key,user_id uuid references auth.users(id),status text);
create table public.uploads(id uuid primary key,user_id uuid,session_id uuid references lecture_sessions(id) on delete cascade,status text);
create table public.credit_grants(id uuid primary key,user_id uuid,plan_code text,remaining_credits integer,granted_credits integer,refunded_credits integer default 0,starts_at timestamptz,expires_at timestamptz,revoked_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.lecture_credit_usage(grant_id uuid);
create table storage.buckets(id text,allowed_mime_types text[]);
insert into storage.buckets values('lecture-audio',array['audio/wav']);
\ir ../../../supabase/migrations/20260908020000_audio_budget.sql
insert into auth.users values('11111111-1111-4111-8111-111111111111');
insert into lecture_sessions values('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','recording'),('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','recording');
insert into uploads values('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','uploading',null),('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','uploading',null);
insert into credit_grants(id,user_id,plan_code,remaining_credits,granted_credits,starts_at,expires_at) values('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','trial',3,3,now()-interval '1 day',now()+interval '1 day');

do $$declare v record; v_credit integer; begin
select * into v from reserve_audio_credits_service('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',180000);
if not v.allowed or v.credits<>0 then raise exception 'reservation failed'; end if;
select * into v from reserve_audio_credits_service('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',180000);
if v.allowed then raise exception 'shared credits reused'; end if;
perform settle_audio_credits_service('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',false);
perform settle_audio_credits_service('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',false);
select remaining_credits into v_credit from credit_grants;
if v_credit<>3 then raise exception 'release not idempotent'; end if;
select * into v from reserve_audio_credits_service('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',180000);
if not v.allowed then raise exception 'released credits unavailable'; end if;
perform submit_audio_reservation_service('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555');
delete from lecture_sessions where id='33333333-3333-4333-8333-333333333333';
perform settle_audio_credits_service('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',true);
perform settle_audio_credits_service('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',false);
select remaining_credits into v_credit from credit_grants;
if v_credit<>0 then raise exception 'deletion restored accepted provider spend'; end if;
if has_function_privilege('authenticated','public.reserve_audio_credits_service(uuid,uuid,integer)','execute') then raise exception 'client can reserve'; end if;
raise notice 'PASS: reservation, insufficient funds, idempotent release, deletion-safe settlement, RPC permission';
end $$;
