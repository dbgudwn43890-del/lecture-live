# Lecue

현장 강의 음성을 실시간 스크립트로 만들고, 질문 시점까지의 강의 맥락으로 답하는 웹서비스입니다.

## 로컬 실행

1. `.env.example`을 복사해 `.env.local`을 만듭니다.
2. `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, Supabase URL과 Publishable Key를 입력합니다.
3. Supabase Dashboard의 **SQL Editor**에서 아래 마이그레이션을 순서대로 실행합니다.
   - `supabase/migrations/20260822000000_user_llm_credentials.sql`
   - `supabase/migrations/20260822010000_classrooms.sql`
   - `supabase/migrations/20260823000000_billing_credits.sql`
   - `supabase/migrations/20260825000000_optional_classrooms.sql`
   - `supabase/migrations/20260825010000_fix_credit_consumption.sql`
   - `supabase/migrations/20260825020000_flexible_trial_term.sql`
   - `supabase/migrations/20260827000000_server_side_metering.sql`
   - `supabase/migrations/20260827010000_question_counts.sql`
   - `supabase/migrations/20260827020000_bound_ask_credit_gate.sql`
   - `supabase/migrations/20260828000000_pilot_reports.sql`
   - `supabase/migrations/20260828010000_classroom_glossary.sql`
   - `supabase/migrations/20260828020000_lecture_materials.sql`
   - `supabase/migrations/20260828030000_latency_metrics.sql`
   - `supabase/migrations/20260828040000_material_files.sql`

   목록은 `supabase/migrations/`의 파일 이름 순서와 같습니다. 새 마이그레이션이
   생기면 이 목록에도 추가하고, 기존 프로젝트에는 새로 생긴 것만 실행합니다.
   `20260828040000_material_files.sql`은 `storage.objects`에 정책을 만들기 때문에
   프로젝트 권한 설정에 따라 SQL Editor에서 거부될 수 있습니다. 그때는 Dashboard의
   **Storage → Policies**에서 `materials` 버킷에 같은 조건의 정책을 직접 만듭니다.
4. **Settings → API Keys**의 backend-only Secret Key를 `.env.local`의
   `SUPABASE_SECRET_KEY`에 입력합니다. 이 키에는 `NEXT_PUBLIC_`을 붙이지 않습니다.
5. 다음 명령을 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. 마이크 입력은 Chrome 또는 Edge의 `localhost`나 HTTPS 환경에서 사용합니다.

## Paddle 결제 설정

1. Paddle Sandbox에서 월간 상품의 반복 가격 2개와 4개월권·한 학기권의 일회성 가격을 만듭니다.
   - 월간 체험 가격: 기본 `$9.99`, 한국 `13,900 KRW` 가격 재정의, 7일 체험
   - 월간 일반 가격: 같은 가격, 체험 없음
   - 4개월권: 기본 `$35.99`, 한국 `49,900 KRW` 가격 재정의, 일회성
   - 한 학기권: 기본 `$50.99`, 한국 `70,900 KRW` 가격 재정의, 일회성
2. 월간 체험·월간 일반·4개월권·한 학기권 Price ID를 각각 `PADDLE_MONTHLY_PRICE_ID`,
   `PADDLE_MONTHLY_NO_TRIAL_PRICE_ID`, `PADDLE_TERM_PRICE_ID`, `PADDLE_SEMESTER_PRICE_ID`에 넣습니다.
3. Paddle API key, Webhook secret, Client-side token을 `.env.local`과 배포 환경 변수에 넣습니다.
   API key와 Webhook secret에는 `NEXT_PUBLIC_`을 붙이지 않습니다.
4. Paddle Checkout 설정에서 한국 결제수단을 켭니다. 한국 구매자에게는 카카오페이,
   네이버페이, 국내 카드 등이 표시되고, 해외 구매자에게는 국가·기기에 맞는 카드,
   Apple Pay, Google Pay, PayPal과 현지 결제수단이 표시됩니다.
5. 알림 대상 URL을 `https://www.lecue.app/api/billing/webhook`으로 만들고 다음 이벤트를 구독합니다.
   - `subscription.created`, `subscription.trialing`, `subscription.activated`, `subscription.updated`
   - `subscription.past_due`, `subscription.canceled`, `subscription.paused`, `subscription.resumed`
   - `transaction.completed`, `adjustment.updated`
