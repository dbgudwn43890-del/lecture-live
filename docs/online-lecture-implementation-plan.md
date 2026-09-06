# Lecue 온라인 강의 구현 명세

작성일: 2026-09-06. 대상: 프런트엔드·백엔드 개발자, 디자이너, QA.
상태: 구현을 위한 계획. 온라인 강의 기능은 아직 구현하지 않았다.
코드 기준: `4974e3c` + 현재 작업 폴더의 결제·원가 절감 변경. 작업 시작 전에 미커밋 변경을 보존하고 최신 코드를 다시 확인한다.

## 1. 목표와 확정된 제품 원칙

사용자는 Lecue에서 **온라인 강의 듣기 → 브라우저에서 강의 탭 선택 → 자동 기록**만 수행한다. 별도 설정 페이지, 연결 마법사, 음량 테스트, 두 번째 시작 버튼을 만들지 않는다.

- 강의 플랫폼의 계정이나 영상 주소를 입력하지 않는다.
- 사용자가 선택한 탭의 소리를 기존 STT에 전달한다. 마이크는 요청하거나 혼합하지 않는다.
- 질문·답변·수업 자료·구간 요약·복습 노트는 기존 강의실 기능을 사용한다.
- 언어·모델·장치 설정을 시작의 필수 단계로 만들지 않는다. 기존 인식 언어 설정을 그대로 사용한다.
- Deepgram 지원을 활용하는 현재 라우팅을 유지한다. `ko/en`은 Deepgram, `multi`는 기존 Soniox 경로다. 화면 언어와 인식 언어는 서로 다르다.
- Monthly는 월 3,000 credits(50시간), 무료 체험은 300 credits. 온라인 전용 요금제를 만들지 않는다.
- 브라우저의 공유 선택창은 생략·자동 승인·영구 저장할 수 없는 필수 사용자 동작이다. “완전 자동 연결”이라고 광고하지 않는다.

## 2. 첫 출시 범위

### 포함

- 데스크톱 Chrome의 일반 브라우저 탭 오디오. Windows/macOS에서 실제 검증한 버전을 지원 대상으로 기록한다.
- 현장 강의와 온라인 강의의 두 시작 동작.
- 온라인 기록 시작, 수동 일시정지, 같은 연결로 재개, 공유 종료 감지, 다시 선택, 수업 종료.
- 한·영 UI, 밝은/어두운 테마, 좁은 창에서 질문하기.
- 이어폰, 배속, 되감기, 강의 탭 새로고침·닫힘, 네트워크 장애 검증.

### 제외

- 설치형 Zoom/Teams의 시스템 오디오, 전체 화면/앱 창 캡처.
- 브라우저 확장 프로그램, 가상 오디오 드라이버, 앱 설치.
- 영상 URL 다운로드, DRM 우회, 자동 로그인, 화면 OCR, 강의 영상 저장.
- 원본 영상의 재생 시간 읽기/제어, 질문에서 영상 시각으로 이동.
- 영상 플레이어의 일시정지를 감지해 자동 과금 중단. 탭 오디오만으로 이를 확실히 판별할 수 없다.
- 모바일·Safari·Firefox 지원 보장. 기능 감지와 안내는 구현하되, 미검증 환경에서 지원을 약속하지 않는다.

## 3. 화면 명세

### 3.1 시작 화면

기존 준비 화면의 시작 영역에 동작 버튼 두 개를 둔다. 사용 방식 선택 후 시작 버튼을 다시 누르는 구성은 금지한다.

| 한국어 | 영어 | 동작 |
|---|---|---|
| 현장 강의 듣기 | In-person lecture | 기존 마이크 시작 |
| 온라인 강의 듣기 | Online lecture | 클릭 핸들러에서 즉시 탭 선택창 요청 |

온라인 버튼 가까이에 한 줄만 표시한다: `강의가 재생되는 탭을 선택하면 바로 시작해요.` / `Choose your lecture tab to start.`

수업 이름·자료 첨부는 선택 사항이다. 기존 저장된 인식 언어를 사용하고, 설정이 없으면 현재 제품 기본값을 유지한다. 온라인 버튼 클릭 전에 언어 선택을 요구하지 않는다. 현장 강의용 “마이크를 강사 가까이” 안내를 온라인 진행 상태에 표시하지 않는다.

