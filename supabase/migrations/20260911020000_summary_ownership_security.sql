-- Additive stage: apply before deploying the summary API that uses these RPCs.
-- Browser summary writes are revoked separately, after old deployments drain.
-- These validated constraints intentionally abort on existing ownership mismatches.
-- Before applying, inspect these read-only counts and resolve any nonzero result:
-- select count(*) from public.lecture_sessions s join public.classrooms c on c.id=s.classroom_id where s.user_id<>c.user_id;
-- select count(*) from public.lecture_summaries x join public.lecture_sessions s on s.id=x.session_id where x.user_id<>s.user_id;
-- select count(*) from public.lecture_summaries x join public.classrooms c on c.id=x.classroom_id where x.user_id<>c.user_id;
create unique index if not exists classrooms_id_user_unique on public.classrooms(id, user_id);
create unique index if not exists lecture_sessions_id_user_unique on public.lecture_sessions(id, user_id);

alter table public.lecture_sessions drop constraint if exists lecture_sessions_classroom_id_fkey;
alter table public.lecture_sessions add constraint lecture_sessions_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id)
  on delete set null (classroom_id);
alter table public.lecture_summaries add constraint lecture_summaries_session_owner_fk
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade;
alter table public.lecture_summaries drop constraint if exists lecture_summaries_classroom_id_fkey;
alter table public.lecture_summaries add constraint lecture_summaries_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id)
  on delete set null (classroom_id);

-- Deleting a generated result does not reset a window's completion or attempts.
create table public.lecture_summary_generations (
  session_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  window_index integer not null check (window_index between 0 and 17),
  attempts integer not null default 0 check (attempts between 0 and 2),
  claim_token uuid,
  lease_until timestamptz,
  source_characters integer not null default 0 check (source_characters >= 0),
  end_ms integer not null check (end_ms between 0 and 10800000),
  completed_at timestamptz,
  primary key (session_id, window_index),
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade
);
-- This budget survives both summary and session deletion. Failed/ambiguous paid
-- requests consume budget too; otherwise repeated upstream failures permit abuse.
create table public.lecture_summary_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  attempts integer not null default 0 check (attempts >= 0),
  source_characters bigint not null default 0 check (source_characters >= 0),
  primary key (user_id, usage_date)
);
alter table public.lecture_summary_generations enable row level security;
alter table public.lecture_summary_daily_usage enable row level security;
revoke all on public.lecture_summary_generations, public.lecture_summary_daily_usage from public, anon, authenticated;
grant select, insert, update, delete on public.lecture_summary_generations, public.lecture_summary_daily_usage to service_role;

insert into public.lecture_summary_generations(session_id,user_id,window_index,attempts,source_characters,end_ms,completed_at)
select session_id,user_id,window_index,1,source_characters,end_ms,created_at from public.lecture_summaries;
insert into public.lecture_summary_daily_usage(user_id,usage_date,attempts,source_characters)
select user_id,(created_at at time zone 'UTC')::date,count(*)::integer,sum(source_characters)
from public.lecture_summaries group by user_id,(created_at at time zone 'UTC')::date;

create function public.claim_lecture_summary_generation(
  p_user_id uuid, p_session_id uuid, p_window_index integer, p_token uuid,
  p_source_characters integer, p_end_ms integer
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_generation public.lecture_summary_generations%rowtype;
  v_day date := (clock_timestamp() at time zone 'UTC')::date;
begin
  if p_token is null or p_source_characters is null or p_source_characters < 400
    or p_window_index is null or p_window_index not between 0 and 17
    or p_end_ms is null or p_end_ms <= p_window_index * 600000
    or p_end_ms > (p_window_index + 1) * 600000 then
    raise exception 'INVALID_SUMMARY_WINDOW' using errcode = '22023';
  end if;
  if not exists (select 1 from public.lecture_sessions where id=p_session_id and user_id=p_user_id) then
    raise exception 'LECTURE_NOT_FOUND' using errcode = '42501';
  end if;
  -- One request is at most 60k input characters / 2k output tokens. Together
  -- with disabled SDK retries, these budgets bound paid work, not HTTP traffic.
  if p_source_characters > 60000 then return 'source-limit'; end if;
  insert into public.lecture_summary_generations(session_id,user_id,window_index,end_ms)
  values(p_session_id,p_user_id,p_window_index,p_end_ms) on conflict do nothing;
  select * into v_generation from public.lecture_summary_generations
  where session_id=p_session_id and window_index=p_window_index for update;
  if v_generation.user_id <> p_user_id then
    raise exception 'LECTURE_NOT_FOUND' using errcode = '42501';
  end if;
  -- Also covers results created by the previous deployment during staged rollout.
  if v_generation.completed_at is not null or exists (
    select 1 from public.lecture_summaries where session_id=p_session_id and window_index=p_window_index
  ) then
    update public.lecture_summary_generations set completed_at=coalesce(completed_at,clock_timestamp())
    where session_id=p_session_id and window_index=p_window_index;
    return 'completed';
  end if;
  if v_generation.lease_until > clock_timestamp() then return 'generating'; end if;
  if v_generation.attempts >= 2 then return 'attempt-limit'; end if;
  insert into public.lecture_summary_daily_usage(user_id,usage_date) values(p_user_id,v_day) on conflict do nothing;
  update public.lecture_summary_daily_usage set attempts=attempts+1,source_characters=source_characters+p_source_characters
  where user_id=p_user_id and usage_date=v_day and attempts < 72 and source_characters+p_source_characters <= 1000000;
  if not found then return 'daily-budget'; end if;
  update public.lecture_summary_generations set attempts=attempts+1,claim_token=p_token,
    lease_until=clock_timestamp()+interval '180 seconds',source_characters=p_source_characters,end_ms=p_end_ms
  where session_id=p_session_id and window_index=p_window_index;
  return 'claimed';
end;
$$;

-- The save and durable completion form a single transaction. Use the current
-- classroom after a concurrent move; never trust the earlier browser context.
create function public.complete_lecture_summary_generation(
  p_user_id uuid, p_session_id uuid, p_window_index integer, p_token uuid, p_text text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_generation public.lecture_summary_generations%rowtype;
  v_classroom_id uuid;
begin
  select classroom_id into v_classroom_id from public.lecture_sessions
  where id=p_session_id and user_id=p_user_id for share;
  if not found then raise exception 'LECTURE_NOT_FOUND' using errcode = '42501'; end if;
  select * into v_generation from public.lecture_summary_generations
  where session_id=p_session_id and window_index=p_window_index and user_id=p_user_id for update;
  if not found or p_token is null or v_generation.claim_token is distinct from p_token
    or v_generation.completed_at is not null then return false; end if;
  -- An expired token may save until another claim replaces it. It cannot save
  -- over a newer claimant; this preserves successful slow requests safely.
  insert into public.lecture_summaries(session_id,classroom_id,user_id,window_index,start_ms,end_ms,text,source_characters)
  values(p_session_id,v_classroom_id,p_user_id,p_window_index,p_window_index*600000,
    v_generation.end_ms,p_text,v_generation.source_characters)
  on conflict (session_id,window_index) do nothing;
  update public.lecture_summary_generations set completed_at=clock_timestamp(),claim_token=null,lease_until=null
  where session_id=p_session_id and window_index=p_window_index;
  return true;
end;
$$;
revoke all on function public.claim_lecture_summary_generation(uuid,uuid,integer,uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.complete_lecture_summary_generation(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_lecture_summary_generation(uuid,uuid,integer,uuid,integer,integer) to service_role;
grant execute on function public.complete_lecture_summary_generation(uuid,uuid,integer,uuid,text) to service_role;
