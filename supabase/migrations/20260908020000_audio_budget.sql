-- Provider work reserves real spendable credits before submission. The ledger
-- survives lecture/upload deletion, so deleting a pending lecture cannot refund
-- work already accepted by the transcription provider.
create table public.audio_credit_reservations (
  upload_id uuid primary key,
  session_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  reserved_credits integer not null check (reserved_credits between 1 and 180),
  duration_ms integer not null check (duration_ms between 1 and 10800000),
  status text not null default 'reserved' check (status in ('reserved','submitted','settled','released')),
  charged_credits integer check (charged_credits between 0 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.audio_credit_allocations (
  upload_id uuid not null references public.audio_credit_reservations(upload_id) on delete cascade,
  grant_id uuid not null references public.credit_grants(id) on delete restrict,
  credits integer not null check (credits > 0),
  charged_credits integer check (charged_credits >= 0 and charged_credits <= credits),
  primary key (upload_id,grant_id)
);
alter table public.audio_credit_reservations enable row level security;
alter table public.audio_credit_allocations enable row level security;
revoke all on public.audio_credit_reservations,public.audio_credit_allocations from public,anon,authenticated;
grant all on public.audio_credit_reservations,public.audio_credit_allocations to service_role;
create index audio_credit_reservations_pending_idx on public.audio_credit_reservations(created_at)
  where status in ('reserved','submitted');
alter table public.uploads add column callback_claimed_at timestamptz;
update storage.buckets set allowed_mime_types = array_append(allowed_mime_types,'audio/flac')
  where id='lecture-audio' and not ('audio/flac'=any(allowed_mime_types));

create function public.reserve_audio_credits_service(p_user_id uuid,p_upload_id uuid,p_duration_ms integer)
returns table(allowed boolean,credits integer)
language plpgsql security definer set search_path='' as $$
declare v_required integer; v_remaining integer; v_need integer; v_take integer; v_grant record; v_existing public.audio_credit_reservations; v_session uuid;
begin
  if p_user_id is null or p_duration_ms not between 1 and 10800000 then raise exception 'INVALID_RESERVATION'; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  select * into v_existing from public.audio_credit_reservations where upload_id=p_upload_id;
  if found then
    if v_existing.user_id<>p_user_id or v_existing.duration_ms<>p_duration_ms then raise exception 'INVALID_RESERVATION'; end if;
    return query select v_existing.status in ('reserved','submitted','settled'),v_existing.reserved_credits; return;
  end if;
  select u.session_id into v_session from public.uploads u join public.lecture_sessions s on s.id=u.session_id
    where u.id=p_upload_id and u.user_id=p_user_id and s.user_id=p_user_id and u.status='uploading';
  if v_session is null then raise exception 'UPLOAD_NOT_FOUND'; end if;
  v_required:=ceil(p_duration_ms/60000.0)::integer;
  select coalesce(sum(g.remaining_credits),0)::integer into v_remaining from public.credit_grants g
    where g.user_id=p_user_id and g.starts_at<=now() and g.expires_at>now() and g.revoked_at is null;
  if v_remaining<v_required then return query select false,v_remaining; return; end if;
  insert into public.audio_credit_reservations(upload_id,session_id,user_id,reserved_credits,duration_ms)
    values(p_upload_id,v_session,p_user_id,v_required,p_duration_ms);
  v_need:=v_required;
  for v_grant in select g.id,g.remaining_credits from public.credit_grants g
    where g.user_id=p_user_id and g.remaining_credits>0 and g.starts_at<=now() and g.expires_at>now() and g.revoked_at is null
    order by case when g.plan_code='trial' then 0 else 1 end,g.expires_at,g.created_at for update
  loop
    v_take:=least(v_need,v_grant.remaining_credits);
    insert into public.audio_credit_allocations(upload_id,grant_id,credits) values(p_upload_id,v_grant.id,v_take);
    update public.credit_grants set remaining_credits=remaining_credits-v_take,updated_at=now() where id=v_grant.id;
    v_need:=v_need-v_take; exit when v_need=0;
  end loop;
  if v_need<>0 then raise exception 'RESERVATION_INCOMPLETE'; end if;
  return query select true,v_remaining-v_required;
end $$;

-- Mark BEFORE calling the provider. An ambiguous network failure must not free
-- the reservation while the provider may still be processing the same file.
create function public.submit_audio_reservation_service(p_user_id uuid,p_upload_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  update public.audio_credit_reservations set status='submitted',updated_at=now()
    where upload_id=p_upload_id and user_id=p_user_id and status='reserved';
  return found;
end $$;

create function public.settle_audio_credits_service(p_user_id uuid,p_upload_id uuid,p_charge boolean)
returns integer language plpgsql security definer set search_path='' as $$
declare v_res public.audio_credit_reservations; v_alloc record;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-balance:'||p_user_id::text,0));
  select * into v_res from public.audio_credit_reservations where upload_id=p_upload_id and user_id=p_user_id for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_res.status in ('settled','released') then return v_res.charged_credits; end if;
  if not p_charge then
    for v_alloc in select * from public.audio_credit_allocations where upload_id=p_upload_id loop
      -- Refunds and reservations share this lock. Never restore credits revoked
      -- by a payment refund, or exceed the grant's remaining entitlement.
      update public.credit_grants g set remaining_credits=least(g.remaining_credits+v_alloc.credits,
        greatest(0,g.granted_credits-g.refunded_credits
          -(select count(*)::integer from public.lecture_credit_usage u where u.grant_id=g.id)
          -(select coalesce(sum(coalesce(a.charged_credits,a.credits)),0)::integer
            from public.audio_credit_allocations a where a.grant_id=g.id and a.upload_id<>p_upload_id))),updated_at=now()
        where g.id=v_alloc.grant_id and g.revoked_at is null;
    end loop;
  end if;
  update public.audio_credit_allocations set charged_credits=case when p_charge then credits else 0 end where upload_id=p_upload_id;
  update public.audio_credit_reservations set status=case when p_charge then 'settled' else 'released' end,
    charged_credits=case when p_charge then reserved_credits else 0 end,updated_at=now() where upload_id=p_upload_id;
  return case when p_charge then v_res.reserved_credits else 0 end;
end $$;

-- A callback lease makes duplicate delivery safe for paid embedding generation.
create function public.claim_audio_callback_service(p_upload_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.uploads set callback_claimed_at=now() where id=p_upload_id
    and status in ('uploading','queued','processing')
    and (callback_claimed_at is null or callback_claimed_at<now()-interval '5 minutes');
  return found;
end $$;

-- Crash recovery: definite pre-submit failures are refunded, submitted work is
-- settled. The upload ledger remains even if the user deleted the lecture.
create function public.sweep_audio_credit_reservations_service()
returns integer language plpgsql security definer set search_path='' as $$
declare v_res record; v_count integer:=0;
begin
  for v_res in select upload_id,user_id,status from public.audio_credit_reservations
    where status in ('reserved','submitted') and created_at<now()-interval '24 hours' order by created_at limit 100
  loop
    perform public.settle_audio_credits_service(v_res.user_id,v_res.upload_id,v_res.status='submitted');
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.reserve_audio_credits_service(uuid,uuid,integer),public.submit_audio_reservation_service(uuid,uuid),public.settle_audio_credits_service(uuid,uuid,boolean),public.claim_audio_callback_service(uuid),public.sweep_audio_credit_reservations_service() from public,anon,authenticated;
grant execute on function public.reserve_audio_credits_service(uuid,uuid,integer),public.submit_audio_reservation_service(uuid,uuid),public.settle_audio_credits_service(uuid,uuid,boolean),public.claim_audio_callback_service(uuid),public.sweep_audio_credit_reservations_service() to service_role;
