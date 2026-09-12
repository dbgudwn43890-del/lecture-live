-- Generated rows are server-owned; parent ownership is also a DB invariant.
-- Existing mismatches abort this migration, rather than deleting learner data.
create unique index if not exists lecture_sessions_id_user_unique on public.lecture_sessions(id, user_id);
create unique index if not exists material_documents_id_user_unique on public.material_documents(id, user_id);
create unique index if not exists classrooms_id_user_unique on public.classrooms(id, user_id);

alter table public.lecture_notes add constraint lecture_notes_session_owner_fk
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade;
alter table public.lecture_chunks add constraint lecture_chunks_session_owner_fk
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade;
alter table public.material_documents add constraint material_documents_session_owner_fk
  foreign key (session_id, user_id) references public.lecture_sessions(id, user_id) on delete cascade;
alter table public.material_chunks add constraint material_chunks_document_owner_fk
  foreign key (document_id, user_id) references public.material_documents(id, user_id) on delete cascade;

-- A forged classroom must not cross the same tenant boundary. Existing optional
-- classroom FKs still handle SET NULL/cascades; deferred checks allow those actions.
alter table public.lecture_notes add constraint lecture_notes_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id) deferrable initially deferred;
alter table public.lecture_chunks add constraint lecture_chunks_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id) deferrable initially deferred;
alter table public.material_documents add constraint material_documents_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id) deferrable initially deferred;
alter table public.material_chunks add constraint material_chunks_classroom_owner_fk
  foreign key (classroom_id, user_id) references public.classrooms(id, user_id) deferrable initially deferred;

revoke insert, update, delete on public.lecture_chunks, public.material_chunks, public.lecture_notes from anon, authenticated;
revoke insert, update on public.material_documents from anon, authenticated;
drop policy if exists lecture_chunks_owner on public.lecture_chunks;
create policy lecture_chunks_owner_read on public.lecture_chunks for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists lecture_notes_owner on public.lecture_notes;
create policy lecture_notes_owner_read on public.lecture_notes for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists material_chunks_owner_insert on public.material_chunks;
drop policy if exists material_documents_owner on public.material_documents;
create policy material_documents_owner_read on public.material_documents for select to authenticated
  using (user_id = (select auth.uid()));
create policy material_documents_owner_delete on public.material_documents for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.match_lecture_chunks(
  p_user_id uuid, p_classroom_id uuid, p_session_id uuid,
  p_query_embedding extensions.vector(1536), p_match_count integer default 5
) returns table (chunk_id uuid, session_id uuid, session_title text, start_ms integer,
  end_ms integer, text text, similarity double precision)
language sql stable security definer set search_path = public, extensions as $$
  select c.id, c.session_id, s.title, c.start_ms, c.end_ms, c.text,
    1 - (c.embedding <=> p_query_embedding)
  from public.lecture_chunks c
  join public.lecture_sessions s on s.id = c.session_id and s.user_id = p_user_id
  join public.classrooms room on room.id = s.classroom_id and room.user_id = p_user_id
  where c.user_id = p_user_id and s.classroom_id = p_classroom_id
    and c.classroom_id = p_classroom_id and c.session_id <> p_session_id
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 8);
$$;
create or replace function public.match_material_chunks(
  p_user_id uuid, p_session_id uuid, p_query_embedding extensions.vector(1536),
  p_match_count integer default 4
) returns table (chunk_id uuid, document_id uuid, filename text, start_page integer,
  end_page integer, text text, similarity double precision)
language sql stable security definer set search_path = public, extensions as $$
  select c.id, c.document_id, d.filename, c.start_page, c.end_page, c.text,
    1 - (c.embedding <=> p_query_embedding)
  from public.material_chunks c
  join public.material_documents d on d.id = c.document_id and d.user_id = p_user_id
  join public.lecture_sessions s on s.id = d.session_id and s.user_id = p_user_id
  where c.user_id = p_user_id and d.session_id = p_session_id
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 6);
$$;
revoke all on function public.match_lecture_chunks(uuid, uuid, uuid, extensions.vector, integer) from public, anon, authenticated;
revoke all on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.match_lecture_chunks(uuid, uuid, uuid, extensions.vector, integer) to service_role;
grant execute on function public.match_material_chunks(uuid, uuid, extensions.vector, integer) to service_role;

-- Private owner reads remain; writes only occur in authenticated server routes.
drop policy if exists lecture_audio_owner on storage.objects;
drop policy if exists materials_owner on storage.objects;
create policy lecture_audio_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'lecture-audio' and (select auth.uid())::text = (storage.foldername(name))[1]);
create policy materials_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'materials' and (select auth.uid())::text = (storage.foldername(name))[1]);
-- Restrictive policies prevent future permissive policies reopening these writes.
create policy lecture_files_no_client_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id not in ('lecture-audio', 'materials'));
create policy lecture_files_no_client_update on storage.objects as restrictive for update to authenticated
  using (bucket_id not in ('lecture-audio', 'materials')) with check (bucket_id not in ('lecture-audio', 'materials'));
