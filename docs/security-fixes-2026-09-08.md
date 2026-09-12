# 보안 수정 진행 기록 — 2026-09-08

## 현재 상태

**2026-09-09 업데이트: Workers Paid 한도 적용, 네 개 DB 마이그레이션, 최신 앱의 운영 도메인 연결 완료. 운영 RLS/FK·자료 관계 조회·무인증 차단을 확인했다. 정기 파일 삭제는 자동 승인 검토가 첫 실행을 거부해 다시 비활성화했으며, 사용자 승인을 기다린다.**

최종 배포와 확인 범위: [2026-09-09 배포 기록](deployment-2026-09-09.md). 아래 초기 검증 기록의 구형 배포 ID·미적용 표시는 당시 상태다.

기존 감사: `docs/security-review-2026-09-08.md`. 감사의 확인된 7개 항목을 수정했다. 아래 결과는 알려지지 않은 모든 취약점의 부재를 보장하지 않는다.

| 항목 | 변경 | 확인 |
|---|---|---|
| S1 다른 사용자의 부모 행 연결 | 복합 소유권 FK, 생성 결과의 브라우저 쓰기 금지, 검색 조인 소유권 확인 | 격리 PostgreSQL 회귀 검증; 운영 부모 불일치 8개 조합 모두 0건 |
| S2 STT 공급자 토큰·사용량 우회 | 브라우저는 30초 유효 일회용 Lecue 티켓만 수신. Worker가 공급자 키·PCM 전송·20초 연결 임대·분당 크레딧을 통제 | 실제 DB 25개 경계/경합 검증, 첫 1분 환불 우회 회귀 검증, 토큰/내부 API 30개 검증, Workers 17개 검증 |
| S3 업로드 길이·후불 비용 우회 | 서명 확인된 FFmpeg 8.1.2 오디오 전용 빌드로 전체 해독·FLAC 변환 후 실제 길이로 원자적 크레딧 예약·정산 | 실제 WAV/MP3/M4A/WebM 변환, 업로드·콜백·중복·실패 검증 |
| S4 Storage 직접 쓰기 우회 | 브라우저 INSERT/UPDATE/DELETE 제한, 서버가 소유권·동의·용량 확인 후 업로드 | RLS 및 정상 서버 업로드 검증 |
| S5 완료·재색인 비용 우회 | 실제 차감 이력 기반 세션/일일 색인 예산·작업 임대·재시도 제한 | 실제 DB 19개 검증, 이미 결제한 마지막 분량은 잔액 0이어도 색인 가능 |
| S6 삭제 실패 후 원본 잔존 | DB 삭제 큐·연쇄 삭제 트리거·재시도·만료/고아 파일 청소 | 격리 DB 및 라우트 테스트. 운영 예약은 실제 삭제 승인 대기로 비활성화 |
| S7 Mermaid 외부 요청 | 렌더 전 허용 문법 검사, 이미지/URL/설정/스타일 문법 차단, 기존 노트에도 적용 | 실제 브라우저 정상 도식/한국어 마인드맵 렌더·외부 요청 0건 |

## 추가 방어와 복구

- Next.js 16.3.3 적용. CSP로 리소스 출처 제한, iframe 삽입 금지, object 금지. 정적 Next hydration을 유지하기 위한 inline script 허용은 남아 있으며, 이 CSP를 완전한 XSS 방어라고 설명하지 않는다.
- GitHub 본 저장소는 공개이므로 백업 저장소 `dbgudwn43890-del/lecue-private-backups`를 별도로 생성했다.
- 운영 DB 암호화 백업 1회 생성: `/tmp/lecue-security-recovery/backups/lecue-database-20260908T020441Z.tar.age`.
- 복구 개인키는 Git·배포 제외 파일 `.env.backup-recovery.local`에 0600 권한으로 보관. 내용은 로그나 GitHub에 전달하지 않는다.
- 자동 백업은 DB 전용이다. PDF 원본·임시 오디오·사용자 개인 API 키·로그인 세션 토큰은 포함하지 않는다. 백업 복구 후 BYOK 재입력과 재로그인이 필요하다.
- 자동 백업의 실제 운영 실행은 별도 검증이 필요하다. 합성 데이터의 암호화→복호화→pg_restore·변조 탐지는 통과했다.
- OpenAI 키 교체는 사용자가 완료했다고 확인했다.

## 통합 검증

