begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000007','generation-test@example.invalid');
insert into public.classrooms(id,user_id,title) values('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000007','Test');
insert into public.lecture_sessions(id,classroom_id,user_id,title) values('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000007','Test');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',true);
do $$
declare s uuid := '00000000-0000-4000-8000-000000000007'; a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
begin
  if not public.claim_generation_lease(s,'note',a) then raise exception 'First claim failed'; end if;
  if public.claim_generation_lease(s,'note',b) then raise exception 'Duplicate claim allowed'; end if;
  if not public.claim_generation_lease(s,'summary',a) then raise exception 'Independent work blocked'; end if;
  perform public.release_generation_lease(s,'note',b);
  if public.claim_generation_lease(s,'note',b) then raise exception 'Wrong token released lease'; end if;
  update public.generation_leases set expires_at=now()-interval '1 second' where session_id=s and kind='note';
  if not public.claim_generation_lease(s,'note',b) then raise exception 'Stale recovery failed'; end if;
  perform public.release_generation_lease(s,'note',a);
  if public.claim_generation_lease(s,'note',a) then raise exception 'Old request released new lease'; end if;
  perform public.release_generation_lease(s,'note',b);
  if not public.claim_generation_lease(s,'note',a) then raise exception 'Release failed'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000008',true);
  begin
    perform public.claim_generation_lease(s,'note',b);
    raise exception 'Non-owner accepted';
  exception when insufficient_privilege then null; end;
  if has_table_privilege('authenticated','public.generation_leases','INSERT') then raise exception 'Direct writes allowed'; end if;
  if has_function_privilege('anon','public.claim_generation_lease(uuid,text,uuid)','EXECUTE') then raise exception 'Anonymous claim allowed'; end if;
  raise notice 'PASS: duplicate exclusion, independent jobs, expiry, token fencing, ownership, permissions';
end $$;
rollback;
