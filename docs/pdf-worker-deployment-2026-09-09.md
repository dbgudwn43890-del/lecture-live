# PDF worker 호환 수정 및 운영 배포

2026-09-09 23:32 KST 기준, 수정본의 운영 반영과 후속 검증을 완료했다.

- 서비스: https://www.lecue.app
- 배포: `dpl_E4DQFs9hzDWorsjVMzNV11pk6tkW`
- 원본: https://lecue-n1603edza-dbgudwn43890-dels-projects.vercel.app
- 직전 운영 배포: `dpl_EzCwRPxYPWr832mrD1Fqdam5fJEo`
- 기존 작업 트리를 보존하고 CLI로 배포했다. Git commit/push, DB 마이그레이션, 결제·음성 중계·파일 삭제 예약 변경은 하지 않았다.

## 수정

1. `build-tools/prepare-pdf-worker.mjs`가 설치된 `pdfjs-dist`의 legacy worker를 `public/pdfjs/<version>/pdf.worker.min.mjs`에 복사한다. `predev`/`prebuild`에서 실행하며 기존 FFmpeg 설치 과정은 유지한다.
2. 노트 자료 미리보기는 `pdfjs.version`을 사용한 동일 출처 URL로 worker를 읽는다. 번들러의 `new URL(package .mjs, import.meta.url)` 해석을 피하고 API/worker 버전을 맞춘다.
3. Proxy는 엄격한 숫자 버전의 worker 파일에 대한 GET/HEAD만 인증·언어 리다이렉트 없이 통과시킨다. 폴더 전체, 문서, 추가 확장자·하위 경로·POST는 예외가 아니다. 자료 API의 개별 인증도 유지한다.
4. 생성된 worker는 Git과 소스 업로드에서 제외하고 배포 환경의 설치본으로 다시 만든다. 파일 내용은 기존 배포 API 키나 사용자 PDF를 포함하지 않는다.

## 검증

- 앱 전체 테스트 528/528 통과. worker 준비·재실행·라이프사이클 테스트 2/2 통과.
- 타입 검사와 `git diff --check` 통과.
- 로컬 Webpack production 빌드 성공. 기본 Turbopack은 로컬 보조 프로세스의 포트 생성 제한이 여전히 있으므로 설정을 약화시키지 않고 원격에서 확인했다.
- Vercel Linux/Node.js 24/Turbopack production 빌드 및 타입 검사 성공. 먼저 `--prod --skip-domain` 후보를 만들고 확인 후 해당 배포를 `promote`했다.
- 배포 입력 337개 파일 확인: 비밀 환경 파일·로컬 도구 상태·사용자 면접 문서·DB 덤프 제외, worker 준비 스크립트 포함.
- 배포 후보의 공용 페이지/로그인 보호/API 무인증 차단 HTTP 검사 8개 통과.
- 후보 worker 응답 `200 application/javascript; charset=utf-8`. 파일 1,317,034바이트가 설치된 legacy worker와 정확히 일치한다. SHA-256: `a33cfe728c584fdba4fcc1fd54bcdc2f9f2f13889ddbb5b2bd1d0f8cbe49b84e`.
- 로컬 production 서버와 운영 www.lecue.app 모두 실제 headless Chrome에서 합성 1페이지 PDF 파싱·200×200 canvas 렌더 통과. 중앙 검정/여백 흰색 픽셀을 검사했고 실제 browser worker 생성도 확인하여 fake-worker fallback을 성공으로 인정하지 않았다.
- 브라우저 검사는 동일 버전 API 모듈만 격리된 테스트 브라우저에서 공급하고, worker는 실제 앱의 HTTP·Proxy·CSP를 거쳐 받았다. 사용자 원본 PDF 조회·업로드, 노트 재생성, 유료 API 호출은 하지 않았다. 기존 사용자 자료 전체나 인쇄 결과에 대한 전수 검사는 아니다.
- 운영 후속 HTTP 검사 9개 통과: `/`, `/en`, `/login`, `/billing` 200; `/classroom` 307→`/login`; 자료·질문·음성 티켓·정리 API 무인증 401. CSP 유지.
- `vercel alias ls`에서 lecue.app, www.lecue.app, lecue.vercel.app 및 기본 프로젝트 도메인이 모두 이번 배포를 가리킴을 확인했다.

이 배포에는 작업 트리에 있던 이전 Impeccable 디자인 보완도 포함된다. 열린 수업은 마친 뒤 새로고침해야 새 브라우저 코드가 적용된다.
