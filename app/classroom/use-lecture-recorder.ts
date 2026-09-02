"use client";

import { useEffect, useRef, useState } from "react";

import type { DeepgramFinal, DeepgramLanguage } from "../lib/deepgram";
import { utteranceOverflowed, utteranceSegment } from "../lib/deepgram";
import { adaptSonioxMessages, type SonioxMessage } from "../lib/soniox";

export type Status = "idle" | "connecting" | "recording" | "paused" | "ended" | "error";

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
};

type DeepgramResult = DeepgramFinal & {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
};

/** 끊긴 소켓을 다시 여는 간격. 마지막 값은 포기하지 않고 계속 되풀이한다. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000];

export const MAX_LECTURE_MS = 10_800_000;

type RecorderOptions = {
  locale: "ko" | "en";
  isEnglish: boolean;
  speechLanguage: DeepgramLanguage;
  /** 강의 시작 시점에 세션을 만들 강의실. */
  activeClassroomId: string;
  /** 화면에 보이는 세션. 훅이 ref로 미러링해 소켓 콜백이 읽는다. */
  activeSessionId: string;
  lectureTitle: string;
  setError(message: string): void;
  setNotice(message: string): void;
  setMobilePane(pane: "chat" | "transcript"): void;
  /** 새 강의가 시작되면 이전 수업의 질문 스레드를 비운다. */
  clearMessages(): void;
  setActiveSessionId(id: string): void;
  setLectureTitle(title: string): void;
  /** 토큰 응답이 실어 오는 최신 크레딧 수. */
  onCredits(credits: number): void;
  loadClassrooms(preferredId?: string): Promise<void>;
  loadCredits(): Promise<void>;
};

/**
 * 녹음 엔진: 마이크 → MediaRecorder → STT 소켓 → 세그먼트 확정·저장, 그리고
 * 시작/일시정지/재개/종료의 수명주기 전부. workspace-client에서 verbatim으로
 * 분리했다 — 재연결·이중 시작 같은 수명주기 버그를 UI와 떼어 두기 위해서다.
 */