create policy lecture_files_no_client_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id not in ('lecture-audio', 'materials'));

-- No FK to users: deletion must survive account/session cascades.
create table public.storage_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('lecture-audio', 'materials')),
  object_key text not null check (length(object_key) between 1 and 1024),
  user_id uuid,
  reason text not null,
  available_at timestamptz not null default now(),
  claimed_until timestamptz,
  claim_token uuid,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (bucket, object_key)
);
alter table public.storage_deletion_jobs enable row level security;
revoke all on public.storage_deletion_jobs from public, anon, authenticated;
grant all on public.storage_deletion_jobs to service_role;
create index storage_deletion_jobs_due on public.storage_deletion_jobs(available_at, claimed_until);

create function public.enqueue_storage_deletion(
  p_bucket text, p_object_key text, p_user_id uuid, p_reason text,
  p_not_before timestamptz default now()
) returns void language sql security definer set search_path = '' as $$
  insert into public.storage_deletion_jobs(bucket, object_key, user_id, reason, available_at)
  values (p_bucket, p_object_key, p_user_id, left(p_reason, 120), coalesce(p_not_before, now()))
  on conflict (bucket, object_key) do update
    set available_at = least(public.storage_deletion_jobs.available_at, excluded.available_at);
$$;

create function public.preserve_deleted_storage_object() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_key text; v_bucket text;
begin
  if tg_table_name = 'uploads' then
    v_key := old.object_key; v_bucket := 'lecture-audio';
    if tg_op = 'UPDATE' and new.object_key is not distinct from old.object_key then return new; end if;
  else
    v_key := old.storage_path; v_bucket := 'materials';
    if tg_op = 'UPDATE' and new.storage_path is not distinct from old.storage_path then return new; end if;
  end if;
  if v_key is not null then
    perform public.enqueue_storage_deletion(v_bucket, v_key, old.user_id, 'tracking_row_removed');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger uploads_preserve_storage_deletion before delete or update of object_key on public.uploads
  for each row execute function public.preserve_deleted_storage_object();
create trigger materials_preserve_storage_deletion before delete or update of storage_path on public.material_documents
  for each row execute function public.preserve_deleted_storage_object();

create function public.schedule_storage_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_deletion_jobs(bucket, object_key, user_id, reason)
  select 'lecture-audio', u.object_key, u.user_id, 'retention_expired'
  from public.uploads u where u.object_key is not null and u.delete_at <= now()
  on conflict (bucket, object_key) do nothing;
  -- A process can stop between Storage upload and tracking-row INSERT. Allow a
  -- full day for in-flight uploads; deleted tracking rows are queued immediately.
  insert into public.storage_deletion_jobs(bucket, object_key, user_id, reason)
  select o.bucket_id, o.name, null, 'untracked_object'
  from storage.objects o
  where o.bucket_id in ('lecture-audio', 'materials') and o.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.uploads u where o.bucket_id = 'lecture-audio' and u.object_key = o.name)
    and not exists (select 1 from public.material_documents d where o.bucket_id = 'materials' and d.storage_path = o.name)
  on conflict (bucket, object_key) do nothing;
end;
$$;

create function public.claim_storage_deletions(p_limit integer default 50, p_user_id uuid default null)
returns setof public.storage_deletion_jobs language sql security definer set search_path = '' as $$
  with candidates as (
    select id from public.storage_deletion_jobs
    where available_at <= now() and (claimed_until is null or claimed_until <= now())
      and (p_user_id is null or user_id = p_user_id)
    order by available_at, id for update skip locked limit least(greatest(p_limit, 1), 100)
  )
  update public.storage_deletion_jobs j
    set claimed_until = now() + interval '5 minutes', claim_token = gen_random_uuid(), attempts = attempts + 1
  from candidates c where j.id = c.id returning j.*;
$$;
create function public.finish_storage_deletion(p_id uuid, p_token uuid, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job public.storage_deletion_jobs;
begin
  select * into v_job from public.storage_deletion_jobs where id = p_id and claim_token = p_token for update;
  if not found then return false; end if;
  if p_error is not null then
    update public.storage_deletion_jobs set last_error = left(p_error, 120), claim_token = null,
      claimed_until = null, available_at = now() + make_interval(secs => least(3600, 60 * greatest(attempts, 1)))
      where id = p_id;
    return false;
  end if;
  if v_job.bucket = 'lecture-audio' then
    update public.uploads set object_key = null, deleted_at = now()
      where object_key = v_job.object_key and (v_job.user_id is null or user_id = v_job.user_id);
  end if;
  delete from public.storage_deletion_jobs where id = p_id and claim_token = p_token;
  return true;
end;
$$;
revoke all on function public.enqueue_storage_deletion(text,text,uuid,text,timestamptz), public.preserve_deleted_storage_object(), public.schedule_storage_cleanup(), public.claim_storage_deletions(integer,uuid), public.finish_storage_deletion(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.enqueue_storage_deletion(text,text,uuid,text,timestamptz), public.schedule_storage_cleanup(), public.claim_storage_deletions(integer,uuid), public.finish_storage_deletion(uuid,uuid,text) to service_role;
