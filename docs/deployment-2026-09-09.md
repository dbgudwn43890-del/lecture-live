# 운영 배포 — 2026-09-09

23:32 KST 후속: PDF worker 호환 수정 및 이전 Impeccable 디자인 보완을 `dpl_E4DQFs9hzDWorsjVMzNV11pk6tkW`로 운영 반영했다. 로컬 Webpack·Vercel Turbopack 빌드, 앱 테스트 528개와 worker 준비 테스트 2개, 운영 실제 Chrome worker 렌더링 및 HTTP 검사 통과. [수정·배포 검증 기록](pdf-worker-deployment-2026-09-09.md). DB·결제·음성 중계·삭제 예약 변경 없음.

19:51 KST 후속 앱 배포: `dpl_9Q5busa8QEmbXths3B7yiwkdUb4g` (https://lecue-2c7bue9j9-dbgudwn43890-dels-projects.vercel.app) 운영 승격 완료. 첫 질문 전 입력창 하단 고정, 30초 PCM 대기 큐·속도 조절·정지 시 전송 완료 대기·저장 중 UI·오래된 연결 응답 보호를 포함한다. 전체 테스트 483개, 타입 검사, 실제 workerd 대기 큐 전송, Vercel Linux/Turbopack 빌드, 배포 후보 HTTP 검사 8개 통과. 로컬 빌드는 환경 포트 제한과 Webpack PDF worker 처리 차이로 완료하지 못했으며 운영과 동일한 원격 빌드를 검증했다. [후속 원인·검증 기록](stt-reconnect-2026-09-09.md). Worker·DB·파일 삭제 예약 변경 없음. 아래는 최초 배포 기록이다.

03:25 KST 후속: 반복 재연결을 일으킨 WebSocket 8초 취소 타이머 오류를 수정하여 Worker에 배포했다. [원인·재현·검증 기록](stt-reconnect-2026-09-09.md). 앱 배포 ID와 DB는 그대로이며, 파일 정리 예약도 계속 비활성 상태다.

## 결과

03:02 KST 기준, 최신 앱과 네 개 DB 마이그레이션의 운영 반영 완료. 정기 파일 삭제만 승인 대기로 비활성화했다.

- 서비스: https://www.lecue.app
- 배포 ID: `dpl_DujVgGqSUTaWgDY2qxURFHRBfz3k`
- 배포 원본: https://lecue-2rmc9rgit-dbgudwn43890-dels-projects.vercel.app
- `vercel promote` 성공. `vercel alias ls`에서 www.lecue.app, lecue.app, lecue.vercel.app, 프로젝트 기본 주소가 모두 이 배포를 가리킴을 확인했다. `inspect`의 일부 alias 목록만으로 판단하지 않았다.
- 이번 배포는 작업 트리를 CLI로 업로드했다. Git commit/push는 하지 않았으며 기존 변경 파일을 보존했다.

## 포함된 변경

- 페이지 번호를 말하지 않은 일반 질문에서도 전체 자료 목록·저장된 PDF 텍스트를 조회하도록 개선. 긴 자료는 키워드·의미 검색과 인접 문맥을 함께 사용하고 검색 실패 시 저장 텍스트를 유지한다.
- PDF 전 페이지 추출 및 부분 추출 실패 처리, 원본 페이지 조회 fallback. 실제 PDF.js 엔진과 worker가 `/api/ask` 서버 번들에 포함된다.
- 가운데 정렬된 질문 화면, 슬림한 상단/입력창, 불필요한 자료 헤더·답변별 페이지 배지·실험 애니메이션 제거, 입력창 주변 fade, 사용자의 위 스크롤을 존중하는 자동 스크롤.
- 수식 엔진/CSS 버전 정렬과 잘림 방지. 프로필 중복 사용량 정리 및 누적된 요금제·언어·복습노트 변경.
- 소유권 FK/RLS, 서비스 전용 음성 중계 티켓·사용량 통제, 실제 업로드 오디오 길이 검증과 크레딧 예약, 색인 예산, 저장소 삭제 큐, Mermaid 제한 등 보안 수정.
- FFmpeg 공식 고정 소스 다운로드 중 일시적 네트워크 실패를 제한된 횟수로 재시도. SHA 검증·버전 고정은 유지하며 영구 오류는 실패 처리한다.

## 운영 전환

1. 사용자 Workers Paid 결제 후 Worker에 `cpu_ms: 30000`, `subrequests: 3000` 적용 및 재조회 확인. 중계 주소는 `wss://lecue-stt-relay.lecue-app.workers.dev/v1/listen`.
2. DB 22개 테이블의 암호화 백업 생성: `/tmp/lecue-release-recovery-20260909/lecue-database-20260908T175037Z.tar.age`. PDF/오디오 원본, 개인 API 키, 로그인 세션은 제외한다. 복구키는 별도 로컬 제외 파일에 보관한다.
3. 테이블 잠금 안에서 진행 중 오디오 업로드가 0건인지 확인했다. 네 마이그레이션을 한 트랜잭션으로 적용하고 이력을 기록했다: `20260908010000`, `20260908020000`, `20260908030000`, `20260908040000`.
4. DB 적용 직후 위 최신 배포를 운영으로 승격했다. 기존 월별 지급 마이그레이션은 재실행하지 않았다.

## 검증

- 전체 앱 테스트 475/475, 타입 검사, 로컬 production 빌드 통과.
- 다운로드 재시도 회귀 테스트 7개 통과. Vercel Linux FFmpeg 및 최종 production 빌드 성공.
- 사전 배포의 8개 HTTP 검사 통과.
- 운영 `/`, `/en`, `/billing`, `/en/billing`, `/login`: 200. `/classroom`: 307 → `/login`. 영어 앱 경로는 공용 앱 경로로 정상 전환한다.
- 운영 POST `/api/ask`, `/api/deepgram-token`, `/api/lecture-audio`, `/api/stt/relay`, GET `/api/cron/storage-cleanup`의 무인증 요청: 모두 401.
- CSP·HSTS·nosniff 확인. Worker health 200.
- 운영 DB 소유권 FK 8개 검증 상태, 서비스 전용 테이블 7개 RLS 및 클라이언트 쓰기 불가, 주요 함수 8개 서비스 전용 실행 권한, Storage 제한 정책 3개 확인.
- PostgREST의 명시적 자료 FK 관계 조회: 200 (`limit=0`, 사용자 자료 내용 미열람).
- 실제 12페이지 합성 PDF 추출, 21개 수식의 잘림, 스트리밍 스크롤/반응형 UI는 앞선 로컬 검증 결과다. 이번 배포 중 유료 모델·STT·실결제 테스트나 사용자 원본 PDF 읽기는 하지 않았다. 장시간 실강의 E2E 완료로 간주하지 않는다.

## 정기 정리 — 승인 대기

- 매시 17분 예약의 설정·조회는 성공했으나 첫 운영 정리 실행은 자동 승인 검토가 거부했다. 사유: 만료·미추적 운영 파일을 실제 삭제하는 작업의 별도 승인이 필요함.
- 거부된 작업을 예약으로 우회하지 않도록 예약을 즉시 비활성화했고, 최종 API 결과 `schedules: []`를 확인했다. 직접 정리 endpoint는 실행되지 않았다.
- 읽기 전용 개수 확인: 만료된 추적 오디오 0, 24시간이 지난 미추적 파일 0, 삭제 큐 0. 현재 수업에 연결된 PDF는 정리 대상이 아니다.
- 사용자에게 정기 삭제와 첫 실행 검증을 묶어 승인 요청했다. 승인을 받으면 검토된 정리 경로 1회 실행 및 결과 확인 후 매시 17분 예약을 다시 활성화한다.
- Cloudflare 임시 설정 파일은 이 남은 작업 동안 Git·배포 제외 상태로 유지한다. 완료 후 삭제한다.

## 복구 주의와 별도 보류

- 이전 운영 배포: `dpl_EcfaYkMQ2vQmJt5Ruc68vtoBT45F`. 새 예약 방식으로 처리한 오디오가 생긴 뒤 이전 콜백 코드로 단순 롤백하면 정산 충돌 가능성이 있으므로, 앱만 무조건 되돌리지 않는다.
- 예전 보안 사전 배포 `dpl_9H1CbGvfjXHzPuEbAcj2uKCttVb9`는 이번 UI/PDF 변경을 포함하지 않는다. 승격 대상으로 사용하지 않는다.
- 별도 지속적 DB 백업 역할·GitHub Secret 전송은 이전 승인 거부 이후 실행하지 않았다. 백업 workflow 예약은 비활성화 상태다.
- 신규 서비스 구매나 추가 유료 API 테스트는 하지 않았다.
