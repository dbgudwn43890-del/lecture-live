-- Final transcript acknowledgements, inactive-session recovery, and durable indexing.
-- Every recording mutation takes the same account lock as relay open/advance.
create table public.lecture_index_queue (
  session_id uuid primary key references public.lecture_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','completed')),
  segment_count integer not null default 0 check (segment_count between 0 and 50000),
  updated_at timestamptz not null default now()
);
alter table public.lecture_index_queue enable row level security;
revoke all on public.lecture_index_queue from public, anon, authenticated;
grant all on public.lecture_index_queue to service_role;
create index lecture_index_queue_pending on public.lecture_index_queue(user_id,updated_at) where state='pending';
alter table public.lecture_index_jobs add column source_segment_count integer not null default 0;

create function public.queue_lecture_index_service(p_session_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if not exists(select 1 from public.lecture_sessions where id=p_session_id and user_id=p_user_id and status='completed') then return false; end if;
  select count(*) into v_count from public.transcript_segments where session_id=p_session_id and user_id=p_user_id;
  if v_count>50000 then raise exception 'TRANSCRIPT_LIMIT'; end if;
  insert into public.lecture_index_queue(session_id,user_id,segment_count,state)
    values(p_session_id,p_user_id,v_count,case when v_count=0 then 'completed' else 'pending' end)
    on conflict(session_id) do update set segment_count=excluded.segment_count,
      state=case when public.lecture_index_queue.segment_count<>excluded.segment_count then 'pending' else public.lecture_index_queue.state end,
      updated_at=case when public.lecture_index_queue.segment_count<>excluded.segment_count then now() else public.lecture_index_queue.updated_at end;
  return true;
end $$;

create function public.recover_lecture_session_service(p_session_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.lecture_sessions; r public.stt_relay_sessions; v_ms integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  select * into s from public.lecture_sessions where id=p_session_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('error','SESSION_NOT_FOUND'); end if;
  -- Pending tickets cover the interval between token issuance and relay open.
  if exists(select 1 from public.stt_relay_sessions where session_id=s.id and connection_id is not null and expires_at>now())
    or exists(select 1 from public.stt_relay_tickets where session_id=s.id and consumed_at is null and expires_at>now()) then
    return jsonb_build_object('status',s.status,'recordedMs',s.recorded_ms,'activeRecording',true);
  end if;
  if s.status='recording' then
    select * into r from public.stt_relay_sessions where session_id=s.id and user_id=p_user_id;
    -- An expired connection may have forwarded its full paid allowance. Keep
    -- its connection marker so the next open cannot reuse those paid bytes.
    if found then
      v_ms:=least(10800000,ceil((case when r.connection_id is null then r.processed_bytes else r.authorized_bytes end)/32.0)::integer);
    else
      v_ms:=least(10800000,s.recorded_ms+greatest(0,floor(extract(epoch from(now()-coalesce(s.recording_started_at,s.started_at)))*1000))::bigint);
    end if;
    update public.lecture_sessions set status='paused',recording_started_at=null,recorded_ms=v_ms,duration_seconds=ceil(v_ms/1000.0)::integer where id=s.id returning * into s;
  end if;
  return jsonb_build_object('status',s.status,'recordedMs',s.recorded_ms,'activeRecording',false);
end $$;

create function public.save_lecture_final_service(p_session_id uuid,p_user_id uuid,p_segments jsonb,p_complete boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  s public.lecture_sessions; r public.stt_relay_sessions; v_relay boolean;
  v_elapsed bigint; v_recorded integer; v_tail integer; v_count integer; v_added integer;
  v_ack jsonb; v_segment record; v_charge record; v_paid_upload_ms integer;
begin
  if p_user_id is null or p_complete is null or jsonb_typeof(p_segments)<>'array' or jsonb_array_length(p_segments)>250 then
    return jsonb_build_object('error','INVALID_SEGMENTS');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  select * into s from public.lecture_sessions where id=p_session_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('error','SESSION_NOT_FOUND'); end if;
  if s.status not in ('recording','paused','completed') then return jsonb_build_object('error','SESSION_UNAVAILABLE'); end if;
  if exists(select 1 from public.stt_relay_sessions where session_id=s.id and connection_id is not null and expires_at>now())
    or exists(select 1 from public.stt_relay_tickets where session_id=s.id and consumed_at is null and expires_at>now()) then
    return jsonb_build_object('error','RECORDING_ALREADY_ACTIVE');
  end if;
  select * into r from public.stt_relay_sessions where session_id=s.id and user_id=p_user_id;
  v_relay:=found;
  v_elapsed:=least(10800000,s.recorded_ms+case when s.status='recording' then greatest(0,floor(extract(epoch from(now()-coalesce(s.recording_started_at,s.started_at)))*1000))::bigint else 0 end);
  if v_relay then
    v_recorded:=least(10800000,ceil((case when r.connection_id is null then r.processed_bytes else r.authorized_bytes end)/32.0)::integer);
  else v_recorded:=v_elapsed; end if;
  select coalesce(max(least(duration_ms,charged_credits*60000)),0) into v_paid_upload_ms from public.audio_credit_reservations
    where session_id=s.id and user_id=p_user_id and status='settled';
  for v_segment in select * from jsonb_to_recordset(p_segments) as x(id text,"startMs" numeric,"endMs" numeric,text text) loop
    if v_segment.id is null or length(v_segment.id) not between 1 and 2200
      or v_segment."startMs" is null or v_segment."endMs" is null
      or v_segment."startMs"<0 or v_segment."endMs"<v_segment."startMs" or v_segment."endMs">10800000
      or v_segment.text is null or length(btrim(v_segment.text)) not between 1 and 2000 then
      return jsonb_build_object('error','INVALID_SEGMENTS');
    end if;
    if exists(select 1 from public.transcript_segments t where t.session_id=s.id and t.client_id=v_segment.id) then
      -- Existing IDs are acknowledgements, never a way to rewrite paid history.
      if not exists(select 1 from public.transcript_segments t where t.session_id=s.id and t.client_id=v_segment.id
        and t.start_ms=round(v_segment."startMs") and t.end_ms=round(v_segment."endMs") and t.text=btrim(v_segment.text)) then
        return jsonb_build_object('error','SEGMENT_CONFLICT');
      end if;
    else
      if s.status='completed' and (
        round(v_segment."endMs")>greatest(s.recorded_ms,v_recorded)
        or (round(v_segment."endMs")>v_paid_upload_ms and exists(
          select 1 from generate_series(floor(v_segment."startMs"/60000)::integer,
            greatest(floor(v_segment."startMs"/60000)::integer,ceil(v_segment."endMs"/60000)::integer-1)) minute
          where not exists(select 1 from public.lecture_credit_usage u where u.session_id=s.id and u.user_id=p_user_id and u.minute_index=minute)
        ))
      ) then return jsonb_build_object('error','RECOVERY_OUTSIDE_PAID_RECORDING'); end if;
    end if;
  end loop;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_segments) x)<>jsonb_array_length(p_segments) then
    return jsonb_build_object('error','INVALID_SEGMENTS');
  end if;
  select count(*) into v_count from public.transcript_segments where session_id=s.id;
  select count(*) into v_added from jsonb_array_elements(p_segments) x where not exists(
    select 1 from public.transcript_segments t where t.session_id=s.id and t.client_id=x->>'id');
  if v_count+v_added>50000 then return jsonb_build_object('error','TRANSCRIPT_LIMIT'); end if;
  insert into public.transcript_segments(session_id,classroom_id,user_id,client_id,start_ms,end_ms,text)
    select s.id,s.classroom_id,p_user_id,x.id,round(x."startMs"),round(x."endMs"),btrim(x.text)
    from jsonb_to_recordset(p_segments) as x(id text,"startMs" numeric,"endMs" numeric,text text)
    on conflict(session_id,client_id) do nothing;
  if p_complete and s.status in ('recording','paused') then
    if not v_relay then
      select coalesce(max(end_ms),0) into v_tail from public.transcript_segments where session_id=s.id;
      v_recorded:=case when v_count+v_added=0 then 0 when v_tail>0 then least(v_elapsed,v_tail+60000) else v_elapsed end;
      if v_recorded>0 then
        select * into v_charge from public.consume_lecture_credits_service(p_user_id,s.id,least(179,greatest(0,ceil(v_recorded/60000.0)::integer-1)));
      end if;
    end if;
    update public.lecture_sessions set status='completed',ended_at=now(),duration_seconds=ceil(v_recorded/1000.0)::integer,
      recorded_ms=v_recorded,recording_started_at=null where id=s.id returning * into s;
  end if;
  -- The queue write shares the transcript/completion transaction: no success
  -- can escape if the durable work could not be recorded.
  if s.status='completed' then perform public.queue_lecture_index_service(s.id,p_user_id); end if;
  select coalesce(jsonb_agg(x->>'id'),'[]'::jsonb) into v_ack from jsonb_array_elements(p_segments) x;
  return jsonb_build_object('saved',true,'completed',s.status='completed','acknowledgedSegmentIds',v_ack,
    'session',to_jsonb(s)-'user_id'-'start_request_id'-'recording_started_at',
    'indexingPending',coalesce((select state='pending' from public.lecture_index_queue where session_id=s.id),false));
end $$;

-- A queue survives process termination. Existing partial legacy indexes are
-- revisited once through the same three-attempt and daily paid-work budget.
insert into public.lecture_index_queue(session_id,user_id,segment_count)
  select s.id,s.user_id,count(t.id) from public.lecture_sessions s join public.transcript_segments t on t.session_id=s.id
  where s.status='completed' group by s.id,s.user_id having count(t.id)<=50000;

create or replace function public.reserve_lecture_index(p_session_id uuid,p_user_id uuid,p_characters integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.lecture_index_jobs; v_paid_minutes integer; v_used integer; v_count integer;
  v_day date:=(now() at time zone 'UTC')::date; v_token uuid:=gen_random_uuid();
begin
  if p_user_id is null or p_characters is null or p_characters not between 1 and 500000 then return jsonb_build_object('allowed',false,'reason','input_limit'); end if;
  perform pg_advisory_xact_lock(hashtextextended('lecture-index:'||p_user_id::text,0));
  if not exists(select 1 from public.lecture_sessions where id=p_session_id and user_id=p_user_id and status='completed') then return jsonb_build_object('allowed',false,'reason','session_unavailable'); end if;
  select (count(*)+coalesce((select sum(r.charged_credits) from public.audio_credit_reservations r where r.session_id=p_session_id and r.user_id=p_user_id and r.status='settled'),0))::integer
    into v_paid_minutes from public.lecture_credit_usage where session_id=p_session_id and user_id=p_user_id;
  if v_paid_minutes=0 or p_characters>v_paid_minutes*6000 then return jsonb_build_object('allowed',false,'reason','unfunded_input'); end if;
  select count(*) into v_count from public.transcript_segments where session_id=p_session_id and user_id=p_user_id;
  select * into v_job from public.lecture_index_jobs where session_id=p_session_id for update;
  if found and ((v_job.state='completed' and v_job.source_segment_count>=v_count) or v_job.attempts>=3
    or (v_job.state='running' and v_job.lease_until>now())) then return jsonb_build_object('allowed',false,'reason','already_claimed'); end if;
  insert into public.lecture_index_daily_budget(user_id,day,characters) values(p_user_id,v_day,0) on conflict do nothing;
  select characters into v_used from public.lecture_index_daily_budget where user_id=p_user_id and day=v_day for update;
  if v_used+p_characters>2000000 then return jsonb_build_object('allowed',false,'reason','daily_budget'); end if;
  update public.lecture_index_daily_budget set characters=characters+p_characters where user_id=p_user_id and day=v_day;
  insert into public.lecture_index_jobs(session_id,user_id,state,attempts,claim_token,lease_until,characters,source_segment_count)
    values(p_session_id,p_user_id,'running',1,v_token,now()+interval '5 minutes',p_characters,v_count)
    on conflict(session_id) do update set state='running',attempts=public.lecture_index_jobs.attempts+1,
      claim_token=excluded.claim_token,lease_until=excluded.lease_until,characters=excluded.characters,source_segment_count=v_count,updated_at=now();
  return jsonb_build_object('allowed',true,'claim_token',v_token);
end $$;

create function public.replace_lecture_index_service(p_session_id uuid,p_user_id uuid,p_claim_token uuid,p_segment_count integer,p_chunks jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_job public.lecture_index_jobs;
begin
  -- Serializes a recovered final batch with index commit without reversing
  -- relay/credit lock order. Reserve releases its transaction before this.
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('lecture-index:'||p_user_id::text,0));
  select * into v_job from public.lecture_index_jobs where session_id=p_session_id and user_id=p_user_id for update;
  if not found or v_job.state<>'running' or v_job.claim_token<>p_claim_token or v_job.lease_until<=now() then return false; end if;
  if v_job.source_segment_count<>p_segment_count or p_segment_count<>(select count(*) from public.transcript_segments where session_id=p_session_id and user_id=p_user_id) then
    update public.lecture_index_jobs set state='failed',updated_at=now() where session_id=p_session_id; return false;
  end if;
  delete from public.lecture_chunks where session_id=p_session_id and user_id=p_user_id;
  insert into public.lecture_chunks(session_id,classroom_id,user_id,start_ms,end_ms,text,embedding)
    select s.id,s.classroom_id,p_user_id,x.start_ms,x.end_ms,x.text,x.embedding::extensions.vector
    from public.lecture_sessions s cross join jsonb_to_recordset(p_chunks) as x(start_ms integer,end_ms integer,text text,embedding text)
    where s.id=p_session_id and s.user_id=p_user_id and s.status='completed';
  update public.lecture_index_jobs set state='completed',updated_at=now() where session_id=p_session_id;
  update public.lecture_index_queue set state='completed',updated_at=now() where session_id=p_session_id and segment_count=p_segment_count;
  return true;
end $$;

revoke all on function public.queue_lecture_index_service(uuid,uuid),public.recover_lecture_session_service(uuid,uuid),
  public.save_lecture_final_service(uuid,uuid,jsonb,boolean),public.replace_lecture_index_service(uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.queue_lecture_index_service(uuid,uuid),public.recover_lecture_session_service(uuid,uuid),
  public.save_lecture_final_service(uuid,uuid,jsonb,boolean),public.replace_lecture_index_service(uuid,uuid,uuid,integer,jsonb) to service_role;
