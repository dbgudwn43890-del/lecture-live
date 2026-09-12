# 배포 누락 재확인 — 2026-09-11

## 서비스 배포

- `www.lecue.app`: `dpl_AhZMnnaLsUVRm1xHGL2h8P3Gz52V`, READY. 마지막 검증한 운영 배포 ID와 일치.
- 배포 manifest390개와 현재 로컬 파일 SHA-1 모두 일치. 누락·수정된 실행 소스0개. 추가 앱·공개자산·빌드·설정 파일도 없음. 재생성하는 PDF.js 파일과 문서·테스트용 자료는 의도적 제외.
- Cloudflare STT relay와 phone-mic의 실제 배포 모듈 SHA-256 모두 현재 로컬 소스와 일치.
- 이번 보안 DB migration4개 적용 완료. 후속 운영작업에서 `20260906040000_lecture_input_source.sql`의 실제 컬럼·제약·인덱스·INSERT 권한을 재확인하고 누락 이력만 복구했다. 현재 로컬47개 migration 모두 적용 이력에 있음.

## 후속 운영작업 — 2026-09-11

1. **자동 DB 백업: 연결 승인 대기.** 최초 확인은 공개 앱 저장소만 조사했다. 후속 조사에서 기존 비공개 `dbgudwn43890-del/lecue-private-backups`의 workflow `352732211`을 확인했다. 상태는 `disabled_manually`, Secrets는 미설정이다. 최신 백업 allowlist·권한 보강을 준비했고 실제 운영에서 역할 구성을 ROLLBACK 검증했다. 합성 PostgreSQL18 복구·암호화·권한 거부 테스트도 통과했다. 전용 역할/비밀번호 적용과 GitHub Secret 전송은 자동 승인 검토가 "전송 대상 저장소에 대한 명시 승인 부족"으로 거부해 실행되지 않았다. 사용자에게 정확한 비공개 저장소 및 전송 범위 승인을 요청했다. 실제 자동 백업 실행·복구는 아직 미완료다.
2. **정기 파일 정리: 활성화.** 기존 대상은 0개였다. 무음 WAV 테스트 파일 하나를 업로드하고 정리 큐에 넣어 운영 endpoint로 삭제했다. `claimed=1, removed=1, failed=0`, Storage 객체와 큐 항목 모두 제거됨을 확인했다. 후속 실행도 `0/0/0`. Cloudflare 예약 `17 * * * *`가 등록됐다. 매시간 17분에 실행되며 최초 예약 실행은 아직 관측하지 않았다. 실제 추적 중인 자료는 삭제하지 않았다. Worker 코드·비밀키·녹음 연결 설정은 변경하지 않았다.
3. **DB 이력 정리: 완료.** `20260906040000` 이력 1행을 복구했다. 실제 스키마·사용자 데이터 변경은 없다.

후속 운영작업 후 정리·녹음·relay·token·credits 관련 테스트141개, 타입 검사, 실제 로컬/운영 녹음 HTTP 사전 검사 모두 통과했다. 이번에는 음성 캡처나 앱/Worker 코드 배포를 바꾸지 않았고 실제 마이크·탭 오디오를 새로 실행하지 않았다. HTTP/모의 테스트를 실제 전사 검증으로 표현하지 않는다.

Git 미커밋 변경이 많지만 이것이 앱 미배포라는 뜻은 아니다. Vercel CLI 배포 소스와 운영 배포 ID·Worker 소스를 직접 대조했다. Git 커밋/푸시는 별도 미실행 상태다.

증거: `/private/tmp/lecue-undeployed-check-production.json`, `/private/tmp/lecue-deployment-completeness-workers.json`, `/private/tmp/lecue-deployment-completeness-migrations.txt`, `/private/tmp/lecue-input-migration-state.txt`.

운영 증거: `/private/tmp/lecue-ops-history-result.json`, `/private/tmp/lecue-ops-cleanup-result.json`, `/private/tmp/lecue-ops-cleanup-schedule.json`, `/private/tmp/lecue-ops-recording-tests.log`, `/private/tmp/lecue-ops-typecheck.log`, `/private/tmp/lecue-ops-preflight-production-after.log`, `/private/tmp/lecue-ops-preflight-local-after.log`.
