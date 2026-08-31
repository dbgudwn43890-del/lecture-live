-- Material extraction runs through the signed-in user's server client.
-- Documents already permit owner writes; chunks need the same insert path.
drop policy if exists material_chunks_owner_insert on public.material_chunks;
create policy material_chunks_owner_insert on public.material_chunks for insert to authenticated
with check ((select auth.uid()) = user_id);

grant insert on public.material_chunks to authenticated;
