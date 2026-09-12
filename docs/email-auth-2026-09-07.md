# 이메일 가입·로그인 — 2026-09-07

## 요구사항

- 기존 Google 로그인 유지.
- 이메일 + 비밀번호로 가입하고, 최초 이메일 인증을 완료한 뒤 이용 가능.
- 이후에는 이메일 + 비밀번호로 로그인.
- 한영 UI, 모바일, 오류·재전송·비밀번호 재설정까지 하나의 흐름으로 제공.

## 구현 완료

- `app/login/page.tsx`, `login.css`: 로그인/회원가입, 8자리 인증번호, 비밀번호 찾기/변경, 완료 화면. 비밀번호 표시 전환, 붙여넣기·자동완성 지원.
- 재전송 대기는 요청 시각을 기준으로 60초. 새로고침·언어 변경으로 대기를 초기화하지 않음.
- 인증 진행 상태만 sessionStorage에 저장. 비밀번호·인증번호는 저장하지 않음.
- 비밀번호 복구 인증 후 새로고침·언어 변경 시 `getUser()`의 인증 이메일과 사용자 ID를 재검증한 뒤 새 비밀번호 화면 복원. 복구 힌트는 인증 권한으로 사용하지 않음.
- `app/lib/email-auth.ts`: 검증·가입·로그인·재전송·비밀번호 복구/변경 및 한영 오류 분류. HTTP 5xx 메일 발송 실패를 사용자 네트워크 오류로 오인하지 않음.
- 예상하지 않은 가입 즉시 세션은 로그아웃 처리. 미인증 사용자·다른 이메일·일치하지 않는 세션 사용자 거부.
- `verified-email.ts`: Supabase가 확인한 `email_confirmed_at`만 신뢰. 사용자 수정 가능 metadata를 인증 근거로 사용하지 않음.
- 공통 인증 함수, 직접 `getUser()`를 호출하는 API, 한영 강의실 페이지에서 미인증·익명 사용자 거부.
- 무료 크레딧 지급 직전에 관리자 API로 동일 사용자의 인증 상태를 재검증. 기존 중복 지급 방지 및 현재 600 credits 설정 유지.
- 인증 callback은 지원하는 이메일 확인 타입만 처리. recovery callback은 복구 화면으로 연결. Google PKCE와 안전한 next/언어 보존 유지.

## 외부 설정

Supabase 프로젝트 `pltfsehykwuefyfldhng`:

- Email provider ON, Confirm email ON, anonymous sign-in OFF.
- 비밀번호 최소 길이 6 → 8자로 저장. OTP 8자리, 유효기간 3600초.
- 가입·복구 메일을 Lecue 한영 인증번호 템플릿으로 저장. `{{ .Token }}` 사용, 로그인/복구 링크 자동 진입 없음.
- 템플릿 원본: `supabase/templates/confirmation.html`, `recovery.html`.
- SMTP: `smtp.resend.com:465`, username `resend`, sender `Lecue <noreply@lecue.app>`, 최소 전송 간격 60초. 기존 저장된 SMTP 비밀값은 변경하지 않음.
- 기존 로컬 Resend 키로 SMTP 인증 결과 235(성공). 키 값은 출력·기록하지 않음.

Cloudflare `lecue.app` DNS에서 다음 두 레코드가 누락되어 있었음. 2026-09-07 18:07 전후 KST 복구, DNS only, Auto TTL:

| 유형 | 이름 | 대상 |
| --- | --- | --- |
| CNAME | send | send.forge.rmta.net |
| CNAME | rsend | rsend.forge.rmta.net |

기존 웹사이트 A/CNAME, 수신용 Cloudflare MX/SPF, Google 확인 TXT, Resend DKIM은 유지. 권한 있는 Cloudflare 화면에서 9 → 11개 레코드 저장 확인. 권한 DNS 조회 및 CNAME 대상의 SPF/MX 응답 확인.

Resend에서 Restart verification 실행. DNS verified 18:08 KST, Domain verified 18:22 KST. 최종 상태 **Verified**, DKIM 및 두 CNAME 모두 Verified, sending enabled 확인. 기존 API 키 변경 없이 발송 정상화.

## 검증

