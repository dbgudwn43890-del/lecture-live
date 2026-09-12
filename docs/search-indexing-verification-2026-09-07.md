# Search Console 선제 검증 — 2026-09-07

사용자가 공유한 세 보고서와 운영 HTTP 응답을 대조하고, Google URL 검사에서 영문 공개 페이지의 실제 URL 테스트를 실행했다. 공유 링크의 접근 키는 기록하지 않는다.

## 판정

| 보고서 | 보고된 주소 | 현재 확인 결과 |
| --- | --- | --- |
| 사용자 선택 표준 없는 중복 5개 | `/en`, `/en/privacy`, 영문 로그인 3개 | 공개 2개는 자기 주소 canonical이 현재 정상. 로그인은 `noindex, follow`가 의도된 정책 |
| 리디렉션 포함 9개 | HTTP·비www, 언어 쿼리, 옛 요금제 주소 등 | HTTPS/www 통합과 언어 전환은 정상. 옛 `/월`, `/4개월`, `/month`를 `/billing`으로 영구 이동하도록 추가 수정 |
| 크롤링됨·미색인 3개 | 폰트 2개, `/billing?plan=term` | 폰트는 HTTP 200 + `X-Robots-Tag: noindex`. 결제 쿼리는 HTTP 200 + `/billing` canonical |

Google의 과거 `/en` 검사에는 9월 4일 크롤링 기준 canonical 없음 및 Google 선택 `/`가 표시됐다. `/en/privacy`도 9월 6일 크롤링 기준 canonical 없음 및 Google 선택 `/privacy`였다. 현재 응답과 과거 색인 스냅샷이 다른 상태다.

## Google 실제 URL 테스트

- `/en`: 2026-09-07 16:02:43 KST 검사. “URL을 Google에 등록할 수 있음”. 크롤링 허용, 가져오기 성공, 색인 생성 허용. 사용자 선언 canonical은 `https://www.lecue.app/en`.
- `/en/privacy`: 16:04:13 KST 검사. 같은 항목 모두 통과. canonical은 `https://www.lecue.app/en/privacy`.
- **실제 URL 테스트 성공은 색인 완료를 뜻하지 않는다.** Google이 재크롤링하고 최종 대표 주소를 선택해야 한다.
- 기존 유효성 검사 3개는 9월 7일 시작되어 진행 중. 리디렉션 9개·크롤링됨 3개 보고서의 검사 세부 화면은 대기, 실패 0이었다. 검사를 다시 시작하거나 URL 삭제를 요청하지 않았다.

## 사이트맵

Search Console에는 제출된 사이트맵이 없었다. 운영 `https://www.lecue.app/sitemap.xml`의 XML과 공개 URL 10개를 확인한 뒤 제출했다. 제출 직후 일시적으로 “가져올 수 없음”이 나타났지만, 상세 화면에서 **“사이트맵 처리 완료”**, 마지막 읽기 2026-09-07, 발견한 페이지 **10개**를 확인했다.

## 운영 응답 검증

공개 `/ko`, `/en`, 한국어·영어 개인정보·약관·환불·결제 페이지 총 10개가 모두 HTTP 200, 올바른 문서 언어, 자기 주소 canonical, `index, follow`, 상호 hreflang을 반환했다. Googlebot 모바일 User-Agent와 반대 언어 쿠키로도 확인했다. robots.txt는 폰트·렌더링 자원 접근을 막지 않는다.

`scripts/check-seo.mjs`에 옛 가격 주소의 308 → `/billing` 검사를 추가했다. 로컬 검사는 통과했다. 추가 수정의 운영 배포 결과는 아래에 기록한다.

참고: [Google 대표 URL 통합 지침](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [페이지 색인 생성 보고서 설명](https://support.google.com/webmasters/answer/7440203?hl=ko).

## 운영 배포 완료

- Vercel Production `dpl_Gb3uPRtKF2MrWeqzUAKW2tWkgeF6`, `READY`, https://www.lecue.app 연결 확인.
- 배포 URL: https://lecue-ddlabrsfw-dbgudwn43890-dels-projects.vercel.app
- 운영에서 `scripts/check-seo.mjs https://www.lecue.app` 전체 통과. 옛 주소 3개의 HTTP 308 → `/billing`, 한영 공개 canonical/hreflang, 언어별 홈, 로그인 noindex, robots/sitemap, 정적 자산 noindex 재확인.
- 이 배포에는 이전에 요청받은 복습노트·답변 들여쓰기 개선도 포함된다. Google의 실제 색인 포함 또는 진행 중인 검사의 최종 성공을 뜻하는 기록은 아니다.
