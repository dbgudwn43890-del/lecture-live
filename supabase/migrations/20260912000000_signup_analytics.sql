begin;

-- Authoritative signup markers. Never backfill existing auth.users: a login
-- by an existing account must not become a new-account conversion.
-- No identifiers from this table are sent to Google.
create table public.signup_analytics_events (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Internal only. Never sent to GA. Retain the binding even after sign-out.
  first_session_id uuid,
  method text not null check (method in ('google', 'email', 'other')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  expires_at timestamptz,
  state text not null default 'pending' check (state in ('pending', 'ready', 'discarded', 'claimed')),
  finalized_at timestamptz,
  claimed_at timestamptz
);

alter table public.signup_analytics_events enable row level security;
revoke all on public.signup_analytics_events from public, anon, authenticated;
-- Intentionally no direct client read/write policies. Only the narrow RPCs below.

create function public.capture_signup_analytics_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.signup_analytics_events(user_id, method, confirmed_at, expires_at)
    values (
      new.id,
      case new.raw_app_meta_data ->> 'provider'
        when 'google' then 'google' when 'email' then 'email' else 'other' end,
      new.confirmed_at,
      case when new.confirmed_at is not null then now() + interval '1 hour' else null end
    ) on conflict (user_id) do nothing;
  elsif old.confirmed_at is null and new.confirmed_at is not null then
    -- Update only a marker created by the INSERT trigger. An old, previously
    -- unconfirmed account that predates this migration is not backfilled.
    update public.signup_analytics_events
      set confirmed_at = new.confirmed_at, expires_at = now() + interval '1 hour'
      where user_id = new.id and confirmed_at is null and state = 'pending';
  end if;
  return new;
exception when others then
  -- Optional measurement must never prevent authentication/account creation.
  raise warning 'Signup analytics marker unavailable (SQLSTATE %)', sqlstate;
  return new;
end;
$$;
revoke all on function public.capture_signup_analytics_event() from public, anon, authenticated;

create trigger capture_signup_analytics_insert
after insert on auth.users
for each row execute function public.capture_signup_analytics_event();
create trigger capture_signup_analytics_confirmation
after update on auth.users
for each row
when (old.confirmed_at is null and new.confirmed_at is not null)
execute function public.capture_signup_analytics_event();

-- Bind once to the first server-created authentication session. A later login
-- must not recover an unfinalized marker using a different consent decision.
create function public.bind_signup_analytics_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.signup_analytics_events
    set first_session_id = new.id
    where user_id = new.user_id and first_session_id is null and state = 'pending';
  return new;
exception when others then
  raise warning 'Signup analytics session binding unavailable (SQLSTATE %)', sqlstate;
  return new;
end;
$$;
revoke all on function public.bind_signup_analytics_session() from public, anon, authenticated;
create trigger bind_signup_analytics_first_session
  after insert on auth.sessions
  for each row execute function public.bind_signup_analytics_session();

-- Called on the first successful auth callback. Opting out is terminal for
-- this signup; a later login/consent change must not fabricate a new signup.
create function public.finalize_signup_analytics(p_allowed boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.signup_analytics_events
    set state = case when p_allowed is true and expires_at > now()
                     then 'ready' else 'discarded' end,
        finalized_at = now()
    where user_id = (select auth.uid())
      and first_session_id = nullif((select auth.jwt())->>'session_id', '')::uuid
      and state = 'pending' and confirmed_at is not null;
$$;
revoke all on function public.finalize_signup_analytics(boolean) from public, anon;
grant execute on function public.finalize_signup_analytics(boolean) to authenticated;

-- Atomic at-most-once browser dispatch claim, not a guarantee that GA receives
-- the event. Concurrent tabs and repeat logins cannot both claim the marker.
-- Claims are made only after consent and successful Google tag loading.
create function public.claim_signup_analytics()
returns table(method text)
language sql
security definer
set search_path = ''
as $$
  update public.signup_analytics_events as event
    set state = 'claimed', claimed_at = now()
    where event.user_id = (select auth.uid())
      and event.first_session_id = nullif((select auth.jwt())->>'session_id', '')::uuid
      and event.state = 'ready' and event.expires_at > now()
    returning event.method;
$$;
revoke all on function public.claim_signup_analytics() from public, anon;
grant execute on function public.claim_signup_analytics() to authenticated;

comment on table public.signup_analytics_events is
'First-party signup integrity markers bound to the first auth session. Not a delivery log. No backfill. Failures before finalization or after claim can undercount. Account deletion cascades; operators should schedule stale-row cleanup.';

commit;
