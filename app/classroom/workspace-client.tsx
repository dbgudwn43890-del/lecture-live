"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { cleanAnswerText, cleanSources } from "../lib/answer-format";
import { downsampleAudio, encodeWav } from "../lib/audio";
import { countTranscriptSentences, groupTranscriptParagraphs } from "../lib/chunk-transcript";
import { parseGlossary } from "../lib/glossary";
import { utteranceSegment } from "../lib/deepgram";
import { buildAnchor } from "../lib/material-anchor";
import { personalModelOptions, type PersonalProvider } from "../lib/llm-models";
import { getPlanLabel } from "../lib/plan-label";

type Status = "idle" | "connecting" | "recording" | "ended" | "error";

type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type Source = { title: string; url: string };
type LectureSource = { sessionId: string; title: string; startMs: number; endMs: number };
type MaterialSource = { documentId: string; filename: string; startPage: number; endPage: number };
type SessionSummary = {
  id: string;
  classroom_id: string | null;
  title: string;
  status: "recording" | "completed";
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  question_count: number;
};
type Classroom = { id: string; title: string; locale: "ko" | "en"; glossary?: string; sessions: SessionSummary[] };
type UserProfile = { displayName: string; email: string };
type AiProvider = "lecture-live" | PersonalProvider;
type SavedCredential = { provider: PersonalProvider; model: string; updated_at: string };
type CreditStatus = { credits: number; nextExpiry: string | null; latestGrantAt: string | null; subscriptionStatus: string | null; trialUsed: boolean; planCode: string | null };
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sources?: Source[];
  lectureSources?: LectureSource[];
  materialSources?: MaterialSource[];
  assistantLabel?: string;
};