로그인·기존 필수 약관 처리는 강의실 진입 시 끝나 있어야 한다. 로그인 리디렉션 후 자동으로 공유창을 열지 않는다. 잔액을 이미 알고 있으며 부족하다면 공유창을 열기 전에 기존 크레딧 안내를 사용한다. 서버는 시작 시 잔액을 재검증한다.

### 3.2 정상 진행

- 공유 선택창이 닫히면 바로 연결 상태를 표시하고 자동 시작한다.
- 처음부터 “소리가 들린다”고 표시하지 않는다. 오디오 트랙 존재와 실제 신호 수신은 별개다.
- 연결 중: `강의 소리를 연결하고 있어요…` / `Connecting your lecture audio…`
- 시작 완료: `온라인 강의 · 기록 중` / `Online lecture · Recording`
- 작은 입력 표시기는 소리가 들어올 때만 움직인다. 정상 상태에 토스트·확인 팝업을 추가하지 않는다.
- 주 동작은 `일시정지`, `수업 종료`. 일시정지 중에는 `이어 듣기`가 주 동작이다.
- 입력 원본의 탭 제목이나 URL을 저장·수집하지 않는다. 화면에도 기본적으로 “온라인 강의”만 표시한다.
- 새 브라우저 창을 자동으로 열거나 강의 페이지를 iframe으로 삽입하지 않는다.

### 3.3 좁은 창

강의와 Lecue를 사용자가 나란히 배치했을 때 420~640px 폭에서도 질문 입력·전송·기록 상태·일시정지에 접근할 수 있게 한다. 기존 패널 전환을 재사용하며 별도 전용 페이지를 만들지 않는다. 자동 창 이동/크기 변경은 하지 않는다.

### 3.4 오류 문구와 동작

| 상황 | 한국어 | 영어 | 복구 |
|---|---|---|---|
| 선택 취소 또는 권한 거절 | 선택 화면을 닫았어요. 다시 시작할 수 있어요. | Sharing didn’t start. You can try again. | 원래 시작 화면, 빨간 오류 팝업 없음 |
| 오디오 트랙 없음 | 탭 소리도 함께 공유해 주세요. | Share the tab’s audio too. | 다시 선택 / Choose again |
| 창·전체 화면 선택 | 강의가 재생되는 브라우저 탭을 선택해 주세요. | Choose the browser tab playing your lecture. | 다시 선택 |
| 공유 종료·탭 닫힘 | 공유가 끝나 기록을 멈췄어요. | Sharing ended. Recording is paused. | 강의 다시 선택 / Choose lecture tab |
| 소리 신호 장시간 없음 | 강의를 재생해 주세요. 소리가 들어오면 계속 기록해요. | Play your lecture. Recording continues when audio arrives. | 비차단 안내, 일시정지 유지 |
| 연결 실패 | 강의 소리를 연결하지 못했어요. 다시 시도해 주세요. | Couldn’t connect the lecture audio. Try again. | 다시 선택 |
| 지원 범위 밖 | 온라인 강의는 컴퓨터의 Chrome에서 이용해 주세요. | Use Chrome on a computer for online lectures. | 현장 강의·파일 업로드 기존 경로 유지 |

`NotAllowedError`만으로 취소와 명시적 거부를 확실히 구분할 수 있다고 가정하지 않는다. 브라우저 원문 오류나 API 이름은 사용자 화면에 노출하지 않는다.

## 4. 현재 코드와 수정 위치

경로는 저장소 루트 기준이다.

