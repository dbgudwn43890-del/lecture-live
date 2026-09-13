-- Account creation and the FIRST real auth session are server facts. Existing
-- accounts are never backfilled. No identity in this table is sent to Google.
create table public.analytics_signup_receipts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  first_session_id uuid,
  claimed_at timestamptz
);
alter table public.analytics_signup_receipts enable row level security;
revoke all on public.analytics_signup_receipts from public, anon, authenticated;
grant select, update on public.analytics_signup_receipts to service_role;

create function public.capture_analytics_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.analytics_signup_receipts(user_id, created_at) values(new.id, new.created_at)
    on conflict do nothing;
  return new;
exception when others then
  -- Optional measurement must not break Supabase account creation.
  raise warning 'Optional signup receipt unavailable';
  return new;
end $$;
create trigger analytics_account_created after insert on auth.users
for each row execute function public.capture_analytics_account();

create function public.capture_analytics_first_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.analytics_signup_receipts set first_session_id = new.id
    where user_id = new.user_id and first_session_id is null;
  return new;
exception when others then
  raise warning 'Optional signup session receipt unavailable';
  return new;
end $$;
create trigger analytics_first_session_created after insert on auth.sessions
for each row execute function public.capture_analytics_first_session();

create function public.claim_analytics_signup_service(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.analytics_signup_receipts r set claimed_at = now()
    where r.user_id = p_user_id and r.first_session_id = p_session_id
      and r.claimed_at is null
      and exists(select 1 from auth.users u where u.id = r.user_id
        and u.email_confirmed_at >= now() - interval '1 hour')
      and exists(select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id);
  get diagnostics changed = row_count;
  return changed = 1;
end $$;
revoke all on function public.capture_analytics_account() from public, anon, authenticated;
revoke all on function public.capture_analytics_first_session() from public, anon, authenticated;
revoke all on function public.claim_analytics_signup_service(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_analytics_signup_service(uuid,uuid) to service_role;
