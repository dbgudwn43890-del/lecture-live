-- Recording credits were only ever consumed when the browser chose to call
-- /api/credits. A client that simply never made that call could stream audio
-- to /api/lecture-audio indefinitely on a single credit. Derive the billable
-- minute from the session's own started_at so the server, not the client,
-- decides how much has been used.
create or replace function public.consume_lecture_credits_elapsed(
  p_session_id uuid
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
  v_started_at timestamptz;
  v_minute_index integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select s.started_at into v_started_at
  from public.lecture_sessions s
  where s.id = p_session_id
    and s.user_id = auth.uid()
    and s.status = 'recording';

  if v_started_at is null then
    raise exception 'LECTURE_NOT_RECORDING';
  end if;

  v_minute_index := least(179, greatest(0,
    floor(extract(epoch from (now() - v_started_at)) / 60)::integer
  ));

  return query
  select c.remaining_credits, c.allowed, c.charged_through
  from public.consume_lecture_credits(p_session_id, v_minute_index) as c;
end;
$$;

revoke all on function public.consume_lecture_credits_elapsed(uuid) from public, anon, authenticated;
grant execute on function public.consume_lecture_credits_elapsed(uuid) to authenticated;

-- Rate limits lived in a per-process Map, so every extra serverless instance
-- multiplied every limit. Keep the counters in Postgres instead, shared by all
-- instances. Rows are disposable; the window start doubles as the TTL.
create table if not exists public.rate_limit_counters (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);

alter table public.rate_limit_counters enable row level security;
revoke all on table public.rate_limit_counters from public, anon, authenticated;

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters (window_started_at);

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => greatest(1, p_window_seconds));
  v_started_at timestamptz;
  v_count integer;
begin
  insert into public.rate_limit_counters as c (bucket_key, window_started_at, request_count)
  values (p_key, now(), 1)
  on conflict (bucket_key) do update
    set window_started_at = case
          when c.window_started_at + v_window <= now() then now()
          else c.window_started_at
        end,
        request_count = case
          when c.window_started_at + v_window <= now() then 1
          else c.request_count + 1
        end
  returning c.window_started_at, c.request_count into v_started_at, v_count;

  if v_count > p_limit then
    return query select
      false,
      greatest(1, ceil(extract(epoch from (v_started_at + v_window - now())))::integer);
    return;
  end if;

  return query select true, 0;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;

-- Sweeps counters whose window closed over an hour ago. Safe to call from any
-- request path; it only ever removes rows no live window can still reference.
create or replace function public.purge_rate_limit_counters()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.rate_limit_counters
  where window_started_at < now() - interval '1 hour';
$$;

revoke all on function public.purge_rate_limit_counters() from public, anon, authenticated;
