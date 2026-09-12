-- Isolated PostgreSQL regression after the monthly-reset migration.
-- Every fixture is rolled back; no payment provider or application DB is used.
begin;
create function pg_temp.assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %',p_message; end if; end $$;
create function pg_temp.payment(p_user uuid,p_tx text,p_at timestamptz,p_plan text default 'semester',p_version text default 'monthly_v1')
returns jsonb language plpgsql as $$
declare o uuid:=gen_random_uuid(); c integer; m integer;
begin
  c:=case p_plan when 'semester' then 9600 when 'halfyear' then 14400 when 'annual' then 28800 when 'monthly' then 2400 else 1000 end;
  m:=case p_plan when 'semester' then 4 when 'halfyear' then 6 when 'monthly' then 1 else 12 end;
  if p_version='upfront_v2' and p_plan='semester' then c:=14400; end if;
  insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment,transaction_id,entitlement_version)
    values(o,p_user,p_plan,'pri_fixture',c,m,'sandbox',p_tx,p_version);
  return jsonb_build_object('user_id',p_user,'source_type','payment','source_id',p_tx,'plan_code',p_plan,'credits',c,
    'months',m,'entitlement_version',p_version,'order_id',o,'starts_at',p_at,'paid_at',p_at,
    'expires_at',public.credit_utc_months(p_at,m),'paid_subtotal',1000);
end $$;
insert into auth.users(id,email) select ('00000000-0000-4000-8000-0000000001'||n)::uuid,'reset-'||n||'@example.invalid' from generate_series(10,25) n;
do $$
declare
  u uuid:='00000000-0000-4000-8000-000000000110'; old_user uuid:='00000000-0000-4000-8000-000000000111';
  late_user uuid:='00000000-0000-4000-8000-000000000112'; refund_user uuid:='00000000-0000-4000-8000-000000000113';
  pre_refund_user uuid:='00000000-0000-4000-8000-000000000114'; monthly_user uuid:='00000000-0000-4000-8000-000000000115';
  paid timestamptz:=now()-interval '5 days'; g jsonb; g2 jsonb; s record; reserved public.billing_orders;
  o uuid; exp timestamptz; session_a uuid:=gen_random_uuid(); session_b uuid:=gen_random_uuid();
