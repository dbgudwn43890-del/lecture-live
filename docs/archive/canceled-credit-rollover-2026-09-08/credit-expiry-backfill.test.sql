-- Run against a disposable database BEFORE the credit-renewal migration.
-- This applies the real migration and checks its live-only correction, then
-- rolls back the fixtures AND migration. No real buyer data is required.
begin;
insert into auth.users(id,email)
select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'backfill-'||n||'@example.invalid'
from generate_series(81,84) n;
insert into public.billing_orders(user_id,plan_code,price_id,credits,months,environment,transaction_id,completed_at)
select id,'topup','pri_backfill',1000,12,
  case when right(id::text,2)='82' then 'sandbox' else 'live' end,
  'txn_backfill_'||right(id::text,2),now()-interval '10 days'
from auth.users where email like 'backfill-%@example.invalid';
-- Owner 84 represents legacy payment without an attached server order.
delete from public.billing_orders where transaction_id='txn_backfill_84';
insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,paid_subtotal)
select id,'payment','txn_backfill_'||right(id::text,2),'topup',1000,900,now()-interval '10 days',now()+interval '20 days',1000
from auth.users where email like 'backfill-%@example.invalid';
insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
select id,'service_credit','starter_backfill_'||right(id::text,2),'service_credit',600,517,now()-interval '15 days',now()+interval '20 days'
from auth.users where email like 'backfill-%@example.invalid';
insert into public.billing_adjustments(adjustment_id,transaction_id,subtotal,occurred_at)
values('adj_backfill_83','txn_backfill_83',250,now());
-- Even a stale refund ledger/grant discrepancy must exclude the purchase.
insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
values
 ('00000000-0000-4000-8000-000000000081','service_credit','expired_backfill','service_credit',600,600,now()-interval '15 days',now()-interval '1 day'),
 ('00000000-0000-4000-8000-000000000081','service_credit','longer_backfill','service_credit',600,600,now()-interval '15 days',now()+interval '2 years'),
 ('00000000-0000-4000-8000-000000000081','service_credit','after_payment_backfill','service_credit',600,600,now()-interval '5 days',now()+interval '20 days');
\ir ../../../../supabase/migrations/20260907010000_renew_credit_expiry_on_payment.sql
do $$
declare actual timestamptz;
begin
  if (select expires_at from public.credit_grants where source_id='starter_backfill_81') is distinct from (((now()-interval '10 days') at time zone 'UTC')+interval '12 months') at time zone 'UTC' then raise exception 'Live starter backfill failed'; end if;
  if (select remaining_credits from public.credit_grants where source_id='starter_backfill_81')<>517 then raise exception 'Backfill changed remaining credits'; end if;
  if (select expires_at from public.credit_grants where source_id='txn_backfill_81') is distinct from (((now()-interval '10 days') at time zone 'UTC')+interval '12 months') at time zone 'UTC' then raise exception 'Live paid backfill failed'; end if;
  if exists(select 1 from public.credit_grants where source_id in ('starter_backfill_82','starter_backfill_83','starter_backfill_84','txn_backfill_82','txn_backfill_83','txn_backfill_84','after_payment_backfill') and expires_at<>now()+interval '20 days') then raise exception 'Sandbox, refunded, legacy or post-payment credit was backfilled'; end if;
  if (select expires_at from public.credit_grants where source_id='expired_backfill')<>now()-interval '1 day' then raise exception 'Backfill revived expired credit'; end if;
  if (select expires_at from public.credit_grants where source_id='longer_backfill')<>now()+interval '2 years' then raise exception 'Backfill shortened expiry'; end if;
  if exists(select 1 from public.credit_grants where renewal_paid_at is not null) then raise exception 'Backfill marked historical renewals for replay'; end if;
  raise notice 'PASS: backfill extends current live paid/free balances, preserves usage, excludes expired/refunded/sandbox/legacy balances';
end $$;
rollback;
