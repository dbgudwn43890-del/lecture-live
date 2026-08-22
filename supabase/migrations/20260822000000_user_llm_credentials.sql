create extension if not exists supabase_vault with schema vault;

create table if not exists public.user_llm_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'google')),
  model text not null,
  secret_id uuid not null unique,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_llm_credentials enable row level security;
revoke all on public.user_llm_credentials from anon, authenticated;

create or replace function public.save_user_llm_credential(
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_api_key text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  next_secret_id uuid;
begin
  if p_provider not in ('openai', 'anthropic', 'google')
    or length(p_model) not between 1 and 100
    or length(p_api_key) not between 10 and 512
  then
    raise exception 'Invalid credential';
  end if;

  select secret_id into existing_secret_id
  from public.user_llm_credentials
  where user_id = p_user_id and provider = p_provider
  for update;

  if existing_secret_id is null then
    select vault.create_secret(
      p_api_key,
      'llm-' || p_user_id::text || '-' || p_provider,
      'Lecue user-provided LLM credential'
    ) into next_secret_id;
  else
    perform vault.update_secret(existing_secret_id, p_api_key);
    next_secret_id := existing_secret_id;
  end if;

  insert into public.user_llm_credentials (user_id, provider, model, secret_id, updated_at)
  values (p_user_id, p_provider, p_model, next_secret_id, now())
  on conflict (user_id, provider) do update
  set model = excluded.model,
      secret_id = excluded.secret_id,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.list_user_llm_credentials(p_user_id uuid)
returns table(provider text, model text, updated_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select c.provider, c.model, c.updated_at
  from public.user_llm_credentials c
  where c.user_id = p_user_id
  order by c.provider;
$$;

create or replace function public.get_user_llm_credential(p_user_id uuid, p_provider text)
returns table(provider text, model text, api_key text)
language sql
security definer
set search_path = ''
as $$
  select c.provider, c.model, s.decrypted_secret
  from public.user_llm_credentials c
  join vault.decrypted_secrets s on s.id = c.secret_id
  where c.user_id = p_user_id and c.provider = p_provider;
$$;

create or replace function public.delete_user_llm_credential(p_user_id uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.user_llm_credentials
  where user_id = p_user_id and provider = p_provider;
end;
$$;

create or replace function public.delete_user_llm_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

drop trigger if exists delete_user_llm_secret on public.user_llm_credentials;
create trigger delete_user_llm_secret
before delete on public.user_llm_credentials
for each row execute function public.delete_user_llm_secret();

revoke all on function public.save_user_llm_credential(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.list_user_llm_credentials(uuid) from public, anon, authenticated;
revoke all on function public.get_user_llm_credential(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_user_llm_credential(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_user_llm_secret() from public, anon, authenticated;

grant execute on function public.save_user_llm_credential(uuid, text, text, text) to service_role;
grant execute on function public.list_user_llm_credentials(uuid) to service_role;
grant execute on function public.get_user_llm_credential(uuid, text) to service_role;
grant execute on function public.delete_user_llm_credential(uuid, text) to service_role;