begin
  perform set_config('TimeZone','America/New_York',true);
  perform pg_temp.assert(public.credit_utc_months('2024-01-31T12:34:56Z',1)='2024-02-29T12:34:56Z','UTC leap clamp');
  perform pg_temp.assert(public.credit_utc_months('2024-01-31T12:34:56Z',2)='2024-03-31T12:34:56Z','original anniversary avoids month drift');
  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at) values
    (u,'service_credit','reset_free','service_credit',600,517,paid-interval '10 days',paid+interval '14 days');
  g:=pg_temp.payment(u,'txn_semester',paid);
  perform public.apply_billing_event('evt_semester','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=4 and sum(granted_credits)=9600 and bool_and(granted_credits=2400)
    from public.credit_grants where purchase_transaction_id='txn_semester'),'four semester monthly installments');
  perform pg_temp.assert((select bool_and(starts_at=public.credit_utc_months(paid,installment_index)
    and expires_at=public.credit_utc_months(paid,installment_index+1)) from public.credit_grants where purchase_transaction_id='txn_semester'),'each month expires at next original anniversary');
  perform set_config('request.jwt.claim.sub',u::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=2917 and s.latest_grant_at=paid,'only current installment and valid free balance spendable');
  perform pg_temp.assert(s.next_grant_at=public.credit_utc_months(paid,1) and s.next_grant_credits=2400,'next monthly allocation metadata');
  perform pg_temp.assert(s.scheduled_plan_code='semester' and s.scheduled_ends_at=public.credit_utc_months(paid,4),'paid schedule metadata');
  perform pg_temp.assert((select expires_at=paid+interval '14 days' and remaining_credits=517 from public.credit_grants where source_id='reset_free'),'payment does not extend or reset free balance');
  perform public.apply_billing_event('evt_semester','transaction.completed',now(),g||jsonb_build_object('paid_at',now()));
  perform public.apply_billing_event('evt_semester_duplicate','transaction.completed',now(),g||jsonb_build_object('paid_at',now()));
  perform pg_temp.assert((select count(*)=4 and min(starts_at)=paid from public.credit_grants where purchase_transaction_id='txn_semester'),'replays cannot shift quantity, anchor or expiry');

  -- Exhausting the current month cannot spend next month's allowance.
  insert into public.billing_accounts(user_id,subscription_status) values(u,'canceled');
  update public.credit_grants set remaining_credits=0 where user_id=u and starts_at<=now();
  insert into public.lecture_sessions(id,user_id,status) values(u,u,'recording');
  select * into s from public.consume_lecture_credits(u,0);
  perform pg_temp.assert(not s.allowed and s.remaining_credits=0,'authenticated consumer cannot borrow future credits');
  select * into s from public.consume_lecture_credits_service(u,u,0);
  perform pg_temp.assert(not s.allowed and s.remaining_credits=0,'service consumer cannot borrow future credits');
  begin
    perform public.reserve_billing_order(gen_random_uuid(),u,'halfyear','pri_half',14400,6,'sandbox','monthly_v1');
    raise exception 'FAIL: active spent plan permits overlapping purchase';
  exception when others then if sqlerrm<>'ACTIVE_PLAN' then raise; end if; end;
  g2:=pg_temp.payment(u,'txn_topup',now(),'topup');
  perform public.apply_billing_event('evt_topup','transaction.completed',now(),g2);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=1000 and s.scheduled_ends_at=public.credit_utc_months(paid,4),'topup does not extend paid schedule');
  perform pg_temp.assert((select expires_at=public.credit_utc_months(now(),12) from public.credit_grants where source_id='txn_topup'),'topup retains its independent twelve months');
  perform pg_temp.assert((select expires_at=paid+interval '14 days' from public.credit_grants where source_id='reset_free'),'topup does not extend free credit');
  select * into s from public.consume_lecture_credits(u,0);
  perform pg_temp.assert(s.allowed and s.remaining_credits=999,'canceled account can spend valid standalone topup');

  -- Old order quantities and original billing dates are honored exactly.
  g:=pg_temp.payment(old_user,'txn_upfront',paid,'semester','upfront_v2');
  g:=g||jsonb_build_object('starts_at',paid-interval '3 days','expires_at',paid+interval '22 days');
  perform public.apply_billing_event('evt_upfront','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=1 and sum(remaining_credits)=14400 from public.credit_grants where user_id=old_user),'legacy remains immediately available');
  perform pg_temp.assert((select starts_at=paid-interval '3 days' and expires_at=paid+interval '22 days' and purchase_transaction_id is null
    from public.credit_grants where source_id='txn_upfront'),'legacy validity is neither shortened nor extended');
  perform set_config('request.jwt.claim.sub',old_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=14400 and s.next_grant_at is null and s.scheduled_plan_code is null,'legacy is not converted into new schedule');
  g:=pg_temp.payment(old_user,'txn_calendar','2024-01-31T12:34:56Z');
  perform public.apply_billing_event('evt_calendar','transaction.completed','2024-01-31T12:34:56Z',g);
  perform pg_temp.assert((select array_agg(expires_at order by installment_index)=array[
    '2024-02-29T12:34:56Z'::timestamptz,'2024-03-31T12:34:56Z'::timestamptz,
    '2024-04-30T12:34:56Z'::timestamptz,'2024-05-31T12:34:56Z'::timestamptz]
    from public.credit_grants where purchase_transaction_id='txn_calendar'),'expiry uses original anchor, not clamped start');

  -- Late delivery creates the historical schedule, but expired unused months
  -- stay unavailable: it never accumulates missed allowances into this month.
  paid:=now()-interval '70 days';
  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
    values(late_user,'service_credit','late_free','service_credit',600,600,paid-interval '2 days',paid+interval '10 days');
  g:=pg_temp.payment(late_user,'txn_late_annual',paid,'annual');
  perform public.apply_billing_event('evt_late_annual','transaction.completed',paid,g);
  perform set_config('request.jwt.claim.sub',late_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=2400 and s.next_grant_at=public.credit_utc_months(paid,3),'late payment does not roll expired months forward');
  perform pg_temp.assert((select expires_at=paid+interval '10 days' from public.credit_grants where source_id='late_free'),'late payment cannot revive free credits');
  insert into public.lecture_sessions(id,user_id,status) values(late_user,late_user,'paused');
  select * into s from public.consume_lecture_credits(late_user,0);
  perform pg_temp.assert(s.allowed and s.remaining_credits=2399,'consumer uses current month only after missed months');
  select * into s from public.consume_lecture_credits_service(late_user,late_user,1);
  perform pg_temp.assert(s.allowed and s.remaining_credits=2398,'service consumer excludes expired allocations');
  perform pg_temp.assert((select count(*)=2 and bool_and(g.installment_index=2)
    from public.lecture_credit_usage us join public.credit_grants g on g.id=us.grant_id where us.user_id=late_user),'actual usage targets current installment only');

  -- At an exact boundary, the old allowance is unavailable and the new one
  -- activates. A one-month plan with no new payment simply expires.
  paid:=public.credit_utc_months(now(),-1);
  g:=pg_temp.payment(monthly_user,'txn_expired_month',paid,'monthly');
  perform public.apply_billing_event('evt_expired_month','transaction.completed',paid,g);
  perform set_config('request.jwt.claim.sub',monthly_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=0 and s.next_grant_at is null and s.scheduled_ends_at is null,'monthly has no unpaid continuation at expiry');
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),monthly_user,'halfyear','pri_half',14400,6,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.plan_code='halfyear','expired plan allows repurchase');
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000120','txn_boundary',paid);
  perform public.apply_billing_event('evt_boundary','transaction.completed',paid,g);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000120',true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=2400 and s.latest_grant_at=now(),'exact boundary resets unused credits to new monthly allocation');

  -- Refunds preserve other purchases and shorten the funded schedule.
  paid:=now()-interval '5 days';
  g:=pg_temp.payment(refund_user,'txn_refund_semester',paid);
  perform public.apply_billing_event('evt_refund_semester','transaction.completed',paid,g);
  g2:=pg_temp.payment(refund_user,'txn_refund_other',paid,'topup');
  perform public.apply_billing_event('evt_refund_other','transaction.completed',paid,g2);
  perform public.apply_billing_event('evt_partial','adjustment.created',now(),null,null,'{"id":"adj_part","transaction_id":"txn_refund_semester","subtotal":750}');
  perform set_config('request.jwt.claim.sub',refund_user::text,true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.next_grant_at is null and s.scheduled_ends_at=public.credit_utc_months(paid,1),'75 percent refund removes future months and shortens active period');
  perform pg_temp.assert((select sum(refunded_credits)=7200 and sum(remaining_credits)=2400 from public.credit_grants where purchase_transaction_id='txn_refund_semester'),'proportional refund targets only purchased allocations');
  perform public.apply_billing_event('evt_partial_duplicate','adjustment.updated',now(),null,null,'{"id":"adj_part","transaction_id":"txn_refund_semester","subtotal":750}');
  perform public.apply_billing_event('evt_full','adjustment.updated',now(),null,null,'{"id":"adj_rest","transaction_id":"txn_refund_semester","subtotal":250}');
  perform public.apply_billing_event('evt_refund_replay','transaction.completed',paid,g);
  perform pg_temp.assert((select sum(remaining_credits)=0 and bool_and(revoked_at is not null) from public.credit_grants where purchase_transaction_id='txn_refund_semester'),'full refund and replay cannot revive current/future months');
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.credits=1000 and s.scheduled_plan_code is null,'other topup survives full refund');
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),refund_user,'halfyear','pri_half',14400,6,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.plan_code='halfyear','refunded plan does not block new purchase');

  perform public.apply_billing_event('evt_pre_refund','adjustment.created',now(),null,null,'{"id":"adj_pre","transaction_id":"txn_pre_halfyear","subtotal":1000}');
  g:=pg_temp.payment(pre_refund_user,'txn_pre_halfyear',paid,'halfyear');
  perform public.apply_billing_event('evt_pre_halfyear','transaction.completed',paid,g);
  perform pg_temp.assert((select count(*)=6 and sum(granted_credits)=14400 and sum(remaining_credits)=0 and bool_and(revoked_at is not null)
    from public.credit_grants where purchase_transaction_id='txn_pre_halfyear'),'halfyear is six installments and pre-refund cancels all');

  -- Expired unused rows still store a remaining amount. Refund current funds
  -- first, rather than allowing those expired rows to absorb the adjustment.
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000121','txn_expired_refund',now()-interval '100 days');
  perform public.apply_billing_event('evt_expired_refund_payment','transaction.completed',now(),g);
  perform public.apply_billing_event('evt_expired_refund','adjustment.created',now(),null,null,'{"id":"adj_expired","transaction_id":"txn_expired_refund","subtotal":250}');
  perform pg_temp.assert((select remaining_credits=0 and refunded_credits=2400 from public.credit_grants
    where purchase_transaction_id='txn_expired_refund' and installment_index=3),'refund removes current quota before expired unused months');
  -- If latest allocation was consumed, remove earlier still-available balances
  -- from the same purchase; never spill into another purchase.
  g:=pg_temp.payment(refund_user,'txn_used_last',paid);
  perform public.apply_billing_event('evt_used_last','transaction.completed',paid,g);
  update public.credit_grants set remaining_credits=0 where purchase_transaction_id='txn_used_last' and installment_index=3;
  perform public.apply_billing_event('evt_used_last_refund','adjustment.created',now(),null,null,'{"id":"adj_used_last","transaction_id":"txn_used_last","subtotal":250}');
  perform pg_temp.assert((select sum(remaining_credits)=4800 and sum(refunded_credits)=2400 from public.credit_grants where purchase_transaction_id='txn_used_last'),'consumed final allocation cannot swallow refund');
  perform pg_temp.assert((select remaining_credits=1000 from public.credit_grants where source_id='txn_refund_other'),'refund stays within its purchase');

  -- Once the only surviving month expires, refunded future months cannot
  -- block a new primary plan through the original unshortened schedule.
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000123','txn_shortened',now()-interval '40 days');
  perform public.apply_billing_event('evt_shortened_payment','transaction.completed',now(),g);
  perform public.apply_billing_event('evt_shortened_refund','adjustment.created',now(),null,null,
    '{"id":"adj_shortened","transaction_id":"txn_shortened","subtotal":750}');
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000123',true);
  select * into s from public.get_credit_status();
  perform pg_temp.assert(s.scheduled_ends_at is null and s.credits=0,'expired surviving month is not an active refunded schedule');
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000123','halfyear','pri_half',14400,6,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.plan_code='halfyear','can repurchase after final surviving month expires');

  -- Monthly late capture respects the verified provider cycle end, avoiding
  -- overlap with the next scheduled collection. Missing/past ends fall back.
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000124','txn_late_monthly',paid,'monthly')
    ||jsonb_build_object('expires_at',now()+interval '10 days');
  perform public.apply_billing_event('evt_late_monthly','transaction.completed',now(),g);
  perform pg_temp.assert((select starts_at=paid and expires_at=now()+interval '10 days' from public.credit_grants where source_id='txn_late_monthly'),'Monthly uses verified future billing cycle end');
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000125','txn_monthly_fallback',paid,'monthly')
    ||jsonb_build_object('expires_at',paid-interval '1 day');
  perform public.apply_billing_event('evt_monthly_fallback','transaction.completed',now(),g);
  perform pg_temp.assert((select expires_at=public.credit_utc_months(paid,1) from public.credit_grants where source_id='txn_monthly_fallback'),'Monthly past cycle end falls back to one month');

  -- Refunded portions cannot be restored by undoing a zero-duration lecture.
  g:=pg_temp.payment('00000000-0000-4000-8000-000000000119','txn_abort_refund',paid,'topup');
  perform public.apply_billing_event('evt_abort_payment','transaction.completed',paid,g);
  insert into public.lecture_sessions(id,user_id,status) values
    (session_a,'00000000-0000-4000-8000-000000000119','recording'),(session_b,'00000000-0000-4000-8000-000000000119','recording');
  perform public.consume_lecture_credits_service('00000000-0000-4000-8000-000000000119',session_a,0);
  perform public.consume_lecture_credits_service('00000000-0000-4000-8000-000000000119',session_b,0);
  perform public.apply_billing_event('evt_abort_refund','adjustment.created',now(),null,null,'{"id":"adj_abort","transaction_id":"txn_abort_refund","subtotal":999}');
  update public.lecture_sessions set status='completed' where id=session_a;
  perform pg_temp.assert((select remaining_credits=0 from public.credit_grants where source_id='txn_abort_refund'),'undo cannot resurrect refunded consumed credits');
  update public.lecture_sessions set status='completed' where id=session_b;
  perform pg_temp.assert((select remaining_credits=1 from public.credit_grants where source_id='txn_abort_refund'),'all usage undone restores only retained entitlement');

  o:=gen_random_uuid();
  select * into reserved from public.reserve_billing_order(o,'00000000-0000-4000-8000-000000000116','halfyear','pri_half',14400,6,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.entitlement_version='monthly_v1','halfyear reservation retains version');
  begin update public.billing_orders set credits=1 where id=o; raise exception 'FAIL: order mutation allowed';
  exception when others then if sqlerrm<>'IMMUTABLE_ORDER_ENTITLEMENT' then raise; end if; end;
  begin perform public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000117','halfyear','pri_fixture',12000,6,'sandbox','monthly_v1');
    raise exception 'FAIL: wrong new quantity accepted';
  exception when others then if sqlerrm<>'INVALID_ENTITLEMENT' then raise; end if; end;
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000118','semester','pri_old',14400,4,'sandbox');
  perform pg_temp.assert(reserved.entitlement_version='upfront_v2' and reserved.credits=14400,'old RPC remains compatible');
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000118','semester','pri_new',9600,4,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.entitlement_version='upfront_v2' and reserved.credits=14400,'pending old checkout stays unchanged');
  insert into public.billing_accounts(user_id,subscription_status) values('00000000-0000-4000-8000-000000000122','active');
  begin perform public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000122','halfyear','pri_half',14400,6,'sandbox','monthly_v1');
    raise exception 'FAIL: legacy monthly account allows overlapping primary plan';
  exception when others then if sqlerrm<>'ACTIVE_SUBSCRIPTION' then raise; end if; end;
  select * into reserved from public.reserve_billing_order(gen_random_uuid(),'00000000-0000-4000-8000-000000000122','topup','pri_top',1000,12,'sandbox','monthly_v1');
  perform pg_temp.assert(reserved.plan_code='topup','active subscription allows standalone topup');
  perform pg_temp.assert(not has_function_privilege('anon','public.get_credit_status()','EXECUTE')
    and not has_function_privilege('authenticated','public.consume_lecture_credits_service(uuid,uuid,integer)','EXECUTE')
    and not has_table_privilege('authenticated','public.credit_grants','UPDATE'),'no unauthorized mutations');
  perform pg_temp.assert(not exists(select 1 from information_schema.columns where table_schema='public' and table_name='credit_grants' and column_name='renewal_paid_at'),'canceled renewal migration is absent');
  raise notice 'PASS: monthly resets, UTC boundaries, halfyear, no rollover/extensions, legacy dates, active-plan guards, refunds, future isolation, cancellation, permissions';
end $$;
rollback;
