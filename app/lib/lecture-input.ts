/**
 * 강의 입력 캡처: 마이크 또는 브라우저 탭 오디오. React·STT 로직 없음.
 * docs/online-lecture-implementation-plan.md §5 계약 그대로.
 */

export type LectureInputSource = "microphone" | "browser-tab";

export type LectureInput = {
  source: LectureInputSource;
  /** 브라우저 소유 원본. 탭 캡처면 비디오 트랙이 함께 들어 있다. 공유 수명은 이 스트림이 결정한다. */
  captureStream: MediaStream;
  /** 레코더·미터·STT가 보는 유일한 스트림. 오디오 트랙만. */
  audioStream: MediaStream;
  /** 여러 번 불러도 안전. 원본·오디오 트랙 전부 stop. */
  dispose(): void;
  readonly disposed: boolean;
};

export type LectureInputFailure =
  | "unsupported"   // getDisplayMedia/getUserMedia 없음, 또는 판별 불가 환경
  | "cancelled"     // 선택창 닫음·권한 거절 (NotAllowedError만으로 둘을 구분하지 않는다)
  | "no-audio"      // 오디오 체크박스 없이 공유
  | "wrong-surface" // 창·전체 화면을 골랐다
  | "mic-blocked"
  | "mic-missing"
  | "inactive"    // 활성 문서/사용자 클릭이 없어 브라우저가 선택창을 열 수 없음
  | "failed";

export class LectureInputError extends Error {
  readonly code: LectureInputFailure;
  constructor(code: LectureInputFailure, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "LectureInputError";
    this.code = code;
  }
}

// lib.dom에 없는 Chromium 힌트만 좁게 확장한다. 강제 선택이 아니라 힌트다.
type TabCaptureController = {
  setFocusBehavior(behavior: "no-focus-change"): void;
};

type TabCaptureOptions = DisplayMediaStreamOptions & {
  controller?: TabCaptureController;
  selfBrowserSurface?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
};

const TAB_CAPTURE_OPTIONS: TabCaptureOptions = {
  video: { displaySurface: "browser" },
  audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
  selfBrowserSurface: "exclude",
  systemAudio: "exclude",
  monitorTypeSurfaces: "exclude",
  surfaceSwitching: "exclude",
};

/** 공유 선택 뒤 강의실에 머문다. 미지원·실패 시에도 원래 공유 흐름은 그대로 진행한다. */
function tabCaptureOptions(): TabCaptureOptions {
  try {
    const Controller = (globalThis as {
      CaptureController?: { new(): TabCaptureController; prototype: TabCaptureController };
    }).CaptureController;
    if (typeof Controller === "function" && typeof Controller.prototype?.setFocusBehavior === "function") {
      // 컨트롤러는 캡처마다 새로 만들어야 한다. 포커스 힌트는 선택창을 열기 전에 동기로 설정한다.
      const controller = new Controller();
      controller.setFocusBehavior("no-focus-change");
      return { ...TAB_CAPTURE_OPTIONS, controller };
    }
  } catch { /* 선택적 포커스 힌트 때문에 탭 공유를 막지 않는다. */ }
  return TAB_CAPTURE_OPTIONS;
}

type Devices = Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;

export type AcquireOptions = {
  /** 테스트 주입용. 기본은 navigator.mediaDevices. */
  devices?: Devices | undefined;
  /** 테스트 주입용. 기본은 `new MediaStream(tracks)`. */
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
};

/** 데스크톱 Chrome 계열만 지원 대상. 기능 감지 결과가 false면 버튼은 안내만 한다. */
export function supportsTabCapture(devices: Devices | undefined = globalThis.navigator?.mediaDevices): boolean {
  return typeof devices?.getDisplayMedia === "function"
    && typeof MediaRecorder !== "undefined"
    && (MediaRecorder.isTypeSupported("audio/webm;codecs=opus") || MediaRecorder.isTypeSupported("audio/webm"));
}

function stopAll(stream: MediaStream) {
  stream.getTracks().forEach((track) => { try { track.stop(); } catch { /* 이미 끝난 트랙 */ } });
}

