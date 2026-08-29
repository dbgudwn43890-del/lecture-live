-- ACC-02, ACC-03 (PRD 9.1, 15.2). 만 14세 이상 확인과 최초 녹음 전 고지를
-- 계정에 남긴다. 브라우저 localStorage로는 "언제, 어느 문구에 동의했는가"를
-- 증명할 수 없다 — 기기를 바꾸면 사라지고, 문구가 바뀌어도 그대로 남는다.
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- age_14: 만 14세 이상 확인. recording: 녹음 권한과 외부 AI 처리 고지.
  consent_type text not null check (consent_type in ('age_14', 'recording')),
  document_version text not null,
  accepted_at timestamptz not null default now()
);

-- 같은 문구 버전에 두 번 동의할 일은 없다. 재동의는 새 버전으로만 일어난다.
create unique index if not exists consents_user_type_version
  on public.consents (user_id, consent_type, document_version);

create index if not exists consents_user_idx on public.consents (user_id);

alter table public.consents enable row level security;

-- 동의는 남기고 읽을 수만 있다. 지우거나 시각을 고칠 수 있으면 기록이 아니다.
drop policy if exists consents_owner_read on public.consents;
create policy consents_owner_read on public.consents for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists consents_owner_insert on public.consents;
create policy consents_owner_insert on public.consents for insert to authenticated
with check ((select auth.uid()) = user_id);
