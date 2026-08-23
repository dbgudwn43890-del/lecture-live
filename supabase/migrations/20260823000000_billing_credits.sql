create table if not exists public.billing_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paddle_customer_id text unique,
  paddle_subscription_id text unique,
  subscription_status text check (subscription_status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  next_billed_at timestamptz,
  scheduled_cancel_at timestamptz,
  trial_used_at timestamptz,
  last_event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('trial', 'payment', 'service_credit')),
  source_id text not null,
  plan_code text not null check (plan_code in ('trial', 'monthly', 'semester', 'service_credit')),
  granted_credits integer not null check (granted_credits > 0),
  remaining_credits integer not null check (remaining_credits >= 0 and remaining_credits <= granted_credits),
  starts_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > starts_at),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_id)
);

create table if not exists public.lecture_credit_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  grant_id uuid not null references public.credit_grants(id) on delete restrict,
  minute_index integer not null check (minute_index between 0 and 179),
  created_at timestamptz not null default now(),
  unique (session_id, minute_index)
);

create table if not exists public.billing_webhook_events (
  event_id text primary key,
  event_type text not null,
  occurred_at timestamptz not null,
  processed_at timestamptz not null default now()
);

create index if not exists credit_grants_user_expiry_idx
  on public.credit_grants (user_id, expires_at)
  where remaining_credits > 0 and revoked_at is null;
create index if not exists lecture_credit_usage_user_created_idx
  on public.lecture_credit_usage (user_id, created_at desc);

alter table public.billing_accounts enable row level security;
alter table public.credit_grants enable row level security;
alter table public.lecture_credit_usage enable row level security;
alter table public.billing_webhook_events enable row level security;

drop policy if exists billing_accounts_owner_read on public.billing_accounts;
create policy billing_accounts_owner_read on public.billing_accounts for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists credit_grants_owner_read on public.credit_grants;
create policy credit_grants_owner_read on public.credit_grants for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists lecture_credit_usage_owner_read on public.lecture_credit_usage;
create policy lecture_credit_usage_owner_read on public.lecture_credit_usage for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.billing_accounts from anon, authenticated;
revoke all on public.credit_grants from anon, authenticated;
revoke all on public.lecture_credit_usage from anon, authenticated;
revoke all on public.billing_webhook_events from anon, authenticated;
grant select on public.billing_accounts to authenticated;
grant select on public.credit_grants to authenticated;
grant select on public.lecture_credit_usage to authenticated;

create or replace function public.get_credit_status()
returns table (
  credits integer,
  next_expiry timestamptz,
  latest_grant_at timestamptz,
  subscription_status text,
  trial_used boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(g.remaining_credits) filter (
      where g.starts_at <= now()
        and g.expires_at > now()
        and g.revoked_at is null
    ), 0)::integer as credits,
    min(g.expires_at) filter (
      where g.remaining_credits > 0
        and g.starts_at <= now()
        and g.expires_at > now()
        and g.revoked_at is null
    ) as next_expiry,
    max(g.created_at) as latest_grant_at,
    a.subscription_status,
    (a.trial_used_at is not null) as trial_used
  from (select auth.uid() as user_id) u
  left join public.billing_accounts a on a.user_id = u.user_id
  left join public.credit_grants g on g.user_id = u.user_id
  where u.user_id is not null
  group by a.subscription_status, a.trial_used_at;
$$;

revoke all on function public.get_credit_status() from public, anon, authenticated;
grant execute on function public.get_credit_status() to authenticated;

create or replace function public.can_ask_with_credits(
  p_session_id uuid,
  p_minute_index integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1
      from public.credit_grants g
      where g.user_id = (select auth.uid())
        and g.remaining_credits > 0
        and g.starts_at <= now()
        and g.expires_at > now()
        and g.revoked_at is null
    )
    or exists (
      select 1
      from public.lecture_sessions s
      join public.lecture_credit_usage u on u.session_id = s.id
      where s.id = p_session_id
        and s.user_id = (select auth.uid())
        and s.status = 'recording'
        and u.minute_index = p_minute_index
    )
  );
$$;

revoke all on function public.can_ask_with_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.can_ask_with_credits(uuid, integer) to authenticated;

