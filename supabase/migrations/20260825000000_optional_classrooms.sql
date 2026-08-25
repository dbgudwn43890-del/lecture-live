alter table public.lecture_sessions
  alter column classroom_id drop not null;
alter table public.transcript_segments
  alter column classroom_id drop not null;
alter table public.lecture_chunks
  alter column classroom_id drop not null;
alter table public.lecture_questions
  alter column classroom_id drop not null;

alter table public.lecture_sessions drop constraint if exists lecture_sessions_classroom_id_fkey;
alter table public.lecture_sessions
  add constraint lecture_sessions_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;

alter table public.transcript_segments drop constraint if exists transcript_segments_classroom_id_fkey;
alter table public.transcript_segments
  add constraint transcript_segments_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;

alter table public.lecture_chunks drop constraint if exists lecture_chunks_classroom_id_fkey;
alter table public.lecture_chunks
  add constraint lecture_chunks_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;

alter table public.lecture_questions drop constraint if exists lecture_questions_classroom_id_fkey;
alter table public.lecture_questions
  add constraint lecture_questions_classroom_id_fkey
  foreign key (classroom_id) references public.classrooms(id) on delete set null;

drop policy if exists lecture_chunks_owner_read on public.lecture_chunks;
drop policy if exists lecture_chunks_owner on public.lecture_chunks;
create policy lecture_chunks_owner on public.lecture_chunks for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists lecture_questions_owner_read on public.lecture_questions;
drop policy if exists lecture_questions_owner on public.lecture_questions;
create policy lecture_questions_owner on public.lecture_questions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.lecture_chunks to authenticated;
grant select, insert, update, delete on public.lecture_questions to authenticated;

create or replace function public.move_lecture_session(
  p_session_id uuid,
  p_classroom_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_previous_classroom_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_classroom_id is not null and not exists (
    select 1 from public.classrooms c
    where c.id = p_classroom_id and c.user_id = v_user_id
  ) then
    raise exception 'CLASSROOM_NOT_FOUND';
  end if;

  select s.classroom_id into v_previous_classroom_id
  from public.lecture_sessions s
  where s.id = p_session_id and s.user_id = v_user_id
  for update;
  if not found then return false; end if;

  update public.lecture_sessions set classroom_id = p_classroom_id
  where id = p_session_id and user_id = v_user_id;
  update public.transcript_segments set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_chunks set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.lecture_questions set classroom_id = p_classroom_id
  where session_id = p_session_id and user_id = v_user_id;
  update public.classrooms set updated_at = now()
  where user_id = v_user_id and id in (v_previous_classroom_id, p_classroom_id);
  return true;
end;
$$;

revoke all on function public.move_lecture_session(uuid, uuid) from public, anon;
grant execute on function public.move_lecture_session(uuid, uuid) to authenticated;
