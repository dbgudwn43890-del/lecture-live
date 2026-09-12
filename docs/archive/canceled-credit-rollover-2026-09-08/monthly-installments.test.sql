-- Run against an isolated Postgres fixture after all billing migrations.
-- All test data and mutations are rolled back.
begin;
create function pg_temp.assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %',p_message; end if; end $$;
create function pg_temp.monthly_payment(p_user uuid,p_tx text,p_at timestamptz,p_plan text default 'semester',p_version text default 'monthly_v1')
returns jsonb language plpgsql as $$
declare o uuid:=gen_random_uuid(); c integer; m integer;
begin
  c:=case p_plan when 'semester' then 9600 when 'annual' then 28800 when 'monthly' then 2400 else 1000 end;
  m:=case p_plan when 'semester' then 4 when 'monthly' then 1 else 12 end;
  if p_version='upfront_v2' and p_plan='semester' then c:=14400; end if;
  insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment,transaction_id,entitlement_version)
    values(o,p_user,p_plan,'pri_fixture',c,m,'sandbox',p_tx,p_version);
  return jsonb_build_object('user_id',p_user,'source_type','payment','source_id',p_tx,'plan_code',p_plan,'credits',c,
    'months',m,'entitlement_version',p_version,'order_id',o,'starts_at',p_at,'paid_at',p_at,'expires_at',p_at+interval '12 months','paid_subtotal',1000);
end $$;
insert into auth.users(id,email) select ('00000000-0000-4000-8000-0000000001'||n)::uuid,'installment-'||n||'@example.invalid' from generate_series(10,19) n;
do $$
declare
  u uuid:='00000000-0000-4000-8000-000000000110';
  old_user uuid:='00000000-0000-4000-8000-000000000111';
  late_user uuid:='00000000-0000-4000-8000-000000000112';
  refund_user uuid:='00000000-0000-4000-8000-000000000113';
  pre_refund_user uuid:='00000000-0000-4000-8000-000000000114';
  renewal_user uuid:='00000000-0000-4000-8000-000000000115';
  v_now timestamptz:=now(); paid timestamptz:=now()-interval '5 days';
  g jsonb; g2 jsonb; s record; reserved public.billing_orders; o uuid; exp timestamptz; session_a uuid:=gen_random_uuid(); session_b uuid:=gen_random_uuid();
