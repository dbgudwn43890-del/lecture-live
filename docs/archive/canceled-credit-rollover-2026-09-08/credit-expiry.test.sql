-- Run after migrations with psql -v ON_ERROR_STOP=1 -f this-file.
-- Fixtures and helpers are rolled back; no external payment calls are made.
begin;
create function pg_temp.check_expiry(p_source text,p_expected timestamptz) returns void language plpgsql as $$
begin
  if (select expires_at from public.credit_grants where source_id=p_source) is distinct from p_expected then
    raise exception 'Unexpected expiry for % (expected %)',p_source,p_expected;
  end if;
end $$;
create function pg_temp.payment(p_user uuid,p_tx text,p_paid timestamptz,p_plan text default 'topup') returns jsonb language sql as $$
  select jsonb_build_object('user_id',p_user,'source_type','payment','source_id',p_tx,'plan_code',p_plan,
    'credits',1000,'starts_at',p_paid,'paid_at',p_paid,'expires_at',p_paid+interval '1 month','paid_subtotal',1000)
$$;
create function pg_temp.starter(p_user uuid,p_source text,p_start timestamptz,p_expiry timestamptz,p_remaining integer default 600,p_revoked timestamptz default null) returns void language sql as $$
  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,revoked_at)
  values(p_user,'service_credit',p_source,'service_credit',600,p_remaining,p_start,p_expiry,p_revoked)
$$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000071','credit-renewal-1@example.invalid'),
 ('00000000-0000-4000-8000-000000000072','credit-renewal-2@example.invalid'),
 ('00000000-0000-4000-8000-000000000073','credit-renewal-3@example.invalid'),
 ('00000000-0000-4000-8000-000000000074','credit-renewal-4@example.invalid');
do $$
declare
  u uuid:='00000000-0000-4000-8000-000000000071';
  other_user uuid:='00000000-0000-4000-8000-000000000072';
  refund_user uuid:='00000000-0000-4000-8000-000000000073';
  later_refund_user uuid:='00000000-0000-4000-8000-000000000074';
  a timestamptz:=now()-interval '90 days'; b timestamptz:=now()-interval '30 days';
  original_expiry timestamptz:=now()-interval '60 days';
  g jsonb; n integer; result record;
