// Read-only/rollback preflight by default. --apply is an explicit release step.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
const config = parseEnv(readFileSync('.env.local', 'utf8'));
const url = new URL(config.SUPABASE_DB_URL);
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '10' };
const migration = readFileSync('supabase/migrations/20260913010000_analytics_signup.sql', 'utf8');
const apply = process.argv.includes('--apply');
const audit = process.argv.includes('--audit');
const auditSql = `select json_build_object('receipts',count(*),'claimed',count(claimed_at),'first_sessions',count(first_session_id)) from public.analytics_signup_receipts;
select json_build_object('rls',relrowsecurity) from pg_class where oid='public.analytics_signup_receipts'::regclass;
select json_build_object('public_can_read',has_table_privilege('anon','public.analytics_signup_receipts','select'),'user_can_claim',has_function_privilege('authenticated','public.claim_analytics_signup_service(uuid,uuid)','execute'));
select json_build_object('triggers',count(*)) from pg_trigger where tgname in ('analytics_account_created','analytics_first_session_created') and tgenabled='O';`;
const input = audit ? `begin read only; ${auditSql} rollback;` : `begin;
set local lock_timeout='2s'; set local statement_timeout='15s';
${migration}
${auditSql}
${apply ? `insert into supabase_migrations.schema_migrations(version,name,statements) values('20260913010000','analytics_signup',array[$migration$${migration}$migration$]); commit;` : 'rollback;'}
`;
const result = spawnSync('/opt/homebrew/opt/postgresql@18/bin/psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-qAt'], { env, input, encoding: 'utf8' });
if (result.status !== 0) {
  // Error lines are useful, but connection credentials and SQL bodies are not.
  const errors = (result.stderr ?? '').split('\n').filter(line => /^ERROR:|^FATAL:/.test(line));
  console.error('Analytics DB operation failed:', errors.map(line => line.replaceAll(config.SUPABASE_DB_URL, '[connection]')).join('\n') || 'connection unavailable');
  process.exit(1);
}
console.log(result.stdout.trim());
console.log(audit ? 'Read-only analytics audit complete.' : apply ? 'Analytics migration committed.' : 'Migration and privileges checked; transaction rolled back.');
