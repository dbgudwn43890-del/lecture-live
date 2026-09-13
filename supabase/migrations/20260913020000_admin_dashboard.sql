-- Operator-only telemetry and atomic, attributable credit grants.
create table public.admin_credit_audit (
  request_id uuid primary key,
  actor_id uuid not null,
  user_id uuid not null,
  credits integer not null check (credits between 1 and 100000),
  days integer not null check (days between 1 and 365),
  reason text not null check (length(reason) between 3 and 200),
  created_at timestamptz not null default now()
);
alter table public.admin_credit_audit enable row level security;
revoke all on public.admin_credit_audit from public, anon, authenticated;
grant select, insert on public.admin_credit_audit to service_role;

create function public.admin_grant_credits_service(p_actor uuid, p_user uuid, p_key uuid, p_credits integer, p_days integer, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.admin_credit_audit;
begin
  if p_actor is null or p_user is null or p_key is null or p_credits is null or p_credits not between 1 and 100000
    or p_days is null or p_days not between 1 and 365 or p_reason is null or length(trim(p_reason)) not between 3 and 200 then
    raise exception 'INVALID_GRANT';
  end if;
  if not exists(select 1 from auth.users where id=p_actor and email_confirmed_at is not null) then raise exception 'INVALID_ACTOR'; end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-grant:'||p_key::text,0));
  select * into previous from public.admin_credit_audit where request_id=p_key;
  if found then
    if previous.actor_id<>p_actor or previous.user_id<>p_user or previous.credits<>p_credits or previous.days<>p_days or previous.reason<>trim(p_reason) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('replayed',true);
  end if;
  insert into public.admin_credit_audit(request_id,actor_id,user_id,credits,days,reason)
    values(p_key,p_actor,p_user,p_credits,p_days,trim(p_reason));
  insert into public.credit_grants(user_id,source_type,source_id,plan_code,granted_credits,remaining_credits,starts_at,expires_at)
    values(p_user,'service_credit','admin-'||p_key::text,'service_credit',p_credits,p_credits,now()-interval '10 seconds',now()+make_interval(days=>p_days));
  return jsonb_build_object('replayed',false);
end $$;
revoke all on function public.admin_grant_credits_service(uuid,uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.admin_grant_credits_service(uuid,uuid,uuid,integer,integer,text) to service_role;

create function public.admin_dashboard_service(p_page integer default 1,p_query text default '',p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='8s' as $$
declare result jsonb; since timestamptz;
begin
  if p_page is null or p_page not between 1 and 100000 or p_days is null or p_days not in(7,30,90) or p_query is null or length(p_query)>100 then raise exception 'INVALID_FILTER'; end if;
  since:=now()-make_interval(days=>p_days);
  with matched as (
    select u.id,u.email,left(coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',''),80) as name,
      u.created_at,u.email_confirmed_at,u.last_sign_in_at
    from auth.users u
    where p_query='' or strpos(lower(coalesce(u.email,'')),lower(p_query))>0
      or strpos(lower(coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','')),lower(p_query))>0
  ), selected as (
    select * from matched order by created_at desc,id limit 25 offset (p_page-1)*25
  ), users as (
    select s.*,coalesce(c.credits,0) as credits,l.session_count,l.last_session_at
    from selected s
    left join lateral(select sum(remaining_credits) as credits from public.credit_grants where user_id=s.id and revoked_at is null and starts_at<=now() and expires_at>now()) c on true
    left join lateral(select count(*) as session_count,max(started_at) as last_session_at from public.lecture_sessions where user_id=s.id) l on true
  )
  select jsonb_build_object(
    'generatedAt',now(),'days',p_days,'page',p_page,'pageSize',25,'total',(select count(*) from matched),
    'users',coalesce((select jsonb_agg(jsonb_build_object('id',id,'email',email,'name',name,'createdAt',created_at,'verified',email_confirmed_at is not null,'lastSignInAt',last_sign_in_at,'credits',credits,'sessionCount',session_count,'lastSessionAt',last_session_at) order by created_at desc,id) from users),'[]'::jsonb),
    'metrics',jsonb_build_object(
      'totalUsers',(select count(*) from auth.users),
      'newUsers',(select count(*) from auth.users where created_at>=since),
      'verifiedUsers',(select count(*) from auth.users where email_confirmed_at is not null),
      'activeUsers',(select count(distinct user_id) from public.lecture_sessions where started_at>=since and status in('recording','paused','completed')),
      'liveConnections',(select count(*) from public.stt_relay_sessions where connection_id is not null and expires_at>now()),
      'lectures',(select count(*) from public.lecture_sessions where started_at>=since and status in('recording','paused','completed')),
      'questions',(select count(*) from public.lecture_questions where created_at>=since),
      'notesReady',(select count(*) from public.lecture_notes where status='ready' and updated_at>=since),
      'notesFailed',(select count(*) from public.lecture_notes where status='failed' and updated_at>=since),
      'uploadsFailed',(select count(*) from public.uploads where status='failed' and created_at>=since),
      'indexPending',(select count(*) from public.lecture_index_queue where state='pending'),
      'cleanupPending',(select count(*) from public.storage_deletion_jobs),
      'cleanupRetried',(select count(*) from public.storage_deletion_jobs where attempts>=3),
      'completedOrders',(select count(*) from public.billing_orders where environment='live' and completed_at>=since),
      'failedOrders',(select count(*) from public.billing_orders where environment='live' and failed_at>=since),
      'pastDue',(select count(*) from public.billing_accounts where subscription_status='past_due'),
      'outstandingCredits',(select coalesce(sum(remaining_credits),0) from public.credit_grants where revoked_at is null and starts_at<=now() and expires_at>now()),
      'meteredMinutes',(select count(*) from public.lecture_credit_usage where created_at>=since),
      'signupClaims',(select count(*) from public.analytics_signup_receipts where claimed_at>=since)
    ),
    'attention',coalesce((select jsonb_agg(jsonb_build_object('userId',a.user_id,'email',u.email,'recordings',a.sockets_opened,'segments',a.segments_saved))
      from (select * from public.admin_abuse_signals(since) where sockets_opened>=3 and segments_saved<sockets_opened*5 order by sockets_opened desc limit 25) a join auth.users u on u.id=a.user_id),'[]'::jsonb),
    'audit',coalesce((select jsonb_agg(jsonb_build_object('requestId',a.request_id,'actorId',a.actor_id,'userId',a.user_id,'credits',a.credits,'days',a.days,'reason',a.reason,'createdAt',a.created_at) order by a.created_at desc)
      from (select * from public.admin_credit_audit order by created_at desc limit 20) a),'[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_dashboard_service(integer,text,integer) from public,anon,authenticated;
grant execute on function public.admin_dashboard_service(integer,text,integer) to service_role;
