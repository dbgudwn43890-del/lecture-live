-- A provider connection is server-owned and may forward only prepaid PCM bytes.
create table public.stt_relay_tickets (
  token_hash text primary key check (length(token_hash)=64),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  configuration jsonb not null,
  expires_at timestamptz not null default now()+interval '30 seconds',
  consumed_at timestamptz
);
create table public.stt_relay_sessions (
  session_id uuid primary key references public.lecture_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  processed_bytes bigint not null default 0 check(processed_bytes>=0),
  authorized_bytes bigint not null default 0 check(authorized_bytes>=processed_bytes),
  connection_id uuid unique,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create index stt_relay_active_user on public.stt_relay_sessions(user_id,expires_at);
alter table public.stt_relay_tickets enable row level security;
alter table public.stt_relay_sessions enable row level security;
revoke all on public.stt_relay_tickets,public.stt_relay_sessions from anon,authenticated;
grant all on public.stt_relay_tickets,public.stt_relay_sessions to service_role;

create function public.open_stt_relay_service(p_token_hash text,p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.stt_relay_tickets; s public.stt_relay_sessions; c record; initial_bytes bigint;
begin
  select * into t from public.stt_relay_tickets where token_hash=p_token_hash;
  if not found or t.consumed_at is not null or t.expires_at<=now() then return jsonb_build_object('error','INVALID_TICKET'); end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||t.user_id::text,0));
  select * into t from public.stt_relay_tickets where token_hash=p_token_hash for update;
  if t.consumed_at is not null or t.expires_at<=now() then return jsonb_build_object('error','INVALID_TICKET'); end if;
  if not exists(select 1 from public.lecture_sessions where id=t.session_id and user_id=t.user_id and status='recording') then return jsonb_build_object('error','SESSION_ENDED'); end if;
  if exists(select 1 from public.stt_relay_sessions where user_id=t.user_id and connection_id is not null and expires_at>now()) then return jsonb_build_object('error','CONNECTION_ACTIVE'); end if;
  select coalesce(max(minute_index)+1,0)::bigint*1920000 into initial_bytes from public.lecture_credit_usage where session_id=t.session_id;
  insert into public.stt_relay_sessions(session_id,user_id,processed_bytes,authorized_bytes)
    values(t.session_id,t.user_id,initial_bytes,initial_bytes) on conflict do nothing;
  select * into s from public.stt_relay_sessions where session_id=t.session_id for update;
  -- A crashed relay may have forwarded its allowance before its final acknowledgement.
  -- Never reuse that allowance after an unacknowledged disconnect.
  if s.connection_id is not null then s.processed_bytes:=s.authorized_bytes; end if;
  if s.processed_bytes>=345600000 then return jsonb_build_object('error','SESSION_LIMIT'); end if;
  select * into c from public.consume_lecture_credits_service(t.user_id,t.session_id,(s.processed_bytes/1920000)::integer);
  if not c.allowed then return jsonb_build_object('error','NO_CREDITS'); end if;
  s.authorized_bytes:=((s.processed_bytes/1920000)+1)*1920000;
  update public.stt_relay_sessions set processed_bytes=s.processed_bytes,authorized_bytes=s.authorized_bytes,
    connection_id=p_connection_id,expires_at=now()+interval '20 seconds',updated_at=now() where session_id=t.session_id;
  update public.stt_relay_tickets set consumed_at=now() where token_hash=p_token_hash;
  delete from public.stt_relay_tickets where expires_at<now()-interval '1 hour';
  return jsonb_build_object('configuration',t.configuration,'userId',t.user_id,'sessionId',t.session_id,
    'baseBytes',s.processed_bytes,'authorizedBytes',s.authorized_bytes,'remainingCredits',c.remaining_credits,'leaseMs',20000);
end $$;

