-- Paid indexing uses server-owned credit usage, durable idempotency, and a daily
-- character budget. Browser calls/deleted chunks cannot reset these controls.
create table public.lecture_index_jobs (
  session_id uuid primary key references public.lecture_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null check (state in ('running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  claim_token uuid not null,
  lease_until timestamptz not null,
  characters integer not null check (characters between 1 and 500000),
  updated_at timestamptz not null default now()
);
create table public.lecture_index_daily_budget (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  characters integer not null check (characters between 0 and 2000000),
  primary key (user_id, day)
);
alter table public.lecture_index_jobs enable row level security;
alter table public.lecture_index_daily_budget enable row level security;
revoke all on public.lecture_index_jobs, public.lecture_index_daily_budget from public, anon, authenticated;
grant all on public.lecture_index_jobs, public.lecture_index_daily_budget to service_role;

create function public.reserve_lecture_index(p_session_id uuid, p_user_id uuid, p_characters integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.lecture_index_jobs;
  v_paid_minutes integer;
  v_used integer;
  v_day date := (now() at time zone 'UTC')::date;
  v_token uuid := gen_random_uuid();
begin
  if p_user_id is null or p_characters is null or p_characters < 1 or p_characters > 500000 then
    return jsonb_build_object('allowed', false, 'reason', 'input_limit');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lecture-index:' || p_user_id::text, 0));
  if not exists (select 1 from public.lecture_sessions s where s.id = p_session_id and s.user_id = p_user_id and s.status = 'completed') then
    return jsonb_build_object('allowed', false, 'reason', 'session_unavailable');
  end if;
  select (count(*) + coalesce((
    select sum(r.charged_credits) from public.audio_credit_reservations r
    where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'settled'
  ), 0))::integer into v_paid_minutes from public.lecture_credit_usage u
    where u.session_id = p_session_id and u.user_id = p_user_id;
  -- A user whose last minute consumed the last credit can still index it.
  -- An unpaid fabricated session cannot start any provider call.
  if v_paid_minutes = 0 or p_characters > v_paid_minutes * 6000 then
    return jsonb_build_object('allowed', false, 'reason', 'unfunded_input');
  end if;
  select * into v_job from public.lecture_index_jobs where session_id = p_session_id for update;
  if found and (v_job.state = 'completed' or v_job.attempts >= 3 or v_job.lease_until > now()) then
    return jsonb_build_object('allowed', false, 'reason', 'already_claimed');
  end if;
  -- Existing legacy chunks also count as finished; catch-up is only for missing
  -- indexes, not an API for repeatedly replacing a completed embedding.
  if exists (select 1 from public.lecture_chunks c where c.session_id = p_session_id and c.user_id = p_user_id) then
    return jsonb_build_object('allowed', false, 'reason', 'already_indexed');
  end if;
  insert into public.lecture_index_daily_budget(user_id, day, characters) values (p_user_id, v_day, 0) on conflict do nothing;
  select characters into v_used from public.lecture_index_daily_budget where user_id = p_user_id and day = v_day for update;
  if v_used + p_characters > 2000000 then
    return jsonb_build_object('allowed', false, 'reason', 'daily_budget');
  end if;
  -- Charge reservations even on timeout: the provider might have processed it.
  update public.lecture_index_daily_budget set characters = characters + p_characters where user_id = p_user_id and day = v_day;
  insert into public.lecture_index_jobs(session_id, user_id, state, attempts, claim_token, lease_until, characters)
    values (p_session_id, p_user_id, 'running', 1, v_token, now() + interval '5 minutes', p_characters)
    on conflict (session_id) do update set state = 'running', attempts = public.lecture_index_jobs.attempts + 1,
      claim_token = excluded.claim_token, lease_until = excluded.lease_until, characters = excluded.characters, updated_at = now();
  return jsonb_build_object('allowed', true, 'claim_token', v_token);
end;
$$;

create function public.finish_lecture_index(p_session_id uuid, p_claim_token uuid, p_succeeded boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.lecture_index_jobs set state = case when p_succeeded then 'completed' else 'failed' end, updated_at = now()
    where session_id = p_session_id and claim_token = p_claim_token and state = 'running';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.reserve_lecture_index(uuid,uuid,integer), public.finish_lecture_index(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.reserve_lecture_index(uuid,uuid,integer), public.finish_lecture_index(uuid,uuid,boolean) to service_role;
