# 온라인 강의 QA 기록

기준 명세: `docs/online-lecture-implementation-plan.md`. 작성일 2026-09-06.

2026-09-07 추가: 공유한 탭의 로컬 영상 미리보기·스크립트 전환 구현 및 UI 검증 상태는 [UI 수정 진행 기록](ui-fixes-2026-09-07.md) 참고. 전체 자동 테스트는 153개 통과했으나, 아래 실제 캡처·과금 인수 항목은 아직 통과 처리하지 않았다.

## 구현 요약 (PR 2+3 상당, 한 커밋)

| 항목 | 위치 | 비고 |
|---|---|---|
| 캡처 helper | `app/lib/lecture-input.ts` | `acquireLectureInput`, `wrapCapture`, `LectureInputError`. React·STT 없음 |
| 레코더 수명주기 | `app/classroom/use-lecture-recorder.ts` | `startLecture(source)`, `pauseLecture(reason)`, `resumeLecture()`, `operationIdRef`, `connectingPhase`, `pauseReason` |
| 화면 | `app/classroom/workspace-client.tsx`, `workspace.css` | 시작 버튼 2개(현장/온라인) 세 곳, 상태 문구, 좁은 폭 |
| 세션 API | `app/api/lecture-sessions/route.ts` | `inputSource` 검증·저장, `startRequestId` 멱등 |
| DB | `supabase/migrations/20260906040000_lecture_input_source.sql` | `input_source`, `start_request_id` + 부분 unique 인덱스 |
| 헤더 | `next.config.ts` | `Permissions-Policy: display-capture=(self)` 명시 |
| 개인정보 | `app/privacy/page.tsx`, `app/en/privacy/page.tsx` | 탭 오디오 전송·화면 비전송·탭 제목/URL 미저장 명시 |
| 배포 스위치 | `NEXT_PUBLIC_ONLINE_LECTURE=off` | 온라인 버튼만 숨김. 기존 세션 열기·현장 강의 영향 없음 |

### start 멱등성 방식 (명세 §7)

**요청 ID 방식**을 택했다. 클라이언트는 `startLecture` 호출마다 `crypto.randomUUID()`를 한 번 만들고,
15초 데드라인 안에서 네트워크 오류·타임아웃일 때만 **같은 ID로** 재시도한다(4xx/5xx 응답은 재시도하지 않음).
서버는 `(user_id, start_request_id)` 조회 → 있으면 그 행을 201로 반환, 없으면 insert. insert가 unique 위반(23505)이면 다시 조회해 승자 행을 돌려준다.
draft 재사용 경로는 기존 `eq status=draft` 조건부 update 그대로다.

### 과금 장애 정책 (명세 §8 출시 차단 조건)

- 크레딧 차감은 세그먼트 저장(`consume_lecture_credits_elapsed`)과 종료 PATCH에서만 일어난다. 공유가 끝나면 오디오가 없어 세그먼트가 저장되지 않으므로 **공유 종료 이후 분(minute)이 새로 차감되지는 않는다.**
- 공유 종료 시 클라이언트는 1초 안에 로컬 paused + 소켓/레코더 정리 후 서버 pause를 보낸다. 오프라인이면 `pendingPauseRef`에 두고 `online` 이벤트·30초 간격으로 재시도한다. 서버 pause가 확정되기 전에는 resume을 보내지 않는다.
- **최대 오차:** 공유 종료 후 오프라인이었던 시간이 서버 `recorded_ms`에 더해진다(pause RPC가 서버 수신 시각 기준). 이 시간은 이후 재개해서 세그먼트가 저장될 때 분 인덱스에 반영돼 과금될 수 있다. 상한은 기존 3시간 캡과 reconcile. 종료 PATCH는 마지막 세그먼트 +60초까지만 인정하는 기존 규칙이 계속 적용된다.
- 브라우저가 보낸 duration으로 과금을 줄이는 경로는 없다(기존 그대로).
- heartbeat 만료 마이그레이션은 만들지 않았다. 위 오차가 허용 범위를 넘는다고 판단되면 별도 마이그레이션(pause RPC에서 마지막 세그먼트 활동 시각 상한 적용)이 다음 단계다.

### 재연결 버퍼 (명세 §7)

- 소켓이 닫히면 `onclose`에서 레코더를 멈추므로 재연결 대기 중 `pendingAudio`는 쌓이지 않는다(기존 동작, 코드로 확인).
- 첫 소켓이 열리기 전 버퍼는 2 MiB 상한(`PENDING_AUDIO_MAX_BYTES`). 넘으면 전부 버리고 소켓 open 시 레코더를 새로 시작(온전한 WebM 헤더)하며 "시작 부분 일부가 기록되지 않았어요" 안내를 띄운다. 헤더 없는 중간 조각은 보내지 않는다.
- 시작 준비 15초 제한(`START_DEADLINE_MS`)은 `AbortSignal.timeout`으로 start fetch에 적용. 초과 시 캡처·버퍼 정리, 새 선택창 없음.

