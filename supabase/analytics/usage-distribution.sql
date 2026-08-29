-- 사용 시간 분포. Supabase SQL 편집기에 그대로 붙여 넣는다.
--
-- 왜 이걸 먼저 보는가: 요금제는 월 4,200크레딧(70시간)을 팔고 있는데, 그 한도를
-- 다 쓰는 사용자의 스트리밍 정가 원가는 요금의 네 배가 넘는다. 지금은 API 후원이
-- 그 차이를 가리고 있어서, 후원이 끝나는 날 요금제가 성립하는지 아닌지가
-- 이 쿼리의 답에 달려 있다.
--
-- lecture_credit_usage는 과금된 1분마다 한 행이므로 행 수가 곧 분이다.
-- 단가는 Deepgram Nova-3 스트리밍 정가 $0.0077/분 기준. 환율은 그때 값으로 바꾼다.

with monthly as (
  select
    user_id,
    date_trunc('month', created_at) as month,
    count(*) as minutes
  from public.lecture_credit_usage
  group by 1, 2
)
select
  month,
  count(*)                                                   as active_users,
  round(avg(minutes) / 60.0, 1)                              as mean_hours,
  round(percentile_cont(0.5) within group (order by minutes) / 60.0, 1)  as median_hours,
  round(percentile_cont(0.9) within group (order by minutes) / 60.0, 1)  as p90_hours,
  round(max(minutes) / 60.0, 1)                              as max_hours,
  -- 상위 10%가 전체 분의 몇 퍼센트를 쓰는가. 이 값이 크면 평균은 안심할 근거가
  -- 못 되고, 한도를 시간이 아니라 과목 수로 바꾸는 쪽이 맞다.
  round(100.0 * sum(minutes) filter (
    where minutes >= percentile_cont(0.9) within group (order by minutes) over ()
  ) / nullif(sum(minutes), 0), 1)                            as top_decile_share_pct,
  -- 정가로 돌아갔을 때 사용자 한 명당 월 STT 원가(원). 9,900원과 직접 비교한다.
  round(avg(minutes) * 0.0077 * 1350)                        as mean_stt_cost_krw
from monthly
group by month
order by month desc;

-- 참고 1. 사용자별 상위 20명 — 후원 종료 시 누가 적자를 만드는지.
-- select user_id, count(*) as minutes, round(count(*) * 0.0077 * 1350) as stt_cost_krw
-- from public.lecture_credit_usage
-- where created_at >= date_trunc('month', now())
-- group by user_id order by minutes desc limit 20;

-- 참고 2. 세션당 질문 수 — 캐치업 도입 전후로 비교할 기준선.
-- select date_trunc('week', s.started_at) as week,
--        round(avg(q.count), 2) as questions_per_session
-- from public.lecture_sessions s
-- left join lateral (
--   select count(*) as count from public.lecture_questions q where q.session_id = s.id
-- ) q on true
-- group by week order by week desc;
