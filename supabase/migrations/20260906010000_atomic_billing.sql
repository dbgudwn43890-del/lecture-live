-- Only service_role can reserve checkouts or mutate payment entitlements.
create table public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null check (plan_code in ('monthly', 'semester')),
  price_id text not null,
  credits integer not null check (credits > 0),
  months integer not null check (months > 0),
  environment text not null check (environment in ('sandbox', 'live')),
  transaction_id text unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz
);
alter table public.billing_orders enable row level security;
revoke all on public.billing_orders from public, anon, authenticated;
create index billing_orders_user_created on public.billing_orders(user_id, created_at desc);

create table public.billing_adjustments (
  adjustment_id text primary key,
  transaction_id text not null,
  subtotal bigint not null check (subtotal >= 0),
  occurred_at timestamptz not null
);
create index billing_adjustments_transaction on public.billing_adjustments(transaction_id);
alter table public.billing_adjustments enable row level security;
revoke all on public.billing_adjustments from public, anon, authenticated;
alter table public.credit_grants add column paid_subtotal bigint;
alter table public.credit_grants add column refunded_credits integer not null default 0;

create or replace function public.reserve_billing_order(
  p_id uuid, p_user_id uuid, p_plan text, p_price_id text, p_credits integer, p_months integer, p_environment text
) returns setof public.billing_orders language plpgsql security definer set search_path = '' as $$
declare v_order public.billing_orders;
begin
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
  if p_plan = 'monthly' and exists (
    select 1 from public.billing_accounts where user_id = p_user_id
    and subscription_status in ('active','trialing','paused','past_due')
  ) then raise exception 'ACTIVE_SUBSCRIPTION'; end if;
  select * into v_order from public.billing_orders where user_id = p_user_id
    and plan_code = p_plan and environment = p_environment and failed_at is null
    and completed_at is null and created_at > now() - interval '24 hours'
    order by created_at desc limit 1;
  if found then return next v_order; return; end if;
  insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment)
    values(p_id,p_user_id,p_plan,p_price_id,p_credits,p_months,p_environment) returning * into v_order;
  return next v_order;
end $$;
revoke all on function public.reserve_billing_order(uuid,uuid,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.reserve_billing_order(uuid,uuid,text,text,integer,integer,text) to service_role;

-- Event deduplication and every associated write share one DB transaction.
-- A crash rolls everything back; a parallel delivery waits for commit.
create or replace function public.apply_billing_event(
  p_event_id text, p_event_type text, p_occurred_at timestamptz,
  p_grant jsonb default null, p_account jsonb default null, p_adjustment jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_tx text; v_grant public.credit_grants; v_refund bigint; v_target integer; v_delta integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event_id, 0));
  if exists(select 1 from public.billing_webhook_events where event_id=p_event_id) then return; end if;
  v_tx := coalesce(p_adjustment->>'transaction_id', case when p_grant->>'source_type'='payment' then p_grant->>'source_id' end);
  if v_tx is not null then perform pg_advisory_xact_lock(hashtextextended('payment:' || v_tx,0)); end if;
  if p_account is not null then
    if p_account->>'subscription_id' is not null then
      perform public.sync_billing_account(
        (p_account->>'user_id')::uuid,p_account->>'customer_id',p_account->>'subscription_id',p_account->>'status',
        (p_account->>'period_starts_at')::timestamptz,(p_account->>'period_ends_at')::timestamptz,
        (p_account->>'next_billed_at')::timestamptz,(p_account->>'scheduled_cancel_at')::timestamptz,
        (p_account->>'trial_used_at')::timestamptz,(p_account->>'event_at')::timestamptz);
    else
      insert into public.billing_accounts(user_id,paddle_customer_id,last_event_at)
        values((p_account->>'user_id')::uuid,p_account->>'customer_id','1970-01-01')
        on conflict(user_id) do update set paddle_customer_id=coalesce(public.billing_accounts.paddle_customer_id,excluded.paddle_customer_id);
    end if;
  end if;
  if p_grant is not null then
    insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at,paid_subtotal)
      values((p_grant->>'user_id')::uuid,p_grant->>'source_type',p_grant->>'source_id',p_grant->>'plan_code',
        (p_grant->>'credits')::integer,(p_grant->>'credits')::integer,(p_grant->>'starts_at')::timestamptz,
        (p_grant->>'expires_at')::timestamptz,(p_grant->>'paid_subtotal')::bigint)
      on conflict(source_type,source_id) do nothing;
    update public.billing_orders set completed_at=coalesce(completed_at,p_occurred_at) where transaction_id=v_tx;
  end if;
  if p_adjustment is not null then
    insert into public.billing_adjustments(adjustment_id,transaction_id,subtotal,occurred_at)
      values(p_adjustment->>'id',v_tx,(p_adjustment->>'subtotal')::bigint,p_occurred_at)
      on conflict(adjustment_id) do nothing;
  end if;
  if v_tx is not null then
    select * into v_grant from public.credit_grants where source_type='payment' and source_id=v_tx for update;
    if found then
      select coalesce(sum(subtotal),0) into v_refund from public.billing_adjustments where transaction_id=v_tx;
      if v_refund > 0 then
        -- Cumulative proportional refunds remove only the affected purchase's credits.
        v_target := case when coalesce(v_grant.paid_subtotal,0)=0 then v_grant.granted_credits
          else least(v_grant.granted_credits,ceil(v_grant.granted_credits::numeric*v_refund/v_grant.paid_subtotal))::integer end;
        v_delta := greatest(0,v_target-v_grant.refunded_credits);
        update public.credit_grants set remaining_credits=greatest(0,remaining_credits-v_delta),
          refunded_credits=greatest(refunded_credits,v_target),
          revoked_at=case when v_target=granted_credits then coalesce(revoked_at,p_occurred_at) else revoked_at end,
          updated_at=now() where id=v_grant.id;
      end if;
    end if;
  end if;
  insert into public.billing_webhook_events(event_id,event_type,occurred_at) values(p_event_id,p_event_type,p_occurred_at);
end $$;
revoke all on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;