6. Sandbox 결제, 체험 시작, 첫 과금, 취소와 환불을 확인한 뒤 production 키와 Price ID로 교체하고 재배포합니다.

결제창 완료 이벤트는 화면 안내에만 사용합니다. 크레딧은 서명이 검증된 Paddle 웹훅이
도착했을 때만 부여됩니다. 1크레딧은 시작한 녹음 1분이며 같은 수업의 같은 분은 중복
차감되지 않습니다.

## Supabase 인증 설정

Supabase Authentication의 Site URL은 `http://localhost:3000`, Redirect URL은 `http://localhost:3000/auth/callback`로 설정합니다. **Sign In / Providers → Email**에서 이메일 확인을 켜 두면 회원가입 때만 확인 메일이 발송되고, 이후에는 이메일과 비밀번호로 바로 로그인합니다. 공개 배포 전에는 일반 사용자에게 확인 메일을 보낼 Custom SMTP를 연결해야 합니다.

`SUPABASE_SECRET_KEY`는 RLS를 우회하는 서버 전용 키입니다. 브라우저 코드, Git, 문서,
URL 또는 채팅에 넣지 않습니다. 개인 AI 키 원문은 Vault에서 질문 요청 시에만 읽으며
브라우저로 다시 반환하지 않습니다.

## 현재 구현

- 강의실 실시간 스크립트는 기본값이 Cloudflare Workers AI Whisper large-v3-turbo(5초 청크,
  원가 우위). `STT_PROVIDER=deepgram`으로 Nova-3 실시간 스트리밍으로 되돌릴 수 있게 코드는
  그대로 남겨 두었습니다.
- 브라우저에 장기 Deepgram·Cloudflare 키를 노출하지 않는 서버 전용 요청
- 질문 순간의 확정 스크립트와 임시 문장을 GPT-5.6 Luna에 전달
- 모델이 필요할 때만 사용하는 웹 검색과 출처 링크
- 답변 생성과 독립적으로 계속되는 음성 전송
- Supabase 이메일·비밀번호 회원가입, 최초 이메일 확인, 쿠키 기반 세션
- Google 로그인과 한국어·영어 로그인 복귀 경로
- OpenAI, Anthropic Claude, Google Gemini 개인 API 키의 일회성 사용 또는 Vault 암호화 저장
- 강의실별 수업 관리, 미분류 수업, 스크립트·질문 저장과 지난 수업 다시 열기
- 같은 강의실의 관련 이전 수업만 검색해 답변에 보조 맥락으로 반영
- 수업 1회 최대 3시간 자동 종료·저장
- Paddle 간편결제, 여러 수업에 쓸 수 있는 7일·180크레딧 체험, 월간 구독과 4개월·한 학기권
- 결제 웹훅 기반 크레딧 부여, 1분당 1크레딧 원자적 차감과 환불 시 잔여 크레딧 회수
- `/en` 수동 영문 서비스와 배포 환경의 접속 국가 기반 언어 진입 경로
- 질문 및 Deepgram 임시 토큰 경로의 서버 인증과 사용자별 요청 제한
- 데스크톱 2열 및 좁은 화면 세로 배치

기록 삭제, 파일 업로드와 자동 재연결은 다음 개발 단계에서 추가합니다. 실제 결제를
열려면 위 Paddle·Supabase 설정과 사업자·문의 정보를 먼저 완료해야 합니다.

## 검증

```bash
npm run typecheck
npm run test:rate-limit
npm run test:chunks
npm run test:billing
npm run build
```

Luna 답변 평가는 실행 중인 서버를 대상으로 수행합니다.

```bash
npm run start
# 다른 터미널에서
ASK_EVAL_COOKIE='브라우저 요청의 Cookie 헤더' npm run eval:ask
```

`ASK_EVAL_COOKIE`는 로그인한 로컬 세션에서 복사해 명령 한 번에만 전달하고 파일에는 저장하지 않습니다. `eval:ask`는 8개의 합성 대표 질의로 답변 내용, 강의 인용, 검색 판단, 지연, 토큰 비용을 검사합니다. 공개 출시 게이트의 실제 강의 기반 150개 평가는 별도로 수행해야 합니다.
