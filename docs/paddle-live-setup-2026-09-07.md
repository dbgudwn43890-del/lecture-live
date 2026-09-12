# Paddle Live 연결 — 2026-09-07

## 이번 요청과 기준

- 사용자가 Paddle Live 연결 작업을 승인하고, 별도 로컬 파일에 새 Live 서버 키를 직접 입력함.
- 주요 시장은 미국·캐나다, 특히 미국의 유학생. 사용자가 CAD와 EUR 자동 통화 변환을 설정했고 잔액 통화는 USD로 확인함.
- 화면 언어와 결제 통화를 분리: 한국어 UI라도 미국에서는 USD, 캐나다에서는 CAD. 기존 한국 KRW 가격 유지.
- 단순 대시보드 설정은 사용자에게 안내하고, 연동·코드·검증을 담당함.
- 실제 카드 결제는 실행하지 않음. 첫 실결제 및 실제 지급 확인은 사용자 구매 후 진행.

## 구현

- 비로그인 방문자에게도 Paddle.js와 PricePreview 적용. 실제 반환되는 formatted total과 통화 코드를 표시.
- 자체 환산 없이 지역별 통화·세금을 반영. CAD/EUR에는 USD 예정가를 섞은 취소선·할인율을 표시하지 않음.
- 가격 조회 실패·누락·12초 초과 시 결제 버튼 비활성화와 재시도 제공.
- 확인된 로그인 이메일을 첫 checkout에 미리 채움. 이미 Paddle 고객 ID가 있으면 기존 고객 연결 사용.
- 서버에서 거래를 생성하고 서명 검증 웹훅으로만 credits 지급하는 기존 구조 유지. 브라우저 완료 이벤트는 지급 증거로 사용하지 않음.
- 기본 payment link의 `_ptxn` 진입 시 비로그인 상태에서도 SDK 초기화. 언어 변경 시 query 보존.
- 결제 복귀 시 타 계정·없는 거래의 잘못된 pending 상태 해제. 저장소 차단 상태에서도 checkout 사용 가능.
- 서버 API 키와 공개 토큰의 Sandbox/Live 혼합을 차단. 운영 환경에서는 Sandbox 결제 비활성화.
- 긴 원화 가격과 영어 설명에서도 카드 내부 행을 맞추도록 CSS subgrid 적용.
- 실제 판매 이력 없는 ‘Most popular’를 ‘Recommended’로 수정.

## 외부 설정

- Approved domain: lecue.app. 기본 payment link: https://www.lecue.app/billing.
- Google Pay 및 한국 결제수단 활성화. 기존 PayPal·Apple Pay 등 유지.
- 사용자 새 키를 Vercel production의 Paddle 관련 환경변수에만 저장. 기존 공개 Live 토큰 유지. 다른 운영 비밀값은 내려받지 않음.
- Live Lecue 상품과 네 가격은 이미 존재했고 현재 코드와 일치해 재생성하지 않음.
- 웹훅 `ntfset_01m1wxy2rte2k9362wqwnzxvh8`: active, platform, `/api/billing/webhook`. transaction.completed 단일 구독에서 구독·환불 이벤트 총 11개로 보완하고 재조회 확인.
- 각 기존 가격의 tax_mode는 internal(세금 포함). 계정 기본 세금 설정 Automatic based on location은 변경하지 않음. 별도 세금 선택 질문에 대한 답변이 오기 전까지 기존 설정 보존.

| Plan | Live price ID | USD | Credits | 방식 |
| --- | --- | ---: | ---: | --- |
| Monthly | pri_01m1wxy1hvjn9gn6pvnzejaek3 | 9.99 | 2,400 | 매월 갱신 |
| Semester | pri_01m1wxy1s0btbq19t4gvv7jstk | 33.99 | 10,000 | 4개월, 1회 결제 |
| Annual | pri_01m1wxy2030wj888cr7c9j8bm6 | 78.99 | 24,000 | 12개월, 1회 결제 |
| Top-up | pri_01m1wxy27cxmth3j94rs5p0dyt | 4.29 | 1,000 | 12개월, 1회 결제 |

위 credits는 이번 작업 시작 시 코드와 Live 카탈로그에 있던 값이다. 이전 대화의 50시간 안으로 임의 변경하지 않았다.

## Sandbox → Live 전환

- 전환 전 Live 거래 0건. DB의 결제 고객 연결 1건은 Live에서 404, Sandbox에서 동일 ID 존재를 확인함.
- 잘못된 테스트 고객·구독 연결만 해제. credits 전체 행과 trial_used_at이 전후 동일함을 확인.
- 복구용 원본 계정 행은 `.env.paddle-cutover-backup.local`에 0600 권한으로 보관. Git·배포 제외. 실제 결제 발생 이후에는 이 백업을 그대로 덮어 복원하면 안 됨.
- `.env.local`은 계속 Sandbox 키를 보관하지만 BILLING_ENABLED=false로 변경. 로컬이 운영 DB를 공유하므로 테스트 결제 재활성화 전에는 별도 테스트 DB를 준비해야 함.
- 운영은 Vercel production 변수로 Live 실행. `.env.local`과 임시 키 파일은 배포에서 제외.

## 검증 및 한계

