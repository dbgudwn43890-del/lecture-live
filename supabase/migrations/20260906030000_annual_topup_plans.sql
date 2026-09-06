-- Annual(12개월 1회)과 Top-up(1,000크레딧 1회) 플랜 추가.
-- 두 테이블의 plan_code 체크 제약이 화이트리스트라, 코드가 새 플랜을
-- 보내면 여기서 막힌다. 제약만 넓힌다 — 데이터·함수 변경 없음.
alter table public.billing_orders
  drop constraint if exists billing_orders_plan_code_check;
alter table public.billing_orders
  add constraint billing_orders_plan_code_check
  check (plan_code in ('monthly', 'semester', 'annual', 'topup'));

alter table public.credit_grants
  drop constraint if exists credit_grants_plan_code_check;
alter table public.credit_grants
  add constraint credit_grants_plan_code_check
  check (plan_code in ('trial', 'monthly', 'term', 'semester', 'annual', 'topup', 'service_credit'));