| 파일 | 현재 역할 | 구현 작업 |
|---|---|---|
| `app/classroom/workspace-client.tsx` | 준비 화면, 시작·재개 버튼, 패널, 언어 설정 | 모든 시작 버튼 호출부에 입력 종류 전달; 온라인 상태 문구; 좁은 화면 |
| `app/classroom/use-lecture-recorder.ts` | 마이크 취득, MediaRecorder, STT 소켓, 재연결, 시간·종료 | 입력 캡처 분리, 온라인 일시정지/재개, 취소 경합, 전체 리소스 정리 |
| `app/classroom/workspace.css` | 강의실 UI | 시작 영역·소리 상태·좁은 폭·focus 스타일 |
| `app/lib/lecture-input.ts` (신규 제안) | 없음 | 마이크/탭 캡처와 스트림 검증·해제. React나 STT 로직을 넣지 않음 |
| `app/api/lecture-sessions/route.ts` | draft/start/pause/resume/segment/finish 등 | 입력 종류 저장·응답, start 재시도 중복 방지 검토 |
| `supabase/migrations/<timestamp>_lecture_input_source.sql` | 없음 | `input_source` 필드·제약 추가 |
| `app/api/deepgram-token/route.ts` | STT 설정·임시 인증 | 모델 변경 없음. 온라인 스트림과 동일 경로로 검증 |
| `app/lib/deepgram.ts`, `app/lib/soniox.ts` | 공급자별 설정/메시지 | 입력 종류에 따른 불필요한 분기 추가 금지 |
| `next.config.ts` | 보안 헤더 | 기존 헤더 보존; display-capture 차단 여부 점검 |

현재 `startLecture()`는 `getUserMedia()` 후 녹음을 시작하고 세션을 생성한다. `resumeLecture()`도 항상 마이크를 다시 요청한다. `pauseLecture()`는 서버 응답 후 모든 트랙을 정지한다. 이 세 함수를 모두 수정해야 한다. `streamRef`만 교체하면 재개 때 마이크로 돌아가거나 공유용 비디오 트랙이 남는다.

현재 리포트 그래프는 탐색 보조이고 미커밋 변경이 포함되지 않을 수 있다. 구현 전 해당 파일의 실제 내용을 기준으로 판단한다.

## 5. 캡처 API 계약

```ts
type LectureInputSource = 'microphone' | 'browser-tab';

type LectureInput = {
  source: LectureInputSource;
  captureStream: MediaStream; // 브라우저 소유 원본: 비디오 포함 가능
  audioStream: MediaStream;   // STT/레코더에 전달할 오디오만 포함
  dispose(): void;           // 여러 번 호출해도 안전하게 전체 트랙 stop
};

acquireLectureInput(source, micConstraints): Promise<LectureInput>
startLecture(source: LectureInputSource): Promise<void>
resumeLecture(): Promise<void>
```

기존 버튼은 `onClick={() => void startLecture('microphone')}`처럼 명시한다. React 클릭 이벤트를 source 인자로 잘못 전달하지 않도록 모든 호출부를 검색한다. 선택 source는 state 갱신 직후 다시 읽지 말고 함수 인자로 전달한다.

