// Transactional preflight by default; --apply commits only the additive migration.
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
const config=parseEnv(readFileSync('.env.local','utf8'));
const url=new URL(config.SUPABASE_DB_URL);
const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:url.pathname.slice(1),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'10'};
const migration=readFileSync('supabase/migrations/20260913020000_admin_dashboard.sql','utf8');
const apply=process.argv.includes('--apply');const audit=process.argv.includes('--audit');
const checks=`
do $$ declare actor uuid; target uuid; request_key uuid:=gen_random_uuid(); snapshot jsonb; begin
 if has_function_privilege('anon','public.admin_dashboard_service(integer,text,integer)','execute') or has_function_privilege('authenticated','public.admin_dashboard_service(integer,text,integer)','execute') or has_function_privilege('authenticated','public.admin_grant_credits_service(uuid,uuid,uuid,integer,integer,text)','execute') or has_table_privilege('authenticated','public.admin_credit_audit','select') then raise exception 'ADMIN_PRIVILEGE_LEAK'; end if;
 if not (select relrowsecurity from pg_class where oid='public.admin_credit_audit'::regclass) then raise exception 'ADMIN_RLS_MISSING'; end if;
 snapshot:=public.admin_dashboard_service(1,'',7);
 if not(snapshot ? 'metrics') or jsonb_array_length(snapshot->'users')>25 then raise exception 'INVALID_DASHBOARD'; end if;
end $$;
select jsonb_build_object('dashboard_shape','ok','rls',true,'client_access',false);
`;
const regression=`
do $$ declare actor uuid; request_key uuid:=gen_random_uuid(); reply jsonb; n integer; begin
 select id into actor from auth.users where email_confirmed_at is not null and not coalesce(is_anonymous,false) limit 1;
 if actor is null then raise exception 'VERIFIED_ACCOUNT_REQUIRED_FOR_ROLLBACK_TEST'; end if;
 reply:=public.admin_grant_credits_service(actor,actor,request_key,1,1,'Rollback-only security regression');
 reply:=public.admin_grant_credits_service(actor,actor,request_key,1,1,'Rollback-only security regression');
 if reply->>'replayed'<>'true' then raise exception 'RETRY_NOT_DEDUPLICATED'; end if;
 select count(*) into n from public.credit_grants where source_id='admin-'||request_key::text;
 if n<>1 then raise exception 'DUPLICATE_GRANT'; end if;
 begin
   perform public.admin_grant_credits_service(actor,actor,request_key,2,1,'Rollback-only security regression');
   raise exception 'CONFLICT_WAS_ACCEPTED';
 exception when others then if sqlerrm<>'IDEMPOTENCY_CONFLICT' then raise; end if; end;
 begin
   perform public.admin_grant_credits_service(actor,gen_random_uuid(),gen_random_uuid(),1,1,'Rollback-only missing recipient');
   raise exception 'MISSING_RECIPIENT_ACCEPTED';
 exception when foreign_key_violation then null; end;
 select count(*) into n from public.admin_credit_audit where reason='Rollback-only missing recipient';
 if n<>0 then raise exception 'AUDIT_NOT_ATOMIC'; end if;
end $$;
select 'Rollback regression: deduplication, conflict rejection and audit atomicity passed';
`;
const input=`begin; set local lock_timeout='2s'; set local statement_timeout='20s';\n${audit?'':migration}\n${checks}\n${apply?`insert into supabase_migrations.schema_migrations(version,name,statements) values('20260913020000','admin_dashboard',array[$migration$${migration}$migration$]); commit;`: `${audit?'':regression} rollback;`}`;
const result=spawnSync('/opt/homebrew/opt/postgresql@18/bin/psql',['-X','-v','ON_ERROR_STOP=1','-qAt'],{env,input,encoding:'utf8'});
if(result.status!==0){console.error((result.stderr??'').split('\n').filter(line=>/^ERROR:|^FATAL:/.test(line)).join('\n')||'Database unavailable');process.exit(1);}
console.log(result.stdout.trim());console.log(apply?'Admin migration committed.':audit?'Admin privilege audit passed.':'Preflight passed; every test write rolled back.');
