-- Execute against the deployed billing schema BEFORE the new migration.
-- Assert the actual migration cannot rewrite older balances or paid orders.
begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000199','migration-preserve@example.invalid');
insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment,transaction_id,completed_at)
values('00000000-0000-4000-8000-000000000199','00000000-0000-4000-8000-000000000199','semester','pri_old',14400,4,'live','txn_preserve',now()-interval '10 days');
insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,paid_subtotal) values
 ('00000000-0000-4000-8000-000000000199','payment','txn_preserve','semester',14400,9999,now()-interval '10 days',now()+interval '30 days',1000),
 ('00000000-0000-4000-8000-000000000199','service_credit','free_preserve','service_credit',600,517,now()-interval '10 days',now()+interval '4 days',null),
 ('00000000-0000-4000-8000-000000000199','service_credit','expired_preserve','service_credit',600,600,now()-interval '30 days',now()-interval '1 day',null);
create temporary table preserved_grants as select source_id,granted_credits,remaining_credits,starts_at,expires_at from public.credit_grants where user_id='00000000-0000-4000-8000-000000000199';
\ir ../../../../supabase/migrations/20260907020000_monthly_credit_installments.sql
do $$
begin
 if exists(select 1 from preserved_grants p join public.credit_grants g using(source_id)
   where row(p.granted_credits,p.remaining_credits,p.starts_at,p.expires_at) is distinct from row(g.granted_credits,g.remaining_credits,g.starts_at,g.expires_at)) then raise exception 'Existing grant mutated'; end if;
 if not exists(select 1 from public.billing_orders where id='00000000-0000-4000-8000-000000000199' and entitlement_version='upfront_v2' and credits=14400 and months=4) then raise exception 'Existing order changed'; end if;
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_grants' and column_name='renewal_paid_at') then raise exception 'Canceled renewal schema unexpectedly applied'; end if;
 raise notice 'PASS: migration preserves existing paid/free/expired grant quantities and dates, keeps old orders upfront';
end $$;
rollback;
