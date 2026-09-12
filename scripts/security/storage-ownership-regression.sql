-- Run only against the isolated synthetic fixture created by
-- scripts/security/test-storage-ownership.mjs. Never run on production data.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
insert into public.classrooms(id,user_id,title) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','A'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','B');
insert into public.lecture_sessions(id,user_id,classroom_id,title) values
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A lecture'),
 ('bbbbbbbb-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B lecture');
set local role service_role;
insert into public.material_documents(id,user_id,session_id,filename,storage_path) values
 ('aaaaaaaa-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','A.pdf','11111111-1111-4111-8111-111111111111/a.pdf');
insert into public.lecture_notes(session_id,user_id,status) values
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','ready');
-- Parent validation also applies when a service route accidentally mixes owners.
do $$begin
 begin
  insert into public.lecture_notes(session_id,user_id) values ('bbbbbbbb-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111');
  raise exception 'cross-owner note accepted';
 exception when foreign_key_violation then null; end;
 begin
  update public.lecture_notes set session_id='bbbbbbbb-0000-4000-8000-000000000001'
    where session_id='aaaaaaaa-0000-4000-8000-000000000001';
  raise exception 'cross-owner note update accepted';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.material_documents(user_id,session_id,filename) values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','bad.pdf');
  raise exception 'cross-owner document accepted';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.material_chunks(user_id,document_id,start_page,end_page,text,embedding)
  values ('22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000002',1,1,'bad',array[1.0,0.0]::real[]);
  raise exception 'cross-owner material chunk accepted';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.lecture_chunks(user_id,session_id,start_ms,end_ms,text,embedding)
  values ('11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001',0,1000,'bad',array[1.0,0.0]::real[]);
  raise exception 'cross-owner lecture chunk accepted';
 exception when foreign_key_violation then null; end;
end$$;
insert into public.material_chunks(user_id,document_id,start_page,end_page,text,embedding)
 values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002',1,1,'normal',array[1.0,0.0]::real[]);
do $$begin
 assert (select count(*)=1 from public.match_material_chunks('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',array[1.0,0.0]::real[],4)), 'own search must work';
 assert (select count(*)=0 from public.match_material_chunks('22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001',array[1.0,0.0]::real[],4)), 'foreign search must be empty';
end$$;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$begin
 assert (select count(*)=1 from public.lecture_notes), 'normal owner read must work';
 begin insert into public.lecture_notes(session_id,user_id) values ('bbbbbbbb-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111'); raise exception 'browser note write accepted'; exception when insufficient_privilege then null; end;
 begin delete from public.lecture_chunks; raise exception 'browser chunk delete accepted'; exception when insufficient_privilege then null; end;
 begin insert into storage.objects(bucket_id,name) values ('materials','11111111-1111-4111-8111-111111111111/bypass.pdf'); raise exception 'browser material upload accepted'; exception when insufficient_privilege then null; end;
 begin insert into storage.objects(bucket_id,name) values ('lecture-audio','11111111-1111-4111-8111-111111111111/bypass.wav'); raise exception 'browser audio upload accepted'; exception when insufficient_privilege then null; end;
 begin perform public.claim_storage_deletions(); raise exception 'browser queue access accepted'; exception when insufficient_privilege then null; end;
end$$;
set local request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$begin assert (select count(*)=0 from public.lecture_notes), 'foreign note read'; end$$;
set local role service_role;
insert into storage.objects(bucket_id,name) values ('materials','11111111-1111-4111-8111-111111111111/a.pdf'), ('lecture-audio','11111111-1111-4111-8111-111111111111/a.wav');
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$declare changed integer; begin
 assert (select count(*)=2 from storage.objects), 'owner private object reads remain available';
 update storage.objects set name='11111111-1111-4111-8111-111111111111/changed.pdf' where bucket_id='materials';
 get diagnostics changed = row_count;
 assert changed=0, 'browser object update must change no rows';
 delete from storage.objects where bucket_id='lecture-audio';
 get diagnostics changed = row_count;
 assert changed=0, 'browser object delete must change no rows';
end$$;
set local role service_role;
insert into public.uploads(session_id,user_id,idempotency_key,object_key,status,filename,byte_size)
 values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','normal','11111111-1111-4111-8111-111111111111/a.wav','processing','a.wav',42);
-- Deleting the session captures both paths atomically before cascade discards rows.
delete from public.lecture_sessions where id='aaaaaaaa-0000-4000-8000-000000000001';
do $$declare job public.storage_deletion_jobs; begin
 assert (select count(*)=2 from public.storage_deletion_jobs), 'session cascade must enqueue PDF and audio';
 select * into job from public.claim_storage_deletions(1);
 assert job.id is not null, 'worker must claim job';
 assert (select count(*)=1 from public.claim_storage_deletions(10)), 'claimed job cannot be claimed twice';
 perform public.finish_storage_deletion(job.id,job.claim_token,'storage_error');
 assert (select count(*)=2 from public.storage_deletion_jobs), 'failure retains paths';
 assert (select last_error='storage_error' and claim_token is null from public.storage_deletion_jobs where id=job.id), 'failure must retry';
end$$;
-- Expiration cleanup does not depend on a learner visiting GET /lecture-audio.
insert into public.uploads(session_id,user_id,idempotency_key,object_key,status,filename,byte_size,delete_at)
 values ('bbbbbbbb-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','expired','22222222-2222-4222-8222-222222222222/expired.wav','failed','expired.wav',42,now()-interval '1 second');
insert into storage.objects(bucket_id,name,created_at) values ('materials','untracked/old.pdf',now()-interval '25 hours'),('materials','untracked/new.pdf',now());
select public.schedule_storage_cleanup();
do $$declare job public.storage_deletion_jobs; begin
 assert (select count(*)=1 from public.storage_deletion_jobs where reason='retention_expired'), 'expired audio scheduled';
 assert (select count(*)=1 from public.storage_deletion_jobs where reason='untracked_object'), 'old orphan scheduled, fresh upload preserved';
 select * into job from public.claim_storage_deletions(10,'22222222-2222-4222-8222-222222222222');
 assert (select object_key is not null and deleted_at is null from public.uploads where idempotency_key='expired'), 'tracking retained before confirmed Storage deletion';
 assert public.finish_storage_deletion(job.id,job.claim_token,null), 'acknowledged delete succeeds';
 assert (select object_key is null and deleted_at is not null from public.uploads where idempotency_key='expired'), 'tracking cleared only after success';
 assert (select count(*)=0 from public.storage_deletion_jobs where id=job.id), 'successful job removed';
end$$;
rollback;
\echo 'PASS: ownership, server-only writes, cascade queue, retry leases, expiry and orphan cleanup'
