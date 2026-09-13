"use client";

import { useEffect, useRef, useState } from "react";

import { createPcmRecorder, type PcmRecorder } from "./pcm-recorder";

import { trackAnalyticsEvent } from "../lib/analytics";
import type { DeepgramFinal, DeepgramLanguage } from "../lib/deepgram";
import { utteranceOverflowed, utteranceSegment } from "../lib/deepgram";
import { acquireLectureInput, waitForConsentedInput, LectureInputError, type LectureInput, type LectureInputSource } from "../lib/lecture-input";
import { adaptSonioxMessages, type SonioxMessage } from "../lib/soniox";
import { PendingLectureSaves } from "../lib/pending-lecture-saves";
import { waitForTranscriptTail } from "../lib/recording-tail";
import { PcmSendQueue, PCM_BYTES_PER_SECOND, PCM_PENDING_MAX_MS } from "../lib/pcm-send-queue";
import type { ExternalPcmSource } from "../lib/external-pcm";

export type Status = "idle" | "connecting" | "recording" | "paused" | "ended" | "error";
/** connecting 안의 세부: 공유 선택창이 열려 있는지, 서버·STT를 여는 중인지. */
export type ConnectingPhase = "selecting" | "opening" | null;
export type PauseReason = "manual" | "capture-ended" | "network" | null;
export type { LectureInputSource };

export type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type SessionSummary = {
  id: string;
  classroom_id: string | null;
  title: string;
  status: "draft" | "recording" | "paused" | "completed";
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  recorded_ms: number;
  question_count: number;
  /** 구버전 행·응답에는 없다. 없으면 microphone으로 읽는다. */
  input_source?: LectureInputSource;
};

type DeepgramResult = DeepgramFinal & {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
};

/** 끊긴 소켓을 다시 여는 간격. 마지막 값은 포기하지 않고 계속 되풀이한다. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000];

export const MAX_LECTURE_MS = 10_800_000;
/** 시작 준비(세션 start + 재시도) 총 제한. 넘으면 캡처·버퍼를 정리하고 새 선택창을 열지 않는다. */
const START_DEADLINE_MS = 15_000;
/** 탭 오디오가 이만큼 조용하면 한 번만 "강의를 재생해 주세요"를 띄운다. */
const SILENCE_NOTICE_MS = 10_000;

type RecorderOptions = {
  locale: "ko" | "en";
  isEnglish: boolean;
  speechLanguage: DeepgramLanguage;
  /** 선택한 마이크. 빈 값이면 시스템 기본. ideal이라 장치가 사라져도 기본으로 진행한다. */
  micDeviceId?: string;
  /** 강의 시작 시점에 세션을 만들 강의실. */
  activeClassroomId: string;
  /** 화면에 보이는 세션. 훅이 ref로 미러링해 소켓 콜백이 읽는다. */
  activeSessionId: string;
  lectureTitle: string;
  setError(message: string): void;
  setNotice(message: string): void;
  /** 새 강의가 시작되면 이전 수업의 질문 스레드를 비운다. */
  clearMessages(): void;
  setActiveSessionId(id: string): void;
  setLectureTitle(title: string): void;
  /** 토큰 응답이 실어 오는 최신 크레딧 수. */
  onCredits(credits: number): void;
  onSessionSaved?(session: Omit<SessionSummary, "question_count"> & { question_count?: number }): void;
  loadClassrooms(preferredId?: string): Promise<void>;
  loadCredits(): Promise<void>;
};

/**
 * 녹음 엔진: 마이크 → PCM AudioWorklet → 계량 릴레이 소켓 → 세그먼트 확정·저장, 그리고
 * 시작/일시정지/재개/종료의 수명주기 전부. workspace-client에서 verbatim으로
 * 분리했다 — 재연결·이중 시작 같은 수명주기 버그를 UI와 떼어 두기 위해서다.
 */
