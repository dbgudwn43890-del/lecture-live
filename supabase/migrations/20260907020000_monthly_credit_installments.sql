-- New purchases receive monthly installments without renewing other balances.
-- Existing orders/grants retain their original quantities and validity. This
-- migration starts from the deployed billing schema, with no rollover migration.
alter table public.billing_orders drop constraint billing_orders_plan_code_check;
alter table public.billing_orders add constraint billing_orders_plan_code_check
  check (plan_code in ('monthly','semester','halfyear','annual','topup'));
alter table public.credit_grants drop constraint credit_grants_plan_code_check;
alter table public.credit_grants add constraint credit_grants_plan_code_check
  check (plan_code in ('trial','monthly','term','semester','halfyear','annual','topup','service_credit'));
alter table public.billing_orders add column entitlement_version text not null default 'upfront_v2'
  check (entitlement_version in ('upfront_v2','monthly_v1'));
alter table public.credit_grants
  add column purchase_transaction_id text,
  add column installment_index integer,
  add column installment_count integer,
  add constraint credit_grants_installment_check check (
    (purchase_transaction_id is null and installment_index is null and installment_count is null)
    or (purchase_transaction_id is not null and source_type='payment' and installment_count between 1 and 12
      and installment_index>=0 and installment_index<installment_count));
create unique index credit_grants_purchase_installment_idx
  on public.credit_grants(purchase_transaction_id,installment_index) where purchase_transaction_id is not null;

-- Calendar arithmetic always starts from the original UTC anniversary: Jan 31
-- becomes Feb 28/29, then Mar 31; session timezone never affects an installment.
create function public.credit_utc_months(p_at timestamptz,p_months integer)
returns timestamptz language sql immutable strict set search_path='' as $$
  select ((p_at at time zone 'UTC')+make_interval(months=>p_months)) at time zone 'UTC'
$$;
revoke all on function public.credit_utc_months(timestamptz,integer) from public,anon,authenticated;

create function public.protect_billing_order_entitlement() returns trigger
language plpgsql set search_path='' as $$
begin
  if row(new.user_id,new.plan_code,new.price_id,new.credits,new.months,new.environment,new.entitlement_version)
    is distinct from row(old.user_id,old.plan_code,old.price_id,old.credits,old.months,old.environment,old.entitlement_version)
    or (old.transaction_id is not null and new.transaction_id is distinct from old.transaction_id) then
    raise exception 'IMMUTABLE_ORDER_ENTITLEMENT';
  end if;
  return new;
end $$;
create trigger protect_billing_order_entitlement before update on public.billing_orders
  for each row execute function public.protect_billing_order_entitlement();
revoke all on function public.protect_billing_order_entitlement() from public,anon,authenticated;

drop function public.reserve_billing_order(uuid,uuid,text,text,integer,integer,text);
create function public.reserve_billing_order(
  p_id uuid,p_user_id uuid,p_plan text,p_price_id text,p_credits integer,p_months integer,p_environment text,
  p_entitlement_version text default 'upfront_v2'
) returns setof public.billing_orders language plpgsql security definer set search_path='' as $$
declare v_order public.billing_orders;
begin
  if p_entitlement_version is null or p_entitlement_version not in ('upfront_v2','monthly_v1') then
    raise exception 'INVALID_ENTITLEMENT_VERSION';
  end if;
  if p_entitlement_version='monthly_v1' and not coalesce(
    (p_plan='monthly' and p_credits=2400 and p_months=1)
    or (p_plan='semester' and p_credits=9600 and p_months=4)
    or (p_plan='halfyear' and p_credits=14400 and p_months=6)
    or (p_plan='annual' and p_credits=28800 and p_months=12)
    or (p_plan='topup' and p_credits=1000 and p_months=12),false) then
    raise exception 'INVALID_ENTITLEMENT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  if p_plan<>'topup' and exists(select 1 from public.billing_accounts where user_id=p_user_id
    and subscription_status in ('active','trialing','paused','past_due')) then raise exception 'ACTIVE_SUBSCRIPTION'; end if;
  if p_entitlement_version='monthly_v1' and p_plan<>'topup' and exists(
    select 1 from public.credit_grants g where g.user_id=p_user_id and g.purchase_transaction_id is not null
      and g.plan_code in ('monthly','semester','halfyear','annual') and g.expires_at>now()
      and g.granted_credits>g.refunded_credits and g.revoked_at is null
  ) then raise exception 'ACTIVE_PLAN'; end if;
  -- Return any pending earlier checkout unchanged; callers can surface its
  -- original terms instead of creating a second charge during a catalog switch.
  select * into v_order from public.billing_orders where user_id=p_user_id
    and plan_code=p_plan and environment=p_environment and failed_at is null
    and completed_at is null and created_at>now()-interval '24 hours'
    order by created_at desc limit 1;
  if found then return next v_order; return; end if;
  insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment,entitlement_version)
    values(p_id,p_user_id,p_plan,p_price_id,p_credits,p_months,p_environment,p_entitlement_version) returning * into v_order;
  return next v_order;
