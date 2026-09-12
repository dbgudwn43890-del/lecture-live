-- Only run with the isolated fixture in test-summary-ownership.mjs.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(condition boolean, message text) returns void language plpgsql as $$begin
 if condition is distinct from true then raise exception '%',message; end if;
end;$$;
select pg_temp.assert_true((select count(*)=2 from public.lecture_summary_generations where completed_at is not null),'both rollout backfills must complete existing windows');
select pg_temp.assert_true((select attempts=2 from public.lecture_summary_daily_usage),'legacy windows must count toward the daily budget');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_true((select count(*)=2 from public.lecture_summaries),'owner read is preserved');
do $$begin
 begin
  delete from public.lecture_summaries; raise exception 'browser summary delete accepted';
 exception when insufficient_privilege then null; end;
 begin
  update public.lecture_summaries set text='forged'; raise exception 'column update grant survived';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.lecture_summaries(text) values ('forged'); raise exception 'column insert grant survived';
 exception when insufficient_privilege then null; end;
 begin
  delete from public.lecture_summary_generations; raise exception 'browser ledger delete accepted';
 exception when insufficient_privilege then null; end;
 begin
  update public.lecture_summary_daily_usage set attempts=0; raise exception 'browser budget reset accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,gen_random_uuid(),500,1800000);
  raise exception 'browser claim RPC accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.complete_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,gen_random_uuid(),'forged');
  raise exception 'browser complete RPC accepted';
 exception when insufficient_privilege then null; end;
 -- Legitimate session API inserts still work with existing column grants.
 insert into public.lecture_sessions(user_id,classroom_id,title,status,recording_started_at) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Allowed','recording',now());
 insert into public.lecture_sessions(user_id,classroom_id,title) values ('11111111-1111-4111-8111-111111111111',null,'Allowed without classroom');
 update public.lecture_sessions set title='Renamed' where user_id='11111111-1111-4111-8111-111111111111';
 begin
  insert into public.lecture_sessions(user_id,classroom_id,title) values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Forbidden');
  raise exception 'cross-owner classroom accepted';
 exception when foreign_key_violation then null; end;
end;$$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_true((select count(*)=0 from public.lecture_summaries),'other account must not see generated text');
reset role;
select pg_temp.assert_true(not has_column_privilege('anon','public.lecture_summaries','text','INSERT'),'anon column INSERT survived');
select pg_temp.assert_true(not has_column_privilege('anon','public.lecture_summaries','text','UPDATE'),'anon column UPDATE survived');
select pg_temp.assert_true(not has_column_privilege('authenticated','public.lecture_summaries','text','REFERENCES'),'authenticated column REFERENCES survived');
\echo PASS: browser table/column writes and budget RPCs denied; own reads and legitimate session creation preserved
set local role service_role;
do $$begin
 begin
  update public.lecture_sessions set classroom_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id='aaaaaaaa-0000-4000-8000-000000000001';
  raise exception 'service cross-owner session update accepted';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.lecture_summaries(session_id,user_id,window_index,start_ms,end_ms,text) values ('bbbbbbbb-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',2,1200000,1800000,'bad');
  raise exception 'service cross-owner summary session accepted';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.lecture_summaries(session_id,user_id,classroom_id,window_index,start_ms,end_ms,text) values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',2,1200000,1800000,'bad');
  raise exception 'service cross-owner summary classroom accepted';
 exception when foreign_key_violation then null; end;
 begin
  perform public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001',2,gen_random_uuid(),500,1800000);
  raise exception 'service claim skipped owner verification';
 exception when insufficient_privilege then null; end;
end;$$;
-- A classroom deletion keeps the lecture, summary, and user identity.
delete from public.classrooms where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select pg_temp.assert_true((select classroom_id is null and user_id='11111111-1111-4111-8111-111111111111' from public.lecture_sessions where id='aaaaaaaa-0000-4000-8000-000000000001'),'classroom SET NULL damaged lecture ownership');
select pg_temp.assert_true((select count(*)=2 from public.lecture_summaries where classroom_id is null and user_id='11111111-1111-4111-8111-111111111111'),'classroom delete removed summaries or identity');
\echo PASS: service writes enforce both parent owners; classroom deletion preserves nullable links and user ids
-- Completion is independent from the result row, even after an admin deletes it.
delete from public.lecture_summaries where window_index=0;
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,gen_random_uuid(),500,600000)='completed','result deletion allowed paid replay');
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,'aaaaaaaa-1111-4111-8111-111111111111',500,1800000)='claimed','first attempt rejected');
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,gen_random_uuid(),500,1800000)='generating','active claim replay accepted');
update public.lecture_summary_generations set lease_until=now()-interval '1 second' where window_index=2;
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,'aaaaaaaa-2222-4222-8222-222222222222',500,1800000)='claimed','bounded retry rejected');
select pg_temp.assert_true(not public.complete_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,'aaaaaaaa-1111-4111-8111-111111111111','stale'),'stale token saved over new claim');
update public.lecture_summary_generations set lease_until=now()-interval '1 second' where window_index=2;
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,gen_random_uuid(),500,1800000)='attempt-limit','third window attempt accepted');
-- Failed save must not mark a window complete; valid retry saves atomically.
do $$begin
 begin
  perform public.complete_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,'aaaaaaaa-2222-4222-8222-222222222222','');
  raise exception 'empty text accepted';
 exception when check_violation then null; end;
end;$$;
select pg_temp.assert_true((select completed_at is null from public.lecture_summary_generations where window_index=2),'failed save marked completion');
insert into public.classrooms(id,user_id,title) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac','11111111-1111-4111-8111-111111111111','Moved');
update public.lecture_sessions set classroom_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac' where id='aaaaaaaa-0000-4000-8000-000000000001';
select pg_temp.assert_true(public.complete_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,'aaaaaaaa-2222-4222-8222-222222222222','Saved summary'),'valid save failed');
select pg_temp.assert_true((select classroom_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac' from public.lecture_summaries where window_index=2),'save used stale classroom');
select pg_temp.assert_true((select completed_at is not null and claim_token is null from public.lecture_summary_generations where window_index=2),'save lacked durable completion');
\echo PASS: deleted results cannot replay; attempts persist across failures; stale tokens fail and completion/save are atomic
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,gen_random_uuid(),60001,2400000)='source-limit','oversized input accepted');
update public.lecture_summary_daily_usage set attempts=72 where user_id='11111111-1111-4111-8111-111111111111';
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,gen_random_uuid(),500,2400000)='daily-budget','daily attempt limit bypassed');
update public.lecture_summary_daily_usage set attempts=1,source_characters=999501 where user_id='11111111-1111-4111-8111-111111111111';
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,gen_random_uuid(),500,2400000)='daily-budget','daily input budget bypassed');
update public.lecture_summary_daily_usage set usage_date=usage_date-1 where user_id='11111111-1111-4111-8111-111111111111';
select pg_temp.assert_true(public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,gen_random_uuid(),500,2400000)='claimed','new UTC day did not get a new budget');
delete from public.lecture_sessions where id='aaaaaaaa-0000-4000-8000-000000000001';
select pg_temp.assert_true((select attempts=1 and source_characters=500 from public.lecture_summary_daily_usage where user_id='11111111-1111-4111-8111-111111111111' and usage_date=(now() at time zone 'UTC')::date),'session deletion reset daily cost');
\echo PASS: daily attempt/input limits, per-request input cap, UTC rollover, and session-deletion-resistant usage
rollback;
