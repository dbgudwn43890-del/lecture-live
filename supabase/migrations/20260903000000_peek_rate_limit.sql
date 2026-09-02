-- 소모 없이 남은 횟수만 읽는다. 노트 패널이 "이번 시간 몇 회 남았는지"를
-- 보여주기 위한 조회 전용 함수 — consume_rate_limit과 같은 창 계산을 쓴다.
create or replace function public.peek_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (remaining integer, reset_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => greatest(1, p_window_seconds));
  v_row public.rate_limit_counters%rowtype;
begin
  select * into v_row from public.rate_limit_counters where bucket_key = p_key;
  if v_row.bucket_key is null or v_row.window_started_at + v_window <= now() then
    return query select p_limit, 0;
    return;
  end if;
  return query select
    greatest(0, p_limit - v_row.request_count),
    greatest(0, ceil(extract(epoch from (v_row.window_started_at + v_window - now())))::integer);
end;
$$;

revoke all on function public.peek_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.peek_rate_limit(text, integer, integer) to service_role;