end $$;
revoke all on function public.reserve_billing_order(uuid,uuid,text,text,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.reserve_billing_order(uuid,uuid,text,text,integer,integer,text,text) to service_role;

create or replace function public.apply_billing_event(
  p_event_id text,p_event_type text,p_occurred_at timestamptz,
  p_grant jsonb default null,p_account jsonb default null,p_adjustment jsonb default null
) returns void language plpgsql security definer set search_path='' as $$
declare
  v_tx text; v_user_id uuid; v_paid_at timestamptz; v_version text; v_count integer:=1;
  v_order public.billing_orders; v_first public.credit_grants; v_row public.credit_grants;
  v_refund bigint:=0; v_total integer; v_previous integer; v_target integer; v_this integer; v_pass integer; v_inserted_id uuid;
  v_start timestamptz; v_index integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('event:'||p_event_id,0));
  if exists(select 1 from public.billing_webhook_events where event_id=p_event_id) then return; end if;
  v_tx:=coalesce(p_adjustment->>'transaction_id',case when p_grant->>'source_type'='payment' then p_grant->>'source_id' end);
  if v_tx is not null then perform pg_advisory_xact_lock(hashtextextended('payment:'||v_tx,0)); end if;
  v_user_id:=coalesce((p_grant->>'user_id')::uuid,(p_account->>'user_id')::uuid,
    (select user_id from public.credit_grants where source_type='payment' and source_id=v_tx));
  if v_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||v_user_id::text,0));
  end if;
  if p_grant->>'source_type'='payment' then
    if p_event_type<>'transaction.completed' then raise exception 'INVALID_PAYMENT_EVENT'; end if;
    v_paid_at:=coalesce((p_grant->>'paid_at')::timestamptz,p_occurred_at);
    if v_paid_at>p_occurred_at or v_paid_at>now() then raise exception 'INVALID_PAYMENT_DATE'; end if;
    v_version:=coalesce(p_grant->>'entitlement_version','upfront_v2');
    if v_version not in ('upfront_v2','monthly_v1') then raise exception 'INVALID_ENTITLEMENT_VERSION'; end if;
    -- Renewals may refer to the initial order; the signed webhook handler verifies
    -- the Paddle subscription/customer binding before sending this order id.
    select * into v_order from public.billing_orders where id=(p_grant->>'order_id')::uuid;
    if found and (v_order.user_id<>v_user_id or v_order.entitlement_version<>v_version
      or v_order.plan_code<>p_grant->>'plan_code' or v_order.credits<>(p_grant->>'credits')::integer
      or v_order.months<>(p_grant->>'months')::integer) then raise exception 'ORDER_ENTITLEMENT_MISMATCH'; end if;
    if v_version='monthly_v1' then
      if v_order.id is null then raise exception 'ORDER_REQUIRED'; end if;
      if not ((v_order.plan_code='monthly' and v_order.credits=2400 and v_order.months=1)
        or (v_order.plan_code='semester' and v_order.credits=9600 and v_order.months=4)
        or (v_order.plan_code='halfyear' and v_order.credits=14400 and v_order.months=6)
        or (v_order.plan_code='annual' and v_order.credits=28800 and v_order.months=12)
        or (v_order.plan_code='topup' and v_order.credits=1000 and v_order.months=12)) then raise exception 'INVALID_ENTITLEMENT'; end if;
      v_count:=case when v_order.plan_code='topup' then 1 else v_order.months end;
    end if;
  end if;
  if p_account is not null then
    if p_account->>'subscription_id' is not null then
      perform public.sync_billing_account((p_account->>'user_id')::uuid,p_account->>'customer_id',p_account->>'subscription_id',p_account->>'status',
        (p_account->>'period_starts_at')::timestamptz,(p_account->>'period_ends_at')::timestamptz,
        (p_account->>'next_billed_at')::timestamptz,(p_account->>'scheduled_cancel_at')::timestamptz,
        (p_account->>'trial_used_at')::timestamptz,(p_account->>'event_at')::timestamptz);
    else
      insert into public.billing_accounts(user_id,paddle_customer_id,last_event_at)
        values((p_account->>'user_id')::uuid,p_account->>'customer_id','1970-01-01')
        on conflict(user_id) do update set paddle_customer_id=coalesce(public.billing_accounts.paddle_customer_id,excluded.paddle_customer_id);
    end if;
  end if;
  if p_adjustment is not null then
    insert into public.billing_adjustments(adjustment_id,transaction_id,subtotal,occurred_at)
      values(p_adjustment->>'id',v_tx,(p_adjustment->>'subtotal')::bigint,p_occurred_at)
      on conflict(adjustment_id) do nothing;
  end if;
  select coalesce(sum(subtotal),0) into v_refund from public.billing_adjustments where transaction_id=v_tx;
  if p_grant is not null then
    insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,paid_subtotal,
      purchase_transaction_id,installment_index,installment_count)
    values(v_user_id,p_grant->>'source_type',p_grant->>'source_id',p_grant->>'plan_code',
      (p_grant->>'credits')::integer/v_count,(p_grant->>'credits')::integer/v_count,
      case when v_version='monthly_v1' then v_paid_at else (p_grant->>'starts_at')::timestamptz end,
      case when v_version='monthly_v1' then
        case when v_order.plan_code='monthly' and (p_grant->>'expires_at')::timestamptz>v_paid_at
          then (p_grant->>'expires_at')::timestamptz
          else public.credit_utc_months(v_paid_at,case when v_order.plan_code='topup' then 12 else 1 end) end
        else (p_grant->>'expires_at')::timestamptz end,
      (p_grant->>'paid_subtotal')::bigint,
      case when v_version='monthly_v1' then v_tx end,case when v_version='monthly_v1' then 0 end,
      case when v_version='monthly_v1' then v_count end)
    on conflict(source_type,source_id) do nothing returning id into v_inserted_id;
    -- A differently named replay cannot change the anchor, quantity or schedule.
    if v_inserted_id is not null and v_version='monthly_v1' and v_count>1 then
      for v_index in 1..v_count-1 loop
        v_start:=public.credit_utc_months(v_paid_at,v_index);
        insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,
          purchase_transaction_id,installment_index,installment_count)
        values(v_user_id,'payment',v_tx||':installment:'||v_index,p_grant->>'plan_code',2400,2400,v_start,public.credit_utc_months(v_paid_at,v_index+1),
          v_tx,v_index,v_count);
      end loop;
    end if;
    update public.billing_orders set completed_at=coalesce(completed_at,p_occurred_at) where transaction_id=v_tx;
  end if;
  if v_tx is not null then
    select * into v_first from public.credit_grants where source_type='payment' and source_id=v_tx;
    if found and v_refund>0 then
      select sum(g.granted_credits)::integer,sum(g.refunded_credits)::integer into v_total,v_previous
        from public.credit_grants g where g.id=v_first.id or g.purchase_transaction_id=v_tx;
      v_target:=greatest(0,(case when coalesce(v_first.paid_subtotal,0)=0 then v_total
        else least(v_total,ceil(v_total::numeric*v_refund/v_first.paid_subtotal))::integer end)-v_previous);
      -- First remove the new refund delta from this purchase's remaining
      -- balances, future/current installments first, then expired unused
      -- allocations. If a later installment was already
      -- consumed, continue to older balances of the SAME purchase. Only after
      -- its balance is exhausted may refund accounting cover consumed credits.
      for v_pass in 1..2 loop
        for v_row in select * from public.credit_grants g where g.id=v_first.id or g.purchase_transaction_id=v_tx
          order by case when g.expires_at>now() and g.revoked_at is null then 0 else 1 end,
            coalesce(g.installment_index,0) desc for update
        loop
          exit when v_target=0;
          v_this:=least(v_target,v_row.granted_credits-v_row.refunded_credits,
            case when v_pass=1 then v_row.remaining_credits else v_row.granted_credits end);
          v_target:=v_target-v_this;
          update public.credit_grants g set remaining_credits=greatest(0,g.remaining_credits-v_this),
            refunded_credits=g.refunded_credits+v_this,
            revoked_at=case when g.refunded_credits+v_this=g.granted_credits then coalesce(g.revoked_at,p_occurred_at) else g.revoked_at end,
            updated_at=now() where g.id=v_row.id and v_this>0;
        end loop;
      end loop;
    end if;
  end if;
  insert into public.billing_webhook_events(event_id,event_type,occurred_at) values(p_event_id,p_event_type,p_occurred_at);