begin
  perform set_config('TimeZone','America/New_York',true);
  perform pg_temp.assert(public.credit_utc_months('2024-01-31T12:34:56Z',1)='2024-02-29T12:34:56Z','Jan 31 leap clamp');
  perform pg_temp.assert(public.credit_utc_months('2024-01-31T12:34:56Z',2)='2024-03-31T12:34:56Z','no February drift');
  perform pg_temp.assert(public.credit_utc_months('2024-02-29T12:34:56Z',12)='2025-02-28T12:34:56Z','leap year twelve-month expiry');

  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
    values(u,'service_credit','monthly_free','service_credit',600,517,paid-interval '10 days',paid+interval '14 days');
  g:=pg_temp.monthly_payment(u,'txn_semester',paid);
  perform public.apply_billing_event('evt_semester','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=4 and sum(granted_credits)=9600 from public.credit_grants where purchase_transaction_id='txn_semester'),'four equal semester installments');
  perform pg_temp.assert((select bool_and(granted_credits=2400) from public.credit_grants where purchase_transaction_id='txn_semester'),'2400 per semester month');
  perform set_config('request.jwt.claim.sub',u::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=2917,'future installments are not spendable');
  perform pg_temp.assert(s.next_grant_at=public.credit_utc_months(paid,1) and s.next_grant_credits=2400,'next monthly grant metadata');
  perform pg_temp.assert(s.scheduled_plan_code='semester' and s.scheduled_ends_at=public.credit_utc_months(paid,4),'prepaid period metadata');
  perform pg_temp.assert(s.latest_grant_at=paid,'future installments do not change latest grant time');
  perform pg_temp.assert((select expires_at=public.credit_utc_months(paid,12) and remaining_credits=517 from public.credit_grants where source_id='monthly_free'),'purchase renews remaining free balance');
  perform public.apply_billing_event('evt_semester','transaction.completed',now(),g||jsonb_build_object('paid_at',now()));
  perform public.apply_billing_event('evt_semester_duplicate','transaction.completed',now(),g||jsonb_build_object('paid_at',now()));
  perform pg_temp.assert((select count(*)=4 and min(starts_at)=paid from public.credit_grants where purchase_transaction_id='txn_semester'),'duplicates cannot shift or duplicate schedule');

  insert into public.billing_accounts(user_id,subscription_status) values(u,'canceled');
  update public.credit_grants set remaining_credits=0 where user_id=u and starts_at<=now();
  insert into public.lecture_sessions(id,user_id,status) values(u,u,'recording');
  select * into s from public.consume_lecture_credits(u,0);
  perform pg_temp.assert(s.allowed=false and s.remaining_credits=0,'consumer cannot borrow from future grants');
  select * into s from public.consume_lecture_credits_service(u,u,0);
  perform pg_temp.assert(s.allowed=false and s.remaining_credits=0,'service consumer cannot borrow from future grants');
  g2:=pg_temp.monthly_payment(u,'txn_topup',now(),'topup');
  perform public.apply_billing_event('evt_topup','transaction.completed',now(),g2);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=1000 and s.scheduled_ends_at=public.credit_utc_months(paid,4) and s.next_grant_at=public.credit_utc_months(paid,1),'topup is immediate and cannot extend prepaid period');
  select * into s from public.consume_lecture_credits(u,0);
  perform pg_temp.assert(s.allowed and s.remaining_credits=999,'canceled account may use valid credits');

  g:=pg_temp.monthly_payment(old_user,'txn_upfront',paid,'semester','upfront_v2');
  perform public.apply_billing_event('evt_upfront','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=1 and sum(remaining_credits)=14400 from public.credit_grants where user_id=old_user),'legacy quantities remain immediate');
  perform set_config('request.jwt.claim.sub',old_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=14400 and s.next_grant_at is null and s.scheduled_plan_code is null,'legacy order is not converted to schedule');

  g:=pg_temp.monthly_payment(old_user,'txn_calendar','2024-01-31T12:34:56Z');
  perform public.apply_billing_event('evt_calendar','transaction.completed','2024-01-31T12:34:56Z',g);
  perform pg_temp.assert((select array_agg(starts_at order by installment_index)=array[
    '2024-01-31T12:34:56Z'::timestamptz,'2024-02-29T12:34:56Z'::timestamptz,
    '2024-03-31T12:34:56Z'::timestamptz,'2024-04-30T12:34:56Z'::timestamptz]
    from public.credit_grants where purchase_transaction_id='txn_calendar'),'generated installments retain original UTC anniversary');

  -- A delayed event must release every due installment exactly once and replay
  -- their original anniversary renewals, preserving an expired-before-pay gap.
  paid:=now()-interval '70 days';
  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at) values
    (late_user,'service_credit','late_free','service_credit',600,600,paid-interval '2 days',paid+interval '10 days'),
    (late_user,'service_credit','late_expired','service_credit',600,600,paid-interval '2 days',paid-interval '1 second');
  g:=pg_temp.monthly_payment(late_user,'txn_late_annual',paid,'annual');
  perform public.apply_billing_event('evt_late_annual','transaction.completed',paid,g);
  perform set_config('request.jwt.claim.sub',late_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=7800 and s.next_grant_at=public.credit_utc_months(paid,3),'missed annual months catch up, future months excluded');
  exp:=public.credit_utc_months(public.credit_utc_months(paid,2),12);
  perform pg_temp.assert((select expires_at=exp from public.credit_grants where source_id='late_free'),'monthly issuances renew older/free balances');
  perform pg_temp.assert((select expires_at=paid-interval '1 second' from public.credit_grants where source_id='late_expired'),'expired balance not revived');
  -- Simulate an owner whose preceding access happened before the next due date.
  update public.credit_grants set expires_at=paid+interval '10 days' where source_id='late_free';
  select * into s from public.get_credit_status();
  perform pg_temp.assert((select expires_at=exp from public.credit_grants where source_id='late_free'),'status applies due renewals');
  insert into public.lecture_sessions(id,user_id,status) values(late_user,late_user,'paused');
  update public.credit_grants set expires_at=paid+interval '10 days' where source_id='late_free';
  select * into s from public.consume_lecture_credits(late_user,0);
  perform pg_temp.assert(s.allowed and (select expires_at=exp from public.credit_grants where source_id='late_free'),'cookie consumer applies due renewals');
  update public.credit_grants set expires_at=paid+interval '10 days' where source_id='late_free';
  select * into s from public.consume_lecture_credits_service(late_user,late_user,1);
  perform pg_temp.assert(s.allowed and (select expires_at=exp from public.credit_grants where source_id='late_free'),'service consumer applies due renewals');

  update public.credit_grants set expires_at=paid+interval '10 days' where source_id='late_free';
  perform pg_temp.assert(public.can_ask_with_credits(late_user,1),'question gate permits due credit');
  perform pg_temp.assert((select expires_at=exp from public.credit_grants where source_id='late_free'),'question gate applies due renewals');

  -- Refunds remove the purchased total proportionally, starting at the last
  -- installment. Other purchases and the already renewed free balance survive.
  paid:=now()-interval '5 days';
  g:=pg_temp.monthly_payment(refund_user,'txn_refund_semester',paid);
  perform public.apply_billing_event('evt_refund_semester','transaction.completed',paid,g);
  g2:=pg_temp.monthly_payment(refund_user,'txn_refund_other',paid,'topup');
  perform public.apply_billing_event('evt_refund_other','transaction.completed',paid,g2);
  perform public.apply_billing_event('evt_partial','adjustment.created',now(),null,null,
    '{"id":"adj_part","transaction_id":"txn_refund_semester","subtotal":250}');
  perform pg_temp.assert((select sum(refunded_credits)=2400 and sum(remaining_credits)=7200 from public.credit_grants where purchase_transaction_id='txn_refund_semester'),'partial proportional total across installments');
  perform pg_temp.assert((select remaining_credits=0 and revoked_at is not null from public.credit_grants where purchase_transaction_id='txn_refund_semester' and installment_index=3),'latest future installment revoked');
  perform public.apply_billing_event('evt_partial_duplicate','adjustment.updated',now(),null,null,
    '{"id":"adj_part","transaction_id":"txn_refund_semester","subtotal":250}');
  perform public.apply_billing_event('evt_full','adjustment.updated',now(),null,null,
    '{"id":"adj_rest","transaction_id":"txn_refund_semester","subtotal":750}');
  perform pg_temp.assert((select sum(refunded_credits)=9600 and sum(remaining_credits)=0 and bool_and(revoked_at is not null) from public.credit_grants where purchase_transaction_id='txn_refund_semester'),'full refund stops every current/future installment');
  perform pg_temp.assert((select remaining_credits=1000 from public.credit_grants where source_id='txn_refund_other'),'refund does not touch another purchase');
  perform set_config('request.jwt.claim.sub',refund_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=1000 and s.next_grant_at is null and s.scheduled_plan_code is null,'refunded future grants absent from status');
  perform public.apply_billing_event('evt_refund_replay','transaction.completed',paid,g);
  perform pg_temp.assert((select sum(remaining_credits)=0 from public.credit_grants where purchase_transaction_id='txn_refund_semester'),'completed replay cannot restore refund');

  perform public.apply_billing_event('evt_pre_full','adjustment.created',now(),null,null,
    '{"id":"adj_pre","transaction_id":"txn_pre_annual","subtotal":1000}');
  g:=pg_temp.monthly_payment(pre_refund_user,'txn_pre_annual',paid,'annual');
  perform public.apply_billing_event('evt_pre_annual','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=12 and sum(remaining_credits)=0 and bool_and(revoked_at is not null) from public.credit_grants where purchase_transaction_id='txn_pre_annual'),'refund arriving before completion cancels future allocations');

  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
    values(pre_refund_user,'service_credit','pre_partial_free','service_credit',600,600,paid-interval '1 day',paid+interval '10 days');
  perform public.apply_billing_event('evt_pre_partial','adjustment.created',now(),null,null,
    '{"id":"adj_pre_part","transaction_id":"txn_pre_partial","subtotal":250}');
  g:=pg_temp.monthly_payment(pre_refund_user,'txn_pre_partial',paid);
  perform public.apply_billing_event('evt_pre_partial_payment','transaction.completed',paid,g);
  perform pg_temp.assert((select expires_at=public.credit_utc_months(paid,12) from public.credit_grants where source_id='pre_partial_free'),'partial refund before payment preserves renewal from surviving installment');
  perform pg_temp.assert((select sum(remaining_credits)=7200 from public.credit_grants where purchase_transaction_id='txn_pre_partial'),'partial pre-refund keeps correct total');

  g:=pg_temp.monthly_payment(renewal_user,'txn_monthly_first',paid,'monthly');
  perform public.apply_billing_event('evt_monthly_first','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=1 from public.credit_grants where user_id=renewal_user),'monthly has no unpaid future installments');
  perform public.apply_billing_event('evt_monthly_renewal','transaction.completed',now(),g||jsonb_build_object('source_id','txn_monthly_second','paid_at',now()));
  perform pg_temp.assert((select count(*)=2 and sum(remaining_credits)=4800 from public.credit_grants where user_id=renewal_user),'new verified payment provides next monthly amount');

  -- Later installments can be consumed before earlier ones when their
  -- renewed expiries tie. A refund must still remove the correct available
  -- amount from this purchase, even if its final installment is exhausted.
  g:=pg_temp.monthly_payment(refund_user,'txn_used_last',now()-interval '100 days');
  perform public.apply_billing_event('evt_used_last','transaction.completed',now(),g);
  update public.credit_grants set remaining_credits=0
    where purchase_transaction_id='txn_used_last' and installment_index=3;
  perform public.apply_billing_event('evt_used_last_refund','adjustment.created',now(),null,null,
    '{"id":"adj_used_last","transaction_id":"txn_used_last","subtotal":250}');
  perform pg_temp.assert((select sum(remaining_credits)=4800 and sum(refunded_credits)=2400
    from public.credit_grants where purchase_transaction_id='txn_used_last'),'refund removes available purchase balance even when final installment spent');
  perform pg_temp.assert((select remaining_credits=1000 from public.credit_grants where source_id='txn_refund_other'),'refund spill stays within affected purchase');

  -- Undoing an aborted lecture must not resurrect refunded, already-consumed
  -- credits. Two used minutes plus a 99.9% refund leave a one-credit purchase.
  g:=pg_temp.monthly_payment('00000000-0000-4000-8000-000000000119','txn_abort_refund',paid,'topup');
  perform public.apply_billing_event('evt_abort_payment','transaction.completed',paid,g);
  insert into public.lecture_sessions(id,user_id,status) values
    (session_a,'00000000-0000-4000-8000-000000000119','recording'),
    (session_b,'00000000-0000-4000-8000-000000000119','recording');
  perform public.consume_lecture_credits_service('00000000-0000-4000-8000-000000000119',session_a,0);
  perform public.consume_lecture_credits_service('00000000-0000-4000-8000-000000000119',session_b,0);
  perform public.apply_billing_event('evt_abort_refund','adjustment.created',now(),null,null,
    '{"id":"adj_abort","transaction_id":"txn_abort_refund","subtotal":999}');
  update public.lecture_sessions set status='completed' where id=session_a;
  perform pg_temp.assert((select remaining_credits=0 from public.credit_grants where source_id='txn_abort_refund'),'aborted session cannot restore refunded consumed credits');
  update public.lecture_sessions set status='completed' where id=session_b;
  perform pg_temp.assert((select remaining_credits=1 from public.credit_grants where source_id='txn_abort_refund'),'all usage undone restores only net paid entitlement');

  o:=gen_random_uuid();
  select * into reserved from public.reserve_billing_order(o,'00000000-0000-4000-8000-000000000116','annual','pri_fixture',28800,12,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.entitlement_version='monthly_v1','reservation stores new policy');
  begin
    update public.billing_orders set credits=1 where id=o;
    raise exception 'FAIL: order entitlement mutation allowed';
  exception when others then if sqlerrm<>'IMMUTABLE_ORDER_ENTITLEMENT' then raise; end if; end;
  begin
    perform public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000117','annual','pri_fixture',24000,12,'sandbox','monthly_v1');
    raise exception 'FAIL: wrong new entitlement accepted';
  exception when others then if sqlerrm<>'INVALID_ENTITLEMENT' then raise; end if; end;
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000118','semester','pri_old',14400,4,'sandbox');
  perform pg_temp.assert(reserved.entitlement_version='upfront_v2' and reserved.credits=14400,'old RPC call stays compatible');
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000118','semester','pri_new',9600,4,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.entitlement_version='upfront_v2' and reserved.credits=14400,'pending old order remains unchanged');
  perform pg_temp.assert(not has_function_privilege('authenticated','public.refresh_credit_installments(uuid)','EXECUTE')
    and not has_function_privilege('anon','public.get_credit_status()','EXECUTE')
    and not has_function_privilege('authenticated','public.consume_lecture_credits_service(uuid,uuid,integer)','EXECUTE')
    and not has_table_privilege('authenticated','public.credit_grants','UPDATE'),'no balance mutation or ownership privilege expansion');
  raise notice 'PASS: monthly installments, future isolation, UTC anniversaries, missed issuance, cancellation, topup, legacy orders, cumulative refunds, idempotency, immutable checkout, permissions';
end $$;
rollback;
