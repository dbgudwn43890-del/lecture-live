# Lecue

현장 강의 음성을 실시간 스크립트로 만들고, 질문 시점까지의 강의 맥락으로 답하는 웹서비스입니다.

## 로컬 실행

1. `.env.example`을 복사해 `.env.local`을 만듭니다.
2. `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, Supabase URL과 Publishable Key를 입력합니다.
3. Supabase Dashboard의 **SQL Editor**에서 아래 마이그레이션을 순서대로 실행합니다.
   - `supabase/migrations/20260822000000_user_llm_credentials.sql`
   - `supabase/migrations/20260822010000_classrooms.sql`
4. **Settings → API Keys**의 backend-only Secret Key를 `.env.local`의
   `SUPABASE_SECRET_KEY`에 입력합니다. 이 키에는 `NEXT_PUBLIC_`을 붙이지 않습니다.
5. 다음 명령을 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. 마이크 입력은 Chrome 또는 Edge의 `localhost`나 HTTPS 환경에서 사용합니다.

## Supabase 인증 설정

Supabase Authentication의 Site URL은 `http://localhost:3000`, Redirect URL은 `http://localhost:3000/auth/callback`로 설정합니다. **Sign In / Providers → Email**에서 이메일 확인을 켜 두면 회원가입 때만 확인 메일이 발송되고, 이후에는 이메일과 비밀번호로 바로 로그인합니다. 공개 배포 전에는 일반 사용자에게 확인 메일을 보낼 Custom SMTP를 연결해야 합니다.

`SUPABASE_SECRET_KEY`는 RLS를 우회하는 서버 전용 키입니다. 브라우저 코드, Git, 문서,
URL 또는 채팅에 넣지 않습니다. 개인 AI 키 원문은 Vault에서 질문 요청 시에만 읽으며
브라우저로 다시 반환하지 않습니다.

## 현재 구현

- Deepgram Nova-3 한국어·영어 실시간 스크립트
- 브라우저에 장기 Deepgram 키를 노출하지 않는 임시 토큰 발급
- 질문 순간의 확정 스크립트와 임시 문장을 GPT-5.6 Luna에 전달
- 모델이 필요할 때만 사용하는 웹 검색과 출처 링크
- 답변 생성과 독립적으로 계속되는 음성 전송
- Supabase 이메일·비밀번호 회원가입, 최초 이메일 확인, 쿠키 기반 세션
- Google 로그인과 한국어·영어 로그인 복귀 경로
- OpenAI, Anthropic Claude, Google Gemini 개인 API 키의 일회성 사용 또는 Vault 암호화 저장
- 과목별 강의실, 수업 스크립트·질문 저장과 지난 수업 다시 열기
- 같은 강의실의 관련 이전 수업만 검색해 답변에 보조 맥락으로 반영
- 수업 1회 최대 3시간 자동 종료·저장
- `/en` 수동 영문 서비스와 배포 환경의 접속 국가 기반 언어 진입 경로
- 질문 및 Deepgram 임시 토큰 경로의 서버 인증과 사용자별 요청 제한
- 데스크톱 2열 및 좁은 화면 세로 배치

실제 결제와 요금제별 잔여 시간 차감, 기록 삭제, 업로드, 자동 재연결은 다음 개발 단계에서 추가합니다. 현재 베타에서는 결제가 발생하지 않습니다.

## 검증

```bash
npm run typecheck
npm run test:rate-limit
npm run test:chunks
npm run build
```

Luna 답변 평가는 실행 중인 서버를 대상으로 수행합니다.

```bash
npm run start
# 다른 터미널에서
ASK_EVAL_COOKIE='브라우저 요청의 Cookie 헤더' npm run eval:ask
```

`ASK_EVAL_COOKIE`는 로그인한 로컬 세션에서 복사해 명령 한 번에만 전달하고 파일에는 저장하지 않습니다. `eval:ask`는 8개의 합성 대표 질의로 답변 내용, 강의 인용, 검색 판단, 지연, 토큰 비용을 검사합니다. 공개 출시 게이트의 실제 강의 기반 150개 평가는 별도로 수행해야 합니다.