export function useLectureRecorder(options: RecorderOptions) {
  function audioConstraints(): MediaTrackConstraints {
    return {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(options.micDeviceId ? { deviceId: { ideal: options.micDeviceId } } : {}),
    };
  }
  const { locale, isEnglish, speechLanguage, activeClassroomId, activeSessionId, lectureTitle } = options;

  const [status, setStatus] = useState<Status>("idle");
  const [connectingPhase, setConnectingPhase] = useState<ConnectingPhase>(null);
  const [pauseReason, setPauseReason] = useState<PauseReason>(null);
  const [inputSource, setInputSource] = useState<LectureInputSource>("microphone");
  const [phoneInput, setPhoneInput] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [waitingForAudio, setWaitingForAudio] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isSwitchingMicrophone, setIsSwitchingMicrophone] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const connectionAttemptRef = useRef(0);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const recorderStartingRef = useRef<Promise<void> | null>(null);
  /** 레코더·소켓·미터가 보는 audio-only 스트림. inputRef.current.audioStream의 미러. */
  const streamRef = useRef<MediaStream | null>(null);
  /** 원본 캡처와 그 수명. 탭 공유는 일시정지 중에도 여기 살아 있다. */
  const inputRef = useRef<LectureInput | null>(null);
  const externalSourceRef = useRef<ExternalPcmSource | null>(null);
  const externalCaptureEndedRef = useRef(false);
  /** 세션에 고정된 입력 종류. 재개는 이 값만 읽고, 클라이언트가 중간에 바꾸지 않는다. */
  const sourceRef = useRef<LectureInputSource>("microphone");
  // 시작/재개 시도 식별자. 선택창이 열린 사이 종료·unmount되면 늦게 도착한
  // 스트림을 즉시 버리고 세션을 만들지 않기 위해 증가시킨다.
  const operationIdRef = useRef(0);
  // 서버 pause가 아직 확정되지 않은 세션. 이 값이 있으면 resume을 보내지 않는다.
  const pendingPauseRef = useRef<string | null>(null);
  const audioQueueRef = useRef(new PcmSendQueue());
  const audioSocketReadyRef = useRef(false);
  const audioDrainTimerRef = useRef<number | null>(null);
  const lastSignalAtRef = useRef(0);
  const silenceNoticedRef = useRef(false);
  const silenceNoticeShownRef = useRef(false);
  const startedAtRef = useRef(0);
  const elapsedBaseMsRef = useRef(0);
  const segmentIdsRef = useRef(new Set<string>());
  // Segments the server has actually persisted (its "segment" save fetch
  // resolved with response.ok). /api/ask only needs to carry the ones missing
  // from this set — the server reads everything else back from the DB itself.
  const confirmedSegmentIdsRef = useRef(new Set<string>());
  const finishAcknowledgementsRef = useRef(new Map<string, Set<string>>());
  const finishSaveErrorsRef = useRef(new Map<string, string>());
  const segmentsRef = useRef<Segment[]>([]);
  const activeSessionIdRef = useRef("");
  const finishingRef = useRef(false);
  // startLecture in-flight guard: state alone lets a double-click race the
  // re-render and start everything twice.
  const startingRef = useRef(false);
  const switchingMicrophoneRef = useRef(false);
  const consentStartAbortRef = useRef<AbortController | null>(null);
  const saveFailuresRef = useRef(0);
  // Deepgram's stream clock restarts at 0 on every socket, so a reconnect would
  // collide with earlier segments without this.
  const streamOffsetMsRef = useRef(0);
  // 확정된 조각은 문장이 끝날 때까지 여기 모인다. 세그먼트 하나가 온전한 발화가
  // 되어야 buildAnchor의 창과 문단 묶기가 조각난 반 문장을 다루지 않는다.
  const finalBufferRef = useRef<DeepgramResult[]>([]);
  const interimRef = useRef("");
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  const vocabularyTimerRef = useRef<number | null>(null);
  const vocabularyRefreshedRef = useRef(false);
  const lastSentAtRef = useRef(0);
  const socketOpenedRef = useRef(false);
  const meterRef = useRef<HTMLSpanElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // 종료 저장이 실패한 강의. 연결이 돌아오면 자동으로 다시 보낸다.
  const pendingFinishRef = useRef(new PendingLectureSaves());

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // 트랙 ended 콜백은 등록 시점의 클로저를 계속 들고 있어 status가 낡는다.
  // 항상 최신 상태·함수를 ref로 읽는다.
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const pauseRef = useRef<(reason?: Exclude<PauseReason, null>) => Promise<void>>(async () => {});

  const deadMicMessage = isEnglish
    ? "The microphone was disconnected, so the lecture is paused. Check the mic and press Resume."
    : "마이크 연결이 끊겨 일시정지했습니다. 마이크를 확인한 뒤 '이어하기'를 눌러 주세요.";
  const captureEndedMessage = isEnglish
    ? "Sharing ended. Recording is paused."
    : "공유가 끝나 기록을 멈췄어요.";
  const phoneEndedMessage = isEnglish
    ? "The phone microphone disconnected. Check the phone page and reconnect it before resuming."
    : "휴대폰 마이크 연결이 끊겼어요. 휴대폰 화면과 연결을 확인한 뒤 이어 들어 주세요.";
  const pauseSavingMessage = isEnglish
    ? "Saving the pause… Resume becomes available once it is saved."
    : "일시정지를 저장하는 중이에요. 저장되면 이어 들을 수 있어요.";

  /** 원본·오디오 트랙 전부 해제. 여러 번 불러도 안전. 외부 종료 핸들러가 재진입하지 않는다(dispose가 먼저 disposed를 세운다). */
  function releaseInput(keepExternal = false) {
    setPreviewStream(null);
    inputRef.current?.dispose();
    inputRef.current = null;
    streamRef.current = null;
    if (!keepExternal) {
      // A late remote start acknowledgement must not block the next capture.
      recorderStartingRef.current = null;
      const external = externalSourceRef.current;
      externalSourceRef.current = null;
      external?.dispose();
      setPhoneInput(false);
    }
    stopMicMeter();
  }

  function captureMatches(stream: MediaStream | null, external: ExternalPcmSource | null) {
    return Boolean(stream || external) && streamRef.current === stream && externalSourceRef.current === external;
  }

  function captureIsLive(stream: MediaStream | null, external: ExternalPcmSource | null) {
    return external ? !externalCaptureEndedRef.current && external.isLive()
      : Boolean(stream?.getAudioTracks().some(track => track.readyState === "live"));
  }

  /**
   * 덮개 닫힘·마이크 뽑힘·"공유 중지" 클릭·강의 탭 닫힘: 죽은 스트림으로
   * '기록 중'인 척하는 좀비를 막는다. 원본 비디오·오디오 중 하나라도 ended면
   * 같은 처리를 한 번만 한다. mute/unmute는 종료가 아니라 무시한다.
   */
  function watchInput(input: LectureInput) {
    let handled = false;
    const onEnded = () => {
      // 앱의 자체 stop은 dispose가 disposed를 먼저 세워 여기서 걸러진다.
      if (handled || inputRef.current !== input || input.disposed) return;
      handled = true;
      if (input.source === "microphone") {
        if (finishingRef.current || statusRef.current !== "recording") return;
        void pauseRef.current("capture-ended").then(() => options.setError(deadMicMessage));
        return;
      }
      if (statusRef.current === "recording" && !finishingRef.current) {
        void pauseRef.current("capture-ended");
        return;
      }
      // 이미 일시정지 중(또는 전환 중)에 공유가 끝났다: 죽은 캡처만 놓는다.
      // 다음 이어 듣기는 클릭에서 새 선택창을 연다(LIFE-04).
      releaseInput();
      setPauseReason("capture-ended");
      options.setError(captureEndedMessage);
    };
    input.captureStream.getTracks().forEach((track) => { track.onended = onEnded; });
  }

  /** A batch is durable only when every ID is explicitly acknowledged. */
  async function submitFinishSave(sessionId: string, durationMs: number, segmentList: Segment[]): Promise<boolean> {
    const acknowledged = finishAcknowledgementsRef.current.get(sessionId) ?? new Set<string>();
    finishAcknowledgementsRef.current.set(sessionId, acknowledged);
    finishSaveErrorsRef.current.delete(sessionId);
    let failureMessage: string | undefined;
    const send = async (segments: Segment[], action?: "save-final") => {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ ...(action ? { action } : {}), sessionId, durationMs, segments }),
        });
        const data = await response.json() as { saved?: boolean; completed?: boolean; acknowledgedSegmentIds?: string[]; error?: string; code?: string; session?: Omit<SessionSummary, "question_count"> & { question_count?: number } };
        // CloseStream may still be settling the last PCM acknowledgement. Give
        // that normal close a short grace period without invalidating its lease.
        if (response.status === 409 && data.code === "RECORDING_ALREADY_ACTIVE" && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
          continue;
        }
        if (!response.ok || data.saved !== true) {
          failureMessage = data.error;
          throw new Error();
        }
        return data;
      }
    };
    try {
      const remaining = segmentList.filter((segment) => !acknowledged.has(segment.id));
      for (let from = 0; from < remaining.length; from += 250) {
        const batch = remaining.slice(from, from + 250);
        const data = await send(batch, "save-final");
        const ids = new Set(data.acknowledgedSegmentIds ?? []);
        if (batch.some((segment) => !ids.has(segment.id))) throw new Error();
        batch.forEach((segment) => acknowledged.add(segment.id));
        try {
          window.localStorage.setItem(`lecue-unsaved-finish-${sessionId}`, JSON.stringify({
            sessionId, durationMs, segments: segmentList.filter((segment) => !acknowledged.has(segment.id)),
          }));
        } catch { /* The original mirror and in-memory snapshot still permit replay. */ }
      }
      const data = await send([]);
      if (data.completed !== true) throw new Error();
      try { window.localStorage.removeItem(`lecue-unsaved-finish-${sessionId}`); } catch { /* A redundant replay is idempotent. */ }
      finishAcknowledgementsRef.current.delete(sessionId);
      finishSaveErrorsRef.current.delete(sessionId);
      if (data.session && options.onSessionSaved) options.onSessionSaved(data.session);
      else void options.loadClassrooms().catch(() => {});
      return true;
    } catch {
      if (failureMessage) finishSaveErrorsRef.current.set(sessionId, failureMessage);
      return false;
    }
  }

  /**
   * 서버 pause 한 번. 409는 DB 실패도 포함하므로 성공 응답만 확인으로 본다.
   * 성공하면 서버가 인정한 recorded_ms로 시계를 맞춘다.
   */
  async function submitPause(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "pause", sessionId }),
      });
      const data = await response.json().catch(() => ({})) as { recordedMs?: number };
      if (!response.ok) return false;
      if (response.ok && typeof data.recordedMs === "number" && activeSessionIdRef.current === sessionId && startedAtRef.current === 0) {
        elapsedBaseMsRef.current = data.recordedMs;
        streamOffsetMsRef.current = data.recordedMs;
        setElapsedMs(data.recordedMs);
      }
      if (pendingPauseRef.current === sessionId) {
        pendingPauseRef.current = null;
        if (activeSessionIdRef.current === sessionId) options.setNotice("");
      }
      return true;
    } catch {
      return false;
    }
  }

  // 오프라인 종료 복구: online 이벤트와 30초 간격으로 미저장 종료·일시정지를 재시도하고,
  // 마운트 시엔 지난 방문에서 남은 로컬 미러(새로고침으로 날아갈 뻔한 꼬리)를 밀어 넣는다.
  useEffect(() => {
    const retry = () => {
      // 공유가 끝난 뒤 오프라인이었다면 서버는 아직 recording이다. 연결이 돌아오는
      // 즉시 닫아야 그 사이 시간이 다음 세그먼트 과금에 섞이지 않는다(BILL-02).
      if (pendingPauseRef.current) void submitPause(pendingPauseRef.current);
      for (const sessionId of pendingFinishRef.current.ids()) {
        void pendingFinishRef.current.save(sessionId, (pending) => submitFinishSave(pending.sessionId, pending.durationMs, pending.segments)).then((saved) => {
          if (!saved) return;
          options.setError("");
          options.setNotice(isEnglish ? "The lecture is now fully saved." : "강의 저장을 마쳤습니다.");
          void options.loadCredits().catch(() => {});
      });
      }
    };
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
        const key = window.localStorage.key(i);
        if (!key?.startsWith("lecue-unsaved-finish-")) continue;
        const sessionId = key.slice("lecue-unsaved-finish-".length);
        try {
          const stored = JSON.parse(window.localStorage.getItem(key) ?? "") as { durationMs: number; segments: Segment[] };
          if (Number.isFinite(stored.durationMs) && Array.isArray(stored.segments)) {
            pendingFinishRef.current.add({ sessionId, durationMs: stored.durationMs, segments: stored.segments });
          }
        } catch { /* One damaged entry must not block other lectures. */ }
      }
    } catch { /* 깨진 미러는 버린다 */ }
    retry();
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 30_000);
    return () => {
      window.removeEventListener("online", retry);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => {
      const elapsed = currentElapsedMs();
      // The clock is only read at second granularity, so publishing all four
      // ticks a second re-rendered the whole workspace for an identical
      // string — 43,200 times over a three-hour lecture.
      setElapsedMs((current) =>
        Math.floor(current / 1_000) === Math.floor(elapsed / 1_000) ? current : elapsed);
      // Metering moved to the segment save, where the server decides the minute
      // from the session's own started_at. This ticker only shows the clock.
      if (elapsed >= MAX_LECTURE_MS) void finishLecture();
    }, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  // 녹음 중 탭을 닫으면 마지막 발화가 유실된다. 실수인 닫기만 한 번 막는다.
  useEffect(() => {
    if (status !== "recording") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  // 화면이 잠들면 레코더가 멎고 Deepgram이 소켓을 닫는다(연결부 주석 참고).
  // 녹음 중에는 화면을 깨워 두고, 탭이 다시 보이면 잃은 잠금을 다시 잡는다.
  useEffect(() => {
    if (status !== "recording" || !("wakeLock" in navigator)) return;
    let cancelled = false;
    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release().catch(() => {});
        else wakeLockRef.current = lock;
      } catch {
        // 배터리 절약 모드 등이 거부해도 녹음은 계속된다.
      }
    };
    void acquire();
    const onVisible = () => { if (document.visibilityState === "visible") void acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [status]);

  // 와이파이가 돌아왔는데 백오프 30초를 마저 기다릴 이유가 없다.
  useEffect(() => {
    const onOnline = () => {
      if (reconnectTimerRef.current === null) return;
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const stream = streamRef.current;
      if ((stream || externalSourceRef.current) && !finishingRef.current && startedAtRef.current !== 0) {
        void connectDeepgram(stream).catch(() => scheduleReconnect());
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Strict Mode replays setup after cleanup. A replay must not leave every
    // start/open action permanently locked behind the unmount stop marker.
    finishingRef.current = false;
    return () => {
      // Unmount is a stop. Without marking it as one, the socket's onclose
      // sees a live recording and schedules reconnects forever against the
      // dead mic stream — a new WebSocket and token fetch every 30 seconds
      // until the tab closes.
      finishingRef.current = true;
      // 열려 있던 선택창의 늦은 승인은 stale 시도로 버려진다(LIFE-01).
      operationIdRef.current += 1;
      consentStartAbortRef.current?.abort();
      startedAtRef.current = 0;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      stopSocketTimers();
      if (recorderRef.current && recorderRef.current.state !== "inactive") void recorderRef.current.stop().catch(() => {});
      socketRef.current?.close();
      releaseInput();
    };
  }, []);

  function currentElapsedMs() {
    return Math.min(MAX_LECTURE_MS, elapsedBaseMsRef.current
      + (startedAtRef.current ? Date.now() - startedAtRef.current : 0));
  }

  /** 자막과 앵커가 같은 문장을 본다. 추종기는 상태가 아니라 이 ref를 읽는다. */
  function showInterim(text: string) {
    interimRef.current = text;
    setInterim(text);
  }

  /** 버퍼에 모인 발화를 세그먼트 하나로 확정하고 저장한다. */
  function flushUtterance() {
    const finals = finalBufferRef.current;
    finalBufferRef.current = [];
    showInterim("");
    if (!finals.length) return;
    const segment = utteranceSegment(finals, streamOffsetMsRef.current);
    if (!segment || segmentIdsRef.current.has(segment.id)) return;
    segmentIdsRef.current.add(segment.id);
    setSegments((current) => {
      const next = [...current, segment];
      segmentsRef.current = next;
      return next;
    });
    // 말이 끝난 시각과 지금의 차이가 곧 확정 지연이다 (PRD 36.3.4).
    void saveSegment(segment, Math.max(0, Date.now()
      - (startedAtRef.current + segment.endMs - elapsedBaseMsRef.current)));
  }

  /**
   * 세그먼트 저장이 곧 과금 지점이다. 브라우저가 Deepgram 소켓을 직접 들고 있어
   * 서버가 오디오를 못 보므로, 서버가 관측하는 유일한 사건인 이 저장에서
   * 경과 시간 기준으로 크레딧을 차감한다. 그래서 402와 409는 저장 실패가 아니라
   * 강의 종료 사유다.
   */
  async function saveSegment(segment: Segment, latencyMs?: number) {
    const sessionId = activeSessionIdRef.current;
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "segment", sessionId, segment, latencyMs }),
      });
      if (activeSessionIdRef.current !== sessionId) return;
      if (response.ok) {
        confirmedSegmentIdsRef.current.add(segment.id);
        saveFailuresRef.current = 0;
        return;
      }
      const data = await response.json().catch(() => ({})) as { error?: string; credits?: number };
      if (activeSessionIdRef.current !== sessionId) return;
      if (response.status === 402 || response.status === 409) {
        await finishLecture();
        options.setError(data.error ?? (isEnglish ? "Recording stopped because credits could not be verified." : "크레딧을 확인하지 못해 강의를 종료합니다."));
        await options.loadCredits();
        return;
      }
      throw new Error(data.error ?? "save failed");
    } catch {
      if (activeSessionIdRef.current !== sessionId) return;
      saveFailuresRef.current += 1;
      // One dropped save is a blip; three in a row means the transcript is no
      // longer being kept and the learner needs to know before the lecture ends.
      if (saveFailuresRef.current >= 3) {
        options.setError(isEnglish ? "Transcription stopped. Check the connection." : "받아쓰기가 멈췄습니다. 연결을 확인해 주세요.");
      }
    }
  }

  function stopSocketTimers() {
    if (audioDrainTimerRef.current !== null) {
      window.clearInterval(audioDrainTimerRef.current);
      audioDrainTimerRef.current = null;
    }
    if (keepAliveTimerRef.current !== null) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    if (vocabularyTimerRef.current !== null) {
      window.clearTimeout(vocabularyTimerRef.current);
      vocabularyTimerRef.current = null;
    }
  }

  /** Preparation never became a recording. Detach before stop flushes its tail. */
  function discardFailedCapture() {
    startedAtRef.current = 0;
    audioSocketReadyRef.current = false;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    recorderStartingRef.current = null;
    audioQueueRef.current = new PcmSendQueue();
    const socket = socketRef.current;
    socketRef.current = null;
    stopSocketTimers();
    socket?.close();
    if (recorder) void recorder.stop().catch(() => {});
  }

  /**
   * 강의실 와이파이는 3시간을 버티지 못한다. 끊기면 강의를 끝내지 않고 같은
   * MediaStream에 새 소켓을 연다. 자동 종료는 하지 않는다 — 언제 그만둘지는
   * 수업을 듣는 사람이 정한다.
   *
   * 연결 대기 중 PCM을 최대 30초 보관하고, 릴레이의 속도 제한에 맞춰 전달한다.
   */
  function scheduleReconnect() {
    const stream = streamRef.current;
    const external = externalSourceRef.current;
    const operation = operationIdRef.current;
    if ((!stream && !external) || finishingRef.current || startedAtRef.current === 0) return;
    // 소켓이 아니라 입력이 죽었다면 재연결은 무음만 듣는다. 일시정지로 전환.
    // 살아 있는 캡처는 그대로 재사용한다 — 공유창을 다시 열지 않는다.
    if (!captureIsLive(stream, external)) {
      const mic = sourceRef.current === "microphone";
      void pauseRef.current("capture-ended").then(() => { if (external || mic) options.setError(external ? phoneEndedMessage : deadMicMessage); });
      return;
    }
    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      void pauseRef.current("network").then(() => options.setError(isEnglish
        ? "We couldn’t reconnect. Recording is paused; resume when your connection is back."
        : "다시 연결하지 못해 기록을 멈췄어요. 연결이 돌아오면 이어 들을 수 있어요."));
      return;
    }
    reconnectAttemptRef.current = attempt + 1;
    options.setError(attempt < RECONNECT_DELAYS_MS.length - 1
      ? (isEnglish ? "The connection dropped. Reconnecting…" : "연결이 끊겨 다시 연결하는 중입니다…")
      : (isEnglish
        ? "Still reconnecting. You can end the lecture and keep everything transcribed so far."
        : "계속 다시 연결하고 있습니다. 지금까지 받아쓴 내용을 남기고 수업을 종료해도 됩니다."));
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (operationIdRef.current !== operation || !captureMatches(stream, external)) return;
      void connectDeepgram(stream).catch(() => scheduleReconnect());
    }, RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]);
  }

  /**
   * "지금 내 소리를 듣고 있나?"는 상태 점만으로 알 수 없고, 인식이 안 되는
   * 가장 흔한 원인이 마이크 문제다. 입력 피크를 작은 막대로 보여 준다.
   * 리렌더 없이 CSS 변수로만 그린다 — 60fps로 상태를 바꿀 이유가 없다.
   */
  function startMicMeter(stream: MediaStream) {
    stopMicMeter();
    lastSignalAtRef.current = Date.now();
    silenceNoticeShownRef.current = false;
    let context: AudioContext;
    let analyser: AnalyserNode;
    try {
      context = new AudioContext();
      audioContextRef.current = context;
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      // analyser에만 연결한다. destination에 붙이면 강의 소리가 이중으로 들린다.
      context.createMediaStreamSource(stream).connect(analyser);
      if (context.state === "suspended") void context.resume().catch(() => {});
    } catch {
      return; // 미터가 없어도 STT 입력은 막지 않는다.
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (audioContextRef.current !== context) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
      const level = String(Math.min(1, peak / 56));
      meterRef.current?.style.setProperty("--level", level);
      // 질문 화면의 코어도 같은 입력 음량에 반응한다.
      document.documentElement.style.setProperty("--mic-level", level);
      // 탭 오디오는 "트랙이 있다"와 "소리가 들어온다"가 다르다. 10초 무음이면 한
      // 번만 비차단 안내, 소리가 돌아오면 지운다. 매 프레임 state를 건드리지 않는다.
      if (sourceRef.current === "browser-tab" && statusRef.current === "recording") {
        const now = Date.now();
        if (peak >= 3) {
          lastSignalAtRef.current = now;
          if (silenceNoticeShownRef.current) {
            silenceNoticeShownRef.current = false;
            setWaitingForAudio(false);
          }
        } else if (!silenceNoticedRef.current && now - lastSignalAtRef.current > SILENCE_NOTICE_MS) {
          silenceNoticedRef.current = true;
          silenceNoticeShownRef.current = true;
          setWaitingForAudio(true);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopMicMeter() {
    silenceNoticeShownRef.current = false;
    setWaitingForAudio(false);
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    meterRef.current?.style.setProperty("--level", "0");
    document.documentElement.style.removeProperty("--mic-level");
  }

  function reportDroppedAudio(queue = audioQueueRef.current) {
    const bytes = queue.takeDroppedBytes();
    if (!bytes || queue !== audioQueueRef.current) return 0;
    const seconds = (Math.ceil(bytes / PCM_BYTES_PER_SECOND * 10) / 10).toFixed(1);
    options.setNotice(isEnglish
      ? `The connection delay prevented ${seconds} seconds of audio from being sent.`
      : `연결이 지연되어 ${seconds}초의 소리를 보내지 못했어요.`);
    return bytes;
  }

  function drainPendingAudio() {
    const socket = socketRef.current;
    if (!audioSocketReadyRef.current || socket?.readyState !== WebSocket.OPEN) return;
    if (reportDroppedAudio()) {
      // A gap inside an existing provider stream would shift later timestamps.
      // Reopen so its zero starts at the oldest retained PCM sample instead.
      audioSocketReadyRef.current = false;
      socket.close();
      return;
    }
    try {
      if (audioQueueRef.current.drain(socket, performance.now())) lastSentAtRef.current = Date.now();
    } catch {
      socket.close();
    }
  }

  async function closePcmStream(socket: WebSocket | null, queue: PcmSendQueue) {
    const deadline = performance.now() + PCM_PENDING_MAX_MS + 2_000;
    while (queue.byteLength && queue === audioQueueRef.current && socket === socketRef.current && socket?.readyState === WebSocket.OPEN && performance.now() < deadline) {
      drainPendingAudio();
      if (queue.byteLength) await new Promise(resolve => setTimeout(resolve, 50));
    }
    // A stopped capture cannot recover through a later reconnect. Count only
    // bytes actually left unsent, including a bounded drain that timed out.
    queue.discard();
    reportDroppedAudio(queue);
    if (socket === socketRef.current && socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: "CloseStream" })); } catch { socket.close(); }
    }
  }

  async function startPcmCapture(stream: MediaStream | null) {
    if (recorderRef.current?.state === "recording") return;
    if (recorderStartingRef.current) return recorderStartingRef.current;
    const operation = operationIdRef.current;
    const external = externalSourceRef.current;
    const queue = audioQueueRef.current;
    let installed: PcmRecorder | null = null;
    const onData = (bytes: ArrayBuffer) => {
      if (externalSourceRef.current !== external || queue !== audioQueueRef.current || (installed ? recorderRef.current !== installed : operationIdRef.current !== operation)) return;
      queue.push(bytes);
      drainPendingAudio();
    };
    const onStop = () => {
      // A late stop belonging to an old capture must not close the new socket.
      if (externalSourceRef.current !== external || recorderRef.current !== installed || queue !== audioQueueRef.current) return;
      return closePcmStream(socketRef.current, queue);
    };
    const onEnded = () => {
      if (!external || !captureMatches(stream, external) || operationIdRef.current !== operation || externalCaptureEndedRef.current) return;
      externalCaptureEndedRef.current = true;
      if (finishingRef.current) return;
      if (statusRef.current === "recording") {
        void pauseRef.current("capture-ended").then(() => {
          if (externalSourceRef.current === external && operationIdRef.current === operation) options.setError(phoneEndedMessage);
        });
      } else socketRef.current?.close();
    };
    if (!captureIsLive(stream, external)) throw new Error(external ? phoneEndedMessage : deadMicMessage);
    const opening = external ? external.start(onData, onStop, onEnded)
      : createPcmRecorder(stream!, onData, onStop);
    const pending = opening.then(recorder => {
      if (operationIdRef.current !== operation || !captureMatches(stream, external) || startedAtRef.current === 0) { void recorder.stop().catch(() => {}); return; }
      if (!captureIsLive(stream, external)) { void recorder.stop().catch(() => {}); throw new Error(external ? phoneEndedMessage : deadMicMessage); }
      installed = recorder;
      recorderRef.current = recorder;
    });
    recorderStartingRef.current = pending;
    try { await pending; } finally { if (recorderStartingRef.current === pending) recorderStartingRef.current = null; }
  }

  /**
   * 매 연결마다 서버가 발급한 일회용 티켓으로 계량 릴레이를 연다.
   */
  async function connectDeepgram(stream: MediaStream | null) {
    const operation = operationIdRef.current;
    const external = externalSourceRef.current;
    const sessionId = activeSessionIdRef.current;
    const attempt = ++connectionAttemptRef.current;
    const isCurrent = () => operation === operationIdRef.current && sessionId === activeSessionIdRef.current
      && captureMatches(stream, external) && attempt === connectionAttemptRef.current && startedAtRef.current !== 0;
    let tokenResponse: Response;
    let tokenData: { accessToken?: string; credits?: number; listenUrl?: string; refreshInMs?: number | null; relay?: boolean; provider?: "deepgram" | "soniox"; error?: string };
    try {
      tokenResponse = await fetch("/api/deepgram-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        signal: AbortSignal.timeout(START_DEADLINE_MS),
        body: JSON.stringify({ sessionId, language: speechLanguage, transport: "pcm16" }),
      });
      tokenData = await tokenResponse.json();
    } catch (error) {
      // An old reconnect rejection must not schedule work for a newer lecture.
      if (!isCurrent()) return;
      throw error;
    }
    if (!isCurrent()) return;
    if (!tokenResponse.ok || !tokenData.accessToken || !tokenData.listenUrl || tokenData.relay !== true) {
      throw new Error(tokenData.error ?? (isEnglish
        ? "Could not obtain a speech-recognition token."
        : "음성 인식 토큰을 받지 못했습니다."));
    }
    if (typeof tokenData.credits === "number") options.onCredits(tokenData.credits);

    // Only a one-time Lecue relay ticket reaches the browser. Provider keys
    // and configuration remain on the server, which meters accepted PCM bytes.
    const sonioxMode = tokenData.provider === "soniox";
    const socket = new WebSocket(tokenData.listenUrl, ["lecue", tokenData.accessToken]);
    socketRef.current = socket;
    audioSocketReadyRef.current = false;
    let established = false;
    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
    const connectionError = () => new Error(external && !captureIsLive(stream, external)
      ? phoneEndedMessage
      : isEnglish ? "Speech recognition could not connect. Check your connection and try again."
      : "음성 인식에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.");
    const connectionTimer = window.setTimeout(() => {
      rejectConnection(connectionError());
      socket.close();
    }, START_DEADLINE_MS);

    socket.onopen = async () => {
      if (socketRef.current !== socket || !isCurrent()) {
        resolveConnection();
        socket.close();
        return;
      }
      if (!captureIsLive(stream, external)) {
        rejectConnection(external ? new Error(phoneEndedMessage) : new LectureInputError("failed"));
        socket.close();
        return;
      }
      try { await startPcmCapture(stream); } catch {
        rejectConnection(connectionError());
        socket.close();
        return;
      }
      if (socketRef.current !== socket || !isCurrent() || socket.readyState !== WebSocket.OPEN) { resolveConnection(); return; }
      established = true;
      reconnectAttemptRef.current = 0;
      options.setError("");
      socketOpenedRef.current = true;
      statusRef.current = "recording";
      setStatus("recording");
      setConnectingPhase(null);
      streamOffsetMsRef.current = Math.max(elapsedBaseMsRef.current, currentElapsedMs() - audioQueueRef.current.durationMs);
      audioQueueRef.current.startConnection(performance.now());
      audioSocketReadyRef.current = true;
      reportDroppedAudio();
      drainPendingAudio();
      audioDrainTimerRef.current = window.setInterval(drainPendingAudio, 50);
      // 백그라운드 탭이나 절전으로 레코더가 멎으면 Deepgram이 10초쯤 뒤 소켓을 닫는다.
      lastSentAtRef.current = Date.now();
      // 자료도 용어집도 없는 수업이면 서버가 갱신 시각을 함께 준다. keyterm은
      // 소켓을 열 때만 붙으므로, 한 번 닫아 재연결 경로가 갱신된 용어로 다시
      // 열게 한다. 준비 중 음성은 PCM 큐에 보관한다. 한 수업에 한 번만 한다.
      if (typeof tokenData.refreshInMs === "number" && !vocabularyRefreshedRef.current) {
        vocabularyTimerRef.current = window.setTimeout(() => {
          vocabularyRefreshedRef.current = true;
          if (!finishingRef.current) socketRef.current?.close();
        }, tokenData.refreshInMs);
      }
      keepAliveTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && Date.now() - lastSentAtRef.current >= 5_000) {
          socket.send(JSON.stringify({ type: "KeepAlive" }));
          lastSentAtRef.current = Date.now();
        }
      }, 5_000);
      resolveConnection();
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return; // 공급자가 비JSON 프레임을 보내도 세션은 계속 간다.
      }
      if (parsed?.type === "LecueCreditExhausted") { options.onCredits(0); return; }
      // Soniox 토큰 응답은 어댑터가 Deepgram 모양으로 바꾼다. 아래 로직은 공용.
      const messages = sonioxMode
        ? adaptSonioxMessages(parsed as SonioxMessage)
        : [parsed as DeepgramResult];
      for (const message of messages) {
        // utterance_end_ms를 요청해 놓고 버리던 신호다. speech_final이 뜨지 않는
        // 발화를 끊어 주는 안전망이자, 실시간 자막이 멈춰 보이지 않게 하는 장치다.
        if (message.type === "UtteranceEnd") {
          flushUtterance();
          continue;
        }
        if (message.type !== "Results") continue;
        const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";

        if (message.is_final) {
          if (text) finalBufferRef.current.push(message);
          if (message.speech_final || utteranceOverflowed(finalBufferRef.current)) flushUtterance();
          else showInterim(utteranceSegment(finalBufferRef.current)?.text ?? "");
          continue;
        }
        if (!text) continue;
        // 진행 중인 문장 전체를 보여 준다. 마지막 조각만 띄우면 말이 길어질수록
        // 화면이 앞말을 잃는다.
        const buffered = utteranceSegment(finalBufferRef.current)?.text ?? "";
        showInterim(buffered ? `${buffered} ${text}` : text);
      }
    };

    socket.onerror = () => {
      if (!established) { rejectConnection(connectionError()); socket.close(); }
    };

    socket.onclose = (event) => {
      if (!established) {
        if (isCurrent()) rejectConnection(connectionError());
        else resolveConnection();
        return;
      }
      if (socketRef.current !== socket) return;
      audioSocketReadyRef.current = false;
      stopSocketTimers();
      if (finishingRef.current || startedAtRef.current === 0) return;
      flushUtterance();
      if ([4002, 4003, 4005].includes(event.code)) {
        if (event.code === 4002) options.onCredits(0);
        void pauseRef.current("network").then(() => options.setError(event.code === 4002
          ? (isEnglish ? "You’ve used your available credits. Add credits to continue." : "사용 가능한 크레딧을 모두 썼어요. 크레딧을 추가하면 이어 들을 수 있어요.")
          : (isEnglish ? "Recording was paused. Refresh the page before resuming." : "기록이 일시정지됐어요. 페이지를 새로고침한 뒤 이어 들어 주세요.")));
        return;
      }
      // Capture continues into the bounded PCM buffer while reconnecting.
      scheduleReconnect();
    };
    try { await connected; } finally { window.clearTimeout(connectionTimer); }
  }

  /**
   * 입력 실패는 브라우저 원문 예외로 온다. 원문·API 이름은 노출하지 않고 복구
   * 방법이 있는 문구로 바꾼다. 서버가 준 메시지(크레딧 등)는 그대로 쓴다.
   */
  function inputMessage(caught: unknown) {
    if (caught instanceof LectureInputError) {
      const tab = sourceRef.current === "browser-tab";
      switch (caught.code) {
        case "cancelled": return isEnglish ? "Sharing didn’t start. You can try again." : "선택 화면을 닫았어요. 다시 시작할 수 있어요.";
        case "inactive": return isEnglish ? "Open the Lecue tab and click the button to share again." : "Lecue 탭에서 버튼을 직접 눌러 다시 공유해 주세요.";
        case "no-audio": return isEnglish ? "Share the tab’s audio too." : "탭 소리도 함께 공유해 주세요.";
        case "wrong-surface": return isEnglish ? "Choose the browser tab playing your lecture." : "강의가 재생되는 브라우저 탭을 선택해 주세요.";
        case "unsupported": return tab
          ? (isEnglish ? "Use Chrome on a computer for online lectures." : "온라인 강의는 컴퓨터의 Chrome에서 이용해 주세요.")
          : (isEnglish ? "This browser does not support microphone input." : "이 브라우저는 마이크 입력을 지원하지 않습니다.");
        case "mic-blocked": return isEnglish
          ? "Microphone access is blocked. Allow it for this site in your browser's address bar, then start again."
          : "마이크 사용이 차단돼 있습니다. 브라우저 주소창에서 이 사이트의 마이크를 허용한 뒤 다시 시작해 주세요.";
        case "mic-missing": return isEnglish
          ? "No microphone is available. Connect one, close apps that may be using it, and start again."
          : "사용할 수 있는 마이크가 없습니다. 마이크를 연결하고 마이크를 쓰는 다른 앱을 닫은 뒤 다시 시작해 주세요.";
        default: return tab
          ? (isEnglish ? "Couldn’t connect the lecture audio. Try again." : "강의 소리를 연결하지 못했어요. 다시 시도해 주세요.")
          : (isEnglish ? "Could not start the microphone." : "마이크를 시작하지 못했습니다.");
      }
    }
    if (caught instanceof DOMException) {
      // fetch 시간 초과(AbortError) 등. 원문 대신 연결 실패 문구.
      return sourceRef.current === "browser-tab"
        ? (isEnglish ? "Couldn’t connect the lecture audio. Try again." : "강의 소리를 연결하지 못했어요. 다시 시도해 주세요.")
        : (isEnglish ? "Could not start the microphone." : "마이크를 시작하지 못했습니다.");
    }
    return caught instanceof Error && caught.message
      ? caught.message
      : isEnglish ? "Could not start the lecture." : "강의를 시작하지 못했습니다.";
  }

  /** 취소된 시도의 늦은 결과를 조용히 버릴 때 던지는 표식. */
  const STALE = Symbol("stale-operation");

  /**
   * 세션 start. 같은 startRequestId로 15초 안에서 재시도하므로, 응답만 유실돼도
   * 서버가 기존 행을 돌려주고 두 번째 세션·과금은 생기지 않는다(NET-02).
   * 요청 ID를 바꿔 재전송하지는 않는다.
   */
  async function startSession(draftSessionId: string, source: LectureInputSource, operationId: number): Promise<SessionSummary> {
    const startRequestId = crypto.randomUUID();
    const deadline = Date.now() + START_DEADLINE_MS;
    const title = lectureTitle.trim() || (isEnglish ? `Lecture ${new Date().toLocaleDateString("en-US")}` : `${new Date().toLocaleDateString("ko-KR")} 수업`);
    for (;;) {
      if (operationIdRef.current !== operationId) throw STALE;
      const remaining = deadline - Date.now();
      if (remaining < 1_000) throw new LectureInputError("failed");
      try {
        const response = await fetch("/api/lecture-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          signal: AbortSignal.timeout(remaining),
          body: JSON.stringify({
            action: "start",
            sessionId: draftSessionId || null,
            classroomId: activeClassroomId || null,
            title,
            inputSource: source,
            startRequestId,
          }),
        });
        const data = await response.json() as { session?: SessionSummary; error?: string };
        if (!response.ok || !data.session) throw new Error(data.error);
        return data.session;
      } catch (caught) {
        // 서버가 답했다(4xx/5xx)면 재시도하지 않는다. 네트워크/타임아웃만 같은 ID로 다시.
        const transport = caught instanceof TypeError || (caught instanceof DOMException && caught.name !== "SyntaxError");
        if (!transport) throw caught;
      }
    }
  }

  async function startLecture(source: LectureInputSource = "microphone", consentReady?: Promise<void>, externalSource?: ExternalPcmSource) {
    // 더블클릭이 리렌더보다 빠르면 status 검사만으로는 두 번 다 통과해서
    // 캡처·세션 생성·소켓이 전부 이중으로 뜬다. 선택창도 하나만(UX-05).
    if (finishingRef.current || startingRef.current || status === "connecting" || status === "recording" || status === "paused") return;
    startingRef.current = true;
    const operationId = ++operationIdRef.current;
    // Phone capture uses the existing microphone session/credit contract.
    if (externalSource) source = "microphone";
    releaseInput();
    externalSourceRef.current = externalSource ?? null;
    externalCaptureEndedRef.current = false;
    setPhoneInput(Boolean(externalSource));
    // The workspace owns the agreement UI. Its final click can open the native
    // picker immediately, but no recording starts until the save is confirmed.
    options.setError("");
    options.setNotice("");
    startedAtRef.current = 0;
    elapsedBaseMsRef.current = 0;
    const draftSessionId = status === "idle" ? activeSessionIdRef.current : "";
    saveFailuresRef.current = 0;
    vocabularyRefreshedRef.current = false;
    silenceNoticedRef.current = false;
    audioQueueRef.current = new PcmSendQueue();
    audioSocketReadyRef.current = false;
    sourceRef.current = source;
    setInputSource(source);
    setPauseReason(null);
    if (!draftSessionId) options.setActiveSessionId("");

    const recorderSupported = typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
    if (!externalSource && !recorderSupported && source === "microphone") {
      startingRef.current = false;
      options.setError(isEnglish
        ? "Live recording is not supported in this browser (Safari on iPhone/iPad). Use Chrome on a laptop, or record with a voice memo app and add the file with the Upload recording button."
        : "이 브라우저(아이폰·아이패드 Safari)에서는 실시간 녹음이 지원되지 않아요. 노트북 Chrome을 쓰거나, 음성 메모 앱으로 녹음한 파일을 '녹음 파일' 버튼으로 올려 주세요.");
      setStatus("error");
      return;
    }

    setConnectingPhase(source === "browser-tab" ? "selecting" : null);
    setStatus("connecting");
    // getDisplayMedia runs in this click. Transient activation is time-limited,
    // so a preceding network round trip cannot reliably preserve it.
    const acquiring = externalSource ? null : acquireLectureInput(source, audioConstraints());
    const consentController = consentReady ? new AbortController() : null;
    consentStartAbortRef.current = consentController;

    let startedSessionId = "";
    let input: LectureInput | null = null;
    try {
      if (externalSource) {
        if (consentReady && consentController) {
          const signal = consentController.signal;
          let aborted!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => {
            aborted = () => reject(new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
          });
          try { await Promise.race([consentReady, cancelled]); }
          finally { signal.removeEventListener("abort", aborted); }
        }
      } else {
        input = consentReady && consentController
          ? await waitForConsentedInput(acquiring!, consentReady, consentController.signal)
          : await acquiring!;
      }
      if (operationIdRef.current !== operationId || finishingRef.current) {
        // 선택창이 열린 사이 종료·이동했다. 도착한 트랙은 즉시 놓고 세션은 만들지 않는다(LIFE-01).
        input?.dispose();
        throw STALE;
      }
      if (input) {
        inputRef.current = input;
        setPreviewStream(input.source === "browser-tab" ? new MediaStream(input.captureStream.getVideoTracks()) : null);
        streamRef.current = input.audioStream;
        watchInput(input);
      }
      setConnectingPhase("opening");
      const stream = input?.audioStream ?? null;
      if (stream) startMicMeter(stream);
      streamOffsetMsRef.current = 0;
      audioQueueRef.current.clear();
      socketOpenedRef.current = false;
      // 첫 조각은 서버 세션보다 먼저 잡힌다. 로컬 시계도 그 시점에서 시작해
      // 자막 시각(소켓 스트림 시계 0)과 정렬한다. 서버 started_at은 몇백 ms 뒤다.
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      await startPcmCapture(stream);
      if (operationIdRef.current !== operationId) throw STALE;

      const session = await startSession(draftSessionId, source, operationId);
      startedSessionId = session.id;
      if (operationIdRef.current !== operationId) throw STALE;
      options.setActiveSessionId(session.id);
      activeSessionIdRef.current = session.id;
      options.setLectureTitle(session.title);
      setSegments([]);
      segmentsRef.current = [];
      segmentIdsRef.current.clear();
      confirmedSegmentIdsRef.current.clear();
      finalBufferRef.current = [];
      showInterim("");
      options.clearMessages();
      // '기록 중'은 릴레이 연결이 열렸을 때 표시한다. 준비 중 음성도 보관한다.
      await connectDeepgram(stream);
      if (operationIdRef.current !== operationId) throw STALE;
      if (!captureMatches(stream, externalSource ?? null) || !socketOpenedRef.current) throw new LectureInputError("failed");
      // Count only a newly created session whose capture and relay socket both
      // reached the recording state. Resume and reconnect paths do not pass here.
      trackAnalyticsEvent("recording_started", {
        locale,
        input_source: source === "browser-tab" ? "browser_tab" : "microphone",
      });
    } catch (caught) {
      const stale = operationIdRef.current !== operationId;
      if (startedSessionId && (stale || !socketOpenedRef.current)) {
        void submitFinishSave(startedSessionId, 0, []);
      }
      if (stale) {
        if (input && inputRef.current !== input) input.dispose();
        if (externalSource && externalSourceRef.current !== externalSource) externalSource.dispose();
        return;
      }
      discardFailedCapture();
      if (inputRef.current === input) releaseInput();
      if (caught === STALE) return;
      setConnectingPhase(null);
      // 취소는 오류가 아니다: 원래 준비 화면으로, 빨간 오류 없이 한 줄만.
      if (caught instanceof LectureInputError && caught.code === "cancelled") {
        options.setNotice(inputMessage(caught));
        setStatus("idle");
        return;
      }
      options.setError(inputMessage(caught));
      setStatus("error");
    } finally {
      if (consentStartAbortRef.current === consentController) consentStartAbortRef.current = null;
      if (operationIdRef.current === operationId) startingRef.current = false;
    }
  }

  /**
   * 사용자 입력 즉시 전송을 멈춘다. 서버 pause 응답을 기다리며 오디오를 더
   * 보내지 않는다. 탭 공유는 살려 두고(브라우저 공유 표시가 남는다) 오디오
   * track만 끈다 — 이어 듣기가 선택창 없이 되도록. 마이크는 기존처럼 놓는다.
   * 공유 종료(capture-ended)면 원본까지 전부 정리한다.
   */
  async function pauseLecture(reason: Exclude<PauseReason, null> = "manual") {
    if (statusRef.current !== "recording" || finishingRef.current) return;
    finishingRef.current = true;
    setIsFinalizing(true);
    setIsPausing(true);
    const sessionId = activeSessionIdRef.current;
    const input = inputRef.current;
    const external = externalSourceRef.current;
    try {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      stopSocketTimers();
      // 화면은 1초 안에 일시정지로 바뀐다(LIFE-03). 아래 꼬리 대기는 그 뒤에.
      const localMs = currentElapsedMs();
      elapsedBaseMsRef.current = localMs;
      startedAtRef.current = 0;
      setElapsedMs(localMs);
      const keepShare = reason === "manual" && input?.source === "browser-tab" && !input.disposed;
      if (keepShare) {
        input.audioStream.getAudioTracks().forEach((track) => { track.enabled = false; });
        stopMicMeter();
      } else {
        releaseInput(Boolean(external));
      }
      setPauseReason(reason === "manual" && sourceRef.current === "browser-tab" && !keepShare ? "capture-ended" : reason);
      statusRef.current = "paused";
      setStatus("paused");
      if (reason === "capture-ended" && sourceRef.current === "browser-tab") options.setError(captureEndedMessage);
      // 멈춘 레코더의 꼬리 확정을 기다린 뒤에 비운다.
      let closeGrace: Promise<void> | undefined;
      if (recorderRef.current) {
        try { await recorderRef.current.stop(); }
        catch (error) {
          if (!external) throw error;
          // A lost phone acknowledgement cannot leave the desktop/session live.
          await closePcmStream(socketRef.current, audioQueueRef.current);
          options.setError(phoneEndedMessage);
        }
        // The relay releases its DB lease after closing the browser socket.
        // Preserve the existing resume grace, but overlap the pause request
        // once close proves every final transcript frame has been delivered.
        closeGrace = new Promise((resolve) => setTimeout(resolve, 1_200));
        await waitForTranscriptTail(socketRef.current);
      }
      flushUtterance();
      audioQueueRef.current = new PcmSendQueue();
      socketRef.current?.close();
      // 서버 pause. 실패하면 '저장 중'으로 두고 online/30초마다 재시도한다.
      // 서버 상태를 모른 채 resume을 보내지 않는다.
      const pauseSave = sessionId ? submitPause(sessionId) : Promise.resolve(true);
      const [, saved] = await Promise.all([closeGrace, pauseSave]);
      if (sessionId && !saved) {
        pendingPauseRef.current = sessionId;
        options.setNotice(pauseSavingMessage);
      }
    } finally {
      finishingRef.current = false;
      setIsFinalizing(false);
      setIsPausing(false);
    }
  }

  // 매 렌더마다 최신 클로저로 갱신 — 트랙 ended 콜백이 낡은 status를 읽지 않게.
  pauseRef.current = pauseLecture;

  /**
   * 탭의 원본 트랙이 살아 있으면 권한창 없이 재사용한다. 끝났으면(공유 중지,
   * 새로고침 복원) 클릭의 동기 구간에서 새 선택창을 연다 — 자동 재허용은 없다.
   * source는 세션에 고정: 탭 재개에서 getUserMedia는 호출되지 않는다.
   */
  async function resumePausedLecture(externalSource?: ExternalPcmSource | null): Promise<boolean> {
    if (statusRef.current !== "paused" || finishingRef.current) return false;
    if (pendingPauseRef.current) {
      options.setNotice(pauseSavingMessage);
      void submitPause(pendingPauseRef.current);
      return false;
    }
    // A refreshed phone session can explicitly attach its new QR pairing.
    // A missing/unready replacement must never acquire the laptop microphone.
    if (externalSource) {
      if (!externalSource.isLive()) { options.setError(phoneEndedMessage); return false; }
      if (externalSource !== externalSourceRef.current) {
        releaseInput();
        externalSourceRef.current = externalSource;
      }
      externalCaptureEndedRef.current = false;
      sourceRef.current = "microphone";
      setInputSource("microphone");
      setPhoneInput(true);
    } else if (externalSource === null) {
      // Only an explicit computer-microphone switch revokes the phone pair.
      // Ordinary Resume must never silently change the user's input device.
      releaseInput();
    }
    finishingRef.current = true;
    const operationId = ++operationIdRef.current;
    const sessionId = activeSessionIdRef.current;
    options.setError("");
    options.setNotice("");
    const source = sourceRef.current;
    const external = externalSourceRef.current;
    const existing = inputRef.current;
    const live = Boolean(existing && !existing.disposed
      && existing.audioStream.getAudioTracks().some((track) => track.readyState === "live"));
    setConnectingPhase(live ? "opening" : source === "browser-tab" ? "selecting" : null);
    setStatus("connecting");
    // 동기 구간: 권한창은 여기서 열린다.
    const acquiring = external ? Promise.resolve(null)
      : live && existing ? Promise.resolve(existing) : acquireLectureInput(source, audioConstraints());
    let input: LectureInput | null = null;
    let installed = live;
    let resumed = false;
    try {
      input = await acquiring;
      if (operationIdRef.current !== operationId) {
        if (!live) input?.dispose();
        throw STALE;
      }
      if (external) {
        if (!external.isLive()) throw new Error(phoneEndedMessage);
        externalCaptureEndedRef.current = false;
      } else if (!live && input) {
        releaseInput();
        inputRef.current = input;
        setPreviewStream(input.source === "browser-tab" ? new MediaStream(input.captureStream.getVideoTracks()) : null);
        streamRef.current = input.audioStream;
        watchInput(input);
        installed = true;
      }
      setConnectingPhase("opening");
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        signal: AbortSignal.timeout(START_DEADLINE_MS),
        body: JSON.stringify({ action: "resume", sessionId }),
      });
      const data = await response.json() as { recordedMs?: number; error?: string };
      if (!response.ok) throw new Error(data.error);
      resumed = true;
      if (operationIdRef.current !== operationId) throw STALE;
      // recorded_ms가 오프셋. 일시정지한 시간은 새 자막 시각에 들어가지 않는다.
      const recordedMs = data.recordedMs ?? elapsedBaseMsRef.current;
      elapsedBaseMsRef.current = recordedMs;
      streamOffsetMsRef.current = recordedMs;
      startedAtRef.current = Date.now();
      const stream = input?.audioStream ?? null;
      if (stream) {
        stream.getAudioTracks().forEach((track) => { track.enabled = true; });
        startMicMeter(stream);
      }
      audioQueueRef.current = new PcmSendQueue();
      audioSocketReadyRef.current = false;
      socketOpenedRef.current = false;
      reconnectAttemptRef.current = 0;
      setPauseReason(null);
      await startPcmCapture(stream);
      if (operationIdRef.current !== operationId) throw STALE;
      await connectDeepgram(stream);
      if (operationIdRef.current !== operationId) throw STALE;
      if (!captureMatches(stream, external) || !socketOpenedRef.current) throw new LectureInputError("failed");
      return true;
    } catch (caught) {
      if (operationIdRef.current !== operationId) {
        if (resumed) void submitPause(sessionId);
        if (input && inputRef.current !== input) input.dispose();
        return false;
      }
      discardFailedCapture();
      // 새로 얻은 캡처가 실패했으면 놓는다. 살아 있던 탭 공유는 그대로 둔다.
      if (external) {
        stopMicMeter();
      } else if (!live) {
        if (installed) releaseInput();
        else input?.dispose();
      } else if (input) {
        input.audioStream.getAudioTracks().forEach((track) => { track.enabled = false; });
        stopMicMeter();
      }
      if (resumed && !(await submitPause(sessionId))) {
        pendingPauseRef.current = sessionId;
        options.setNotice(pauseSavingMessage);
      }
      setConnectingPhase(null);
      if (caught instanceof LectureInputError && caught.code === "cancelled") options.setNotice(inputMessage(caught));
      else options.setError(inputMessage(caught));
      setStatus("paused");
      return false;
    } finally {
      if (operationIdRef.current === operationId) finishingRef.current = false;
    }
  }

  async function resumeLecture(externalSource?: ExternalPcmSource) {
    if (switchingMicrophoneRef.current) return false;
    return resumePausedLecture(externalSource);
  }

  /** The workspace uses this after a failed handoff to retain only the adopted pair. */
  function isCurrentPhoneSource(source: ExternalPcmSource) {
    return externalSourceRef.current === source;
  }

  /**
   * Device handoff reuses pause/resume, including final PCM drain, server locks,
   * credit verification and the saved clock offset. Pair the phone before this
   * call; cancelling that picker then leaves the current recording untouched.
   * A failed replacement stays paused. An adopted phone pair remains available
   * for Resume; ownership of an unadopted source stays with the caller.
   */
  async function switchMicrophone(target: "computer" | "phone", externalSource?: ExternalPcmSource): Promise<boolean> {
    if (switchingMicrophoneRef.current || finishingRef.current || startingRef.current
      || sourceRef.current !== "microphone" || !activeSessionIdRef.current
      || (statusRef.current !== "recording" && statusRef.current !== "paused")) return false;
    if (target === "phone" && !externalSource?.isLive()) {
      options.setError(phoneEndedMessage);
      return false;
    }
    const replacement = target === "phone" ? externalSource! : null;
    if (statusRef.current === "recording" && externalSourceRef.current === replacement) return true;
    switchingMicrophoneRef.current = true;
    setIsSwitchingMicrophone(true);
    const operationId = operationIdRef.current;
    const sessionId = activeSessionIdRef.current;
    try {
      if (statusRef.current === "recording") await pauseLecture();
      // Unmount, lecture navigation or ending may cancel the handoff while the
      // previous recorder is draining. Never attach its replacement afterwards.
      if (operationIdRef.current !== operationId || activeSessionIdRef.current !== sessionId
        || finishingRef.current || statusRef.current !== "paused") return false;
      if (pendingPauseRef.current) {
        options.setNotice(pauseSavingMessage);
        return false;
      }
      return await resumePausedLecture(replacement);
    } catch {
      if (operationIdRef.current !== operationId || activeSessionIdRef.current !== sessionId) return false;
      // Even a local recorder's stop failure must not leave the server recording
      // or permit a second capture. Keep the lecture available as a paused retry.
      discardFailedCapture();
      releaseInput(Boolean(externalSourceRef.current));
      if (!(await submitPause(sessionId))) {
        pendingPauseRef.current = sessionId;
        options.setNotice(pauseSavingMessage);
      }
      statusRef.current = "paused";
      setStatus("paused");
      options.setError(isEnglish
        ? "The microphone switch did not finish. Recording is paused; choose the microphone again to continue."
        : "마이크 전환을 마치지 못해 일시정지했습니다. 사용할 마이크를 다시 선택해 주세요.");
      return false;
    } finally {
      switchingMicrophoneRef.current = false;
      setIsSwitchingMicrophone(false);
    }
  }

  async function finishLecture() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setIsFinalizing(true);
    try {
    // 선택창이 열려 있었다면 늦은 승인은 stale로 버려진다.
    operationIdRef.current += 1;
    consentStartAbortRef.current?.abort();
    startingRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopSocketTimers();
    const durationMs = currentElapsedMs();
    const reachedLimit = durationMs >= MAX_LECTURE_MS;
    // 버튼을 누른 즉시 화면을 종료 상태로 바꾼다. 아래 1.2초 대기 동안
    // "기록 중"이 그대로면 눌리지 않은 줄 알고 다시 누른다.
    setStatus("ended");
    setConnectingPhase(null);
    setPauseReason(null);
    // 레코더를 먼저 멈춰 종료 신호를 보내고, 공급자가 맺음말을 확정할 시간을
    // 준다. flush를 먼저 하면 마지막 문장이 버퍼에 닿기 전에 창이 닫힌다.
    // ponytail: 고정 1.2초 대기. Deepgram 마지막 Results/Soniox finished를
    // 직접 기다리는 게 정석이지만 배관 대비 이 대기가 짧고 실패 모드가 없다.
    if (recorderRef.current) {
      try { await recorderRef.current.stop(); }
      catch (error) {
        if (!externalSourceRef.current) throw error;
        await closePcmStream(socketRef.current, audioQueueRef.current);
        options.setError(phoneEndedMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    flushUtterance();
    audioQueueRef.current.clear();
    // 입력은 여기서 놓는다(원본·오디오 둘 다). 재연결이 같은 스트림을 다시
    // 쓰므로 레코더가 멈출 때마다 트랙을 끄면 두 번째 소켓이 무음을 듣는다.
    releaseInput();
    pendingPauseRef.current = null;
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      const snapshot = { sessionId, durationMs, segments: structuredClone(segmentsRef.current.filter((segment) => !confirmedSegmentIdsRef.current.has(segment.id))) };
      pendingFinishRef.current.add(snapshot);
      try {
        window.localStorage.setItem(`lecue-unsaved-finish-${sessionId}`, JSON.stringify(snapshot));
      } catch { /* If storage is full, the in-memory queue still retries. */ }
      const saved = await pendingFinishRef.current.save(sessionId, (pending) => submitFinishSave(pending.sessionId, pending.durationMs, pending.segments));
      if (saved) {
        void options.loadCredits().catch(() => {});
        if (reachedLimit) {
          // Hitting the cap saved the lecture, so this is a notice, not the
          // red alert banner it used to be rendered in.
          options.setNotice(isEnglish ? "This lecture reached the 3-hour session limit and was saved." : "수업 1회 최대 3시간에 도달해 자동으로 저장·종료했습니다.");
        }
      } else {
        // 유일하게 작업물이 영구 소실되던 경로였다: 미러 + 자동 재시도.
        options.setError(finishSaveErrorsRef.current.get(sessionId) || (isEnglish
          ? "The lecture ended, but saving did not finish. The recovery copy has been kept and saving will retry automatically."
          : "강의는 종료됐지만 저장을 마치지 못했습니다. 복구 사본을 보관했으며 자동으로 다시 저장합니다."));
      }
    }
    // socket.onclose lands after these round-trips on a fast connection, so
    // finishingRef alone does not stop a clean stop from being read as a drop.
    // A lecture that has ended has no start time.
    startedAtRef.current = 0;
    elapsedBaseMsRef.current = durationMs;
    } finally {
      finishingRef.current = false;
      setIsFinalizing(false);
    }
  }

  function stopLecture() {
    void finishLecture();
  }

  /** 세션 복원(열기)에서 저장된 source를 세션에 고정한다. 캡처는 열지 않는다. */
  function restoreInputSource(source: LectureInputSource | undefined) {
    if (externalSourceRef.current) releaseInput();
    const next = source ?? "microphone";
    sourceRef.current = next;
    setInputSource(next);
    setPauseReason(next === "browser-tab" ? "capture-ended" : null);
    setConnectingPhase(null);
  }

  return {
    status, setStatus, elapsedMs, setElapsedMs, segments, setSegments, interim, showInterim, isFinalizing, isPausing, isSwitchingMicrophone,
    connectingPhase, pauseReason, inputSource, phoneInput, restoreInputSource, previewStream, waitingForAudio,
    meterRef, segmentsRef, segmentIdsRef, confirmedSegmentIdsRef, activeSessionIdRef,
    finishingRef, saveFailuresRef, elapsedBaseMsRef, startedAtRef, streamOffsetMsRef,
    currentElapsedMs, flushUtterance,
    startLecture, pauseLecture, resumeLecture, switchMicrophone, isCurrentPhoneSource, finishLecture, stopLecture,
  };
}
