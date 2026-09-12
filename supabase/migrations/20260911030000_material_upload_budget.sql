-- Deploy before the new materials route. Legacy server inserts remain valid,
-- but also respect reserved slots and the 20-document ceiling. No learner rows
-- are changed or deleted. Failed paid attempts retain their daily charge.
create table public.material_upload_reservations (
  claim_token uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  state text not null default 'running' check (state in ('running', 'completed', 'failed')),
  lease_until timestamptz not null default now() + interval '10 minutes',
  charged boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade
);
create index material_upload_reservations_active on public.material_upload_reservations(user_id, session_id, lease_until) where state = 'running';
create table public.material_upload_daily_budget (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  attempts integer not null default 0 check (attempts between 0 and 100),
  characters integer not null default 0 check (characters between 0 and 2000000),
  token_bound integer not null default 0 check (token_bound between 0 and 1000000),
  primary key (user_id, day)
);
alter table public.material_upload_reservations enable row level security;
alter table public.material_upload_daily_budget enable row level security;
revoke all on public.material_upload_reservations, public.material_upload_daily_budget from public, anon, authenticated;
grant all on public.material_upload_reservations, public.material_upload_daily_budget to service_role;

create function public.reserve_material_upload(p_session_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid;
  v_day date := (now() at time zone 'UTC')::date;
  v_count integer;
begin
  if p_user_id is null or p_session_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'session_unavailable');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('material-upload:' || p_user_id::text, 0));
  if not exists (select 1 from public.lecture_sessions where id = p_session_id and user_id = p_user_id) then
    return jsonb_build_object('allowed', false, 'reason', 'session_unavailable');
  end if;
  update public.material_upload_reservations set state = 'failed'
    where user_id = p_user_id and state = 'running' and lease_until <= now();
  select count(*) into v_count from public.material_documents where session_id = p_session_id;
  v_count := v_count + (select count(*) from public.material_upload_reservations
    where session_id = p_session_id and state = 'running' and lease_until > now());
  if v_count >= 20 then
    return jsonb_build_object('allowed', false, 'reason', 'document_limit');
  end if;
  if (select count(*) from public.material_upload_reservations
      where user_id = p_user_id and state = 'running' and lease_until > now()) >= 2 then
    return jsonb_build_object('allowed', false, 'reason', 'busy');
  end if;
  insert into public.material_upload_daily_budget(user_id, day) values (p_user_id, v_day) on conflict do nothing;
  if (select attempts >= 100 or characters >= 2000000 or token_bound >= 1000000
      from public.material_upload_daily_budget where user_id = p_user_id and day = v_day) then
    return jsonb_build_object('allowed', false, 'reason', 'daily_budget');
  end if;
  update public.material_upload_daily_budget set attempts = attempts + 1 where user_id = p_user_id and day = v_day;
  insert into public.material_upload_reservations(user_id, session_id) values (p_user_id, p_session_id) returning claim_token into v_token;
  return jsonb_build_object('allowed', true, 'claim_token', v_token);
end;
$$;

create function public.charge_material_upload(p_claim_token uuid, p_user_id uuid,
  p_characters integer, p_token_bound integer, p_chunks integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'UTC')::date;
  v_job public.material_upload_reservations;
  v_budget public.material_upload_daily_budget;
begin
  if p_user_id is null or p_characters is null or p_characters not between 1 and 500000
      or p_token_bound is null or p_token_bound not between 1 and 250000
      or p_chunks is null or p_chunks not between 1 and 400 then
    return jsonb_build_object('allowed', false, 'reason', 'input_limit');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('material-upload:' || p_user_id::text, 0));
  select * into v_job from public.material_upload_reservations
    where claim_token = p_claim_token and user_id = p_user_id for update;
  if not found or v_job.state <> 'running' or v_job.lease_until <= now() or v_job.charged then
    return jsonb_build_object('allowed', false, 'reason', 'claim_unavailable');
  end if;
  insert into public.material_upload_daily_budget(user_id, day) values (p_user_id, v_day) on conflict do nothing;
  select * into v_budget from public.material_upload_daily_budget where user_id = p_user_id and day = v_day for update;
  if v_budget.characters + p_characters > 2000000 or v_budget.token_bound + p_token_bound > 1000000 then
    return jsonb_build_object('allowed', false, 'reason', 'daily_budget');
  end if;
  update public.material_upload_daily_budget set characters = characters + p_characters,
    token_bound = token_bound + p_token_bound where user_id = p_user_id and day = v_day;
  update public.material_upload_reservations set charged = true where claim_token = p_claim_token;
  return jsonb_build_object('allowed', true);
end;
$$;

create function public.finish_material_upload(p_claim_token uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('material-upload:' || p_user_id::text, 0));
  update public.material_upload_reservations set state = 'failed'
    where claim_token = p_claim_token and user_id = p_user_id and state = 'running';
end;
$$;

create function public.enforce_material_upload_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_job public.material_upload_reservations; v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('material-upload:' || new.user_id::text, 0));
  select * into v_job from public.material_upload_reservations where claim_token = new.id for update;
  if found then
    if v_job.user_id <> new.user_id or v_job.session_id is distinct from new.session_id
        or v_job.state <> 'running' or v_job.lease_until <= now() or not v_job.charged then
      raise exception 'material_upload_claim_unavailable' using errcode = '23514';
    end if;
  end if;
  select count(*) into v_count from public.material_documents where session_id = new.session_id;
  v_count := v_count + (select count(*) from public.material_upload_reservations
    where session_id = new.session_id and state = 'running' and lease_until > now() and claim_token <> new.id);
  if v_count >= 20 then raise exception 'material_document_limit' using errcode = '23514'; end if;
  -- The document UUID is the claim UUID. Old deployments generate an unrelated
  -- UUID and need no schema changes; they still cannot steal reserved slots.
  if v_job.claim_token is not null then
    update public.material_upload_reservations set state = 'completed' where claim_token = new.id;
  end if;
  return new;
end;
$$;
create trigger material_upload_slot before insert on public.material_documents
  for each row execute function public.enforce_material_upload_slot();
revoke all on function public.reserve_material_upload(uuid,uuid), public.charge_material_upload(uuid,uuid,integer,integer,integer),
  public.finish_material_upload(uuid,uuid), public.enforce_material_upload_slot() from public, anon, authenticated;
grant execute on function public.reserve_material_upload(uuid,uuid), public.charge_material_upload(uuid,uuid,integer,integer,integer),
  public.finish_material_upload(uuid,uuid) to service_role;
