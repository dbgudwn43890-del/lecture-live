import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Own disposable PostgreSQL only. No application env, live DB, or paid API.
const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'lecue-summary-security-'));
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
const port = '55447';
const run = (name, args) => execFileSync(join(bin, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const args = ['-X', '-h', directory, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const migration = name => readFileSync(join(root, 'supabase/migrations', name), 'utf8');
let started = false;
try {
  let fixture = `create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,public,extensions to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role,authenticated;
create function extensions.cosine(a real[], b real[]) returns double precision language sql immutable as $$select 1-sum(x::double precision*y)/(sqrt(sum(x::double precision*x))*sqrt(sum(y::double precision*y))) from unnest(a,b) z(x,y)$$;
create operator extensions.<=> (leftarg=real[],rightarg=real[],function=extensions.cosine);
`;
  for (const name of ['20260822010000_classrooms.sql','20260825000000_optional_classrooms.sql','20260831010000_lecture_summaries.sql']) fixture += migration(name) + '\n';
  fixture = fixture.replace('create extension if not exists vector with schema extensions;', '').replaceAll('extensions.vector(1536)', 'real[]').replaceAll('extensions.vector,', 'real[],');
  fixture += `alter table public.lecture_sessions add column recording_started_at timestamptz;\n` + migration('20260902000000_lock_billing_columns.sql');
  fixture += `
insert into auth.users values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.classrooms(id,user_id,title) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','A'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','B');
insert into public.lecture_sessions(id,user_id,classroom_id,title) values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A'),('bbbbbbbb-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B');
insert into public.lecture_summaries(session_id,user_id,classroom_id,window_index,start_ms,end_ms,text,source_characters) values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,0,600000,'Legacy summary',500);
-- Explicit column privileges intentionally reproduce a table-only REVOKE bypass.
grant insert (text),update (text),references (text) on public.lecture_summaries to authenticated,anon;
`;
  writeFileSync(join(directory, 'fixture.sql'), fixture);
  run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '--no-locale']);
  run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-k ${directory} -p ${port} -h ''`, 'start']);
  started = true;
  writeFileSync(join(directory, 'fixture.log'), run('psql', [...args, '-f', join(directory, 'fixture.sql')]));
  const additive = migration('20260911020000_summary_ownership_security.sql');
  // The same migration must abort cleanly if pre-existing cross-owner data exists.
  try {
    run('psql', [...args, '-c', `begin; update public.lecture_sessions set classroom_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id='aaaaaaaa-0000-4000-8000-000000000001'; ${additive} commit;`]);
    assert.fail('ownership mismatch did not abort migration');
  } catch (error) {
    assert.match(error.stderr?.toString() ?? '', /violates foreign key constraint "lecture_sessions_classroom_owner_fk"/);
  }
  writeFileSync(join(directory, 'additive.log'), run('psql', [...args, '-c', `begin; ${additive} commit;`]));
  // The old production route's authenticated upsert remains valid in stage one.
  run('psql', [...args, '-c', `begin; set local role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true); insert into public.lecture_summaries(session_id,user_id,window_index,start_ms,end_ms,text,source_characters) values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',1,600000,1200000,'Staged legacy summary',500) on conflict (session_id,window_index) do nothing; commit;`]);
  writeFileSync(join(directory, 'revoke.log'), run('psql', [...args, '-c', `begin; ${migration('20260911040000_summary_server_writes.sql')} commit;`]));
  const result = run('psql', [...args, '-f', join(root, 'scripts/security/summary-ownership-regression.sql')]);
  writeFileSync(join(directory, 'regression.log'), result);
  console.log(result.split('\n').filter(line => line.startsWith('PASS:')).join('\n'));
  // Two real PostgreSQL connections contend on the same window, then on the
  // same daily budget across different sessions. Neither may double-charge.
  const parallel = sql => new Promise((resolve, reject) => {
    const child = spawn(join(bin, 'psql'), [...args, '-qAt', '-c', sql]);
    let output = ''; let error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  const claim = (session, token) => `select public.claim_lecture_summary_generation('11111111-1111-4111-8111-111111111111','${session}',2,'${token}',500,1800000);`;
  const first = 'aaaaaaaa-0000-4000-8000-000000000001';
  const second = 'aaaaaaaa-0000-4000-8000-000000000002';
  run('psql', [...args, '-c', `insert into public.lecture_sessions(id,user_id,title) values ('${second}','11111111-1111-4111-8111-111111111111','Concurrent');`]);
  const competing = await Promise.all([
    parallel(`begin; set local role service_role; ${claim(first,'aaaaaaaa-1111-4111-8111-111111111111')} select pg_sleep(0.2); commit;`),
    parallel(`begin; set local role service_role; ${claim(first,'aaaaaaaa-2222-4222-8222-222222222222')} commit;`),
  ]);
  assert.deepEqual(competing.map(value => value.split('\n')[0]).sort(), ['claimed','generating']);
  run('psql', [...args, '-c', `update public.lecture_summary_daily_usage set attempts=71,source_characters=0 where user_id='11111111-1111-4111-8111-111111111111' and usage_date=(now() at time zone 'UTC')::date; delete from public.lecture_summary_generations where window_index=2;`]);
  const budget = await Promise.all([
    parallel(`begin; set local role service_role; ${claim(first,'aaaaaaaa-3333-4333-8333-333333333333')} select pg_sleep(0.2); commit;`),
    parallel(`begin; set local role service_role; ${claim(second,'aaaaaaaa-4444-4444-8444-444444444444')} commit;`),
  ]);
  assert.deepEqual(budget.map(value => value.split('\n')[0]).sort(), ['claimed','daily-budget']);
  console.log('PASS: real concurrent claims allow one window request and one final daily-budget slot');
  console.log('PASS: staged migration supports the old API until final write revocation; mismatches abort');
} catch (error) {
  console.error(error.stderr?.toString() ?? error.stack);
  process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', join(directory, 'data'), 'stop', '-m', 'fast']);
  console.log(`Synthetic fixture logs: ${directory}`);
}
