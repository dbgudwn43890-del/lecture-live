-- FINAL STAGE ONLY: first apply 20260911020000, deploy the claim/complete API,
-- verify it, and drain old server requests (maxDuration 300 seconds). Old API
-- code writes as authenticated and is incompatible with this final revocation.
-- Run in one migration transaction to exclude old writes during the backfill.
lock table public.lecture_summaries in share row exclusive mode;
insert into public.lecture_summary_generations(session_id,user_id,window_index,attempts,source_characters,end_ms,completed_at)
select session_id,user_id,window_index,1,source_characters,end_ms,created_at from public.lecture_summaries
on conflict (session_id,window_index) do update set completed_at=coalesce(lecture_summary_generations.completed_at,excluded.completed_at);
-- Account for legacy successful requests made between the two stages without
-- reducing budget already charged for new API failures or in-flight requests.
insert into public.lecture_summary_daily_usage(user_id,usage_date,attempts,source_characters)
select user_id,(created_at at time zone 'UTC')::date,count(*)::integer,sum(source_characters)
from public.lecture_summaries group by user_id,(created_at at time zone 'UTC')::date
on conflict (user_id,usage_date) do update set
 attempts=greatest(lecture_summary_daily_usage.attempts,excluded.attempts),
 source_characters=greatest(lecture_summary_daily_usage.source_characters,excluded.source_characters);
revoke insert,update,delete,truncate,references,trigger on public.lecture_summaries from public,anon,authenticated;
-- A table REVOKE does not remove prior per-column grants.
do $$declare v_columns text; begin
 select string_agg(quote_ident(attname),',') into v_columns from pg_attribute
 where attrelid='public.lecture_summaries'::regclass and attnum>0 and not attisdropped;
 execute format('revoke insert (%s), update (%s), references (%s) on public.lecture_summaries from public, anon, authenticated',v_columns,v_columns,v_columns);
end;$$;
drop policy if exists lecture_summaries_owner on public.lecture_summaries;
create policy lecture_summaries_owner_read on public.lecture_summaries for select to authenticated
using (user_id=(select auth.uid()));
grant select on public.lecture_summaries to authenticated;
grant select,insert,update,delete on public.lecture_summaries to service_role;