## 자동 검사 결과

`npm test` 150건 통과 (2026-09-06).

| 대상 | 파일 | 확인 내용 |
|---|---|---|
| helper | `app/lib/lecture-input.test.ts` | 원본/오디오 분리, dispose 멱등(트랙당 stop 1회), 오디오 없음/창·화면/판별 불가 거절 + 전체 트랙 해제, 취소 → `cancelled`이며 getUserMedia 0회, getDisplayMedia 없음 → `unsupported` |
| session API | `app/api/lecture-sessions/route.test.ts` | `inputSource` 저장, 누락 → microphone, 잘못된 값 → 400 + 쓰기 0건, 같은 `startRequestId` 재시도 → 기존 세션 반환·insert 0건, unique 충돌(23505) → 승자 반환, 비UUID ID → 400 |
| 회귀 | 기존 전체 | 기존 마이크 start/pause/resume/finish·과금 테스트 전부 통과 |

레코더 훅(경합/재연결/오프셋)은 브라우저 API에 묶여 있어 node 테스트가 없다. 아래 수동 항목으로 대체한다.

## 실제 브라우저 검증 (미수행 — 반드시 사람이 돌려야 한다)

이 문서를 작성한 세션에는 브라우저·오디오 장치가 없다. **아래 표가 채워지기 전까지 "지원 환경"을 문구에 넣지 않는다.**
Chrome 공유창을 mock한 테스트만으로 오디오 지원을 확인했다고 보고하지 않는다.

| OS | Chrome 버전 | 탭 공유 선택창 | 오디오 체크박스 | 이어폰 재생 시 수신 | audio-only 전송(Network에 비디오 0) | 공유 종료 감지 | 결과 |
|---|---|---|---|---|---|---|---|
| macOS | | | | | | | 미검증 |
| Windows | | | | | | | 미검증 |

### 인수 테스트 체크리스트 (명세 §12)

각 항목은 코드상 대응 위치만 적었다. 합격 여부는 수동 실행 후 기입.

| ID | 코드 대응 | 결과 |
|---|---|---|
| UX-01 | `startLecture("browser-tab")` → `acquireLectureInput` 동기 호출, getUserMedia 미호출 | |
| UX-02 | `cancelled` → notice + `idle`, 세션·토큰 fetch 없음 | |
| UX-03 | `no-audio` → 전체 트랙 stop, 안내 | |
| UX-04 | `wrong-surface` → 전체 트랙 stop, 안내 | |
| UX-05 | `startingRef` + `status` 가드, 선택창 1개 | |
| LIFE-01 | `operationIdRef` 불일치 → `input.dispose()`, `STALE` | |
| LIFE-02 | manual pause: `track.enabled=false`, 원본 유지, 재개 시 선택창 없음 | |
| LIFE-03 | `watchInput` onended → `pauseLecture("capture-ended")`, 상태 먼저 paused | |
| LIFE-04 | paused 중 ended → `releaseInput`, 재개 클릭에서 getDisplayMedia | |
| LIFE-05 | `openSession` → `restoreInputSource`, 캡처 자동 재시작 없음 | |
| NET-01 | 2 MiB 상한, 누락 안내, 소켓 닫힘 시 레코더 정지 | |
| NET-02 | `startRequestId` 재시도 (route 테스트로 서버 측 확인) | |
| AUDIO-01~04 | 수동 | |
| BILL-01~03 | 기존 RPC 그대로. BILL-02는 위 "과금 장애 정책" 참조 | |
| UI-01 | `.start-choice` 줄바꿈, 640px 이하 전폭, 44px 최소 높이 | |
| REG-01 | 기존 테스트 통과. 실제 마이크 수동 확인 필요 | |
| SEC-01 | RLS + `inputSource` 400 (route 테스트) | |

## 알려진 제한

- 설치형 Zoom/Teams·전체 화면·창 캡처 미지원(의도).
- 영상 플레이어 일시정지는 감지하지 않는다. 무음 10초면 안내 한 번, 자동 과금 중단 없음. Lecue 일시정지 버튼 사용.
- Safari/Firefox/모바일: `displaySurface`를 못 읽거나 getDisplayMedia가 없으면 "컴퓨터의 Chrome에서 이용해 주세요"로 안내한다.
- 공유 종료 후 오프라인 구간의 과금 오차는 위 정책 참조.

## 롤백

- 프런트: `NEXT_PUBLIC_ONLINE_LECTURE=off`로 온라인 버튼만 숨김(재배포 필요).
- DB: 컬럼은 default가 있어 구버전 클라이언트와 호환. 되돌릴 때는 `drop index lecture_sessions_start_request_unique; alter table lecture_sessions drop column start_request_id, drop column input_source;`.