탭 캡처는 `getDisplayMedia`를 클릭 핸들러의 동기 실행 구간에서 호출한다. 호출 전 fetch, 로그인, setTimeout, effect를 기다리지 않는다. 브라우저는 사용자 활성화를 요구하고 다시 연결할 때도 공유 허용을 요구한다. [MDN: getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

요청 옵션의 출발점:

```ts
{
  video: { displaySurface: 'browser' },
  audio: { suppressLocalAudioPlayback: false },
  selfBrowserSurface: 'exclude',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'exclude',
  surfaceSwitching: 'exclude'
}
```

옵션은 브라우저 힌트이며 특정 탭 강제 선택을 뜻하지 않는다. 타입 정의에 없는 Chromium 옵션은 좁은 확장 타입으로 선언한다. `preferCurrentTab: true`를 함께 넣지 않는다. `video: false`로 화면 공유를 요청하지 않는다. 상세 동작은 [Chrome 화면 공유 제어](https://developer.chrome.com/docs/web-platform/screen-sharing-controls/)와 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)을 따른다.

획득 후 검사:

1. 비디오 트랙의 `getSettings().displaySurface === 'browser'` 확인. v1은 판별 불가한 환경도 지원 보장 범위 밖으로 처리하고 모든 트랙 해제.
2. 살아 있는 오디오 트랙이 있는지 확인. `audio: true`는 오디오 포함 보장이 아니다.
3. `new MediaStream(captureStream.getAudioTracks())`로 audioStream 생성.
4. 레코더·미터·STT는 audioStream만 참조. 비디오 프레임 인코딩, 업로드, 프리뷰, 스크린샷 생성 금지.
5. 원본 captureStream은 공유 수명 관리에 보관. 비디오 트랙만 즉시 stop하면 캡처 전체에 미치는 영향이 있을 수 있으므로 시작 시 멈추지 않는다. 종료 시에는 둘 다 해제한다.
6. 입력을 `AudioContext.destination`에 연결하지 않는다. 강의 원본 재생은 유지하고 Lecue가 소리를 재생해 이중으로 들리지 않게 한다.

마이크 전용 echoCancellation/noiseSuppression/autoGainControl 설정을 탭에 그대로 적용하지 않는다. STT가 받는 WebM/Opus 형식과 스트리밍 조각 간격은 기존 구현을 유지하고 실제 탭 스트림으로 검증한다.

## 6. 상태 및 동시 실행 규칙

기존 `Status`는 유지한다. source와 아래의 작은 세부 상태를 추가하고 거대한 별도 상태 관리 라이브러리는 도입하지 않는다.

- `connectingPhase`: `selecting | opening | null`
- `pauseReason`: `manual | capture-ended | network | null`
- `operationIdRef`: 시작/재개 시도 식별자. 끝난 시도의 비동기 결과를 무시하기 위해 증가.

| 시작 상태 | 사건 | 결과 |
|---|---|---|
| idle/error/ended | 온라인 시작 | connecting/selecting, 선택창 1개 |
| selecting | 취소 | 원래 준비 상태, 세션·STT 생성 없음 |
| selecting | 정상 스트림 | connecting/opening, 자동 시작 |
| opening | 서버 및 STT 준비 | recording |
| recording | 사용자 일시정지 | paused/manual, 캡처 권한 유지 |
| paused/manual | 이어 듣기 | 같은 캡처가 살아 있으면 선택창 없이 재개 |
| recording 또는 paused | 공유 트랙 ended | paused/capture-ended, 전체 정리 |
| paused/capture-ended | 강의 다시 선택 | 사용자 클릭에서 선택창, 같은 세션 이어감 |
| 어느 상태든 | 종료·unmount | 시도 무효화, 전체 리소스 정리 |

두 번 클릭해도 선택창·세션·STT 연결은 하나만 생긴다. 선택창은 프로그램에서 닫을 수 있다고 가정하지 않는다. 사용자가 선택창을 연 상태에서 수업을 종료/이동했다면 나중에 도착한 스트림을 즉시 dispose하고 새 세션을 만들지 않는다.

트랙 이벤트는 최신 ref를 읽는다. 원본 비디오·오디오 중 하나라도 `ended`되면 동일한 중단 처리를 한 번만 실행한다. `mute/unmute`는 종료와 구분한다. 앱의 자체 stop이 외부 종료 처리를 재진입시키지 않게 한다.

## 7. 시작·버퍼·일시정지 구현 순서

### 시작

1. 동기 중복 가드·기능 검사 후 캡처 요청.
2. 트랙 검증과 시도 유효성 확인.
3. 기존 세션 start API 호출. 세션 시작이 거절되면 전체 캡처 정리.
4. 시작 준비 중 첫 문장을 잃지 않도록 audio-only MediaRecorder 버퍼링 경로를 재사용한다. 첫 조각의 캡처 시점과 서버 세션 시작 시점 차이를 명시적으로 정렬한다. 준비 중이라는 UI와 실제 기록 중 상태를 구분한다.
5. 서버 승인 후 STT를 연결하고 WebM 조각을 생성 순서대로 전송. 컨테이너 헤더 조각을 버린 채 중간 조각부터 전송하지 않는다.
6. 시작 준비에는 15초 제한을 둔다. 넘으면 버퍼·캡처·소켓을 정리하고 자동으로 새 선택창을 열지 않는다. pending 세션 처리 결과가 불명확하면 기존 start를 조회/확인한 뒤 재시도한다.

서버에 시작 전송 후 응답만 유실되면 이미 세션이 생겼을 수 있다. 신규 start에는 요청 ID를 넣고 `(user_id, start_request_id)` 중복을 서버에서 방지하거나, 기존 draft 세션을 확정적으로 재사용하는 경로를 채택한다. 구현 PR에서 어느 방법을 사용했는지 명시한다. 요청 ID만 바꾸어 무작정 start를 재전송하지 않는다.

### 수동 일시정지

- 사용자 입력 즉시 녹음/소켓 재연결을 멈추는 절차를 시작한다. 서버 pause 응답을 기다리며 오디오를 계속 전송하지 않는다.
- MediaRecorder의 마지막 조각과 STT 최종 결과를 기존 종료 절차로 정리한다.
- 탭 source는 captureStream을 살아 있게 유지하되 오디오 track을 disable하고 레코더·소켓·미터·버퍼를 정지한다. 일시정지 중 오디오를 축적하지 않는다.
- 공유 권한은 살아 있어 브라우저 공유 표시가 남는다. UI 보조 문구: `기록은 멈췄어요. 이어 듣기를 위해 탭 연결을 유지해요.`
- 마이크 source는 기존처럼 트랙을 해제한다.
- 서버 pause가 실패하면 “일시정지 저장 중” 상태로 재시도한다. 서버 상태를 모른 채 resume를 보내지 않는다.

### 재개

- 탭의 원본 트랙이 살아 있으면 권한창 없이 재사용한다. 서버 resume 성공 후 오디오 track 활성화, 새 레코더/소켓으로 시작한다.
- 원본 트랙이 끝났으면 이어 듣기 클릭에서 즉시 getDisplayMedia 요청. 자동 재허용은 불가하다.
- `recorded_ms`를 기존 오프셋으로 사용하고 일시정지 시간은 새 자막 시각에 넣지 않는다.
- source는 세션에 고정한다. tab 재개에서 getUserMedia가 호출되지 않아야 한다.

### 네트워크 재연결

살아 있는 captureStream은 재사용하고 공유창을 다시 열지 않는다. 기존 재연결 로직의 pendingAudio에 무제한 누적이 가능한지 확인한다. 초기 한도는 15초 또는 2MiB 중 먼저 도달하는 값으로 두고, 넘으면 조용히 일부를 버리지 말고 일시정지·명시적 누락 안내를 한다. 새 WebM 컨테이너 시작/타임스탬프 오프셋을 테스트한다. 재연결 대기 중에도 메모리 사용량이 계속 증가하면 출시 불가다.

## 8. 시간·크레딧·데이터 계약

신규 컬럼 제안:

```sql
alter table public.lecture_sessions
  add column input_source text not null default 'microphone'
  check (input_source in ('microphone', 'browser-tab'));
```

기존 행에는 마이크 기본값이 들어간다. 녹음 파일 업로드 이력까지 이 값으로 분석하지 않는다. 기존 업로드 여부와 함께 해석한다. `SessionSummary`, 세션 select 응답, 복원 경로에 필드를 추가한다.

- start 요청: `inputSource?: 'microphone' | 'browser-tab'`. 누락은 기존 클라이언트 호환용 microphone. 다른 값은 400.
- draft는 실제 source를 아직 확정하지 않아도 된다. start로 전환할 때 확정한다.
- pause/resume는 저장된 source를 사용한다. 클라이언트가 진행 중인 세션의 source를 변경할 수 없게 한다.
- 브라우저 탭 ID, URL, 원본 영상 제목, 화면 데이터는 DB에 저장하지 않는다.
- 기존 사용자 소유권 검사와 STT 임시 인증, 크레딧 검증을 우회하지 않는다.

과금은 영상의 원래 길이가 아닌 **서버가 인정한 기록 실행 시간** 기준이다. 현재 1분 미만 반올림과 세션 누적 규칙을 유지하고, pause/resume마다 새로 1분씩 올림하지 않는다. 2배속 60분 영상을 실제 30분 기록하면 약 30 credits이며 연결 준비·반올림 경계는 기존 정책에 맞춰 검증한다.

단순 무음, 영상 일시정지, 음소거를 근거로 자동 과금 중단하지 않는다. 안내는 한 번만 보여 주고 Lecue의 일시정지 버튼을 제공한다. 이를 FAQ에 짧게 명시한다.

**출시 차단 조건:** 공유 종료 후 서버가 계속 recording으로 남아 크레딧이 누적되는 경우. 현재 pause RPC는 서버 수신 시각에 기반하므로 오프라인 중단 시 과금 정합성 검사가 필수다. 서버의 기존 reconcile/만료 정책을 추적하고, 필요하면 heartbeat 만료로 기록 구간을 닫는 별도 마이그레이션을 구현한다. 브라우저가 보낸 임의 duration으로 과금을 무조건 줄이는 방식은 금지한다. 장애 시 정산 정책·최대 오차를 테스트 결과와 함께 명시한 뒤 공개한다.

초기 버전의 한 수업 3시간 상한은 그대로 유지한다. 온라인 강의 지원을 이유로 무제한 세션으로 바꾸지 않는다.

## 9. 소리 감지 및 품질

기존 AudioContext analyser를 재사용한다. 정상 안내를 위해 매 프레임 React state를 갱신하지 않는다. AudioContext가 suspended인 경우 resume 결과를 확인하고, 미터 실패만으로 정상 STT 입력을 차단하지 않는다.

- 오디오 트랙 없음: 즉시 복구 안내, STT·과금 시작 금지.
- 트랙이 있지만 무음: 시작 10초 후 비차단 안내. 다시 소리가 들리면 안내 제거.
- 긴 정적: 반복 토스트 금지. 자동 중단하지 않음.
- 미터 신호만으로 말소리·강의 재생·음성 인식 성공을 단정하지 않음.
- 배속 1/1.5/2배, 한국어·영어 혼용, 숫자·수식·전문용어 클립을 동일 원문으로 비교한다. 2배속이 품질 기준을 충족하지 못하면 지원 범위를 명시한다. 모델을 임의로 바꾸지 않는다.

## 10. 접근성·개인정보·관측

- 버튼 최소 44px 터치 영역, 키보드 focus 표시, 상태 변경은 `aria-live=polite`.
- 입력 미터 애니메이션은 reduced-motion을 존중한다. 정상 동작을 매번 화면 읽기 프로그램에 알리지 않는다.
- 선택 실패 후 시작 버튼으로 focus 복귀. 자체 중첩 모달 없음.
- 개인정보 안내에는 선택한 탭 오디오를 STT 공급자에 처리한다는 사실과 화면을 저장/전송하지 않는 동작을 정확히 기재한다. 기술적 수신과 서버 전송을 구분한다.
- 전체 화면·마이크로 자동 fallback 금지. 탭 오디오가 안 되면 사용자가 다른 입력 방식을 직접 선택한다.
- 로그 허용: capture_requested/ready/cancelled, no_audio, wrong_surface, stt_ready, capture_ended, paused/resumed, failure_code, 연결 소요 시간, 버퍼 크기.
- 로그 금지: tab label/URL, 원본 오디오, 전사 내용, 질문 본문, 토큰/API key.
- 실패 로그만으로 새 분석 SDK를 추가하지 않는다. 기존 관측 경로를 재사용한다.

## 11. 개발 순서와 완료 산출물

### PR 1: 실제 브라우저 기술 검증

Windows/macOS Chrome에서 승인된 짧은 테스트 영상을 재생하고 공유 옵션, 오디오 체크박스, 이어폰 재생, audio-only 인코딩, 공유 종료를 확인한다. 비디오 트랙 유지 상태에서 프레임이 전송되지 않는지 Network와 코드로 검증한다. 플랫폼/브라우저 버전과 결과를 `docs/online-lecture-qa.md`에 기록한다. 실패 조건을 해결하기 전 제품 UI 작업을 확정하지 않는다.

### PR 2: 입력 계층과 수명주기

lecture-input helper, operation guard, 원본/오디오 스트림 분리, 시작/정지/재개/종료/재연결을 구현한다. 현장 마이크 회귀 테스트를 먼저 통과시킨다. 필요한 DB 추가 필드를 먼저 배포해 구버전 호환을 유지한다.

### PR 3: 화면 연결과 세션 API

모든 시작 호출부, 세션 복원, 한·영 상태 문구, 좁은 화면, 취소/실패 focus를 연결한다. source 저장·start 멱등성·과금 장애 검사를 완료한다.

### PR 4: 통합 QA와 공개

아래 인수 기준을 전부 확인한다. 미검증 지원 환경을 문구에서 제외한다. 온라인 시작 동작만 배포 설정으로 끌 수 있게 하되 기존 세션 열기와 현장 강의를 막지 않는다. 실제 검증 결과·남은 제한·롤백 절차를 PR에 첨부한다.

## 12. 인수 테스트

| ID | 재현 | 합격 기준 |
|---|---|---|
| UX-01 | 온라인 버튼 → 탭+오디오 선택 | 추가 시작/확인 없이 기록 시작; 마이크 권한 요청 0회 |
| UX-02 | 선택창 취소 | 새 세션/유료 STT 0건, 다시 시작 가능 |
| UX-03 | 오디오 공유 해제 | 안내·재선택만 제공, 모든 원본 트랙 해제 |
| UX-04 | 전체 화면/창 선택 | 입력 거부, 화면/음성 전송 없음 |
| UX-05 | 연속 더블클릭 | 선택창·세션·STT 각 1개 |
| LIFE-01 | 선택 중 종료 후 늦게 공유 승인 | 도착한 트랙 즉시 해제; 세션 생성 없음 |
| LIFE-02 | 온라인 일시정지 후 재개 | 새 선택창 0회; pause 동안 오디오 전송·credits 증가 없음 |
| LIFE-03 | 공유 종료 또는 원본 탭 닫기 | 1초 내 로컬 paused 표시·소켓 정리; 서버 정산 검사 통과 |
| LIFE-04 | pause 중 공유 종료 → 재개 | 선택창 1회; 같은 세션 이어감 |
| LIFE-05 | Lecue 새로고침/이동 | 자동 캡처 재시작 없음; 이전 기록 보존 |
| NET-01 | 5초/20초 네트워크 차단 | 버퍼 상한 준수; 누락 은폐 없음; 과금 장애 기준 충족 |
| NET-02 | 서버 start 응답 유실 | 재시도로 세션/과금 중복 없음 |
| AUDIO-01 | 이어폰으로 강의 재생 | 정상 수신, 사용자에게 강의 소리 유지, 에코 없음 |
| AUDIO-02 | 다른 탭 음악·OS 알림·마이크 소리 | 선택한 탭 외 입력이 STT에 들어가지 않음 |
| AUDIO-03 | 소리 없는 도입부 → 발화 | 비차단 안내 후 정상 전사, 재연결 요구 없음 |
| AUDIO-04 | 1/1.5/2배속·되감기 | 텍스트·숫자·용어와 지연 비교 결과 첨부; 반복 구간 자동 삭제 없음 |
| BILL-01 | 20초 기록·pause·40초 기록 | 기존 누적 반올림 규칙 유지, pause별 중복 차감 없음 |
| BILL-02 | 공유 종료 중 오프라인 | 종료 후 무제한 과금 없음; 정산 정책 검증 |
| BILL-03 | 잔액 부족·3시간 상한 | 기존 서버 차단 유지, 미디어 리소스 해제 |
| UI-01 | KO/EN, light/dark, 390/480/768/1440px | 가로 넘침 없음; 질문 전송·정지 버튼 접근 가능 |
| REG-01 | 기존 마이크 start/pause/resume/finish | 기존 동작·세그먼트 시간·질문·노트 회귀 없음 |
| SEC-01 | 다른 사용자 세션 id / 잘못된 source | 서버 거절; 데이터·크레딧 변경 없음 |

자동 검사는 helper의 스트림 검증/멱등 dispose, recorder의 경합/재연결/오프셋, session API의 source/소유권/중복을 대상으로 한다. 브라우저 공유창을 mock한 테스트만으로 실제 오디오 지원을 확인했다고 보고하지 않는다. 실제 브라우저 공유 및 공급자 STT 연결 검증은 별도로 수행한다.

권장 실행: `npm run typecheck`, `npm test`, `npm run build`, 신규 DB 회귀 검사(테스트 데이터 롤백), 수동 Chrome 오디오 테스트. 이 문서를 작성하면서 해당 기능을 구현하거나 실제 오디오 테스트를 수행한 것은 아니다.

## 13. 개발자가 전달할 최종 결과

1. 코드와 DB 마이그레이션, 신규 테스트.
2. 한국어·영어 데스크톱/좁은 화면 캡처.
3. 정상 시작과 공유 종료 복구를 보여 주는 짧은 영상.
4. OS·브라우저 버전별 지원 표, 오디오 품질·연결 지연 측정 결과.
5. 크레딧 장애 시나리오 결과, 화면 데이터 비전송 확인, 알려진 제한.

브라우저 공유 제약은 현재 공식 문서를 기준으로 적었다. 구현 시 다시 확인한다: [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [Chrome 화면 공유 제어](https://developer.chrome.com/docs/web-platform/screen-sharing-controls/), [Permissions-Policy display-capture](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/display-capture).
