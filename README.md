# Lecture Live

현장 강의 음성을 실시간 스크립트로 만들고, 질문 시점까지의 강의 맥락으로 답하는 웹서비스입니다.

## 로컬 실행

1. `.env.example`을 복사해 `.env.local`을 만듭니다.
2. `DEEPGRAM_API_KEY`와 `OPENAI_API_KEY`를 입력합니다.
3. 다음 명령을 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. 마이크 입력은 Chrome 또는 Edge의 `localhost`나 HTTPS 환경에서 사용합니다.

## 현재 구현

- Deepgram Nova-3 한국어 실시간 스크립트
- 브라우저에 장기 Deepgram 키를 노출하지 않는 임시 토큰 발급
- 질문 순간의 확정 스크립트와 임시 문장을 GPT-5.6 Luna에 전달
- 모델이 필요할 때만 사용하는 웹 검색과 출처 링크
- 답변 생성과 독립적으로 계속되는 음성 전송
- 데스크톱 2열 및 좁은 화면 세로 배치

인증, 데이터베이스 저장, 결제, 업로드, 자동 재연결은 다음 개발 단계에서 추가합니다.