end $$;
revoke all on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;

-- Owner identity comes only from the authenticated JWT. Future and expired
-- installments never enter the spendable balance; no refresh job is needed.
drop function public.get_credit_status();
create function public.get_credit_status()
returns table(credits integer,next_expiry timestamptz,latest_grant_at timestamptz,subscription_status text,trial_used boolean,
  next_grant_at timestamptz,next_grant_credits integer,scheduled_plan_code text,scheduled_ends_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||v_user::text,0));
  return query
    select coalesce(sum(g.remaining_credits) filter(where g.starts_at<=now() and g.expires_at>now() and g.revoked_at is null),0)::integer,
      min(g.expires_at) filter(where g.remaining_credits>0 and g.starts_at<=now() and g.expires_at>now() and g.revoked_at is null),
      max(g.starts_at) filter(where g.starts_at<=now()),a.subscription_status,(a.trial_used_at is not null),
      (select min(f.starts_at) from public.credit_grants f where f.user_id=v_user and f.purchase_transaction_id is not null
        and f.starts_at>now() and f.remaining_credits>0 and f.revoked_at is null),
      (select coalesce(sum(f.remaining_credits),0)::integer from public.credit_grants f where f.user_id=v_user
        and f.purchase_transaction_id is not null and f.revoked_at is null and f.starts_at=(select min(n.starts_at)
          from public.credit_grants n where n.user_id=v_user and n.purchase_transaction_id is not null
          and n.starts_at>now() and n.remaining_credits>0 and n.revoked_at is null)),
      (select p.plan_code from public.credit_grants p where p.user_id=v_user and p.purchase_transaction_id is not null
        and p.plan_code in ('monthly','semester','halfyear','annual') and p.revoked_at is null
        and p.granted_credits>p.refunded_credits and p.expires_at>now()
        order by p.expires_at desc limit 1),
      (select max(p.expires_at) from public.credit_grants p where p.user_id=v_user and p.purchase_transaction_id is not null
        and p.plan_code in ('monthly','semester','halfyear','annual') and p.revoked_at is null
        and p.granted_credits>p.refunded_credits and p.expires_at>now())
    from (select v_user as user_id) u left join public.billing_accounts a on a.user_id=u.user_id
      left join public.credit_grants g on g.user_id=u.user_id
    group by a.subscription_status,a.trial_used_at;