/** 원본 캡처를 검증하고 audio-only 스트림으로 감싼다. 실패하면 모든 트랙을 놓고 던진다. */
export function wrapCapture(
  source: LectureInputSource,
  captureStream: MediaStream,
  createStream: (tracks: MediaStreamTrack[]) => MediaStream = (tracks) => new MediaStream(tracks),
): LectureInput {
  const audioTracks = captureStream.getAudioTracks().filter((track) => track.readyState === "live");
  if (source === "browser-tab") {
    const video = captureStream.getVideoTracks()[0];
    const surface = video ? (video.getSettings() as { displaySurface?: string }).displaySurface : undefined;
    // v1: displaySurface를 못 읽는 환경도 지원 범위 밖. 화면·창은 거절.
    if (surface !== "browser") {
      stopAll(captureStream);
      throw new LectureInputError(surface === undefined ? "unsupported" : "wrong-surface");
    }
  }
  if (!audioTracks.length) {
    stopAll(captureStream);
    throw new LectureInputError("no-audio");
  }
  const audioStream = source === "browser-tab" ? createStream(audioTracks) : captureStream;
  let disposed = false;
  return {
    source,
    captureStream,
    audioStream,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 오디오 트랙은 두 스트림에 같은 객체로 들어 있다. 한 번씩만 stop.
      new Set([...captureStream.getTracks(), ...audioStream.getTracks()])
        .forEach((track) => { try { track.stop(); } catch { /* 이미 끝난 트랙 */ } });
    },
  };
}

/**
 * 반드시 클릭 핸들러의 동기 구간에서 호출한다. getDisplayMedia까지 비동기 대기
 * 없이 진행한다. 호출 전에 await를 두면 사용자 활성화가 사라질 수 있다.
 */
export function acquireLectureInput(
  source: LectureInputSource,
  micConstraints: MediaTrackConstraints,
  options: AcquireOptions = {},
): Promise<LectureInput> {
  const devices = options.devices ?? globalThis.navigator?.mediaDevices;
  if (source === "browser-tab") {
    if (!supportsTabCapture(devices)) return Promise.reject(new LectureInputError("unsupported"));
    return devices!.getDisplayMedia(tabCaptureOptions())
      .then((stream) => wrapCapture(source, stream, options.createStream), (caught) => {
        throw new LectureInputError(cancelCode(caught), caught);
      });
  }
  if (typeof devices?.getUserMedia !== "function") return Promise.reject(new LectureInputError("unsupported"));
  return devices.getUserMedia({ audio: micConstraints })
    .then((stream) => wrapCapture(source, stream, options.createStream), (caught) => {
      throw new LectureInputError(micCode(caught), caught);
    });
}

/**
 * 선택창은 호출자가 클릭 중에 이미 열었다. 동의 저장까지 성공해야 입력 소유권을
 * 넘긴다. 실패·이탈 시 선택창이 늦게 돌려주는 트랙도 놓으며, PCM은 시작하지 않는다.
 */
export function waitForConsentedInput(
  acquiring: Promise<LectureInput>,
  consent: Promise<void>,
  signal: AbortSignal,
): Promise<LectureInput> {
  return new Promise((resolve, reject) => {
    let input: LectureInput | null = null;
    let consentReady = false;
    let settled = false;

    function fail(reason: unknown) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      input?.dispose();
      reject(reason);
    }
    function abort() { fail(signal.reason ?? new DOMException("Aborted", "AbortError")); }
    function finish() {
      if (settled || !input || !consentReady) return;
      if (signal.aborted) { abort(); return; }
      if (input.disposed
        || !input.audioStream.getAudioTracks().some((track) => track.readyState === "live")
        || (input.source === "browser-tab" && input.captureStream.getVideoTracks()[0]?.readyState !== "live")) {
        fail(new LectureInputError("failed"));
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(input);
    }

    signal.addEventListener("abort", abort, { once: true });
    // Both promises get rejection handlers immediately, including an already-aborted call.
    acquiring.then((value) => {
      if (settled) { value.dispose(); return; }
      input = value;
      finish();
    }, fail);
    consent.then(() => { consentReady = true; finish(); }, fail);
    if (signal.aborted) abort();
  });
}

function cancelCode(caught: unknown): LectureInputFailure {
  const name = caught instanceof Error ? caught.name : "";
  if (name === "InvalidStateError") return "inactive";
  if (name === "NotAllowedError" || name === "AbortError" || name === "SecurityError") return "cancelled";
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  return "failed";
}

function micCode(caught: unknown): LectureInputFailure {
  const name = caught instanceof Error ? caught.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-blocked";
  if (name === "NotFoundError" || name === "NotReadableError") return "mic-missing";
  return "failed";
}
