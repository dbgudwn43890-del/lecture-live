import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Isolated PostgreSQL: no application environment, live data, audio, or provider.
// pgvector is unavailable locally; a text domain stands in for vector storage.
// The actual new migration and actual credit/relay functions run unchanged.
const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'lecue-recording-recovery-'));
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
const port = '55449';
const run = (name, args) => execFileSync(join(bin, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const args = ['-X', '-h', directory, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const sql = value => run('psql', [...args, '-qAt', '-c', value]).trim();
const migration = name => readFileSync(join(root, 'supabase/migrations', name), 'utf8');
const user = '11111111-1111-4111-8111-111111111111';
const session = 'aaaaaaaa-0000-4000-8000-000000000001';
const other = 'aaaaaaaa-0000-4000-8000-000000000002';
const grant = 'aaaaaaaa-1111-4111-8111-111111111111';
const json = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const save = (segments = [], complete = true, id = session) => JSON.parse(sql(`select public.save_lecture_final_service('${id}','${user}',${json(segments)},${complete});`));
const segment = (id, startMs = 0, endMs = 1000, text = 'Saved sentence') => ({ id, startMs, endMs, text });
let started = false;
try {
  let fixture = `create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema extensions;
create table auth.users(id uuid primary key);
create domain extensions.vector as text check(value <> 'invalid-vector');
create table public.lecture_sessions(id uuid primary key,user_id uuid not null references auth.users,classroom_id uuid,title text not null default 'Test',status text not null default 'recording',started_at timestamptz not null default now(),ended_at timestamptz,recording_started_at timestamptz default now(),recorded_ms integer not null default 0,duration_seconds integer not null default 0,input_source text default 'microphone');
create table public.transcript_segments(id uuid primary key default gen_random_uuid(),session_id uuid references public.lecture_sessions on delete cascade,classroom_id uuid,user_id uuid,client_id text,start_ms integer,end_ms integer,text text,unique(session_id,client_id));
create table public.lecture_chunks(id uuid primary key default gen_random_uuid(),session_id uuid references public.lecture_sessions on delete cascade,classroom_id uuid,user_id uuid,start_ms integer,end_ms integer,text text,embedding extensions.vector);
create table public.credit_grants(id uuid primary key,user_id uuid,remaining_credits integer,granted_credits integer,refunded_credits integer default 0,starts_at timestamptz default now(),expires_at timestamptz default now()+interval '1 day',revoked_at timestamptz,plan_code text default 'trial',created_at timestamptz default now(),updated_at timestamptz default now());
create table public.lecture_credit_usage(id uuid primary key default gen_random_uuid(),user_id uuid,session_id uuid references public.lecture_sessions on delete cascade,grant_id uuid references public.credit_grants,minute_index integer,unique(session_id,minute_index));
create table public.audio_credit_reservations(session_id uuid,user_id uuid,status text,charged_credits integer,duration_ms integer);
`;
  const credit = migration('20260907020000_monthly_credit_installments.sql');
  const begin = credit.indexOf('create or replace function public.consume_lecture_credits_service(');
  fixture += credit.slice(begin, credit.indexOf('-- Aborted recordings', begin));
  fixture += migration('20260908030000_stt_relay.sql');
  fixture += migration('20260908040000_index_budget.sql');
  fixture += `create trigger reconcile_finished after update on public.lecture_sessions for each row execute function public.reconcile_finished_lecture_credits();\n`;
  fixture += migration('20260911010000_recording_recovery.sql');
  fixture += `insert into auth.users values('${user}'); insert into public.lecture_sessions(id,user_id) values('${session}','${user}'),('${other}','${user}'); insert into public.credit_grants(id,user_id,remaining_credits,granted_credits) values('${grant}','${user}',20,20);`;
  writeFileSync(join(directory, 'fixture.sql'), fixture);
  run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '--no-locale']);
  run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-k ${directory} -p ${port} -h ''`, 'start']);
  started = true;
  writeFileSync(join(directory, 'fixture.log'), run('psql', [...args, '-f', join(directory, 'fixture.sql')]));
  // Both active connections and issued-but-unconsumed tickets fence recovery.
  sql(`insert into public.stt_relay_tickets(token_hash,user_id,session_id,configuration) values(repeat('a',64),'${user}','${session}','{}');`);
  assert.equal(JSON.parse(sql(`select public.recover_lecture_session_service('${session}','${user}');`)).activeRecording, true);
  assert.equal(save().error, 'RECORDING_ALREADY_ACTIVE');
  const opened = JSON.parse(sql(`select public.open_stt_relay_service(repeat('a',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`));
  assert.equal(opened.authorizedBytes, 1920000);
  assert.equal(save().error, 'RECORDING_ALREADY_ACTIVE');
  assert.equal(sql(`select status from public.lecture_sessions where id='${session}';`), 'recording');
  // A separate DB connection holds the shared account lock while open+recovery contend.
  const parallel = value => new Promise((resolve, reject) => {
    const child = spawn(join(bin, 'psql'), [...args, '-qAt', '-c', value]);
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  const race = await Promise.all([
    parallel(`begin; select pg_advisory_xact_lock(hashtextextended('credit-balance:${user}',0)); select pg_sleep(0.15); select public.advance_stt_relay_service('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',32000,false,false); commit;`),
    parallel(`select public.recover_lecture_session_service('${session}','${user}');`),
  ]);
  assert.equal(JSON.parse(race[1]).activeRecording, true);
  assert.equal(sql(`select status from public.lecture_sessions where id='${session}';`), 'recording');
  console.log('PASS: active lease, pending ticket, and two-connection heartbeat/recovery retain the original recording');

  // Clean close settles bytes. Final save charges no wall time on a relay.
  sql(`select public.advance_stt_relay_service('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1920000,false,true); insert into public.transcript_segments(session_id,user_id,client_id,start_ms,end_ms,text) select '${session}','${user}',i::text,i*10,i*10+10,'x' from generate_series(0,4999)i;`);
  let saved = save([segment('5000',50000,50010)]);
  assert.equal(saved.completed, true);
  assert.equal(saved.session.recorded_ms,60000);
  assert.equal(sql(`select count(*) from public.transcript_segments where session_id='${session}';`),'5001');
  assert.equal(sql(`select remaining_credits from public.credit_grants where id='${grant}';`),'19');
  assert.deepEqual(save([segment('5000',50000,50010)]).acknowledgedSegmentIds,['5000']);
  assert.equal(sql(`select count(*) from public.lecture_credit_usage where session_id='${session}';`),'1');
  saved = save([segment('recovered',50010,51000)],false);
  assert.deepEqual(saved.acknowledgedSegmentIds,['recovered']);
  assert.equal(saved.completed,true);
  assert.equal(save([segment('outside',59000,61000)]).error,'RECOVERY_OUTSIDE_PAID_RECORDING');
  assert.equal(save([segment('recovered',50010,51000,'changed')]).error,'SEGMENT_CONFLICT');
  assert.equal(sql(`select count(*) from public.transcript_segments where session_id='${session}';`),'5002');
  assert.equal(sql(`select segment_count from public.lecture_index_queue where session_id='${session}';`),'5002');
  sql(`update public.lecture_sessions set recorded_ms=120000 where id='${session}';`);
  assert.equal(save([segment('unpaid-minute',60000,61000)]).error,'RECOVERY_OUTSIDE_PAID_RECORDING');
  sql(`update public.lecture_sessions set recorded_ms=60000 where id='${session}';
    create function public.test_reject_segment() returns trigger language plpgsql as $$begin if new.text='FAIL_INSERT' then raise exception 'TEST_TRANSCRIPT_FAILURE'; end if; return new; end$$;
    create trigger test_reject_segment before insert on public.transcript_segments for each row execute function public.test_reject_segment();`);
  try { save([segment('rolled-back',0,1),segment('failing',1,2,'FAIL_INSERT')]); assert.fail('failed transcript insert was acknowledged'); }
  catch(error) { assert.match(error.stderr?.toString() ?? '',/TEST_TRANSCRIPT_FAILURE/); }
  assert.equal(sql(`select count(*) from public.transcript_segments where session_id='${session}';`),'5002');
  assert.equal(sql(`select segment_count from public.lecture_index_queue where session_id='${session}';`),'5002');
  assert.equal(sql(`select has_function_privilege('authenticated','public.save_lecture_final_service(uuid,uuid,jsonb,boolean)','execute');`),'f');
  console.log('PASS: segment 5,001, completed paid recovery, duplicate completion, actual unpaid-minute rejection, insert rollback, service privilege, and durable queue');

  // No-paid-work behavior remains: insufficient legacy credits do not discard
  // transcripts, but paid indexing and future recovery beyond usage are denied.
  sql(`update public.credit_grants set remaining_credits=0; update public.lecture_sessions set recording_started_at=now()-interval '90 seconds' where id='${other}';`);
  assert.equal(save([segment('unfunded',0,90000)],true,other).completed,true);
  assert.equal(JSON.parse(sql(`select public.reserve_lecture_index('${other}','${user}',10);`)).reason,'unfunded_input');
  assert.equal(save([segment('unfunded-recovery',0,1000)],true,other).error,'RECOVERY_OUTSIDE_PAID_RECORDING');
  console.log('PASS: exhausted legacy credits preserve transcript but cannot buy indexing or unpaid completed recovery');

  // A failed replacement transaction keeps the old index and its claim retryable.
  sql(`insert into public.lecture_chunks(session_id,user_id,start_ms,end_ms,text,embedding) values('${session}','${user}',0,1000,'Old partial index','[1]');`);
  const claim = JSON.parse(sql(`select public.reserve_lecture_index('${session}','${user}',5100);`));
  assert.equal(claim.allowed,true);
  const replace = chunks => `select public.replace_lecture_index_service('${session}','${user}','${claim.claim_token}',5002,${json(chunks)});`;
  try { sql(replace([{start_ms:0,end_ms:1000,text:'New index',embedding:'invalid-vector'}])); assert.fail('invalid replacement accepted'); } catch(error) { assert.match(error.stderr?.toString() ?? '',/violates check constraint/); }
  assert.equal(sql(`select text from public.lecture_chunks where session_id='${session}';`),'Old partial index');
  assert.equal(sql(replace([{start_ms:0,end_ms:51000,text:'Complete index',embedding:'[1]'}])),'t');
  assert.equal(sql(`select state from public.lecture_index_queue where session_id='${session}';`),'completed');
  assert.equal(JSON.parse(sql(`select public.reserve_lecture_index('${session}','${user}',5100);`)).allowed,false);
  console.log('PASS: partial existing chunks are replaced atomically; failed vector insert retains old index; duplicate indexing stays denied');

  // A new paid tail invalidates only the source count; prior attempts remain.
  assert.equal(save([segment('second-tail',51000,52000)],false).saved,true);
  const secondClaim=JSON.parse(sql(`select public.reserve_lecture_index('${session}','${user}',5200);`));
  assert.equal(secondClaim.allowed,true);
  assert.equal(sql(`select attempts from public.lecture_index_jobs where session_id='${session}';`),'2');
  assert.equal(save([segment('racing-tail',52000,53000)],false).saved,true);
  assert.equal(sql(`select public.replace_lecture_index_service('${session}','${user}','${secondClaim.claim_token}',5003,${json([{start_ms:0,end_ms:52000,text:'Stale index',embedding:'[1]'}])});`),'f');
  assert.equal(sql(`select text from public.lecture_chunks where session_id='${session}';`),'Complete index');
  const thirdClaim=JSON.parse(sql(`select public.reserve_lecture_index('${session}','${user}',5300);`));
  assert.equal(thirdClaim.allowed,true);
  sql(`select public.finish_lecture_index('${session}','${thirdClaim.claim_token}',false);`);
  assert.equal(JSON.parse(sql(`select public.reserve_lecture_index('${session}','${user}',5300);`)).allowed,false);
  const budgetSession='aaaaaaaa-0000-4000-8000-000000000003';
  sql(`insert into public.lecture_sessions(id,user_id,status,recorded_ms) values('${budgetSession}','${user}','completed',1000);
    insert into public.lecture_credit_usage(user_id,session_id,grant_id,minute_index) values('${user}','${budgetSession}','${grant}',0);
    insert into public.transcript_segments(session_id,user_id,client_id,start_ms,end_ms,text) values('${budgetSession}','${user}','paid',0,1000,'paid');
    update public.lecture_index_daily_budget set characters=1999999 where user_id='${user}';`);
  assert.equal(JSON.parse(sql(`select public.reserve_lecture_index('${budgetSession}','${user}',10);`)).reason,'daily_budget');
  console.log('PASS: recovery/index race retains prior vectors; lifetime attempt and daily paid-character budgets cannot reset');
} catch (error) {
  console.error(error.stderr?.toString() ?? error.stack); process.exitCode=1;
} finally {
  if(started) run('pg_ctl',['-D',join(directory,'data'),'stop','-m','fast']);
  console.log(`Synthetic fixture logs: ${directory}`);
}