create function public.advance_stt_relay_service(p_connection_id uuid,p_processed_bytes bigint,p_extend boolean default false,p_close boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.stt_relay_sessions; c record; allowed_bytes bigint;
begin
  select * into s from public.stt_relay_sessions where connection_id=p_connection_id;
  if not found then return jsonb_build_object('error','CONNECTION_ENDED'); end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||s.user_id::text,0));
  select * into s from public.stt_relay_sessions where connection_id=p_connection_id for update;
  if not found or s.expires_at<=now() then return jsonb_build_object('error','LEASE_EXPIRED'); end if;
  if p_processed_bytes<s.processed_bytes or p_processed_bytes>s.authorized_bytes then return jsonb_build_object('error','INVALID_USAGE'); end if;
  allowed_bytes:=s.authorized_bytes;
  if p_close then
    update public.stt_relay_sessions set processed_bytes=p_processed_bytes,connection_id=null,expires_at=null,updated_at=now() where session_id=s.session_id;
    return jsonb_build_object('closed',true);
  end if;
  if not exists(select 1 from public.lecture_sessions where id=s.session_id and user_id=s.user_id and status='recording') then return jsonb_build_object('error','SESSION_ENDED'); end if;
  if p_extend then
    -- Only authorize the next minute when the current allowance is almost consumed.
    if p_processed_bytes<s.authorized_bytes-64000 then return jsonb_build_object('error','EARLY_EXTENSION'); end if;
    if s.authorized_bytes>=345600000 then return jsonb_build_object('error','SESSION_LIMIT'); end if;
    select * into c from public.consume_lecture_credits_service(s.user_id,s.session_id,(s.authorized_bytes/1920000)::integer);
    if not c.allowed then return jsonb_build_object('error','NO_CREDITS'); end if;
    allowed_bytes:=s.authorized_bytes+1920000;
  end if;
  update public.stt_relay_sessions set processed_bytes=p_processed_bytes,authorized_bytes=allowed_bytes,
    expires_at=now()+interval '20 seconds',updated_at=now() where session_id=s.session_id;
  return jsonb_build_object('authorizedBytes',allowed_bytes,'leaseMs',20000);
end $$;
revoke all on function public.open_stt_relay_service(text,uuid),public.advance_stt_relay_service(uuid,bigint,boolean,boolean) from public,anon,authenticated;
grant execute on function public.open_stt_relay_service(text,uuid),public.advance_stt_relay_service(uuid,bigint,boolean,boolean) to service_role;

-- Preserve legitimate failed-before-first-sample refunds without allowing a
-- client to reclaim a used first minute by omitting its transcript at completion.
create or replace function public.reconcile_finished_lecture_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return record;
begin
  if old.status not in ('recording', 'paused') or new.status <> 'completed' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||new.user_id::text,0));
  -- A missing/client-withheld transcript is not proof that no provider audio
  -- was processed. Only a confirmed, clean close at zero PCM can be refunded.
  -- An expired connection is still uncertain until the relay acknowledges it.
  if exists (
    select 1 from public.stt_relay_sessions r where r.session_id = new.id
      and (r.processed_bytes > 0 or r.connection_id is not null)
  ) then return new; end if;
  if new.recorded_ms = 0 and not exists (
    select 1 from public.lecture_credit_usage u
    where u.session_id = new.id and u.minute_index > 0
  ) then
    for v_return in
      select u.grant_id, count(*)::integer as credit_count
      from public.lecture_credit_usage u where u.session_id = new.id group by u.grant_id
    loop
      update public.credit_grants g
      set remaining_credits = least(g.remaining_credits + v_return.credit_count,
        greatest(0,g.granted_credits-g.refunded_credits-(select count(*)::integer
          from public.lecture_credit_usage kept where kept.grant_id=g.id and kept.session_id<>new.id))), updated_at = now()
      where g.id = v_return.grant_id;
    end loop;
    delete from public.lecture_credit_usage where session_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_finished_lecture_credits() from public, anon, authenticated;