- 앱 테스트: **406개 통과** (`/tmp/lecue-security-tests.log`).
- 프로덕션 빌드 통과 (`/tmp/lecue-security-build.log`). 최초 제한된 실행 환경에서 정지해 정상 실행 권한으로 다시 검증했다.
- 음성 API 파일 추적에 `.ffmpeg/ffmpeg` 포함 확인. Vercel Linux에서도 FFmpeg 8.1.2 빌드에 성공했다. FK 조회 수정을 포함한 최종 `--skip-domain` 배포는 **`dpl_9H1CbGvfjXHzPuEbAcj2uKCttVb9` — Ready**이며 운영 도메인에는 연결하지 않았다. URL: `https://lecue-4zu6pdzwa-dbgudwn43890-dels-projects.vercel.app`. 빌드 후 CLI 연결 오류가 있었지만 `vercel inspect`로 실제 Ready를 확인했다. 로그: `/tmp/lecue-security-production-deploy-final.log`.
- 4개 마이그레이션을 운영 DB의 트랜잭션 안에서 실행 후 롤백: 전부 성공, 아직 적용하지 않음 (`/tmp/lecue-security-migrations-dryrun.txt`).
- 운영 마이그레이션 이력의 `version:text`, `statements:ARRAY`, `name:text` 구조와 이번 4개 버전의 미적용 상태를 확인했다.
- 로컬 Chrome: 한/영 로그인 전환·요금제 렌더와 CSP console 오류 없음. 로컬 결제 설정은 disabled여서 이 결과를 Live 결제 검증으로 간주하지 않는다.
- 프로필 사용량 UI의 중복 총 크레딧·동일 만료일·잔액 0인 추가 사용량의 빈 게이지를 정리하고 Chrome 한국어/영어 화면을 확인했다.
- 실제 workerd: WebSocket upgrade→허용 PCM 전달→공급자 응답 전달→미결제 PCM 차단/4002 종료 검증. 공급자는 모킹했으며 실제 유료 STT 요청을 보내지 않았다.
- 복합 소유권 FK 추가 시 PostgREST 관계 조회가 중복되는 부분 2곳을 수정했다. `deepgram-token`의 자료 조회에 `material_documents_classroom_id_fkey`와 `material_documents_session_id_fkey`를 명시해 마이그레이션 전후 모두 같은 관계를 선택한다. 다른 앱 관계 조회에는 해당 중복이 없었다. 용어집·현재 수업 자료 우선순위를 포함한 해당 라우트 테스트 **21개 통과**. 이 검증은 격리 테스트이며, 신규 FK 적용 후 운영 PostgREST 검증은 아직 남아 있다.
- 운영 도메인에 연결하지 않은 배포를 CLI로 점검해 녹음·relay·cron 경로의 무인증 요청이 401로 차단되고 CSP에 정확한 relay 주소가 포함됨을 확인했다. `/en/billing?lang=en`은 307과 같은 호스트의 `/en/billing` Location을 반환했다.
- Mac 잠금으로 브라우저의 최종 탭 URL 재확인이 중단됐다. 따라서 위 CLI 확인과 별개로, 해당 배포의 실제 브라우저 CSP·Paddle 결제 흐름 검증은 완료로 처리하지 않는다.

## 2026-09-09 운영 반영

- 사용자 Workers Paid 활성화 후 `cpu_ms: 30000`, `subrequests: 3000` 적용 및 API 재조회 확인. Free 한도 차단 해소.
- Worker 주소 `wss://lecue-stt-relay.lecue-app.workers.dev/v1/listen`, health 200. Worker/Vercel 중계·정리 비밀키는 기존 값을 유지했으며 공급자 키·DB 키를 Worker에 전달하지 않았다.
- 최신 DB 암호화 백업: `/tmp/lecue-release-recovery-20260909/lecue-database-20260908T175037Z.tar.age` (22개 테이블, 원본 파일 제외).
- 기존 진행 중 오디오 작업이 0건임을 테이블 잠금 안에서 확인한 후 20260908010000→020000→030000→040000을 한 트랜잭션으로 적용하고 이력 기록. PostgREST schema reload 통지.
- 최종 배포 `dpl_DujVgGqSUTaWgDY2qxURFHRBfz3k` Ready 및 promote 완료. `vercel alias ls`에서 www.lecue.app·lecue.app 모두 `lecue-2rmc9rgit-dbgudwn43890-dels-projects.vercel.app` 연결 확인.
- 운영에서 검증된 소유권 FK 8개, 서비스 전용 테이블 7개 RLS 및 클라이언트 쓰기 불가, 주요 함수 8개 클라이언트 실행 불가·service_role 실행 가능, Storage 제한 정책 3개 확인.
- 운영 PostgREST에서 명시적 자료 FK 관계 조회 200. `limit=0`을 사용해 사용자 자료는 읽지 않음.
- 보호 API 5개 무인증 401, 공개 페이지 정상 응답, CSP·HSTS·nosniff, relay health 확인.
- 시간별 파일 정리 예약 설정은 API에서 성공했으나, 실제 정리 endpoint 실행은 자동 승인 검토가 별도 삭제 승인 필요로 거부. 우회 실행을 막기 위해 예약을 즉시 비활성화하고 `schedules: []` 재확인. 정기 삭제·첫 실행 승인 요청을 사용자에게 보냄. 실제 삭제 성공으로 기록하지 않음.

## 운영상 확인 한계와 별도 작업

- 유료 API 호출·실제 결제·3시간 연속 STT·사용자 원본 PDF를 대상으로 한 이번 운영 테스트는 하지 않았다. 로컬 실제 PDF 엔진/브라우저 및 회귀 테스트의 범위를 운영 E2E 결과로 확대하지 않는다.
- Supabase Free의 관리형 자동 백업과 유출 비밀번호 검사는 제공되지 않는 상태다. CAPTCHA·비밀번호 재확인·Preview 환경 자격증명 점검은 별도 운영 설정이다.
- 자동 백업 역할 생성·GitHub Secret 전송은 이전 자동 승인 거부 이후 실행하지 않았다. 비공개 백업 저장소와 스크립트는 있으나 workflow 예약은 비활성화 상태다.
- Cloudflare 임시 설정 파일은 정기 삭제 승인 처리와 최종 검증이 남아 있어 Git·배포 제외 상태로 유지한다. 해당 작업 완료 후 삭제한다. 토큰을 폐기해도 이미 배포한 Worker의 실행에는 영향 없다.