type DeepgramResult = {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

/** Closes the <details> menu that a clicked menu item sits inside. */
function closeMenu(event: { currentTarget: HTMLElement }) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

const providerNames: Record<PersonalProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

const MAX_LECTURE_MS = 10_800_000;
const WHISPER_CHUNK_MS = 5_000;
// /api/lecture-audio rejects anything over 500,000 bytes, which at 16kHz
// 16-bit mono is 15.6s of audio. Browsers throttle background timers to about
// one tick a minute, so a backgrounded tab would otherwise build a chunk far
// past that and have every upload rejected — silently, for the rest of the
// lecture. Send the backlog as slices that each fit, with a safety margin.
const WHISPER_MAX_UPLOAD_MS = 14_000;

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type InitialData = {
  profile: UserProfile | null;
  classrooms: Classroom[];
  unassignedSessions: SessionSummary[];
  creditStatus: CreditStatus | null;
};

export default function LectureWorkspace({ locale = "ko", initial, sttProvider = "whisper" }: { locale?: "ko" | "en"; initial?: InitialData; sttProvider?: "deepgram" | "whisper" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const statusCopy: Record<Status, string> = isEnglish
    ? { idle: "Not started", connecting: "Connecting", recording: "Recording", ended: "Ended", error: "Check connection" }
    : { idle: "시작 전", connecting: "연결 중", recording: "기록 중", ended: "종료됨", error: "연결 확인 필요" };
  const [status, setStatus] = useState<Status>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lectureTitle, setLectureTitle] = useState("");
  const [aiProvider, setAiProvider] = useState<AiProvider>("lecture-live");
  const [aiModel, setAiModel] = useState<string>(personalModelOptions.openai[0].id);
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
  const [credentialPending, setCredentialPending] = useState(false);
  const [classrooms, setClassrooms] = useState<Classroom[]>(initial?.classrooms ?? []);
  const [unassignedSessions, setUnassignedSessions] = useState<SessionSummary[]>(initial?.unassignedSessions ?? []);
  const [activeClassroomId, setActiveClassroomId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [classroomPending, setClassroomPending] = useState(false);
  const [newClassroomTitle, setNewClassroomTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [dragSessionId, setDragSessionId] = useState("");
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(initial?.profile ?? null);
  const [creditStatus, setCreditStatus] = useState<CreditStatus | null>(initial?.creditStatus ?? null);
  const [reportedKeys, setReportedKeys] = useState<string[]>([]);
  // "없음"과 "원본이 없음"은 다른 상태다. 이 변경 전에 올라온 자료는 텍스트만
  // 색인되어 있어 답변에는 쓰이지만 슬라이드로 보여 줄 수는 없다.
  const [materialState, setMaterialState] = useState<"none" | "text-only" | "viewable">("none");
  const [slidePage, setSlidePage] = useState<MaterialSource | null>(null);
  const [slideUrl, setSlideUrl] = useState<{ documentId: string; url: string; expiresAt: number } | null>(null);
  const [slideCollapsed, setSlideCollapsed] = useState(false);
  const [slideZoomed, setSlideZoomed] = useState(false);
  const transcriptParagraphs = useMemo(() => groupTranscriptParagraphs(segments), [segments]);
  const sentenceCount = useMemo(() => countTranscriptSentences(segments), [segments]);
  const sessionsById = useMemo(
    () => new Map([...unassignedSessions, ...classrooms.flatMap((classroom) => classroom.sessions)].map((session) => [session.id, session])),
    [unassignedSessions, classrooms],
  );

  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const segmentIdsRef = useRef(new Set<string>());
  // Segments the server has actually persisted (its "segment" save fetch
  // resolved with response.ok). /api/ask only needs to carry the ones missing
  // from this set — the server reads everything else back from the DB itself.
  const confirmedSegmentIdsRef = useRef(new Set<string>());
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const activeSessionIdRef = useRef("");
  const finishingRef = useRef(false);
  const saveFailuresRef = useRef(0);
  // Deepgram's stream clock restarts at 0 on every socket, so a reconnect would
  // collide with earlier segments without this.
  const streamOffsetMsRef = useRef(0);
  const initialRouteRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioSinkRef = useRef<GainNode | null>(null);
  const whisperChunksRef = useRef<Float32Array[]>([]);
  const whisperSamplesRef = useRef(0);
  const whisperFailuresRef = useRef(0);
  const whisperSampleRateRef = useRef(16_000);
  const whisperCursorMsRef = useRef(0);
  const whisperPreviousTextRef = useRef("");
  const whisperFlushTimerRef = useRef<number | null>(null);
  const whisperPendingRef = useRef(false);
  const whisperFlushRef = useRef<Promise<void> | null>(null);
  const slideUrlRef = useRef<{ documentId: string; url: string; expiresAt: number } | null>(null);
  // A page the learner or an answer put on screen wins over the follower for a
  // while. Without this the next 30s tick drags the panel back to whatever the
  // lecturer is saying, mid-read.
  const slidePinnedUntilRef = useRef(0);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => {
      const elapsed = Math.min(MAX_LECTURE_MS, Date.now() - startedAtRef.current);
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

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { slideUrlRef.current = slideUrl; }, [slideUrl]);

  // Whether this classroom has a slide deck at all decides both the follower
  // below and what the panel says when it has nothing to show.
  useEffect(() => {
    setSlidePage(null);
    setSlideZoomed(false);
    if (!activeClassroomId) {
      setMaterialState("none");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/materials?classroomId=${encodeURIComponent(activeClassroomId)}`, {
          headers: { "X-Site-Locale": locale },
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = await response.json() as { documents?: Array<{ storage_path?: string | null }> };
        const documents = data.documents ?? [];
        if (!cancelled) {
          setMaterialState(documents.some((document) => document.storage_path)
            ? "viewable"
            : documents.length > 0 ? "text-only" : "none");
        }
      } catch {
        // 자료 유무 확인 실패는 강의 진행을 막지 않는다.
      }
    })();
    return () => { cancelled = true; };
  }, [activeClassroomId, locale]);

  // The slide follows the lecture on its own, so the panel is not an empty box
  // for everyone who has not asked anything yet. Nothing is shown unless the
  // match clears the server's threshold; a weak match leaves the last page up.
  useEffect(() => {
    if (status !== "recording" || !activeClassroomId || materialState !== "viewable") return;
    let cancelled = false;
    async function follow() {
      if (Date.now() < slidePinnedUntilRef.current) return;
      const anchor = buildAnchor(segmentsRef.current, Math.min(MAX_LECTURE_MS, Date.now() - startedAtRef.current));
      if (!anchor) return;
      try {
        const response = await fetch("/api/material-page", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ classroomId: activeClassroomId, anchor }),
        });
        if (!response.ok) return;
        const data = await response.json() as { page: MaterialSource | null };
        if (cancelled || !data.page) return;
        const next = data.page;
        setSlidePage((current) =>
          current && current.documentId === next.documentId && current.startPage === next.startPage ? current : next);
      } catch {
        // 슬라이드 추종은 보조 기능이다. 실패해도 스크립트와 질문은 그대로 굴러간다.
      }
    }
    void follow();
    const timer = window.setInterval(() => void follow(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [status, activeClassroomId, materialState, locale]);

  // The bucket is private, so every view goes through a short-lived signed URL.
  // Re-signing only near expiry keeps the viewer from reloading the PDF — and
  // losing the reader's zoom — every time the page changes.
  useEffect(() => {
    if (!slidePage) return;
    const held = slideUrlRef.current;
    if (held && held.documentId === slidePage.documentId && held.expiresAt > Date.now() + 120_000) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/materials?documentId=${encodeURIComponent(slidePage.documentId)}`, {
          headers: { "X-Site-Locale": locale },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("sign failed");
        const data = await response.json() as { url: string; expiresInSeconds?: number };
        if (cancelled) return;
        setSlideUrl({
          documentId: slidePage.documentId,
          url: data.url,
          expiresAt: Date.now() + (data.expiresInSeconds ?? 900) * 1_000,
        });
      } catch {
        if (!cancelled) setSlideUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [slidePage, locale]);

  // Esc closes the enlarged slide, the way every other overlay in the app does.
  useEffect(() => {
    if (!slideZoomed) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSlideZoomed(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slideZoomed]);

  // Every <details> menu in the shell closes the same way, and the sidebar now
  // has one per lecture, so this queries them rather than holding a ref each.
  useEffect(() => {
    function openMenus() {
      return document.querySelectorAll<HTMLDetailsElement>("details.profile-menu[open], details.session-menu[open]");
    }
    function closeIfOutside(event: PointerEvent) {
      for (const menu of openMenus()) {
        if (!menu.contains(event.target as Node)) menu.open = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      for (const menu of openMenus()) menu.open = false;
    }
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!segments.length && !interim) return;
    const transcript = transcriptScrollRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [segments, interim]);

  useEffect(
    () => () => {
      recorderRef.current?.stop();
      socketRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      stopWhisperNodes();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/llm-credentials", { headers: { "X-Site-Locale": locale } })
      .then(async (response) => {
        if (response.status === 503) return { credentials: [] };
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ credentials?: SavedCredential[] }>;
      })
      .then((data) => {
        if (!cancelled) setSavedCredentials(data.credentials ?? []);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // ponytail: bounded rather than looping until hasMore clears — a backlog
  // this deep is already pathological, and the next page load picks up the
  // remainder. Raise it if real backlogs turn out to be larger.
  const MAX_RECONCILE_PASSES = 5;

  const hydratedRef = useRef(Boolean(initial));

  useEffect(() => {
    // The server already sent classrooms and credits with the page, so the
    // first pass only closes lectures abandoned by an earlier crash — and
    // reloads only if that actually changed something.
    void (async () => {
      if (!hydratedRef.current) {
        await Promise.all([loadClassrooms(), loadCredits()]);
      }
      hydratedRef.current = false;
      try {
        // The server closes at most one batch per call and reports hasMore when
        // it filled that batch. A single call used to leave the rest abandoned
        // until some future page load happened to catch them.
        let reconciledAny = false;
        for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass += 1) {
          const response = await fetch("/api/lecture-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
            body: JSON.stringify({ action: "reconcile" }),
          });
          const data = await response.json() as { reconciled?: number; hasMore?: boolean };
          if (!response.ok) break;
          reconciledAny ||= Boolean(data.reconciled);
          if (!data.hasMore) break;
        }
        if (reconciledAny) await loadClassrooms();
      } catch {
        // Reconciliation is housekeeping; a failure only delays it to next load.
      }
    })();
  }, [locale]);

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

  /** Renames any lecture — the topbar field and the sidebar menu both land here. */
  async function renameSession(sessionId: string, raw: string) {
    const title = raw.trim();
    const stored = sessionsById.get(sessionId)?.title;
    // The topbar field is controlled state, so every path that does not rename
    // has to put the stored title back or it keeps showing a name nothing has.
    const revert = () => {
      if (sessionId === activeSessionIdRef.current) setLectureTitle(stored ?? "");
    };
    if (!sessionId || !title || title === stored) return revert();
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "rename", sessionId, title }),
      });
      if (!response.ok) return revert();
      if (sessionId === activeSessionIdRef.current) setLectureTitle(title);
      await loadClassrooms();
    } catch {
      revert();
    }
  }

  /** Persists an edited title to the lecture that is open, if any. */
  async function renameActiveLecture() {
    await renameSession(activeSessionIdRef.current, lectureTitle);
  }

  /** Moves a lecture between classrooms. Both the sidebar menu and a drag land here. */
  async function moveSession(sessionId: string, classroomId: string | null) {
    const session = sessionsById.get(sessionId);
    if (!session || (session.classroom_id ?? null) === classroomId) return;
    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "move", sessionId, classroomId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      if (sessionId === activeSessionIdRef.current) setActiveClassroomId(classroomId ?? "");
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not move the lecture." : "수업을 이동하지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  // Pilot instrumentation (PRD 36.2). A report is a hint for the glossary and
  // the context pipeline, never something the learner has to wait on — so it
  // marks the row done immediately and only rolls back if the save fails.
  async function reportIssue(kind: "stt_error" | "context_miss", targetText: string, key: string) {
    if (!activeSessionIdRef.current || reportedKeys.includes(key)) return;
    setReportedKeys((current) => [...current, key]);
    try {
      const response = await fetch("/api/lecture-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({
          sessionId: activeSessionIdRef.current,
          classroomId: activeClassroomId || null,
          kind,
          targetText,
        }),
      });
      if (!response.ok) throw new Error();
    } catch {
      setReportedKeys((current) => current.filter((item) => item !== key));
      setError(isEnglish ? "Could not send the report." : "신고를 보내지 못했습니다.");
    }
  }

  async function loadCredits() {
    try {
      const response = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      if (!response.ok) return;
      setCreditStatus(await response.json() as CreditStatus);
    } catch {
      // The server enforces credits even when this display cannot refresh.
    }
  }

  /**
   * 세그먼트 저장이 곧 과금 지점이다. 브라우저가 Deepgram 소켓을 직접 들고 있어
   * 서버가 오디오를 못 보므로, 서버가 관측하는 유일한 사건인 이 저장에서
   * 경과 시간 기준으로 크레딧을 차감한다. 그래서 402와 409는 저장 실패가 아니라
   * 강의 종료 사유다.
   */
  async function saveSegment(segment: Segment) {
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "segment", sessionId: activeSessionIdRef.current, segment }),
      });
      if (response.ok) {
        confirmedSegmentIdsRef.current.add(segment.id);
        saveFailuresRef.current = 0;
        return;
      }
      const data = await response.json().catch(() => ({})) as { error?: string; credits?: number };
      if (response.status === 402 || response.status === 409) {
        await finishLecture();
        setError(data.error ?? (isEnglish ? "Recording stopped because credits could not be verified." : "크레딧을 확인하지 못해 강의를 종료합니다."));
        await loadCredits();
        return;
      }
      throw new Error(data.error ?? "save failed");
    } catch {
      saveFailuresRef.current += 1;
      // One dropped save is a blip; three in a row means the transcript is no
      // longer being kept and the learner needs to know before the lecture ends.
      if (saveFailuresRef.current >= 3) {
        setError(isEnglish ? "Transcription stopped. Check the connection." : "받아쓰기가 멈췄습니다. 연결을 확인해 주세요.");
      }
    }
  }

  async function loadClassrooms(preferredId?: string) {
    try {
      const response = await fetch("/api/classrooms", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      const data = await response.json() as { classrooms?: Classroom[]; unassignedSessions?: SessionSummary[]; profile?: UserProfile; error?: string };
      if (!response.ok) throw new Error(data.error);
      const next = data.classrooms ?? [];
      setClassrooms(next);
      setUnassignedSessions(data.unassignedSessions ?? []);
      setProfile(data.profile ?? null);
      if (preferredId !== undefined) setActiveClassroomId(preferredId);
      if (!initialRouteRef.current) {
        initialRouteRef.current = true;
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get("session");
        const classroomId = params.get("classroom");
        if (sessionId) void openSession(sessionId);
        else if (classroomId && next.some((classroom) => classroom.id === classroomId)) setActiveClassroomId(classroomId);
        // Checkout sends the buyer here with ?payment=success and nothing used
        // to read it, so a completed purchase was confirmed by nothing at all.
        if (params.get("payment") === "success") {
          setNotice(isEnglish
            ? "Payment complete. Your credits have been added."
            : "결제가 완료됐습니다. 크레딧이 추가되었습니다.");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not load your classrooms." : "강의실을 불러오지 못했습니다.");
    }
  }

  async function createClassroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newClassroomTitle.trim();
    if (!title || classroomPending) return;

    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ title, locale }),
      });
      const data = await response.json() as { classroom?: Classroom; error?: string };
      if (!response.ok || !data.classroom) throw new Error(data.error);
      setClassrooms((current) => [data.classroom!, ...current]);
      setActiveClassroomId(data.classroom.id);
      setNewClassroomTitle("");
      prepareNewLecture();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  async function openSession(sessionId: string) {
    if (status === "recording" || status === "connecting") return;
    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch(`/api/lecture-sessions?sessionId=${encodeURIComponent(sessionId)}`, { headers: { "X-Site-Locale": locale } });
      const data = await response.json() as {
        session?: SessionSummary;
        segments?: Segment[];
        questions?: Array<{ id: string; question: string; answer: string; external_sources?: Source[]; lecture_sources?: LectureSource[]; provider: string; model: string }>;
        error?: string;
      };
      if (!response.ok || !data.session) throw new Error(data.error);
      const restoredSegments = data.segments ?? [];
      setActiveClassroomId(data.session.classroom_id ?? "");
      setActiveSessionId(data.session.id);
      setLectureTitle(data.session.title);
      setSegments(restoredSegments);
      segmentIdsRef.current = new Set(restoredSegments.map((segment) => segment.id));
      // Restored segments are already saved, so /api/ask must not re-upload them.
      confirmedSegmentIdsRef.current = new Set(segmentIdsRef.current);
      setMessages((data.questions ?? []).flatMap((item) => [
        { id: `${item.id}-q`, role: "user" as const, text: item.question },
        { id: `${item.id}-a`, role: "assistant" as const, text: cleanAnswerText(item.answer), sources: cleanSources(item.external_sources ?? []), lectureSources: item.lecture_sources, assistantLabel: `${item.provider} · ${item.model}` },
      ]));
      setInterim("");
      setElapsedMs(data.session.duration_seconds * 1_000);
      setStatus("ended");
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not load the lecture." : "수업 기록을 불러오지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  function prepareNewLecture() {
    if (status === "recording" || status === "connecting") return;
    setActiveSessionId("");
    setLectureTitle("");
    setSegments([]);
    segmentIdsRef.current.clear();
    confirmedSegmentIdsRef.current.clear();
    setMessages([]);
    setInterim("");
    setElapsedMs(0);
    saveFailuresRef.current = 0;
    setStatus("idle");
  }

  const savedCredential = aiProvider === "lecture-live"
    ? undefined
    : savedCredentials.find((item) => item.provider === aiProvider && item.model === aiModel);

  async function saveCredential() {
    if (aiProvider === "lecture-live" || !personalApiKey.trim()) return;
    setCredentialPending(true);
    setError("");
    try {
      const response = await fetch("/api/llm-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ provider: aiProvider, model: aiModel, apiKey: personalApiKey.trim(), locale }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setSavedCredentials((current) => [
        ...current.filter((item) => item.provider !== aiProvider),
        { provider: aiProvider, model: aiModel, updated_at: new Date().toISOString() },
      ]);
      setPersonalApiKey("");
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save the API key." : "API 키를 저장하지 못했습니다.");
    } finally {
      setCredentialPending(false);
    }
  }

  async function deleteCredential() {
    if (aiProvider === "lecture-live") return;
    setCredentialPending(true);
    setError("");
    try {
      const response = await fetch("/api/llm-credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ provider: aiProvider, locale }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setSavedCredentials((current) => current.filter((item) => item.provider !== aiProvider));
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not remove the saved API key." : "저장된 API 키를 삭제하지 못했습니다.");
    } finally {
      setCredentialPending(false);
    }
  }

  function stopWhisperNodes() {
    if (whisperFlushTimerRef.current !== null) window.clearInterval(whisperFlushTimerRef.current);
    whisperFlushTimerRef.current = null;
    workletNodeRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    audioSinkRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    workletNodeRef.current = null;
    audioSourceRef.current = null;
    audioSinkRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
  }

  async function uploadWhisperSlice(samples: Float32Array, startMs: number, durationMs: number) {
    const wav = encodeWav(downsampleAudio(samples, whisperSampleRateRef.current));
    const formData = new FormData();
    formData.set("audio", new File([wav], "chunk.wav", { type: "audio/wav" }));
    formData.set("sessionId", activeSessionIdRef.current);
    formData.set("language", isEnglish ? "en" : "ko");
    if (whisperPreviousTextRef.current) formData.set("prompt", whisperPreviousTextRef.current.slice(-500));

    const requestedAt = Date.now();
    const response = await fetch("/api/lecture-audio", { method: "POST", body: formData });
    // The STT round trip per segment, measured where the wait actually is, so
    // the pilot has real numbers to redesign against (PRD 36.3.4).
    const latencyMs = Date.now() - requestedAt;
    const data = await response.json() as { text?: string; error?: string };
    if (!response.ok) {
      const failure = new Error(data.error ?? "") as Error & { status?: number };
      failure.status = response.status;
      throw failure;
    }

    const text = data.text?.trim().slice(0, 2_000);
    if (!text) return;

    whisperPreviousTextRef.current = text;
    const endMs = startMs + durationMs;
    // The server rejects an id over 2200 chars or text over 2000 to match the
    // column constraints, and the save below never reads its response — so an
    // over-long chunk used to render, be rejected with an unseen 400, and
    // vanish on the next reload.
    const id = `${startMs}-${endMs}-${text.slice(0, 120)}`;
    if (segmentIdsRef.current.has(id)) return;
    segmentIdsRef.current.add(id);
    const segment = { id, startMs, endMs, text };
    setSegments((current) => {
      const next = [...current, segment];
      segmentsRef.current = next;
      return next;
    });
    void fetch("/api/lecture-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
      body: JSON.stringify({ action: "segment", sessionId: activeSessionIdRef.current, segment, latencyMs }),
    }).then((response) => {
      if (response.ok) confirmedSegmentIdsRef.current.add(id);
    });
  }

  async function flushWhisperChunk() {
    if (whisperPendingRef.current) return;
    const sampleCount = whisperSamplesRef.current;
    const sampleRate = whisperSampleRateRef.current;
    if (sampleCount < sampleRate * 0.5) return;
    whisperPendingRef.current = true;

    const merged = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of whisperChunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    whisperChunksRef.current = [];
    whisperSamplesRef.current = 0;

    setInterim(isEnglish ? "Transcribing…" : "받아쓰는 중…");
    const sliceSamples = Math.floor(sampleRate * (WHISPER_MAX_UPLOAD_MS / 1_000));

    // The cursor advances across the whole backlog before any upload. Doing it
    // per slice inside the loop meant one failure discarded the remaining
    // slices without their durations, shifting every later timestamp earlier
    // for the rest of the lecture.
    const slices: Array<{ samples: Float32Array; startMs: number; durationMs: number }> = [];
    for (let start = 0; start < sampleCount; start += sliceSamples) {
      const samples = merged.subarray(start, Math.min(sampleCount, start + sliceSamples));
      const durationMs = Math.round((samples.length / sampleRate) * 1_000);
      slices.push({ samples, startMs: whisperCursorMsRef.current, durationMs });
      whisperCursorMsRef.current += durationMs;
    }

    try {
      for (const slice of slices) {
        try {
          await uploadWhisperSlice(slice.samples, slice.startMs, slice.durationMs);
          whisperFailuresRef.current = 0;
        } catch (caught) {
          const status = (caught as { status?: number }).status;
          // Out of credits is terminal: retrying just repeats the rejection
          // every few seconds while the UI still claims to be recording.
          if (status === 402 || status === 409) throw caught;
          // Anything else costs one caption. A run of them means the
          // transcript has stopped and the user cannot otherwise tell.
          whisperFailuresRef.current += 1;
          if (whisperFailuresRef.current >= 3) {
            setError(caught instanceof Error && caught.message
              ? caught.message
              : isEnglish
                ? "The transcript has stopped updating. Check your connection."
                : "받아쓰기가 멈췄습니다. 네트워크 상태를 확인해 주세요.");
          }
        }
      }
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Recording stopped." : "기록이 중단됐습니다.");
      void finishLecture();
    } finally {
      setInterim("");
      whisperPendingRef.current = false;
    }
  }

  async function startLecture() {
    if (sttProvider === "deepgram") return startLectureDeepgram();
    return startLectureWhisper();
  }

  async function startLectureWhisper() {
    setError("");
    startedAtRef.current = 0;
    activeSessionIdRef.current = "";
    saveFailuresRef.current = 0;
    setActiveSessionId("");
    setStatus("connecting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(isEnglish ? "This browser does not support microphone input." : "이 브라우저는 마이크 입력을 지원하지 않습니다.");
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

      const sessionResponse = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({
          action: "start",
          classroomId: activeClassroomId || null,
          title: lectureTitle.trim() || (isEnglish ? `Lecture ${new Date().toLocaleDateString("en-US")}` : `${new Date().toLocaleDateString("ko-KR")} 수업`),
        }),
      });
      const sessionData = await sessionResponse.json() as { session?: SessionSummary; error?: string };
      if (!sessionResponse.ok || !sessionData.session) throw new Error(sessionData.error);
      setActiveSessionId(sessionData.session.id);
      activeSessionIdRef.current = sessionData.session.id;
      setLectureTitle(sessionData.session.title);
      setSegments([]);
      segmentsRef.current = [];
      segmentIdsRef.current.clear();
      confirmedSegmentIdsRef.current.clear();
      setMessages([]);

      const context = new AudioContext();
      await context.audioWorklet.addModule("/pcm-capture-worklet.js");
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "pcm-capture");
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(context.destination);

      audioContextRef.current = context;
      audioSourceRef.current = source;
      workletNodeRef.current = worklet;
      audioSinkRef.current = sink;
      whisperSampleRateRef.current = context.sampleRate;
      whisperChunksRef.current = [];
      whisperSamplesRef.current = 0;
      whisperCursorMsRef.current = 0;
      whisperPreviousTextRef.current = "";

      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const chunk = new Float32Array(event.data);
        whisperChunksRef.current.push(chunk);
        whisperSamplesRef.current += chunk.length;
      };

      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setStatus("recording");
      whisperFlushTimerRef.current = window.setInterval(() => { whisperFlushRef.current = flushWhisperChunk(); }, WHISPER_CHUNK_MS);
    } catch (caught) {
      stopWhisperNodes();
      if (activeSessionIdRef.current && startedAtRef.current === 0) {
        void fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ sessionId: activeSessionIdRef.current, durationMs: 0, segments: [] }),
        });
      }
      setError(microphoneMessage(caught));
      setStatus("error");
    }
  }

  async function startLectureDeepgram() {
    setError("");
    startedAtRef.current = 0;
    activeSessionIdRef.current = "";
    saveFailuresRef.current = 0;
    setActiveSessionId("");
    setStatus("connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const sessionResponse = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({
          action: "start",
          classroomId: activeClassroomId || null,
          title: lectureTitle.trim() || (isEnglish ? `Lecture ${new Date().toLocaleDateString("en-US")}` : `${new Date().toLocaleDateString("ko-KR")} 수업`),
        }),
      });
      const sessionData = await sessionResponse.json() as { session?: SessionSummary; error?: string };
      if (!sessionResponse.ok || !sessionData.session) throw new Error(sessionData.error);
      setActiveSessionId(sessionData.session.id);
      activeSessionIdRef.current = sessionData.session.id;
      setLectureTitle(sessionData.session.title);
      setSegments([]);
      segmentsRef.current = [];
      segmentIdsRef.current.clear();
      confirmedSegmentIdsRef.current.clear();
      setMessages([]);

      const tokenResponse = await fetch("/api/deepgram-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ sessionId: sessionData.session.id }),
      });
      const tokenData = (await tokenResponse.json()) as { accessToken?: string; credits?: number; error?: string };
      if (!tokenResponse.ok || !tokenData.accessToken) {
        throw new Error(tokenData.error ?? (isEnglish
          ? "Could not obtain a speech-recognition token."
          : "음성 인식 토큰을 받지 못했습니다."));
      }
      streamOffsetMsRef.current = 0;
      setCreditStatus((current) => current && typeof tokenData.credits === "number"
        ? { ...current, credits: tokenData.credits }
        : current);

      const params = new URLSearchParams({
        model: "nova-3",
        language: isEnglish ? "en" : "ko",
        smart_format: "true",
        punctuate: "true",
        interim_results: "true",
        endpointing: "500",
        utterance_end_ms: "1000",
        mip_opt_out: "true",
      });
      // Nova-3 takes the classroom glossary as repeated keyterm values, the
      // streaming counterpart to the initial_prompt hint the Whisper path
      // sends (PRD 36.3.1).
      for (const term of parseGlossary(classrooms.find((room) => room.id === activeClassroomId)?.glossary).slice(0, 20)) {
        params.append("keyterm", term);
      }
      const socket = new WebSocket(
        `wss://api.deepgram.com/v1/listen?${params.toString()}`,
        ["bearer", tokenData.accessToken],
      );
      socketRef.current = socket;

      socket.onopen = () => {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(event.data);
        };
        recorder.onstop = () => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
          stream.getTracks().forEach((track) => track.stop());
        };
        recorder.start(250);
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setStatus("recording");
      };

      socket.onmessage = (event) => {
        const result = JSON.parse(event.data as string) as DeepgramResult;
        if (result.type !== "Results") return;
        const text = result.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (!text) return;

        if (result.is_final) {
          // The id used to carry the whole transcript, which pushed long
          // utterances past the server's 2200-character client_id limit and
          // had them silently rejected. utteranceSegment owns that cap.
          const segment = utteranceSegment([result], streamOffsetMsRef.current);
          if (segment && !segmentIdsRef.current.has(segment.id)) {
            segmentIdsRef.current.add(segment.id);
            setSegments((current) => {
              const next = [...current, segment];
              segmentsRef.current = next;
              return next;
            });
            void saveSegment(segment);
          }
          setInterim("");
        } else {
          setInterim(text);
        }
      };

      socket.onerror = () => {
        if (startedAtRef.current === 0 && activeSessionIdRef.current) {
          void fetch("/api/lecture-sessions", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
            body: JSON.stringify({ sessionId: activeSessionIdRef.current, durationMs: 0, segments: [] }),
          }).then(() => loadCredits());
          stream.getTracks().forEach((track) => track.stop());
        }
        setError(isEnglish
          ? "Speech recognition could not connect. Check the network and API settings."
          : "음성 인식 연결에 실패했습니다. 네트워크와 API 설정을 확인해 주세요.");
        setStatus("error");
      };

      socket.onclose = () => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
        // A mid-lecture drop (a Wi-Fi handoff in a lecture hall) used to leave
        // the UI saying 기록 중 while the timer kept charging credits against a
        // transcript that had stopped. End the lecture and say so.
        if (startedAtRef.current > 0 && !finishingRef.current) {
          setError(isEnglish
            ? "The connection dropped, so the lecture was saved and ended. Start again to keep recording."
            : "연결이 끊겨 수업을 저장하고 종료했습니다. 이어서 기록하려면 다시 시작해 주세요.");
          void finishLecture();
        }
      };
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (activeSessionIdRef.current && startedAtRef.current === 0) {
        void fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ sessionId: activeSessionIdRef.current, durationMs: 0, segments: [] }),
        });
      }
      setError(microphoneMessage(caught));
      setStatus("error");
    }
  }

  async function finishLecture() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (sttProvider === "whisper") {
      // A flush in flight makes flushWhisperChunk() a no-op, so awaiting it
      // alone would drop everything buffered behind that upload.
      await whisperFlushRef.current;
      await flushWhisperChunk();
      stopWhisperNodes();
    }
    setStatus("ended");
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      try {
        const response = await fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({
            sessionId,
            durationMs: Math.min(MAX_LECTURE_MS, Date.now() - startedAtRef.current),
            segments: segmentsRef.current,
          }),
        });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error);
        await loadClassrooms(activeClassroomId);
        await loadCredits();
        if (Date.now() - startedAtRef.current >= MAX_LECTURE_MS) {
          // Hitting the cap saved the lecture, so this is a notice, not the
          // red alert banner it used to be rendered in.
          setNotice(isEnglish ? "This lecture reached the 3-hour session limit and was saved." : "수업 1회 최대 3시간에 도달해 자동으로 저장·종료했습니다.");
        }
      } catch (caught) {
        setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "The lecture ended, but saving did not finish." : "강의는 종료됐지만 저장을 마치지 못했습니다.");
      }
    }
    // socket.onclose lands after these round-trips on a fast connection, so
    // finishingRef alone does not stop a clean stop from being read as a drop.
    // A lecture that has ended has no start time.
    startedAtRef.current = 0;
    finishingRef.current = false;
  }

  function stopLecture() {
    void finishLecture();
  }

  const canAsk = (segments.length > 0 || interim.length > 0)
    && !messages.some((message) => message.pending)
    && (creditStatus === null || creditStatus.credits > 0 || status === "recording");

  function askQuestion(event: FormEvent) {
    event.preventDefault();
    void submitQuestion(question, true);
  }

  /** 학습자나 답변이 직접 지정한 쪽. 잠깐은 자동 추종보다 우선한다. */
  function pinSlide(source: MaterialSource) {
    slidePinnedUntilRef.current = Date.now() + 120_000;
    setSlidePage(source);
    setSlideCollapsed(false);
  }

  // Typing during a lecture is itself a distraction, so a transcript paragraph
  // can send its own question with one press (PRD 36.3.3). Both entry points
  // land here; only the composer clears itself, or a half-typed draft would
  // disappear when the learner tapped a paragraph instead.
  async function submitQuestion(text: string, fromComposer = false) {
    const cleanQuestion = text.trim().slice(0, 1_000);
    if (!cleanQuestion || !canAsk || messages.some((message) => message.pending)) return;
    if (aiProvider !== "lecture-live" && !personalApiKey.trim() && !savedCredential) {
      setError(isEnglish
        ? "Enter or save an API key for the selected provider in Answer model settings."
        : "답변 모델 설정에서 선택한 공급자의 API 키를 입력하거나 저장해 주세요.");
      return;
    }

    setError("");
    const selectedModel =
      aiProvider === "lecture-live"
        ? null
        : personalModelOptions[aiProvider].find((model) => model.id === aiModel) ??
          personalModelOptions[aiProvider][0];
    const assistantLabel = selectedModel
      ? `${providerNames[aiProvider as PersonalProvider]} · ${selectedModel.label}`
      : isEnglish ? "Lecture assistant · Default AI" : "강의 조교 · 기본 AI";

    const askedAt = elapsedMs;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: cleanQuestion,
    };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        text: isEnglish ? "Reviewing the lecture context…" : "강의 흐름을 확인하고 있습니다…",
        pending: true,
        assistantLabel,
      },
    ]);
    if (fromComposer) setQuestion("");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: cleanQuestion,
          questionAtMs: askedAt,
          // 질문 문장만으로는 "이거", "방금 그 식"이 무엇을 가리키는지 알 수 없다.
          // 직전 1분의 강의 내용을 같이 보내 그 시점의 슬라이드를 찾게 한다.
          anchor: buildAnchor(segments, askedAt, interim),
          // Only the tail the server hasn't confirmed saved yet — everything
          // else it reads back from transcript_segments itself.
          segments: segments.filter((segment) => !confirmedSegmentIdsRef.current.has(segment.id)),
          interim,
          locale,
          classroomId: activeClassroomId,
          lectureSessionId: activeSessionId,
          personalLlm:
            aiProvider === "lecture-live"
              ? undefined
              : savedCredential && !personalApiKey.trim()
                ? { provider: aiProvider, model: selectedModel!.id, useSaved: true }
                : { provider: aiProvider, model: selectedModel!.id, apiKey: personalApiKey.trim() },
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? (isEnglish ? "Could not receive an answer." : "답변을 받지 못했습니다."));
      }
      if (!response.body) throw new Error(isEnglish ? "Could not receive an answer." : "답변을 받지 못했습니다.");

      // NDJSON: one {"delta"} line per text chunk, then a final {"done"} line
      // (or {"error"} if the provider failed mid-stream). Deltas render raw so
      // the reader sees text arrive immediately; done's cleaned text replaces it.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      let streamError: string | null = null;
      let finalDone: { answer: string; sources?: Source[]; lectureSources?: LectureSource[]; materialSources?: MaterialSource[]; screenSource?: MaterialSource | null } | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as { delta?: string; done?: typeof finalDone; error?: string };
          if (typeof parsed.delta === "string") {
            streamedText += parsed.delta;
            const text = streamedText;
            setMessages((current) =>
              current.map((message) => (message.id === assistantId ? { ...message, text, pending: true } : message)),
            );
          } else if (parsed.done) {
            finalDone = parsed.done;
          } else if (parsed.error) {
            streamError = parsed.error;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      if (!finalDone) throw new Error(isEnglish ? "Could not receive an answer." : "답변을 받지 못했습니다.");
      const { answer, sources, lectureSources, materialSources, screenSource } = finalDone;
      // 답이 무엇을 보고 쓰였는지 읽기 전에 보이도록, 근거가 된 쪽을 바로 띄운다.
      if (screenSource) pinSlide(screenSource);
      else if (materialSources?.[0]) pinSlide(materialSources[0]);

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                // Cleaned once here rather than on every render: it is eleven
                // regex passes and the result never changes.
                text: cleanAnswerText(answer),
                pending: false,
                sources: cleanSources(sources ?? []),
                lectureSources: lectureSources ?? [],
                materialSources: materialSources ?? [],
              }
            : message,
        ),
      );
    } catch (caught) {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: caught instanceof Error
                  ? caught.message
                  : isEnglish ? "Could not create an answer." : "답변을 만들지 못했습니다.",
                pending: false,
              }
            : message,
        ),
      );
    }
  }

  const canStart = (status === "idle" || status === "ended" || status === "error")
    && (creditStatus === null || creditStatus.credits > 0);
  const activeModelLabel =
    aiProvider === "lecture-live"
      ? isEnglish ? "Default AI" : "기본 AI"
      : personalModelOptions[aiProvider].find((model) => model.id === aiModel)?.label ??
        personalModelOptions[aiProvider][0].label;
  const planLabel = getPlanLabel(creditStatus?.planCode, locale);

  const sidebarLocked = classroomPending || status === "recording" || status === "connecting";

  /** One lecture row: open it, rename it in place, or move it by menu or drag. */
  function renderSessionRow(session: SessionSummary) {
    if (renamingSessionId === session.id) {
      return (
        <input
          key={session.id}
          className="sidebar-session-rename"
          autoFocus
          defaultValue={session.title}
          maxLength={80}
          onBlur={(event) => {
            setRenamingSessionId("");
            void renameSession(session.id, event.target.value);
          }}
          onKeyDown={(event) => {
            // Escape restores the stored title first, so the blur below is a no-op.
            if (event.key === "Escape") event.currentTarget.value = session.title;
            if (event.key === "Escape" || event.key === "Enter") event.currentTarget.blur();
          }}
        />
      );
    }
    return (
      <div
        key={session.id}
        className="sidebar-session"
        draggable={!sidebarLocked}
        onDragStart={(event) => {
          setDragSessionId(session.id);
          // Firefox refuses to start a drag without payload on the transfer.
          event.dataTransfer.setData("text/plain", session.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => { setDragSessionId(""); setDragOverKey(null); }}
      >
        <button
          type="button"
          className={session.id === activeSessionId ? "active" : undefined}
          onClick={() => void openSession(session.id)}
          disabled={sidebarLocked}
          title={session.title}
        >{session.title}</button>
        <details className="session-menu">
          <summary aria-label={isEnglish ? "Lecture options" : "수업 옵션"}>⋯</summary>
          <div className="session-menu-panel">
            <button type="button" onClick={(event) => { closeMenu(event); setRenamingSessionId(session.id); }}>
              {isEnglish ? "Rename" : "이름 변경"}
            </button>
            <p>{isEnglish ? "Move to" : "이동"}</p>
            <button
              type="button"
              disabled={!session.classroom_id}
              onClick={(event) => { closeMenu(event); void moveSession(session.id, null); }}
            >{isEnglish ? "Unassigned" : "미분류 수업"}</button>
            {classrooms.map((classroom) => (
              <button
                key={classroom.id}
                type="button"
                disabled={classroom.id === session.classroom_id}
                onClick={(event) => { closeMenu(event); void moveSession(session.id, classroom.id); }}
              >{classroom.title}</button>
            ))}
          </div>
        </details>
      </div>
    );
  }

  /** A classroom and its lectures. The whole group is a drop target. */
  function renderClassroomGroup(key: string, label: string, sessions: SessionSummary[]) {
    return (
      <div
        key={key || "unassigned"}
        className={dragOverKey === key ? "sidebar-classroom-group drop-target" : "sidebar-classroom-group"}
        onDragOver={(event) => {
          if (!dragSessionId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOverKey(key);
        }}
        onDragLeave={() => setDragOverKey((current) => (current === key ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          const sessionId = dragSessionId;
          setDragSessionId("");
          setDragOverKey(null);
          if (sessionId) void moveSession(sessionId, key || null);
        }}
      >
        <button
          type="button"
          className={activeClassroomId === key ? "sidebar-classroom active" : "sidebar-classroom"}
          onClick={() => {
            setActiveClassroomId(key);
            prepareNewLecture();
          }}
          disabled={status === "recording" || status === "connecting"}
        >
          <span>{label}</span>
          <small>{sessions.length}</small>
        </button>
        <div className="sidebar-sessions">{sessions.map(renderSessionRow)}</div>
      </div>
    );
  }

  return (
    <main className="workspace">
      <aside className="workspace-sidebar">
        <Link className="sidebar-brand" href={basePath || "/"} aria-label={isEnglish ? "Lecue home" : "Lecue 홈"}>Lecue</Link>

        <button
          type="button"
          className="sidebar-new-lecture"
          onClick={prepareNewLecture}
          disabled={status === "recording" || status === "connecting"}
        >
          <span aria-hidden="true">＋</span>
          {isEnglish ? "New lecture" : "새 수업"}
        </button>

        <div className="sidebar-library">
          <div className="sidebar-section-heading">
            <span>{isEnglish ? "Classrooms" : "강의실"}</span>
            <Link href={`${basePath}/classrooms`}>{isEnglish ? "Manage" : "관리"}</Link>
          </div>

          <nav className="sidebar-classrooms" aria-label={isEnglish ? "Classrooms and lectures" : "강의실과 수업 목록"}>
            {renderClassroomGroup("", isEnglish ? "Unassigned" : "미분류 수업", unassignedSessions)}
            {classrooms.map((classroom) => renderClassroomGroup(classroom.id, classroom.title, classroom.sessions))}
          </nav>

          <form className="sidebar-create-classroom" onSubmit={createClassroom}>
            <label htmlFor="new-classroom">{isEnglish ? "Add a classroom" : "강의실 추가하기"}</label>
            <div>
              <input
                id="new-classroom"
                value={newClassroomTitle}
                onChange={(event) => setNewClassroomTitle(event.target.value)}
                placeholder={isEnglish ? "e.g. Economics" : "예: 경제학개론"}
                maxLength={80}
                disabled={classroomPending}
              />
              <button type="submit" disabled={classroomPending || !newClassroomTitle.trim()} aria-label={isEnglish ? "Add classroom" : "강의실 추가"}>＋</button>
            </div>
          </form>
        </div>

        <div className="sidebar-account">
          <Link className="sidebar-credit" href={`${basePath}/billing`}>
            <span>{isEnglish ? "Credits" : "남은 크레딧"}</span>
            <b>{creditStatus ? creditStatus.credits.toLocaleString(isEnglish ? "en-US" : "ko-KR") : "—"}</b>
          </Link>
          <details className="profile-menu">
            <summary className="sidebar-profile">
              <span className="profile-avatar" aria-hidden="true">{(profile?.displayName || profile?.email || "L").slice(0, 1).toUpperCase()}</span>
              <span className="profile-copy">
                <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
                <small>{planLabel}</small>
              </span>
              <span className="profile-chevron" aria-hidden="true">•••</span>
            </summary>

            <div className="profile-menu-panel">
              <header>
                <span className="profile-avatar" aria-hidden="true">{(profile?.displayName || profile?.email || "L").slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
                  <small>{profile?.email}</small>
                </span>
              </header>

              <div className="profile-plan">
                <span><small>{isEnglish ? "Plan" : "요금제"}</small><strong>{planLabel}</strong></span>
                <span><small>{isEnglish ? "Credits" : "크레딧"}</small><strong>{creditStatus ? creditStatus.credits.toLocaleString(isEnglish ? "en-US" : "ko-KR") : "—"}</strong></span>
              </div>
              <Link className="profile-billing-link" href={`${basePath}/billing`}>{isEnglish ? "View plan and billing" : "요금제 및 결제 관리"}<span aria-hidden="true">→</span></Link>

              {/* A plain anchor, not a Link: the language lives in a cookie the
                  proxy sets on this request and acts on for the next one, and a
                  client-side navigation would skip that round trip. */}
              <a className="profile-language" href={isEnglish ? "?lang=ko" : "?lang=en"}>
                <span>{isEnglish ? "Language" : "언어"}</span>
                <strong>{isEnglish ? "한국어로 보기" : "View in English"}</strong>
              </a>

              <section className="profile-model-settings" aria-labelledby="profile-model-title">
                <div className="profile-model-heading">
                  <h3 id="profile-model-title">{isEnglish ? "Answer model" : "답변 모델"}</h3>
                  <span>{activeModelLabel}</span>
                </div>
                <fieldset className="settings-choice">
                  <legend>{isEnglish ? "Provider" : "공급자"}</legend>
                  <div className="settings-choice-list">
                    {([
                      { id: "lecture-live", label: isEnglish ? "Lecue default AI" : "Lecue 기본 AI" },
                      { id: "openai", label: "OpenAI" },
                      { id: "anthropic", label: "Anthropic Claude" },
                      { id: "google", label: "Google Gemini" },
                    ] as Array<{ id: AiProvider; label: string }>).map((option) => (
                      <button
                        type="button"
                        key={option.id}
                        className={aiProvider === option.id ? "active" : undefined}
                        aria-pressed={aiProvider === option.id}
                        onClick={() => {
                          const provider = option.id;
                          setAiProvider(provider);
                          setPersonalApiKey("");
                          if (provider !== "lecture-live") setAiModel(personalModelOptions[provider][0].id);
                        }}
                      >{option.label}</button>
                    ))}
                  </div>
                </fieldset>

                {aiProvider !== "lecture-live" && (
                  <>
                    <fieldset className="settings-choice">
                      <legend>{isEnglish ? "Model" : "모델"}</legend>
                      <div className="settings-choice-list settings-model-list">
                        {personalModelOptions[aiProvider].map((model) => (
                          <button
                            type="button"
                            key={model.id}
                            className={aiModel === model.id ? "active" : undefined}
                            aria-pressed={aiModel === model.id}
                            onClick={() => setAiModel(model.id)}
                          >{model.label}</button>
                        ))}
                      </div>
                    </fieldset>
                    <label className="profile-api-key">
                      <span>{isEnglish ? "Your API key" : "개인 API 키"}</span>
                      <input
                        type="password"
                        value={personalApiKey}
                        onChange={(event) => setPersonalApiKey(event.target.value)}
                        placeholder={savedCredential
                          ? isEnglish ? "A key is saved — enter one to replace it" : "저장됨 — 교체하려면 새 키 입력"
                          : isEnglish ? "Enter API key" : "API 키 입력"}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={512}
                      />
                    </label>
                    <div className="credential-actions">
                      <button type="button" onClick={saveCredential} disabled={credentialPending || !personalApiKey.trim()}>
                        {credentialPending
                          ? isEnglish ? "Working…" : "처리 중…"
                          : savedCredential
                            ? isEnglish ? "Replace saved key" : "저장된 키 교체"
                            : isEnglish ? "Save to my account" : "내 계정에 저장"}
                      </button>
                      {savedCredential && (
                        <button type="button" onClick={deleteCredential} disabled={credentialPending}>
                          {isEnglish ? "Remove saved key" : "저장된 키 삭제"}
                        </button>
                      )}
                    </div>
                    <p>{isEnglish ? "Provider charges apply to your own account." : "질문 비용은 선택한 공급자 계정에 별도로 청구됩니다."}</p>
                  </>
                )}
              </section>

              <form className="profile-signout" action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
                <button type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
              </form>
            </div>
          </details>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          {/* Without this every lecture took the auto-generated date name, so
              two lectures in one day were indistinguishable in the sidebar and
              the rename endpoint had no way to be reached. */}
          <label className="lecture-title-field">
            <span className="sr-only">{isEnglish ? "Lecture title" : "수업 제목"}</span>
            {/* Reads as plain text until a double-click; the field only looks
                editable while it is. */}
            <input
              type="text"
              value={lectureTitle}
              readOnly={!titleEditing}
              title={isEnglish ? "Double-click to rename" : "더블클릭하면 이름을 바꿉니다"}
              onChange={(event) => setLectureTitle(event.target.value)}
              onDoubleClick={(event) => { setTitleEditing(true); event.currentTarget.select(); }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              onBlur={() => { setTitleEditing(false); void renameActiveLecture(); }}
              placeholder={isEnglish ? "Untitled lecture" : "제목 없는 수업"}
              maxLength={80}
            />
          </label>

          <div className="session-state" aria-live="polite">
            <span className={`state-dot state-${status}`} />
            <span>{statusCopy[status]}</span>
            <time>{formatTime(elapsedMs)}</time>
          </div>

          {status === "recording" || status === "connecting" ? (
            <button className="stop-button" type="button" onClick={stopLecture} disabled={status === "connecting"}>
              {isEnglish ? "End lecture" : "강의 종료"}
            </button>
          ) : (
            <button className="start-button" type="button" onClick={startLecture} disabled={!canStart}>
              {isEnglish ? "Start lecture" : "강의 시작"}
            </button>
          )}
        </header>

        <div className="error-banner" role="alert">{error}</div>
        <div className="notice-banner" role="status">{notice}</div>

        <section className="panes">
          <section className="chat-pane" aria-labelledby="chat-title">
          <div className="pane-heading">
            <div>
              <h1 id="chat-title">{isEnglish ? "Ask about the lecture" : "강의에 질문하기"}</h1>
            </div>
            <span className="count">{messages.filter((message) => message.role === "user").length}{isEnglish ? " questions" : "개 질문"}</span>
          </div>

          {/* Likewise: announce the newest answer, not the whole thread. */}
          <p className="sr-only" aria-live="polite">
            {messages.at(-1)?.role === "assistant" && !messages.at(-1)?.pending ? messages.at(-1)!.text : ""}
          </p>

          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>{isEnglish ? "Ask as soon as the lecture starts." : "강의가 시작되면 바로 물어보세요."}</p>
                <span>{isEnglish
                  ? "You can ask ‘What did CIB mean just now?’ and get an answer grounded in the lecture flow."
                  : "“방금 말한 CIB가 뭐야?”처럼 질문해도 강의 흐름을 기준으로 답합니다."}</span>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`}>
                  {message.role === "assistant" && (
                    <span className="message-label">{message.assistantLabel ?? (isEnglish ? "Lecture assistant · AI" : "강의 조교 · AI")}</span>
                  )}
                  <p className={message.pending ? "pending" : undefined}>
                    {message.text}
                  </p>
                  {message.sources && message.sources.length > 0 && (
                    <div className="sources">
                      <span>{isEnglish ? "External search used" : "외부 검색 사용"}</span>
                      {message.sources.slice(0, 3).map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {new URL(source.url).hostname.replace(/^www\./, "")}
                        </a>
                      ))}
                      {message.sources.length > 3 && (
                        <details className="source-more">
                          <summary>{isEnglish ? `Show ${message.sources.length - 3} more sources` : `출처 ${message.sources.length - 3}개 더 보기`}</summary>
                          <div>
                            {message.sources.slice(3).map((source) => (
                              <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                                {new URL(source.url).hostname.replace(/^www\./, "")}
                              </a>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                  {message.role === "assistant" && !message.pending && activeSessionId && (
                    <div className="message-report">
                      <button
                        type="button"
                        disabled={reportedKeys.includes(`miss:${message.id}`)}
                        onClick={() => void reportIssue("context_miss", message.text.slice(0, 2_000), `miss:${message.id}`)}
                      >
                        {reportedKeys.includes(`miss:${message.id}`)
                          ? isEnglish ? "Thanks, noted" : "신고 접수됨"
                          : isEnglish ? "Missed the lecture context" : "강의 맥락과 안 맞음"}
                      </button>
                    </div>
                  )}
                  {message.materialSources && message.materialSources.length > 0 && (
                    <div className="lecture-sources material-sources">
                      <span>{isEnglish ? "Material used" : "강의 자료 참고"}</span>
                      {/* 답과 근거를 잇는 고리. 누르면 옆 패널이 그 쪽으로 간다. */}
                      {message.materialSources.map((source) => (
                        <button
                          type="button"
                          key={`${source.documentId}-${source.startPage}`}
                          onClick={() => pinSlide(source)}
                        >
                          {source.filename} p.{source.startPage}
                          {source.endPage !== source.startPage ? `-${source.endPage}` : ""}
                        </button>
                      ))}
                    </div>
                  )}
                  {message.lectureSources && message.lectureSources.length > 0 && (
                    <div className="lecture-sources">
                      <span>{isEnglish ? "Earlier lecture used" : "이전 수업 참고"}</span>
                      {message.lectureSources.map((source) => (
                        <button type="button" key={`${source.sessionId}-${source.startMs}`} onClick={() => void openSession(source.sessionId)}>
                          {source.title}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))
            )}
          </div>

          <form className="question-form" onSubmit={askQuestion}>
            <label htmlFor="question" className="sr-only">{isEnglish ? "Enter a question" : "질문 입력"}</label>
            <textarea
              id="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={canAsk
                ? isEnglish ? "Ask about this lecture" : "이 강의에 대해 질문하세요"
                : isEnglish ? "You can ask once the transcript begins" : "스크립트가 들어오면 질문할 수 있습니다"}
              maxLength={1_000}
              disabled={!canAsk}
              rows={2}
            />
            <button type="submit" disabled={!canAsk || !question.trim()} aria-label={isEnglish ? "Send question" : "질문 보내기"}>
              {isEnglish ? "Send" : "보내기"}
            </button>
          </form>
          </section>

          <section className="transcript-pane" aria-labelledby="transcript-title">
          <div className="pane-heading transcript-heading">
            <div>
              <h2 id="transcript-title">{isEnglish ? "Live transcript" : "실시간 스크립트"}</h2>
            </div>
            <span className="count">{sentenceCount}{isEnglish ? " sentences" : "개 문장"}</span>
          </div>

          {activeClassroomId && materialState === "none" && (
            <p className="slide-hint">{isEnglish
              ? "Upload the slide deck to this classroom and answers will read the formulas and tables on screen too."
              : "이 강의실에 강의 자료(PDF)를 올리면 화면 속 수식·표까지 보고 답합니다."}</p>
          )}

          {activeClassroomId && materialState === "text-only" && (
            <p className="slide-hint">{isEnglish
              ? "This classroom's materials were indexed before originals were kept. Answers still use them; upload them again to see the slides."
              : "이 강의실의 자료는 원본을 보관하기 전에 올라왔습니다. 답변에는 그대로 쓰이지만, 슬라이드를 보려면 다시 올려 주세요."}</p>
          )}

          {activeClassroomId && materialState === "viewable" && (
            <div className={`slide-panel${slideCollapsed ? " collapsed" : ""}`}>
              <div className="slide-bar">
                <span className="slide-label">
                  {slidePage
                    ? `${slidePage.filename} p.${slidePage.startPage}${slidePage.endPage !== slidePage.startPage ? `-${slidePage.endPage}` : ""}`
                    : isEnglish ? "Finding the page the lecture is on" : "지금 강의가 지나는 쪽을 찾는 중"}
                </span>
                <button type="button" onClick={() => setSlideZoomed(true)} disabled={!slidePage || slideUrl?.documentId !== slidePage?.documentId}>
                  {isEnglish ? "Enlarge" : "크게 보기"}
                </button>
                <button type="button" onClick={() => setSlideCollapsed((collapsed) => !collapsed)}>
                  {slideCollapsed
                    ? isEnglish ? "Show" : "펼치기"
                    : isEnglish ? "Hide" : "접기"}
                </button>
              </div>
              {!slideCollapsed && (
                <div className="slide-frame">
                  {slidePage && slideUrl?.documentId === slidePage.documentId ? (
                    /* ponytail: 브라우저 내장 PDF 뷰어의 #page 프래그먼트에 기댄다.
                       Chrome·Edge(1차 지원 환경)는 따르지만 Safari는 무시한다.
                       현장에서 문제가 되면 pdf.js 캔버스 렌더로 올린다. */
                    <iframe
                      title={isEnglish ? "Slide the lecture is on" : "지금 강의가 지나는 슬라이드"}
                      src={`${slideUrl.url}#page=${slidePage.startPage}&view=Fit`}
                    />
                  ) : (
                    <p>{slidePage
                      ? isEnglish ? "Opening the slide…" : "슬라이드를 여는 중입니다"
                      : isEnglish
                        ? "The slide appears once the lecture reaches a page in the deck."
                        : "강의가 자료의 어느 쪽에 닿으면 그 슬라이드가 여기 뜹니다."}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* The live region is the newest line only. On the scrollback
              container a screen reader re-read the entire lecture every time a
              segment arrived, roughly every five seconds. */}
          <p className="sr-only" aria-live="polite">
            {interim || transcriptParagraphs.at(-1)?.text || ""}
          </p>

          <div className="transcript" ref={transcriptScrollRef}>
            {segments.length === 0 && !interim ? (
              <div className="empty-transcript">
                <p>{status === "connecting"
                  ? isEnglish ? "Connecting to the microphone" : "마이크와 연결하는 중입니다"
                  : isEnglish ? "Speech will appear here once you start the lecture" : "강의를 시작하면 말이 이곳에 쌓입니다"}</p>
                <span>{isEnglish
                  ? "Place your laptop near the speaker for better recognition."
                  : "노트북을 강사와 가까운 곳에 두면 인식률이 좋아집니다."}</span>
              </div>
            ) : (
              <div className="transcript-copy">
                {transcriptParagraphs.map((paragraph) => {
                  const key = `${paragraph.startMs}-${paragraph.endMs}`;
                  const reported = reportedKeys.includes(`stt:${key}`);
                  return (
                    <div className="transcript-line" key={key}>
                      <p>{paragraph.text}</p>
                      <button
                        type="button"
                        className="line-ask"
                        disabled={!canAsk}
                        onClick={() => void submitQuestion(isEnglish
                          ? `Explain this part of the lecture in plain language: "${paragraph.text}"`
                          : `강의의 이 부분을 쉽게 설명해 줘: "${paragraph.text}"`)}
                      >
                        {isEnglish ? "Explain" : "설명"}
                      </button>
                      <button
                        type="button"
                        className="line-report"
                        disabled={reported || !activeSessionId}
                        onClick={() => void reportIssue("stt_error", paragraph.text, `stt:${key}`)}
                      >
                        {reported
                          ? isEnglish ? "Reported" : "신고됨"
                          : isEnglish ? "Misheard" : "잘못 적힘"}
                      </button>
                    </div>
                  );
                })}
                {interim && <p className="interim-line">{interim}</p>}
              </div>
            )}
          </div>
          </section>
        </section>

        {slideZoomed && slidePage && slideUrl?.documentId === slidePage.documentId && (
          <div className="slide-overlay" role="dialog" aria-modal="true" onClick={() => setSlideZoomed(false)}>
            <div className="slide-overlay-inner" onClick={(event) => event.stopPropagation()}>
              <div className="slide-bar">
                <span className="slide-label">
                  {slidePage.filename} p.{slidePage.startPage}
                  {slidePage.endPage !== slidePage.startPage ? `-${slidePage.endPage}` : ""}
                </span>
                <button type="button" onClick={() => setSlideZoomed(false)}>{isEnglish ? "Close" : "닫기"}</button>
              </div>
              <iframe
                title={isEnglish ? "Slide, enlarged" : "슬라이드 크게 보기"}
                src={`${slideUrl.url}#page=${slidePage.startPage}&view=Fit`}
              />
            </div>
          </div>
        )}

        <footer className="footnote">
          <span>{isEnglish ? "AI transcription · errors may occur" : "AI 자동 변환 · 오류가 있을 수 있습니다"}</span>
          <span className="footnote-links">
            <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
            <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
            <span>{isEnglish ? "Confirm recording permission before use" : "현장 녹음 권한을 확인한 뒤 사용하세요"}</span>
          </span>
        </footer>
      </div>
    </main>
  );
}