end $$;
revoke all on function public.get_credit_status() from public,anon,authenticated;
grant execute on function public.get_credit_status() to authenticated;

-- Both charge paths serialize with payments/refunds under the same owner lock.
create or replace function public.consume_lecture_credits(
  p_session_id uuid,
  p_minute_index integer
)
returns table (remaining_credits integer, allowed boolean, charged_through integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_index integer;
  v_grant_id uuid;
  v_usage_id uuid;
  v_remaining integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_minute_index < 0 or p_minute_index > 179 then raise exception 'INVALID_MINUTE'; end if;
  if not exists (
    select 1 from public.lecture_sessions s
    where s.id = p_session_id and s.user_id = v_user_id
      and s.status in ('recording', 'paused')
  ) then raise exception 'LECTURE_NOT_RECORDING'; end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||v_user_id::text,0));

  for v_index in 0..p_minute_index loop
    if exists (
      select 1 from public.lecture_credit_usage u
      where u.session_id = p_session_id and u.minute_index = v_index
    ) then continue; end if;

    v_grant_id := null;
    select g.id into v_grant_id
    from public.credit_grants g
    where g.user_id = v_user_id
      and g.remaining_credits > 0
      and g.starts_at <= now()
      and g.expires_at > now()
      and g.revoked_at is null
    order by case when g.plan_code = 'trial' then 0 else 1 end, g.expires_at, g.created_at
    limit 1 for update;

    if v_grant_id is null then
      select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
      from public.credit_grants g
      where g.user_id = v_user_id and g.starts_at <= now()
        and g.expires_at > now() and g.revoked_at is null;
      return query select v_remaining, false, v_index - 1;
      return;
    end if;

    v_usage_id := null;
    insert into public.lecture_credit_usage (user_id, session_id, grant_id, minute_index)
    values (v_user_id, p_session_id, v_grant_id, v_index)
    on conflict (session_id, minute_index) do nothing
    returning id into v_usage_id;
    if v_usage_id is not null then
      update public.credit_grants as g
      set remaining_credits = g.remaining_credits - 1, updated_at = now()
      where g.id = v_grant_id;
    end if;
  end loop;

  select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
  from public.credit_grants g
  where g.user_id = v_user_id and g.starts_at <= now()
    and g.expires_at > now() and g.revoked_at is null;
  return query select v_remaining, true, p_minute_index;