export function useLectureRecorder(options: RecorderOptions) {
  const { locale, isEnglish, speechLanguage, activeClassroomId, activeSessionId, lectureTitle } = options;

  const [status, setStatus] = useState<Status>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const elapsedBaseMsRef = useRef(0);
  const segmentIdsRef = useRef(new Set<string>());
  // Segments the server has actually persisted (its "segment" save fetch
  // resolved with response.ok). /api/ask only needs to carry the ones missing
  // from this set — the server reads everything else back from the DB itself.
  const confirmedSegmentIdsRef = useRef(new Set<string>());
  const segmentsRef = useRef<Segment[]>([]);
  const activeSessionIdRef = useRef("");
  const finishingRef = useRef(false);
  // startLecture in-flight guard: state alone lets a double-click race the
  // re-render and start everything twice.
  const startingRef = useRef(false);
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
  const pendingAudioRef = useRef<Blob[]>([]);
  const socketOpenedRef = useRef(false);
  const meterRef = useRef<HTMLSpanElement | null>(null);
  // 현재 소켓이 Soniox인지. 레코더 onstop이 종료 메시지 형식을 고를 때 읽는다.
  const sonioxModeRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

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
      if (stream && !finishingRef.current && startedAtRef.current !== 0) {
        void connectDeepgram(stream).catch(() => scheduleReconnect());
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      // Unmount is a stop. Without marking it as one, the socket's onclose
      // sees a live recording and schedules reconnects forever against the
      // dead mic stream — a new WebSocket and token fetch every 30 seconds
      // until the tab closes.
      finishingRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      stopSocketTimers();
      recorderRef.current?.stop();
      socketRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      stopMicMeter();
    },
    [],
  );

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
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "segment", sessionId: activeSessionIdRef.current, segment, latencyMs }),
      });
      if (response.ok) {
        confirmedSegmentIdsRef.current.add(segment.id);
        saveFailuresRef.current = 0;
        return;
      }
      const data = await response.json().catch(() => ({})) as { error?: string; credits?: number };
      if (response.status === 402 || response.status === 409) {
        await finishLecture();
        options.setError(data.error ?? (isEnglish ? "Recording stopped because credits could not be verified." : "크레딧을 확인하지 못해 강의를 종료합니다."));
        await options.loadCredits();
        return;
      }
      throw new Error(data.error ?? "save failed");
    } catch {
      saveFailuresRef.current += 1;
      // One dropped save is a blip; three in a row means the transcript is no
      // longer being kept and the learner needs to know before the lecture ends.
      if (saveFailuresRef.current >= 3) {
        options.setError(isEnglish ? "Transcription stopped. Check the connection." : "받아쓰기가 멈췄습니다. 연결을 확인해 주세요.");
      }
    }
  }

  function stopSocketTimers() {
    if (keepAliveTimerRef.current !== null) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    if (vocabularyTimerRef.current !== null) {
      window.clearTimeout(vocabularyTimerRef.current);
      vocabularyTimerRef.current = null;
    }
  }

  /**
   * 강의실 와이파이는 3시간을 버티지 못한다. 끊기면 강의를 끝내지 않고 같은
   * MediaStream에 새 소켓을 연다. 자동 종료는 하지 않는다 — 언제 그만둘지는
   * 수업을 듣는 사람이 정한다.
   *
   * ponytail: 재연결 사이의 1~2초 발화는 잃는다. WebM은 초기화 세그먼트가 첫
   * 청크에만 있어 중간부터 다시 흘릴 수 없다. 손실이 한 문장을 넘으면 linear16
   * PCM + 링 버퍼로 올라가야 한다.
   */
  function scheduleReconnect() {
    const stream = streamRef.current;
    if (!stream || finishingRef.current || startedAtRef.current === 0) return;
    const attempt = reconnectAttemptRef.current;
    reconnectAttemptRef.current = attempt + 1;
    options.setError(attempt < RECONNECT_DELAYS_MS.length - 1
      ? (isEnglish ? "The connection dropped. Reconnecting…" : "연결이 끊겨 다시 연결하는 중입니다…")
      : (isEnglish
        ? "Still reconnecting. You can end the lecture and keep everything transcribed so far."
        : "계속 다시 연결하고 있습니다. 지금까지 받아쓴 내용을 남기고 수업을 종료해도 됩니다."));
    reconnectTimerRef.current = window.setTimeout(() => {
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
    const context = new AudioContext();
    audioContextRef.current = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (audioContextRef.current !== context) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
      meterRef.current?.style.setProperty("--level", String(Math.min(1, peak / 56)));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopMicMeter() {
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  }

  function startMediaRecorder(stream: MediaStream) {
    if (recorderRef.current?.state === "recording") return;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      // pause/resume can replace the recorder before the old one's final
      // dataavailable event arrives. Never feed that stale WebM chunk into the
      // resumed socket.
      if (recorderRef.current !== recorder) return;
      if (event.data.size === 0) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(event.data);
        lastSentAtRef.current = Date.now();
      } else {
        pendingAudioRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      // The previous recorder may finish after resume has installed a new one.
      // Its CloseStream must not close the new Deepgram connection.
      if (recorderRef.current !== recorder) return;
      const socket = socketRef.current;
      // Soniox의 정상 종료는 빈 프레임, Deepgram은 CloseStream 메시지다.
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(sonioxModeRef.current ? "" : JSON.stringify({ type: "CloseStream" }));
      }
    };
    recorder.start(250);
  }

  /**
   * 토큰을 받아 소켓을 연다. 첫 연결과 재연결이 같은 경로를 쓴다 — grant는 30초
   * 만에 만료되고 주소는 매번 서버가 다시 만들어 주므로 재사용할 것이 없다.
   */
  async function connectDeepgram(stream: MediaStream, recoverAsPaused = false) {
    const tokenResponse = await fetch("/api/deepgram-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
      body: JSON.stringify({ sessionId: activeSessionIdRef.current, language: speechLanguage }),
    });
    const tokenData = (await tokenResponse.json()) as { accessToken?: string; credits?: number; listenUrl?: string; refreshInMs?: number | null; sonioxConfig?: Record<string, unknown>; error?: string };
    if (!tokenResponse.ok || !tokenData.accessToken || !tokenData.listenUrl) {
      throw new Error(tokenData.error ?? (isEnglish
        ? "Could not obtain a speech-recognition token."
        : "음성 인식 토큰을 받지 못했습니다."));
    }
    if (typeof tokenData.credits === "number") options.onCredits(tokenData.credits);

    // 파라미터도 용어집도 서버가 정한다 (app/lib/deepgram.ts, app/lib/soniox.ts).
    // 클라이언트를 다시 배포하지 않고 모델·엔드포인팅·용어 예산을 조정하기 위해서다.
    // Soniox는 인증·설정이 URL이 아니라 첫 JSON 메시지로 간다.
    const sonioxConfig = tokenData.sonioxConfig;
    sonioxModeRef.current = Boolean(sonioxConfig);
    const socket = sonioxConfig
      ? new WebSocket(tokenData.listenUrl)
      : new WebSocket(tokenData.listenUrl, ["bearer", tokenData.accessToken]);
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) {
        socket.close();
        return;
      }
      if (finishingRef.current || startedAtRef.current === 0) {
        socket.close();
        return;
      }
      reconnectAttemptRef.current = 0;
      options.setError("");
      const firstConnection = !socketOpenedRef.current;
      socketOpenedRef.current = true;
      // Soniox는 오디오보다 먼저 설정 메시지를 받아야 한다.
      if (sonioxConfig) socket.send(JSON.stringify({ api_key: tokenData.accessToken, ...sonioxConfig }));
      // 첫 연결의 대기 조각만 재생한다. 그건 방금 시작한 레코더의 것이라
      // WebM 헤더부터 온전하다. 재연결이면 대기 조각은 죽은 레코더의
      // 중간 클러스터라, 새 레코더의 헤더 앞에 흘리면 디코딩이 깨진다.
      if (!firstConnection) pendingAudioRef.current = [];
      startMediaRecorder(stream);
      for (const chunk of pendingAudioRef.current.splice(0)) socket.send(chunk);
      if (!firstConnection) {
        // 새 소켓의 시계는 0에서 다시 시작한다. 이 값을 더하지 않으면 재연결 뒤
        // 세그먼트가 강의 첫머리와 겹쳐 순서와 앵커가 함께 무너진다.
        streamOffsetMsRef.current = currentElapsedMs();
      }
      // 백그라운드 탭이나 절전으로 레코더가 멎으면 Deepgram이 10초쯤 뒤 소켓을 닫는다.
      lastSentAtRef.current = Date.now();
      // 자료도 용어집도 없는 수업이면 서버가 갱신 시각을 함께 준다. keyterm은
      // 소켓을 열 때만 붙으므로, 한 번 닫아 재연결 경로가 갱신된 용어로 다시
      // 열게 한다. 그 사이 1~2초 발화는 잃는다 — 남은 한 시간의 전공어 표기와
      // 맞바꾼다. 한 수업에 한 번만 한다.
      if (typeof tokenData.refreshInMs === "number" && !vocabularyRefreshedRef.current) {
        vocabularyTimerRef.current = window.setTimeout(() => {
          vocabularyRefreshedRef.current = true;
          if (!finishingRef.current) socketRef.current?.close();
        }, tokenData.refreshInMs);
      }
      keepAliveTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && Date.now() - lastSentAtRef.current > 5_000) {
          socket.send(JSON.stringify({ type: sonioxConfig ? "keepalive" : "KeepAlive" }));
        }
      }, 5_000);
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return; // 공급자가 비JSON 프레임을 보내도 세션은 계속 간다.
      }
      // Soniox 토큰 응답은 어댑터가 Deepgram 모양으로 바꾼다. 아래 로직은 공용.
      const messages = sonioxConfig
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
      if (socketRef.current !== socket) return;
      // 강의가 이미 돌고 있으면 onclose의 재연결이 처리한다. 시작도 못 한
      // 연결만 여기서 실패로 끝낸다.
      if (socketOpenedRef.current) return;
      startedAtRef.current = 0;
      pendingAudioRef.current = [];
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      if (activeSessionIdRef.current) {
        void fetch("/api/lecture-sessions", {
          method: recoverAsPaused ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify(recoverAsPaused
            ? { action: "pause", sessionId: activeSessionIdRef.current }
            : { sessionId: activeSessionIdRef.current, durationMs: 0, segments: [] }),
        }).then(() => options.loadCredits());
        stream.getTracks().forEach((track) => track.stop());
        stopMicMeter();
      }
      options.setError(isEnglish
        ? "Speech recognition could not connect. Check the network and API settings."
        : "음성 인식 연결에 실패했습니다. 네트워크와 API 설정을 확인해 주세요.");
      setStatus(recoverAsPaused ? "paused" : "error");
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      stopSocketTimers();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      if (finishingRef.current || startedAtRef.current === 0) return;
      flushUtterance();
      scheduleReconnect();
    };
  }

  /**
   * Microphone failures arrive as DOMExceptions whose message is written by
   * the browser, in the browser's language, and says nothing about how to
   * recover. Translate the two that actually happen.
   */
  function microphoneMessage(caught: unknown) {
    const name = caught instanceof DOMException ? caught.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return isEnglish
        ? "Microphone access is blocked. Allow it for this site in your browser's address bar, then start again."
        : "마이크 사용이 차단돼 있습니다. 브라우저 주소창에서 이 사이트의 마이크를 허용한 뒤 다시 시작해 주세요.";
    }
    if (name === "NotFoundError" || name === "NotReadableError") {
      return isEnglish
        ? "No microphone is available. Connect one, close apps that may be using it, and start again."
        : "사용할 수 있는 마이크가 없습니다. 마이크를 연결하고 마이크를 쓰는 다른 앱을 닫은 뒤 다시 시작해 주세요.";
    }
    return caught instanceof Error && caught.message
      ? caught.message
      : isEnglish ? "Could not start the microphone." : "마이크를 시작하지 못했습니다.";
  }

  async function startLecture() {
    // 더블클릭이 리렌더보다 빠르면 status 검사만으로는 두 번 다 통과해서
    // getUserMedia·세션 생성·소켓이 전부 이중으로 뜬다.
    if (finishingRef.current || startingRef.current || status === "connecting" || status === "recording" || status === "paused") return;
    startingRef.current = true;
    // ACC-02/ACC-03의 계정 동의는 여기서 묻지 않는다. 가입할 때 받고, 기록이
    // 없는 계정은 강의실에 들어오는 순간 한 번 묻는다 — 강의가 막 시작되려는
    // 순간에 약관을 읽히는 것은 동의를 받는 방법이 아니라 누르게 만드는 방법이다.
    options.setError("");
    options.setNotice("");
    startedAtRef.current = 0;
    elapsedBaseMsRef.current = 0;
    const draftSessionId = status === "idle" ? activeSessionIdRef.current : "";
    saveFailuresRef.current = 0;
    vocabularyRefreshedRef.current = false;
    if (!draftSessionId) options.setActiveSessionId("");
    setStatus("connecting");

    let startedSessionId = "";
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(isEnglish
          ? "This browser does not support microphone input."
          : "이 브라우저는 마이크 입력을 지원하지 않습니다.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      startMicMeter(stream);
      streamOffsetMsRef.current = 0;
      pendingAudioRef.current = [];
      socketOpenedRef.current = false;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      startMediaRecorder(stream);
      setStatus("recording");
      options.setMobilePane("transcript");

      const sessionResponse = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({
          action: "start",
          sessionId: draftSessionId || null,
          classroomId: activeClassroomId || null,
          title: lectureTitle.trim() || (isEnglish ? `Lecture ${new Date().toLocaleDateString("en-US")}` : `${new Date().toLocaleDateString("ko-KR")} 수업`),
        }),
      });
      const sessionData = await sessionResponse.json() as { session?: SessionSummary; error?: string };
      if (!sessionResponse.ok || !sessionData.session) throw new Error(sessionData.error);
      startedSessionId = sessionData.session.id;
      options.setActiveSessionId(sessionData.session.id);
      activeSessionIdRef.current = sessionData.session.id;
      options.setLectureTitle(sessionData.session.title);
      setSegments([]);
      segmentsRef.current = [];
      segmentIdsRef.current.clear();
      confirmedSegmentIdsRef.current.clear();
      finalBufferRef.current = [];
      showInterim("");
      options.clearMessages();

      await connectDeepgram(stream);
      startingRef.current = false;
    } catch (caught) {
      startingRef.current = false;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      stopMicMeter();
      pendingAudioRef.current = [];
      startedAtRef.current = 0;
      if (startedSessionId && !socketOpenedRef.current) {
        void fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ sessionId: startedSessionId, durationMs: 0, segments: [] }),
        });
      }
      options.setError(microphoneMessage(caught));
      setStatus("error");
    }
  }

  async function pauseLecture() {
    if (status !== "recording" || finishingRef.current) return;
    finishingRef.current = true;
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "pause", sessionId: activeSessionIdRef.current }),
      });
      const data = await response.json() as { recordedMs?: number; error?: string };
      if (!response.ok) throw new Error(data.error);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      stopSocketTimers();
      // 종료와 같은 이유로, 멈춘 레코더의 꼬리 확정을 기다린 뒤에 비운다.
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      flushUtterance();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      stopMicMeter();
      pendingAudioRef.current = [];
      socketRef.current?.close();
      const recordedMs = data.recordedMs ?? currentElapsedMs();
      elapsedBaseMsRef.current = recordedMs;
      startedAtRef.current = 0;
      streamOffsetMsRef.current = recordedMs;
      setElapsedMs(recordedMs);
      setStatus("paused");
    } catch (caught) {
      options.setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not pause the lecture." : "강의를 일시정지하지 못했습니다.");
    } finally {
      finishingRef.current = false;
    }
  }

  async function resumeLecture() {
    if (status !== "paused" || finishingRef.current) return;
    finishingRef.current = true;
    options.setError("");
    setStatus("connecting");
    let stream: MediaStream | null = null;
    let resumed = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "resume", sessionId: activeSessionIdRef.current }),
      });
      const data = await response.json() as { recordedMs?: number; error?: string };
      if (!response.ok) throw new Error(data.error);
      resumed = true;
      const recordedMs = data.recordedMs ?? elapsedBaseMsRef.current;
      elapsedBaseMsRef.current = recordedMs;
      streamOffsetMsRef.current = recordedMs;
      startedAtRef.current = Date.now();
      streamRef.current = stream;
      startMicMeter(stream);
      pendingAudioRef.current = [];
      socketOpenedRef.current = false;
      reconnectAttemptRef.current = 0;
      setStatus("recording");
      await connectDeepgram(stream, true);
    } catch (caught) {
      stream?.getTracks().forEach((track) => track.stop());
      stopMicMeter();
      startedAtRef.current = 0;
      if (resumed) {
        await fetch("/api/lecture-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ action: "pause", sessionId: activeSessionIdRef.current }),
        }).catch(() => {});
      }
      options.setError(microphoneMessage(caught));
      setStatus("paused");
    } finally {
      finishingRef.current = false;
    }
  }

  async function finishLecture() {
    if (finishingRef.current) return;
    finishingRef.current = true;
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
    // 레코더를 먼저 멈춰 종료 신호를 보내고, 공급자가 맺음말을 확정할 시간을
    // 준다. flush를 먼저 하면 마지막 문장이 버퍼에 닿기 전에 창이 닫힌다.
    // ponytail: 고정 1.2초 대기. Deepgram 마지막 Results/Soniox finished를
    // 직접 기다리는 게 정석이지만 배관 대비 이 대기가 짧고 실패 모드가 없다.
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    flushUtterance();
    pendingAudioRef.current = [];
    // 마이크는 여기서 놓는다. 재연결이 같은 스트림을 다시 쓰므로 레코더가 멈출
    // 때마다 트랙을 끄면 두 번째 소켓이 무음을 듣는다.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    stopMicMeter();
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      try {
        const response = await fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({
            sessionId,
            durationMs,
            segments: segmentsRef.current,
          }),
        });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error);
        await options.loadClassrooms(activeClassroomId);
        await options.loadCredits();
        if (reachedLimit) {
          // Hitting the cap saved the lecture, so this is a notice, not the
          // red alert banner it used to be rendered in.
          options.setNotice(isEnglish ? "This lecture reached the 3-hour session limit and was saved." : "수업 1회 최대 3시간에 도달해 자동으로 저장·종료했습니다.");
        }
      } catch (caught) {
        options.setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "The lecture ended, but saving did not finish." : "강의는 종료됐지만 저장을 마치지 못했습니다.");
      }
    }
    // socket.onclose lands after these round-trips on a fast connection, so
    // finishingRef alone does not stop a clean stop from being read as a drop.
    // A lecture that has ended has no start time.
    startedAtRef.current = 0;
    elapsedBaseMsRef.current = durationMs;
    finishingRef.current = false;
  }

  function stopLecture() {
    void finishLecture();
  }

  return {
    status, setStatus, elapsedMs, setElapsedMs, segments, setSegments, interim, showInterim,
    meterRef, segmentsRef, segmentIdsRef, confirmedSegmentIdsRef, activeSessionIdRef,
    finishingRef, saveFailuresRef, elapsedBaseMsRef, startedAtRef, streamOffsetMsRef,
    currentElapsedMs, flushUtterance,
    startLecture, pauseLecture, resumeLecture, finishLecture, stopLecture,
  };
}