begin
  perform pg_temp.starter(u,'renew_starter',a-interval '10 days',original_expiry,517);
  perform pg_temp.starter(u,'renew_expired',a-interval '10 days',a-interval '1 second');
  perform pg_temp.starter(u,'renew_boundary',a-interval '10 days',a);
  perform pg_temp.starter(u,'renew_revoked',a-interval '10 days',a+interval '10 days',600,a-interval '1 day');
  perform pg_temp.starter(u,'renew_empty',a-interval '10 days',a+interval '10 days',0);
  perform pg_temp.starter(u,'renew_longer',a-interval '10 days',now()+interval '2 years');
  perform pg_temp.starter(u,'renew_future',b+interval '1 day',now()+interval '2 years');
  perform pg_temp.starter(other_user,'renew_other_owner',a-interval '10 days',original_expiry);

  -- Later payment first cannot jump over the starter's expiry gap.
  perform public.apply_billing_event('evt_renew_b','transaction.completed',b,pg_temp.payment(u,'txn_renew_b',b,'monthly'));
  perform pg_temp.check_expiry('renew_starter',original_expiry);
  -- Late delivery of a payment made before expiry repairs the continuous chain.
  perform public.apply_billing_event('evt_renew_a','transaction.completed',a,pg_temp.payment(u,'txn_renew_a',a));
  perform pg_temp.check_expiry('renew_starter',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  perform pg_temp.check_expiry('txn_renew_a',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  perform pg_temp.check_expiry('txn_renew_b',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  perform pg_temp.check_expiry('renew_expired',a-interval '1 second');
  perform pg_temp.check_expiry('renew_boundary',a);
  perform pg_temp.check_expiry('renew_revoked',a+interval '10 days');
  perform pg_temp.check_expiry('renew_empty',a+interval '10 days');
  perform pg_temp.check_expiry('renew_longer',now()+interval '2 years');
  perform pg_temp.check_expiry('renew_future',now()+interval '2 years');
  perform pg_temp.check_expiry('renew_other_owner',original_expiry);
  if (select remaining_credits from public.credit_grants where source_id='renew_starter')<>517 then raise exception 'Renewal reset usage'; end if;

  -- Replays cannot use a changed timestamp to extend an already granted purchase.
  update public.credit_grants set remaining_credits=750 where source_id='txn_renew_a';
  g:=pg_temp.payment(u,'txn_renew_a',now());
  perform public.apply_billing_event('evt_renew_a','transaction.completed',now(),g);
  perform public.apply_billing_event('evt_renew_duplicate','transaction.completed',now(),g);
  perform pg_temp.check_expiry('txn_renew_a',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  if (select remaining_credits from public.credit_grants where source_id='txn_renew_a')<>750 then raise exception 'Replay reset usage'; end if;

  -- Repeated timely payments extend all eligible balances again, including free.
  perform public.apply_billing_event('evt_renew_c','transaction.completed',now(),pg_temp.payment(u,'txn_renew_c',now(),'annual'));
  perform pg_temp.check_expiry('renew_starter',((now() at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  perform pg_temp.check_expiry('txn_renew_a',((now() at time zone 'UTC')+interval '12 months') at time zone 'UTC');

  -- A refund recorded before completion suppresses renewal, even if partial.
  perform pg_temp.starter(refund_user,'renew_refund_starter',a-interval '1 day',now()+interval '10 days');
  perform public.apply_billing_event('evt_renew_full_refund','adjustment.created',a,null,null,
    '{"id":"adj_renew_full","transaction_id":"txn_renew_full","subtotal":1000}');
  perform public.apply_billing_event('evt_renew_full','transaction.completed',a,pg_temp.payment(refund_user,'txn_renew_full',a));
  perform pg_temp.check_expiry('renew_refund_starter',now()+interval '10 days');
  if not exists(select 1 from public.credit_grants where source_id='txn_renew_full' and remaining_credits=0 and revoked_at is not null and renewal_paid_at is null) then raise exception 'Refund-before-payment granted renewal'; end if;
  perform public.apply_billing_event('evt_renew_partial_refund','adjustment.created',a,null,null,
    '{"id":"adj_renew_partial","transaction_id":"txn_renew_partial","subtotal":250}');
  perform public.apply_billing_event('evt_renew_partial','transaction.completed',a,pg_temp.payment(refund_user,'txn_renew_partial',a));
  perform pg_temp.check_expiry('renew_refund_starter',now()+interval '10 days');
  if not exists(select 1 from public.credit_grants where source_id='txn_renew_partial' and remaining_credits=750 and renewal_paid_at is null) then raise exception 'Partial refund handling changed'; end if;

  -- A later refund keeps already-extended unrelated balances, but cannot supply
  -- a renewal to a newly arriving earlier purchase during chronological replay.
  perform pg_temp.starter(later_refund_user,'renew_later_refund_starter',a-interval '1 day',now()+interval '10 days');
  perform public.apply_billing_event('evt_renew_later','transaction.completed',b,pg_temp.payment(later_refund_user,'txn_renew_later',b));
  perform public.apply_billing_event('evt_renew_later_refund','adjustment.created',now(),null,null,
    '{"id":"adj_renew_later","transaction_id":"txn_renew_later","subtotal":1000}');
  perform pg_temp.check_expiry('renew_later_refund_starter',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');
  perform public.apply_billing_event('evt_renew_earlier','transaction.completed',a,pg_temp.payment(later_refund_user,'txn_renew_earlier',a));
  perform pg_temp.check_expiry('txn_renew_earlier',((a at time zone 'UTC')+interval '12 months') at time zone 'UTC');

  -- Zero-value/tax-only adjustments do not suppress a real payment's renewal.
  perform public.apply_billing_event('evt_renew_tax','adjustment.created',b,null,null,
    '{"id":"adj_renew_tax","transaction_id":"txn_renew_tax","subtotal":0}');
  perform public.apply_billing_event('evt_renew_tax_payment','transaction.completed',b,pg_temp.payment(refund_user,'txn_renew_tax',b));
  perform pg_temp.check_expiry('renew_refund_starter',((b at time zone 'UTC')+interval '12 months') at time zone 'UTC');

  -- UTC calendar-year arithmetic clamps leap day even under a DST timezone.
  perform set_config('TimeZone','America/New_York',true);
  perform public.apply_billing_event('evt_renew_leap','transaction.completed','2024-02-29T12:00:00Z',pg_temp.payment(other_user,'txn_renew_leap','2024-02-29T12:00:00Z'));
  perform pg_temp.check_expiry('txn_renew_leap','2025-02-28T12:00:00Z');

  -- Existing paid credits remain usable after cancellation; no membership gate.
  insert into public.billing_accounts(user_id,subscription_status) values(u,'canceled');
  perform set_config('request.jwt.claim.sub',u::text,true);
  insert into public.lecture_sessions(id,user_id,status) values('00000000-0000-4000-8000-000000000071',u,'recording');
  select * into result from public.consume_lecture_credits('00000000-0000-4000-8000-000000000071',0);
  if result.allowed is not true then raise exception 'Cancellation blocked valid credits'; end if;

  -- Failed atomic writes cannot leave an event claim or renewal behind.
  begin
    perform public.apply_billing_event('evt_renew_bad','transaction.completed',now(),pg_temp.payment(u,'txn_renew_bad',now())||'{"credits":-1}');
    raise exception 'Invalid credit grant accepted';
  exception when check_violation then null; end;
  if exists(select 1 from public.billing_webhook_events where event_id='evt_renew_bad') then raise exception 'Rollback left an event claim'; end if;
  if has_table_privilege('authenticated','public.credit_grants','UPDATE')
    or has_function_privilege('authenticated','public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb)','EXECUTE') then raise exception 'Billing permissions changed'; end if;
  raise notice 'PASS: renewal, expiry gaps, reversed delivery, usage preservation, duplicates, refunds, ownership, UTC, cancellation and permissions';
end $$;
rollback;