end;
$$;

create or replace function public.consume_lecture_credits_service(
  p_user_id uuid,
  p_session_id uuid,
  p_minute_index integer
)
returns table (remaining_credits integer, allowed boolean, charged_through integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := p_user_id;
  v_index integer;
  v_grant_id uuid;
  v_usage_id uuid;
  v_remaining integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_minute_index < 0 or p_minute_index > 179 then raise exception 'INVALID_MINUTE'; end if;
  if not exists (
    select 1 from public.lecture_sessions s
    where s.id = p_session_id and s.user_id = v_user_id
      and s.status in ('recording', 'paused')
  ) then raise exception 'LECTURE_NOT_RECORDING'; end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||v_user_id::text,0));

  for v_index in 0..p_minute_index loop
    if exists (
      select 1 from public.lecture_credit_usage u
      where u.session_id = p_session_id and u.minute_index = v_index
    ) then continue; end if;

    v_grant_id := null;
    select g.id into v_grant_id
    from public.credit_grants g
    where g.user_id = v_user_id
      and g.remaining_credits > 0
      and g.starts_at <= now()
      and g.expires_at > now()
      and g.revoked_at is null
    order by case when g.plan_code = 'trial' then 0 else 1 end, g.expires_at, g.created_at
    limit 1 for update;

    if v_grant_id is null then
      select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
      from public.credit_grants g
      where g.user_id = v_user_id and g.starts_at <= now()
        and g.expires_at > now() and g.revoked_at is null;
      return query select v_remaining, false, v_index - 1;
      return;
    end if;

    v_usage_id := null;
    insert into public.lecture_credit_usage (user_id, session_id, grant_id, minute_index)
    values (v_user_id, p_session_id, v_grant_id, v_index)
    on conflict (session_id, minute_index) do nothing
    returning id into v_usage_id;
    if v_usage_id is not null then
      update public.credit_grants as g
      set remaining_credits = g.remaining_credits - 1, updated_at = now()
      where g.id = v_grant_id;
    end if;
  end loop;

  select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
  from public.credit_grants g
  where g.user_id = v_user_id and g.starts_at <= now()
    and g.expires_at > now() and g.revoked_at is null;
  return query select v_remaining, true, p_minute_index;
end;
$$;

revoke all on function public.consume_lecture_credits_service(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_lecture_credits_service(uuid, uuid, integer) to service_role;

-- Aborted recordings cannot restore credits already removed by a refund.
create or replace function public.reconcile_finished_lecture_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return record;
begin
  if old.status not in ('recording', 'paused') or new.status <> 'completed' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||new.user_id::text,0));
  if new.recorded_ms = 0 and not exists (
    select 1 from public.lecture_credit_usage u
    where u.session_id = new.id and u.minute_index > 0
  ) then
    for v_return in
      select u.grant_id, count(*)::integer as credit_count
      from public.lecture_credit_usage u where u.session_id = new.id group by u.grant_id
    loop
      update public.credit_grants g
      set remaining_credits = least(g.remaining_credits + v_return.credit_count,
        greatest(0,g.granted_credits-g.refunded_credits-(select count(*)::integer
          from public.lecture_credit_usage kept where kept.grant_id=g.id and kept.session_id<>new.id))), updated_at = now()
      where g.id = v_return.grant_id;
    end loop;
    delete from public.lecture_credit_usage where session_id = new.id;
  end if;
  return new;
end;
$$;
