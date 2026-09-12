-- Only a NEW disposable database. The Python test creates a private Unix-socket
-- cluster, applies this fixture and the actual migration, then removes it.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create table public.lecture_sessions(id uuid primary key, user_id uuid not null references auth.users(id), unique(id,user_id));
create table public.material_documents(id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id), session_id uuid,
  foreign key(session_id,user_id) references public.lecture_sessions(id,user_id));
\ir ../../../supabase/migrations/20260911030000_material_upload_budget.sql

insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.lecture_sessions values
  ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111'),
  ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222');

do $$
declare
  v_user uuid := '11111111-1111-4111-8111-111111111111';
  v_session uuid := '33333333-3333-4333-8333-333333333333';
  v_claim uuid; v_second uuid; v_result jsonb;
begin
  if has_function_privilege('authenticated','public.reserve_material_upload(uuid,uuid)','execute')
      or has_function_privilege('anon','public.charge_material_upload(uuid,uuid,integer,integer,integer)','execute')
      or has_function_privilege('authenticated','public.finish_material_upload(uuid,uuid)','execute')
      or has_table_privilege('authenticated','public.material_upload_daily_budget','update') then
    raise exception 'browser can manipulate upload budget';
  end if;
  if not has_function_privilege('service_role','public.reserve_material_upload(uuid,uuid)','execute') then
    raise exception 'server cannot reserve';
  end if;
  v_result := public.reserve_material_upload('44444444-4444-4444-8444-444444444444',v_user);
  if v_result->>'reason' <> 'session_unavailable' then raise exception 'foreign session allowed'; end if;
  v_claim := (public.reserve_material_upload(v_session,v_user)->>'claim_token')::uuid;
  v_second := (public.reserve_material_upload(v_session,v_user)->>'claim_token')::uuid;
  if public.reserve_material_upload(v_session,v_user)->>'reason' <> 'busy' then raise exception 'concurrency cap missing'; end if;
  if public.charge_material_upload(v_claim,v_user,500001,100,1)->>'reason' <> 'input_limit' then raise exception 'character budget missing'; end if;
  if public.charge_material_upload(v_claim,v_user,100,250001,1)->>'reason' <> 'input_limit' then raise exception 'token budget missing'; end if;
  if public.charge_material_upload(v_claim,v_user,100,100,401)->>'reason' <> 'input_limit' then raise exception 'chunk budget missing'; end if;
  if public.charge_material_upload(v_claim,v_user,100,100,1)->>'allowed' <> 'true' then raise exception 'charge failed'; end if;
  if public.charge_material_upload(v_claim,v_user,100,100,1)->>'reason' <> 'claim_unavailable' then raise exception 'claim charged twice'; end if;
  insert into public.material_documents(id,user_id,session_id) values(v_claim,v_user,v_session);
  if (select state from public.material_upload_reservations where claim_token=v_claim) <> 'completed' then raise exception 'insert failed to consume reservation'; end if;
  perform public.finish_material_upload(v_claim,v_user);
  delete from public.material_documents where id=v_claim;
  if (select characters from public.material_upload_daily_budget where user_id=v_user) <> 100 then raise exception 'deletion refunded provider spend'; end if;
  perform public.finish_material_upload(v_second,v_user);
  perform public.finish_material_upload(v_second,v_user);
  if (select count(*) from public.material_upload_reservations where user_id=v_user and state='running') <> 0 then raise exception 'release failed'; end if;
  v_claim := (public.reserve_material_upload(v_session,v_user)->>'claim_token')::uuid;
  perform public.charge_material_upload(v_claim,v_user,100,100,1);
  update public.material_upload_reservations set lease_until=now()-interval '1 second' where claim_token=v_claim;
  begin
    insert into public.material_documents(id,user_id,session_id) values(v_claim,v_user,v_session);
    raise exception 'expired claim saved';
  exception when check_violation then null;
  end;
  -- Existing provider charges remain after a failure and cannot cross the daily cap.
  update public.material_upload_daily_budget set token_bound=999999 where user_id=v_user;
  v_second := (public.reserve_material_upload(v_session,v_user)->>'claim_token')::uuid;
  if public.charge_material_upload(v_second,v_user,100,100,1)->>'reason' <> 'daily_budget' then raise exception 'daily budget missing'; end if;
  perform public.finish_material_upload(v_second,v_user);
  raise notice 'PASS: ownership, grants, per-user concurrency, input/daily budgets, expiry, release and deletion-safe charges';
end;
$$;
