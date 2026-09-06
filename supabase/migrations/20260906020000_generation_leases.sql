create table public.generation_leases (
  session_id uuid not null references public.lecture_sessions(id) on delete cascade,
  kind text not null check (kind in ('note', 'summary')),
  token uuid not null,
  expires_at timestamptz not null,
  primary key (session_id, kind)
);
alter table public.generation_leases enable row level security;
revoke all on public.generation_leases from public, anon, authenticated;

create function public.claim_generation_lease(p_session_id uuid, p_kind text, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare claimed boolean;
begin
  if auth.uid() is null or not exists (
    select 1 from public.lecture_sessions where id = p_session_id and user_id = auth.uid()
  ) then raise exception 'Lecture not found' using errcode = '42501'; end if;
  insert into public.generation_leases(session_id, kind, token, expires_at)
  values (p_session_id, p_kind, p_token, now() + interval '6 minutes')
  on conflict (session_id, kind) do update
    set token = excluded.token, expires_at = excluded.expires_at
    where public.generation_leases.expires_at <= now()
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create function public.release_generation_lease(p_session_id uuid, p_kind text, p_token uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.generation_leases
  where session_id = p_session_id and kind = p_kind and token = p_token
    and exists (select 1 from public.lecture_sessions s where s.id = p_session_id and s.user_id = auth.uid());
$$;
revoke all on function public.claim_generation_lease(uuid,text,uuid) from public, anon;
revoke all on function public.release_generation_lease(uuid,text,uuid) from public, anon;
grant execute on function public.claim_generation_lease(uuid,text,uuid) to authenticated;
grant execute on function public.release_generation_lease(uuid,text,uuid) to authenticated;
