-- Every successful payment renews still-valid balances for twelve UTC calendar
-- months, independently of the subscription's billing frequency. Existing
-- authorization/credit-consumption rules are unchanged.
alter table public.credit_grants add column renewal_paid_at timestamptz
  check (renewal_paid_at is null or source_type='payment');
create index credit_grants_user_renewal_idx on public.credit_grants(user_id,renewal_paid_at)
  where renewal_paid_at is not null;

-- Event deduplication and every associated write share one DB transaction.
-- A crash rolls everything back; a parallel delivery waits for commit.
create or replace function public.apply_billing_event(
  p_event_id text, p_event_type text, p_occurred_at timestamptz,
  p_grant jsonb default null, p_account jsonb default null, p_adjustment jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_tx text; v_grant public.credit_grants; v_refund bigint; v_target integer; v_delta integer;
  v_user_id uuid; v_paid_at timestamptz; v_inserted_id uuid; v_renewal record;
  v_renewal_expiry timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event_id, 0));
  if exists(select 1 from public.billing_webhook_events where event_id=p_event_id) then return; end if;
  v_tx := coalesce(p_adjustment->>'transaction_id', case when p_grant->>'source_type'='payment' then p_grant->>'source_id' end);
  if v_tx is not null then perform pg_advisory_xact_lock(hashtextextended('payment:' || v_tx,0)); end if;
  v_user_id := coalesce((p_grant->>'user_id')::uuid,(p_account->>'user_id')::uuid,
    (select user_id from public.credit_grants where source_type='payment' and source_id=v_tx));
  -- Different payments for one owner must see each other's committed renewals.
  if v_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('credit-renewal:' || v_user_id::text,0));
    -- Match the credit-consumer lock order before touching several balances.
    perform id from public.credit_grants where user_id=v_user_id
      and remaining_credits>0 and revoked_at is null
      order by case when plan_code='trial' then 0 else 1 end,expires_at,created_at for update;
  end if;
  if p_grant->>'source_type'='payment' then
    if p_event_type<>'transaction.completed' then raise exception 'INVALID_PAYMENT_EVENT'; end if;
    v_paid_at := coalesce((p_grant->>'paid_at')::timestamptz,p_occurred_at);
    if v_paid_at>p_occurred_at then raise exception 'INVALID_PAYMENT_DATE'; end if;
  end if;
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
        (p_grant->>'credits')::integer,(p_grant->>'credits')::integer,
        coalesce(v_paid_at,(p_grant->>'starts_at')::timestamptz),
        case when v_paid_at is not null then ((v_paid_at at time zone 'UTC')+interval '12 months') at time zone 'UTC'
          else (p_grant->>'expires_at')::timestamptz end,(p_grant->>'paid_subtotal')::bigint)
      on conflict(source_type,source_id) do nothing returning id into v_inserted_id;
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
  -- Only a newly inserted, successful, not-yet-refunded payment can renew.
  -- A replay (even under another event id) cannot renew balances again.
  if v_inserted_id is not null and v_paid_at is not null
    and coalesce(v_grant.paid_subtotal,0)>0 and coalesce(v_refund,0)=0 then
    update public.credit_grants set renewal_paid_at=v_paid_at where id=v_inserted_id;
    -- Reapply later successful payments when an earlier webhook arrives late.
    -- This repairs a continuous chain of timely payments without crossing an
    -- expiry gap. Refunded purchases never supply new renewal effects.
    for v_renewal in
      select g.renewal_paid_at from public.credit_grants g
      where g.user_id=v_user_id and g.renewal_paid_at>=v_paid_at
        and not exists(select 1 from public.billing_adjustments a
          where a.transaction_id=g.source_id and a.subtotal>0)
      order by g.renewal_paid_at
    loop
      v_renewal_expiry := ((v_renewal.renewal_paid_at at time zone 'UTC')+interval '12 months') at time zone 'UTC';
      update public.credit_grants g
      set expires_at=greatest(g.expires_at,v_renewal_expiry),updated_at=now()
      where g.user_id=v_user_id and g.remaining_credits>0 and g.revoked_at is null
        and g.starts_at<=v_renewal.renewal_paid_at and g.expires_at>v_renewal.renewal_paid_at
        and g.expires_at<v_renewal_expiry;
    end loop;
  end if;
  -- Later refunds revoke the affected purchase as above. They intentionally
  -- do not roll back expiry already granted to unrelated credit balances.
  insert into public.billing_webhook_events(event_id,event_type,occurred_at) values(p_event_id,p_event_type,p_occurred_at);
end $$;
revoke all on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;

-- Conservative one-time correction for existing live buyers. The completed
-- server-created order proves ownership/environment; its completion event time
-- is the best payment-time evidence in the old schema. Never revive a balance
-- already expired at migration time, and never infer sandbox or legacy owners.
-- Do not mark these historical purchases for future replay under the new policy.
with latest_live_payment as (
  select o.user_id,max(o.completed_at) as paid_at
  from public.billing_orders o
  join public.credit_grants p on p.source_type='payment' and p.source_id=o.transaction_id and p.user_id=o.user_id
  where o.environment='live' and o.completed_at<=now() and o.completed_at>now()-interval '12 months'
    and o.failed_at is null and p.paid_subtotal>0 and p.refunded_credits=0 and p.revoked_at is null
    and not exists(select 1 from public.billing_adjustments a where a.transaction_id=o.transaction_id and a.subtotal>0)
  group by o.user_id
)
update public.credit_grants g
set expires_at=greatest(g.expires_at,((p.paid_at at time zone 'UTC')+interval '12 months') at time zone 'UTC'),updated_at=now()
from latest_live_payment p
where g.user_id=p.user_id and g.remaining_credits>0 and g.revoked_at is null
  and g.starts_at<=p.paid_at and g.expires_at>greatest(now(),p.paid_at)
  and g.expires_at<((p.paid_at at time zone 'UTC')+interval '12 months') at time zone 'UTC';
