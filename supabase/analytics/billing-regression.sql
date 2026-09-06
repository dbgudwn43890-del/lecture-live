-- Run with psql -v ON_ERROR_STOP=1. Every fixture is rolled back.
begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000006','billing-regression@example.invalid');
do $$
declare u uuid := '00000000-0000-4000-8000-000000000006'; a uuid; b uuid; n integer; g jsonb;
begin
  select id into a from public.reserve_billing_order(gen_random_uuid(),u,'monthly','pri_test',900,1,'sandbox');
  select id into b from public.reserve_billing_order(gen_random_uuid(),u,'monthly','pri_test',900,1,'sandbox');
  if a<>b then raise exception 'Duplicate checkout reservation'; end if;
  g := jsonb_build_object('user_id',u,'source_type','payment','source_id','txn_regression','plan_code','monthly','credits',900,'starts_at',now(),'expires_at',now()+interval '1 month','paid_subtotal',1500);
  perform public.apply_billing_event('evt_regression_1','transaction.completed',now(),g);
  update public.credit_grants set remaining_credits=800 where source_id='txn_regression';
  perform public.apply_billing_event('evt_regression_1','transaction.completed',now(),g);
  perform public.apply_billing_event('evt_regression_2','transaction.completed',now(),g);
  select remaining_credits into n from public.credit_grants where source_id='txn_regression';
  if n<>800 then raise exception 'Replay reset consumed credits'; end if;
  perform public.apply_billing_event('evt_regression_r1','adjustment.created',now(),null,null,'{"id":"adj_regression1","transaction_id":"txn_regression","subtotal":500}');
  perform public.apply_billing_event('evt_regression_r2','adjustment.updated',now(),null,null,'{"id":"adj_regression1","transaction_id":"txn_regression","subtotal":500}');
  select remaining_credits into n from public.credit_grants where source_id='txn_regression';
  if n<>500 then raise exception 'Partial refund or adjustment replay failed'; end if;
  perform public.apply_billing_event('evt_regression_r3','adjustment.created',now(),null,null,'{"id":"adj_regression2","transaction_id":"txn_regression","subtotal":1000}');
  select remaining_credits into n from public.credit_grants where source_id='txn_regression' and revoked_at is not null;
  if n is distinct from 0 then raise exception 'Full refund not revoked'; end if;
  perform public.apply_billing_event('evt_regression_early','adjustment.created',now(),null,null,'{"id":"adj_regression3","transaction_id":"txn_regression_early","subtotal":1500}');
  perform public.apply_billing_event('evt_regression_late','transaction.completed',now(),g || '{"source_id":"txn_regression_early"}');
  select remaining_credits into n from public.credit_grants where source_id='txn_regression_early';
  if n<>0 then raise exception 'Refund-before-payment granted credits'; end if;
  begin
    perform public.apply_billing_event('evt_regression_rollback','transaction.completed',now(),g || '{"credits":-1,"source_id":"txn_bad"}');
    raise exception 'Invalid grant accepted';
  exception when check_violation then null; end;
  if exists(select 1 from public.billing_webhook_events where event_id='evt_regression_rollback') then raise exception 'Failed event claim survived rollback'; end if;
  if has_table_privilege('authenticated','public.billing_orders','INSERT') or has_table_privilege('authenticated','public.credit_grants','UPDATE') then raise exception 'Client may mutate money'; end if;
  if has_function_privilege('authenticated','public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb)','EXECUTE') then raise exception 'Client may grant credits'; end if;
  raise notice 'PASS: order deduplication, consumed-credit replay, partial/full refunds, refund ordering, rollback and permissions';
end $$;
rollback;