- 자동 테스트 265개 통과, Next production build 통과, git diff --check 통과.
- Chrome에서 실제 로그인 UI 확인. 외부 인증을 호출하지 않는 임시 화면으로 가입·인증·만료 오류·재전송 대기·복구·완료 상태 검수.
- 인증 및 새 비밀번호 단계에서 새로고침·한영 전환 유지 확인.
- 320px/390px 모바일 및 데스크톱, 밝은/어두운 테마 확인. 가로 넘침 없음. 긴 이메일 줄바꿈과 인증번호 접근성 라벨 개선.
- 임시 `auth-ui-check` 경로 두 개는 검수 후 삭제. proxy의 인증 정책은 변경하지 않음. 브라우저 크기 설정 복원.
- 사용자 승인된 테스트 별칭으로 실제 가입 메일 요청 1회. Supabase는 500, 인증 로그의 원인은 Resend SMTP 550 "domain is not verified". **메일 수신 성공으로 간주하지 않음.** 세션 미발급 확인.
- 메일 전송 없이 관리자 `generateLink`로 테스트 계정의 일회용 코드를 발급하여 **실제 공개 인증 API**의 동작 확인: 인증 전 비밀번호 로그인 거부, 가입 OTP 인증 성공, 이후 비밀번호 로그인 성공, recovery OTP 인증·비밀번호 변경·변경 후 로그인 성공. 일반 사용자 인증 흐름에는 관리자 API를 사용하지 않음.

## 실제 메일 및 운영 검증 완료

- 승인된 테스트 별칭으로 총 3회 발송 요청: 최초 1회는 검증 전 SMTP 거절, 이후 복구 메일과 가입 메일 **2통 모두 Resend delivered** 확인. Gmail 수신 서버 전달 확인이며, 받은편지함/스팸함 위치는 확인하지 않음.
- 복구 메일: `a9da9308-485f-4e18-8aff-45c4a63fccf7`.
- 가입 메일: `7c7cb535-31b8-4d78-877b-fffedd6160a2`.
- 운영 Chrome UI에서 새 테스트 계정 가입 → 인증 전 `email_confirmed_at` 없음 확인 → 발송된 가입 메일의 실제 OTP 입력 → 확인 상태 및 강의실 진입 → 로그아웃 → 이메일·비밀번호만으로 재로그인 성공.
- 복구 API·OTP·비밀번호 변경은 앞서 실제 Supabase 서버에서 통합 검증했고, 복구 메일 전달도 별도로 확인함. 실제 복구 메일의 OTP를 사용자 화면에서 입력하는 검증은 추가 발송 한도를 지키기 위해 반복하지 않음.
- 검증용 계정 2개(같은 별칭을 순차 재생성)는 각각 삭제. 최종 브라우저 테스트 세션 로그아웃, `/tmp/lecue-email-auth-live-state.json` 삭제 및 메모리 내 임시 인증번호·비밀번호 정리. 기존 Google 계정의 비밀번호·데이터는 변경하지 않음.

## 배포 완료

- 2026-09-07 18:30 KST 운영 배포 생성, Ready 및 운영 별칭 연결 확인.
- Deployment: `dpl_7dmp1rggFrxM26iWsDkEJnhSGid8`.
- URL: https://lecue-3700it2gb-dbgudwn43890-dels-projects.vercel.app
- 운영 별칭: https://www.lecue.app / https://lecue.app
- 운영 `/login`, `/en/login` 각각 200 및 새 이메일 UI 확인. recovery callback이 새 복구 화면으로 307 연결됨 확인.
- Google 버튼 및 기존 OAuth 경로 유지. 이번 검증에서 사용자 Google 계정으로 새 OAuth 로그인을 실행하지 않음.

## 별도 보안 안내

- 앞선 네이티브 Chrome 도구가 잘못된 창을 반환하면서 OpenAI API 키가 도구 출력에 노출된 기록이 있어 사용자에게 교체 필요성을 알림. 키 값은 이 문서에 기록하지 않음. 이메일 설정 과정에서 해당 키를 사용하거나 변경하지 않음.

## 참고

- [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase production SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend SMTP](https://resend.com/docs/send-with-smtp)
- [Resend 도메인 상태](https://resend.com/domains/ff84e37c-de97-41d1-bd15-0ae72ac9a0ad)
