# Lecture Live

현장 강의 음성을 실시간 스크립트로 만들고, 질문 시점까지의 강의 맥락으로 답하는 웹서비스입니다.

## 로컬 실행

1. `.env.example`을 복사해 `.env.local`을 만듭니다.
2. `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, Supabase URL과 Publishable Key를 입력합니다.
3. 다음 명령을 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. 마이크 입력은 Chrome 또는 Edge의 `localhost`나 HTTPS 환경에서 사용합니다.

## Supabase 인증 설정

Supabase Authentication의 Site URL은 `http://localhost:3000`, Redirect URL은 `http://localhost:3000/auth/callback`로 설정합니다. SSR 매직링크를 쓰려면 **Email Templates → Magic Link**의 링크를 아래처럼 지정합니다.

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">로그인</a>
```

## 현재 구현

- Deepgram Nova-3 한국어 실시간 스크립트
- 브라우저에 장기 Deepgram 키를 노출하지 않는 임시 토큰 발급
- 질문 순간의 확정 스크립트와 임시 문장을 GPT-5.6 Luna에 전달
- 모델이 필요할 때만 사용하는 웹 검색과 출처 링크
- 답변 생성과 독립적으로 계속되는 음성 전송
- Supabase 이메일 로그인과 쿠키 기반 세션
- 질문 및 Deepgram 임시 토큰 경로의 서버 인증과 사용자별 요청 제한
- 데스크톱 2열 및 좁은 화면 세로 배치

강의 데이터베이스 저장, 결제, 업로드, 자동 재연결은 다음 개발 단계에서 추가합니다.

## 검증

```bash
npm run typecheck
npm run test:rate-limit
npm run build
```

Luna 답변 평가는 실행 중인 서버를 대상으로 수행합니다.

```bash
npm run start
# 다른 터미널에서
ASK_EVAL_COOKIE='브라우저 요청의 Cookie 헤더' npm run eval:ask
```

`ASK_EVAL_COOKIE`는 로그인한 로컬 세션에서 복사해 명령 한 번에만 전달하고 파일에는 저장하지 않습니다. `eval:ask`는 8개의 합성 대표 질의로 답변 내용, 강의 인용, 검색 판단, 지연, 토큰 비용을 검사합니다. 공개 출시 게이트의 실제 강의 기반 150개 평가는 별도로 수행해야 합니다.