create or replace function public.consume_lecture_credits(
  p_session_id uuid,
  p_minute_index integer
)
returns table (
  remaining_credits integer,
  allowed boolean,
  charged_through integer
)
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
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_minute_index < 0 or p_minute_index > 179 then
    raise exception 'INVALID_MINUTE';
  end if;
  if not exists (
    select 1
    from public.lecture_sessions s
    where s.id = p_session_id
      and s.user_id = v_user_id
      and s.status = 'recording'
  ) then
    raise exception 'LECTURE_NOT_RECORDING';
  end if;

  for v_index in 0..p_minute_index loop
    if exists (
      select 1 from public.lecture_credit_usage u
      where u.session_id = p_session_id and u.minute_index = v_index
    ) then
      continue;
    end if;

    v_grant_id := null;
    select g.id into v_grant_id
    from public.credit_grants g
    where g.user_id = v_user_id
      and g.remaining_credits > 0
      and g.starts_at <= now()
      and g.expires_at > now()
      and g.revoked_at is null
      and (
        g.plan_code <> 'trial'
        or not exists (
          select 1
          from public.lecture_credit_usage prior_usage
          where prior_usage.grant_id = g.id
            and prior_usage.session_id <> p_session_id
        )
      )
    order by case when g.plan_code = 'trial' then 0 else 1 end, g.expires_at, g.created_at
    limit 1
    for update;

    if v_grant_id is null then
      select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
      from public.credit_grants g
      where g.user_id = v_user_id
        and g.starts_at <= now()
        and g.expires_at > now()
        and g.revoked_at is null;
      return query select v_remaining, false, v_index - 1;
      return;
    end if;

    v_usage_id := null;
    insert into public.lecture_credit_usage (user_id, session_id, grant_id, minute_index)
    values (v_user_id, p_session_id, v_grant_id, v_index)
    on conflict (session_id, minute_index) do nothing
    returning id into v_usage_id;

    if v_usage_id is not null then
      update public.credit_grants
      set remaining_credits = remaining_credits - 1,
          updated_at = now()
      where id = v_grant_id;
    end if;
  end loop;

  select coalesce(sum(g.remaining_credits), 0)::integer into v_remaining
  from public.credit_grants g
  where g.user_id = v_user_id
    and g.starts_at <= now()
    and g.expires_at > now()
    and g.revoked_at is null;
  return query select v_remaining, true, p_minute_index;
end;
$$;

revoke all on function public.consume_lecture_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_lecture_credits(uuid, integer) to authenticated;

create or replace function public.sync_billing_account(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_period_starts_at timestamptz,
  p_period_ends_at timestamptz,
  p_next_billed_at timestamptz,
  p_scheduled_cancel_at timestamptz,
  p_trial_used_at timestamptz,
  p_event_at timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.billing_accounts (
    user_id,
    paddle_customer_id,
    paddle_subscription_id,
    subscription_status,
    current_period_starts_at,
    current_period_ends_at,
    next_billed_at,
    scheduled_cancel_at,
    trial_used_at,
    last_event_at,
    updated_at
  ) values (
    p_user_id,
    p_customer_id,
    p_subscription_id,
    p_status,
    p_period_starts_at,
    p_period_ends_at,
    p_next_billed_at,
    p_scheduled_cancel_at,
    p_trial_used_at,
    p_event_at,
    now()
  )
  on conflict (user_id) do update set
    paddle_customer_id = excluded.paddle_customer_id,
    paddle_subscription_id = excluded.paddle_subscription_id,
    subscription_status = excluded.subscription_status,
    current_period_starts_at = excluded.current_period_starts_at,
    current_period_ends_at = excluded.current_period_ends_at,
    next_billed_at = excluded.next_billed_at,
    scheduled_cancel_at = excluded.scheduled_cancel_at,
    trial_used_at = coalesce(public.billing_accounts.trial_used_at, excluded.trial_used_at),
    last_event_at = excluded.last_event_at,
    updated_at = now()
  where excluded.last_event_at >= public.billing_accounts.last_event_at;
$$;

revoke all on function public.sync_billing_account(uuid, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.sync_billing_account(uuid, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) to service_role;

create or replace function public.reconcile_finished_lecture_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return record;
begin
  if old.status <> 'recording' or new.status <> 'completed' then
    return new;
  end if;

  if new.duration_seconds = 0
    and new.ended_at is not null
    and new.ended_at - new.started_at <= interval '30 seconds'
    and not exists (
      select 1 from public.lecture_credit_usage u
      where u.session_id = new.id and u.minute_index > 0
    )
  then
    for v_return in
      select u.grant_id, count(*)::integer as credit_count
      from public.lecture_credit_usage u
      where u.session_id = new.id
      group by u.grant_id
    loop
      update public.credit_grants g
      set remaining_credits = least(g.granted_credits, g.remaining_credits + v_return.credit_count),
          updated_at = now()
      where g.id = v_return.grant_id;
    end loop;
    delete from public.lecture_credit_usage where session_id = new.id;
    return new;
  end if;

  update public.credit_grants g
  set remaining_credits = 0,
      updated_at = now()
  where g.plan_code = 'trial'
    and g.id in (
      select u.grant_id
      from public.lecture_credit_usage u
      where u.session_id = new.id
    );
  return new;
end;
$$;

drop trigger if exists reconcile_finished_lecture_credits on public.lecture_sessions;
create trigger reconcile_finished_lecture_credits
after update of status on public.lecture_sessions
for each row execute function public.reconcile_finished_lecture_credits();

revoke all on function public.reconcile_finished_lecture_credits() from public, anon, authenticated;