- 자동 테스트 272개 통과, TypeScript 통과. 가격 파싱·통화 비교·환경 혼합 차단 검증 포함.
- Vercel production 환경에서 Next 기본 Turbopack build 성공. 로컬 Turbopack은 실행 제한(포트 bind EPERM), 대체 webpack은 기존 PDF worker 모듈 호환 및 폰트 다운로드 제약으로 실패. 운영 빌드 성공을 로컬 성공으로 표기하지 않음.
- Live 가격 API: 뉴욕 USD $9.99, 토론토 CAD $13.80, 서울 KRW ₩13,900, 베를린 EUR €8.59 (Monthly, 세금 포함). CAD/EUR는 검증 시점 자동 환산값이며 고정 가격이 아님.
- Chrome에서 실제 Live PricePreview 및 한국어/영어 전환 확인. 비로그인 가격 표시 정상.
- 보호된 배포는 일반 HTTP 요청에 Vercel 401을 반환함. 공식 `vercel curl` 인증으로 검증한 결과, unsigned webhook 401 / 올바른 Live 서명 200. 지급을 발생시키지 않는 미지원 확인 이벤트 사용.
- 실제 결제 성공·실제 환불·다음 달 갱신까지 완료했다고 주장하지 않음. 자동 테스트와 웹훅 설정 검증을 실제 거래 검증과 구분.

## 운영 배포 완료

- 최종 deployment: `dpl_DkggbSFDktKTffDw4Gffgx4SLgfW`.
- 빌드 URL: https://lecue-91xq1g9tr-dbgudwn43890-dels-projects.vercel.app
- 검수 후 `vercel promote` 성공. 운영 결제 페이지: https://www.lecue.app/billing
- 영어 설명이 길어져도 네 플랜의 credits 및 결제 버튼이 같은 높이에 배치됨을 DOM 좌표로 확인. 390px 영어 화면 시각 확인, 320px 한영 가로 넘침 없음. viewport 원상 복구.
- 운영 도메인에서도 unsigned webhook 401 Invalid signature / Live 서명 200 / 비로그인 checkout 401 확인. 실제 결제·credits 변경 없는 요청만 사용.
- 키 입력용 `.env.paddle-setup.local` 및 임시 비밀값 파일은 작업 종료 전 삭제. 위 Sandbox 계정 원본 백업은 별도 유지.

## 첫 실결제 및 완료 UX 개선

- 사용자 카카오페이 승인 후 DB에서 Live Top-up 1건 완료 확인: `2026-09-07T14:00:14.774308Z` (23:00 KST). 1,000 credits가 정확히 1회 지급됐고, 확인 당시 전량 남아 있으며 회수되지 않음.
- Paddle `checkout.completed` 수신 즉시 `Checkout.close()` 후 한영 강의실로 `location.replace`. `settings.successUrl`도 동일한 강의실로 지정하여 기본 완료 화면에 머무르지 않게 함.
- 완료 URL의 `billing_tx`는 화면 복귀용 식별자일 뿐 지급 증거로 신뢰하지 않음. 기존 서명 웹훅만 credits 지급.
- 강의실은 소유 주문의 `/api/billing/status`를 백그라운드 확인. 지급 확인 후 실제 잔액 API를 갱신하고 return query/storage 제거. 네트워크·잔액 갱신 실패는 재시도, 계정 불일치/없는 주문은 성공 안내 없이 해제. 늦어지는 경우에만 중복 결제를 막는 안내 표시.
- 이전 `?payment=success`만으로 출력되던 ‘credits가 추가되었습니다’ 안내 두 곳 제거. URL만 조작해서 성공 메시지가 뜨지 않음.
- 취소·실패·결제 시도 단계에서는 강의실로 자동 이동하지 않음. 인증/결제 컨트롤은 유지.
- 테스트 281개 및 TypeScript 통과. 완료 이벤트 즉시 이동, SDK close 실패 복구, 한영 경로, 잘못된 반환값, 지급 대기·계정 불일치·네트워크 실패·화면 이탈 검증 포함.
- 변경 배포: `dpl_AqTuMfWEwMwkPrNpiCLxruHxnfcP`, https://lecue-p1bg2ilpj-dbgudwn43890-dels-projects.vercel.app. Next 운영 빌드 성공 후 `vercel promote`로 운영 도메인 적용 확인.
- 자동 복귀 코드는 실제 SDK 완료 이벤트 형태를 사용한 테스트로 검증. 이 변경 이후 추가 유료 결제를 실행하지 않았으므로, 새 코드로 실제 카카오페이 승인→자동 복귀까지 재검증했다고 표기하지 않음.

### 남은 외부 화면 제약

사용자가 첨부한 카카오페이 전환 화면은 Paddle/결제 처리사 화면이다. 문구·스피너·재시도/취소 버튼 및 footer 겹침을 개별 제거하는 공식 SDK 설정은 확인하지 못했다. 이 화면을 임의 CSS로 가리거나 결제 중 iframe을 닫지 않았다. 그렇게 하면 팝업이 열리지 않을 때의 복구 수단과 진행 중 결제를 방해할 수 있다. **첫 요청의 외부 화면 제거는 완료되지 않았다.**

Paddle 문의 초안(미발송):

> During a successful live Kakao Pay checkout, the intermediate local-processing redirect screen shows English text in a Korean checkout and its retry/cancel buttons overlap the merchant footer. Can this screen be localized and its layout corrected, or replaced through a supported integration option while preserving popup-blocked recovery? We use Paddle.js v2, overlay, one-page, locale ko. Screenshot available from the merchant.

### 참고 문서

- https://developer.paddle.com/build/checkout/handle-success-post-checkout/
- https://developer.paddle.com/paddle-js/methods/paddle-checkout-close/

- https://developer.paddle.com/build/products/offer-localized-pricing/
- https://developer.paddle.com/build/transactions/default-payment-link/
- https://developer.paddle.com/paddle-js/methods/paddle-pricepreview/
- https://developer.paddle.com/api-reference/notification-settings/update-notification-setting/
