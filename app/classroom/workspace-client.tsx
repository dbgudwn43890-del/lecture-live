"use client";

import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";

// KaTeX·Mermaid를 노트를 열 때만 내려받는다. 평소 강의 화면 번들에서 제외.
const LectureNotePanel = dynamic(() => import("./lecture-note"), { ssr: false });

/** 슬라이딩 인디케이터가 있는 세그먼트 토글. 라이트/다크, 음성 언어 같은 소수 선택지용. */
function SegmentedControl<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange(next: T): void;
  disabled?: boolean;
}) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  return (
    <div
      className={`segmented${disabled ? " is-disabled" : ""}`}
      role="radiogroup"
      style={{ "--seg-count": options.length, "--seg-index": index } as CSSProperties}
    >
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled}
          onClick={() => onChange(option.id)}
        >{option.label}</button>
      ))}
    </div>
  );
}

import { cleanAnswerText, cleanSources } from "../lib/answer-format";
import { countTranscriptSentences, groupTranscriptParagraphs } from "../lib/chunk-transcript";
import { CONSENT_COPY } from "../lib/consent";
import type { DeepgramLanguage } from "../lib/deepgram";
import { FREE_PILOT } from "../lib/free-pilot";
import { buildAnchor } from "../lib/material-anchor";
import { personalModelOptions, type PersonalProvider } from "../lib/llm-models";
import { getPlanLabel } from "../lib/plan-label";
import {
  MAX_LECTURE_MS,
  useLectureRecorder,
  type Segment,
  type SessionSummary,
  type Status,
} from "./use-lecture-recorder";

type Source = { title: string; url: string };
type LectureSource = { sessionId: string; title: string; startMs: number; endMs: number };
type MaterialSource = { documentId: string; filename: string; startPage: number; endPage: number };
type MaterialDocument = { id: string; classroom_id: string | null; session_id: string; filename: string; page_count: number };
type Classroom = { id: string; title: string; locale: "ko" | "en"; glossary?: string; sessions: SessionSummary[] };
type AudioUpload = {
  id: string;
  session_id: string;
  status: "uploading" | "queued" | "processing" | "completed" | "failed" | "deleted";
  filename: string;
  error_code?: string | null;
};
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

/**
 * Closes the whole <details> menu a clicked item sits inside — every open
 * ancestor, so a click in the "Move to" flyout also closes the menu it flew
 * out of, not just the submenu.
 */
function closeMenu(event: { currentTarget: HTMLElement }) {
  let node: HTMLElement | null = event.currentTarget.closest("details");
  while (node) {
    node.removeAttribute("open");
    node = node.parentElement?.closest("details") ?? null;
  }
}

function DraggableSession({ id, title, disabled, active, isEnglish, children }: {
  id: string;
  title: string;
  disabled: boolean;
  active: boolean;
  isEnglish: boolean;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragSource, isDropping } = useDraggable({
    id: `session:${id}`,
    type: "session",
    disabled,
  });
  return (
    <div ref={ref} className={`sidebar-session${active ? " is-active" : ""}${isDragSource ? " is-dragging" : ""}${isDropping ? " is-dropping" : ""}`}>
      {/* 점이 곧 드래그 핸들이다: 행마다 ⠿를 늘어놓지 않고도 잡을 곳이 남는다. */}
      <button
        ref={handleRef}
        type="button"
        className="session-bullet"
        aria-label={isEnglish ? `Move ${title}` : `${title} 이동`}
        title={isEnglish ? "Drag or press Space to move" : "드래그하거나 Space를 눌러 이동"}
        disabled={disabled}
      ><span aria-hidden="true" /></button>
      {children}
    </div>
  );
}

function ClassroomDropTarget({ id, disabled, children }: { id: string; disabled: boolean; children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id: `classroom:${id || "unassigned"}`,
    accept: "session",
    disabled,
  });
  return <div ref={ref} className={`sidebar-classroom-group${isDropTarget ? " drop-target" : ""}`}>{children}</div>;
}

const providerNames: Record<PersonalProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isPdfMaterial(document: MaterialDocument) {
  return document.filename.toLowerCase().endsWith(".pdf");
}

type InitialData = {
  profile: UserProfile | null;
  classrooms: Classroom[];
  unassignedSessions: SessionSummary[];
  creditStatus: CreditStatus | null;
};

export default function LectureWorkspace({ locale = "ko", initial, restoreSessionId }: { locale?: "ko" | "en"; initial?: InitialData; restoreSessionId?: string }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const statusCopy: Record<Status, string> = isEnglish
    ? { idle: "Not started", connecting: "Connecting", recording: "Recording", paused: "Paused", ended: "Ended", error: "Check connection" }
    : { idle: "시작 전", connecting: "연결 중", recording: "기록 중", paused: "일시정지", ended: "종료됨", error: "연결 확인 필요" };
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobilePane, setMobilePane] = useState<"chat" | "transcript">("chat");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // null until the first check answers; the gate never flashes on a returning
  // account that already agreed.
  const [consentSatisfied, setConsentSatisfied] = useState<boolean | null>(null);
  const [consentGate, setConsentGate] = useState(false);
  const [consentAge, setConsentAge] = useState(false);
  const [consentRecording, setConsentRecording] = useState(false);
  const [consentPending, setConsentPending] = useState(false);
  const [lectureTitle, setLectureTitle] = useState("");
  const [aiProvider, setAiProvider] = useState<AiProvider>("lecture-live");
  const [aiModel, setAiModel] = useState<string>(personalModelOptions.openai[0].id);
  // 기본값 "multi" = 한국어 수업(화면 표기는 그냥 "한국어"). 실시간은 Soniox가
  // 한 문장 속 한·영을 함께 인식하고, 업로드는 Deepgram ko로 내려간다.
  const [speechLanguage, setSpeechLanguage] = useState<DeepgramLanguage>("multi");
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("");
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
  const [credentialPending, setCredentialPending] = useState(false);
  const [classrooms, setClassrooms] = useState<Classroom[]>(initial?.classrooms ?? []);
  const [unassignedSessions, setUnassignedSessions] = useState<SessionSummary[]>(initial?.unassignedSessions ?? []);
  const [activeClassroomId, setActiveClassroomId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [classroomPending, setClassroomPending] = useState(false);
  const [newClassroomTitle, setNewClassroomTitle] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingClassroomId, setEditingClassroomId] = useState("");
  const [editingClassroomTitle, setEditingClassroomTitle] = useState("");
  const [editingGlossary, setEditingGlossary] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(initial?.profile ?? null);
  const [creditStatus, setCreditStatus] = useState<CreditStatus | null>(initial?.creditStatus ?? null);
  const [reportedKeys, setReportedKeys] = useState<string[]>([]);
  const [materials, setMaterials] = useState<MaterialDocument[]>([]);
  const [materialPending, setMaterialPending] = useState(false);
  // UPL-03. The upload being watched right now, if any.
  const [audioUpload, setAudioUpload] = useState<AudioUpload | null>(null);
  const [materialDragOver, setMaterialDragOver] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [theme, setThemeState] = useState<"system" | "light" | "dark">("system");
  const [deletingSessionId, setDeletingSessionId] = useState("");

  const recorder = useLectureRecorder({
    locale,
    isEnglish,
    speechLanguage,
    micDeviceId,
    activeClassroomId,
    activeSessionId,
    lectureTitle,
    setError,
    setNotice,
    setMobilePane,
    clearMessages: () => setMessages([]),
    setActiveSessionId,
    setLectureTitle,
    onCredits: (credits) => setCreditStatus((current) => (current ? { ...current, credits } : current)),
    loadClassrooms,
    loadCredits,
  });
  const {
    status, setStatus, elapsedMs, setElapsedMs, segments, setSegments, interim, showInterim,
    meterRef, segmentsRef, segmentIdsRef, confirmedSegmentIdsRef, activeSessionIdRef,
    finishingRef, saveFailuresRef, elapsedBaseMsRef, startedAtRef, streamOffsetMsRef,
    flushUtterance, startLecture, pauseLecture, resumeLecture, finishLecture, stopLecture,
  } = recorder;

  const transcriptParagraphs = useMemo(() => groupTranscriptParagraphs(segments), [segments]);
  const sentenceCount = useMemo(() => countTranscriptSentences(segments), [segments]);
  const sessionsById = useMemo(
    () => new Map([...unassignedSessions, ...classrooms.flatMap((classroom) => classroom.sessions)].map((session) => [session.id, session])),
    [unassignedSessions, classrooms],
  );

  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesFollowRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  // 지난 부분을 다시 읽는 중에는 새 문장이 와도 바닥으로 끌어내리지 않는다.
  const transcriptFollowRef = useRef(true);
  const initialRouteRef = useRef(false);
  const consentDialogRef = useRef<HTMLDialogElement | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("lecue-speech-language");
    // Deepgram's streaming `multi` model does not support Korean. Migrate the
    // old default instead of letting a saved value keep producing mixed-script noise.
    // 이제 선택지는 한국어(multi)와 English 둘뿐. 옛 저장값(ko/default)은
    // 한국어로 옮긴다.
    const language = saved === "en" ? "en" : "multi";
    setSpeechLanguage(language);
    window.localStorage.setItem("lecue-speech-language", language);
    const storedTheme = window.localStorage.getItem("lecue-theme");
    if (storedTheme === "dark" || storedTheme === "light") setThemeState(storedTheme);
    const storedMic = window.localStorage.getItem("lecue-mic-device");
    if (storedMic) setMicDeviceId(storedMic);
    // 답변 모델 선택도 새로고침을 견딘다. 언어 저장과 같은 방식.
    const provider = window.localStorage.getItem("lecue-ai-provider");
    if (provider && provider !== "lecture-live" && Object.hasOwn(personalModelOptions, provider)) {
      const options = personalModelOptions[provider as PersonalProvider];
      const model = window.localStorage.getItem("lecue-ai-model");
      setAiProvider(provider as AiProvider);
      setAiModel(options.some((option) => option.id === model) ? model! : options[0].id);
    }
  }, []);

  // 끝난 10분 구간을 강의 중에 미리 접어 둔다. 질문할 때 세 시간짜리 원문을
  // 통째로 보내지 않기 위한 준비이고, 학습자가 기다리는 시점이 아니라 여기서
  // 돈다. 서버가 할 일이 없으면 아무것도 하지 않으므로 그냥 두드린다.
  useEffect(() => {
    if (status !== "recording") return;
    const fold = () => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      void fetch("/api/lecture-summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ sessionId }),
        // 실패해도 답변은 원문으로 나온다. 강의를 방해할 이유가 없다.
      }).catch(() => {});
    };
    const timer = window.setInterval(fold, 120_000);
    return () => window.clearInterval(timer);
  }, [status, locale]);

  useEffect(() => {
    messagesFollowRef.current = true;
    transcriptFollowRef.current = true;
  }, [activeSessionId]);
  useEffect(() => {
    const scroller = messagesScrollRef.current;
    const countChanged = previousMessageCountRef.current !== messages.length;
    previousMessageCountRef.current = messages.length;
    if (!scroller || !messagesFollowRef.current) return;
    if (countChanged && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [messages]);
  useEffect(() => {
    if (!initialRouteRef.current) return;
    const url = new URL(window.location.href);
    if (activeSessionId) {
      url.searchParams.set("session", activeSessionId);
      url.searchParams.delete("classroom");
    } else {
      url.searchParams.delete("session");
      if (activeClassroomId) url.searchParams.set("classroom", activeClassroomId);
      else url.searchParams.delete("classroom");
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeSessionId, activeClassroomId]);

  // Uploading or transcribing: the control is occupied either way.
  const audioBusy = audioUpload?.status === "uploading" || audioUpload?.status === "processing" || audioUpload?.status === "queued";

  // UPL-03. Deepgram answers on its own callback, so the only way this tab
  // learns the transcript landed is to ask. Polling stops the moment the job
  // reaches a terminal state, so an idle workspace makes no requests.
  useEffect(() => {
    if (!audioUpload || (audioUpload.status !== "processing" && audioUpload.status !== "queued")) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/lecture-audio?sessionId=${encodeURIComponent(audioUpload.session_id)}`, { headers: { "X-Site-Locale": locale } });
        if (!response.ok) return;
        const data = await response.json() as { uploads?: AudioUpload[] };
        const current = data.uploads?.find((row) => row.id === audioUpload.id);
        if (cancelled || !current || current.status === audioUpload.status) return;
        setAudioUpload(current);
        if (current.status === "completed") {
          setNotice(isEnglish ? "The recording is transcribed." : "녹음 파일을 스크립트로 옮겼습니다.");
          await loadClassrooms();
        } else if (current.status === "failed") {
          setNotice("");
          setError(current.error_code === "empty"
            ? isEnglish ? "No speech was found in this recording." : "이 녹음 파일에서 말소리를 찾지 못했습니다."
            : isEnglish ? "Could not transcribe this recording." : "이 녹음 파일을 옮기지 못했습니다.");
        }
      } catch {
        /* A missed poll is retried on the next tick. */
      }
    }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUpload?.id, audioUpload?.status, locale, isEnglish]);
  // Materials stay available to answers; the workspace does not render the
  // original files.
  useEffect(() => {
    if (!activeSessionId) {
      setMaterials([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/materials?sessionId=${encodeURIComponent(activeSessionId)}`, {
          headers: { "X-Site-Locale": locale },
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = await response.json() as { documents?: MaterialDocument[] };
        const documents = data.documents ?? [];
        if (!cancelled) {
          setMaterials(documents);
        }
      } catch {
        // 자료 유무 확인 실패는 강의 진행을 막지 않는다.
      }
    })();
    return () => { cancelled = true; };
  }, [activeSessionId, locale]);

  /**
   * UPL-01. Reads the length in the browser first: a file past the three-hour
   * ceiling is refused here rather than after a 1GB upload, and the estimate
   * lets the server turn away an account with no credits before it pays
   * Deepgram to transcribe anything. The charge itself uses Deepgram\'s own
   * measurement, so this number cannot buy a cheaper lecture.
   */
  async function readDurationMs(file: File): Promise<number> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("audio");
      probe.preload = "metadata";
      const done = (value: number) => { URL.revokeObjectURL(url); resolve(value); };
      probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? Math.round(probe.duration * 1_000) : 0);
      // A container the browser cannot read is not necessarily one Deepgram
      // cannot: send 0 and let the server decide.
      probe.onerror = () => done(0);
      probe.src = url;
    });
  }

  async function uploadLectureAudio(file: File) {
    if (audioUpload && (audioUpload.status === "processing" || audioUpload.status === "uploading")) return;
    const durationMs = await readDurationMs(file);
    if (durationMs > MAX_LECTURE_MS) {
      setError(isEnglish ? "A lecture can be up to 3 hours long." : "한 수업은 최대 3시간까지 변환할 수 있습니다.");
      return;
    }

    setError("");
    setNotice(isEnglish ? "Uploading the recording…" : "녹음 파일을 올리는 중입니다…");
    setAudioUpload({ id: "", session_id: "", status: "uploading", filename: file.name });
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("title", file.name.replace(/\.[^.]+$/, "").slice(0, 80) || (isEnglish ? "Uploaded lecture" : "올린 수업"));
      formData.set("language", speechLanguage);
      formData.set("durationMs", String(durationMs));
      if (activeClassroomId) formData.set("classroomId", activeClassroomId);
      // UPL-04. Stable for this file, so a retry after a dropped connection
      // rejoins the job already running instead of paying for it twice.
      formData.set("idempotencyKey", `${file.name}:${file.size}:${file.lastModified}`);

      // fetch는 업로드 진행률을 주지 않는다. 1GB짜리 파일을 침묵 속에 올리게
      // 하지 않으려고 이 요청만 XHR로 보낸다.
      const data = await new Promise<{ upload?: AudioUpload; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/lecture-audio");
        xhr.setRequestHeader("X-Site-Locale", locale);
        xhr.responseType = "json";
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          setNotice(isEnglish
            ? `Uploading the recording… ${percent}%`
            : `녹음 파일을 올리는 중입니다… ${percent}%`);
        };
        xhr.onload = () => resolve((xhr.response ?? {}) as { upload?: AudioUpload; error?: string });
        xhr.onerror = () => reject(new Error());
        xhr.send(formData);
      });
      if (!data.upload) throw new Error(data.error);
      setAudioUpload(data.upload);
      setNotice(isEnglish
        ? "Transcribing. You can leave this page — the lecture appears in the sidebar when it is done."
        : "받아쓰는 중입니다. 이 화면을 떠나도 되며, 끝나면 왼쪽 목록에 수업이 나타납니다.");
      await loadClassrooms();
    } catch (caught) {
      setNotice("");
      setAudioUpload(null);
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not upload this recording." : "녹음 파일을 올리지 못했습니다.");
    }
  }

  async function uploadMaterial(file: File) {
    if (materialPending) return;
    setMaterialPending(true);
    setError("");
    setNotice(isEnglish ? "Reading the material…" : "자료를 읽는 중입니다…");
    try {
      let sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        const response = await fetch("/api/lecture-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({
            action: "draft",
            classroomId: activeClassroomId || null,
            title: isEnglish ? `Lecture ${new Date().toLocaleDateString("en-US")}` : `${new Date().toLocaleDateString("ko-KR")} 수업`,
          }),
        });
        const data = await response.json() as { session?: SessionSummary; error?: string };
        if (!response.ok || !data.session) throw new Error(data.error);
        sessionId = data.session.id;
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        setLectureTitle(data.session.title);
        await loadClassrooms(activeClassroomId);
      }
      const formData = new FormData();
      formData.set("sessionId", sessionId);
      formData.set("file", file);
      const response = await fetch("/api/materials", {
        method: "POST",
        headers: { "X-Site-Locale": locale },
        body: formData,
      });
      const data = await response.json() as { document?: MaterialDocument; error?: string };
      if (!response.ok || !data.document) throw new Error(data.error);
      const next = [data.document!, ...materials];
      setMaterials(next);
      setNotice(isEnglish ? "The material is ready." : "강의 자료를 준비했습니다.");
    } catch (caught) {
      setNotice("");
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not upload this material." : "강의 자료를 올리지 못했습니다.");
    } finally {
      setMaterialPending(false);
    }
  }

  async function deleteMaterial(documentId: string) {
    if (materialPending) return;
    setMaterialPending(true);
    setError("");
    try {
      const response = await fetch(`/api/materials?documentId=${encodeURIComponent(documentId)}`, {
        method: "DELETE",
        headers: { "X-Site-Locale": locale },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      const next = materials.filter((document) => document.id !== documentId);
      setMaterials(next);
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not delete this material." : "강의 자료를 삭제하지 못했습니다.");
    } finally {
      setMaterialPending(false);
    }
  }

  // Every temporary <details> menu closes on an outside click or Escape.
  useEffect(() => {
    function openMenus() {
      return document.querySelectorAll<HTMLDetailsElement>("details[open]");
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
    if (transcript && transcriptFollowRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [segments, interim]);

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
      } else if (!initialRouteRef.current) {
        initialRouteRef.current = true;
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get("session");
        const classroomId = params.get("classroom");
        if (sessionId) await openSession(sessionId);
        else if (classroomId && classrooms.some((classroom) => classroom.id === classroomId)) setActiveClassroomId(classroomId);
        if (params.get("payment") === "success") {
          setNotice(isEnglish
            ? "Payment complete. Your credits have been added."
            : "결제가 완료됐습니다. 크레딧이 추가되었습니다.");
        }
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

  /** Moves a lecture between classrooms from drag-and-drop or the options menu. */
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

  /**
   * HIS-03. Deleting takes the transcript, the questions and the search index
   * with it (the child tables cascade), so it asks first. If the lecture being
   * deleted is the one on screen, the workspace goes back to an empty new
   * lecture rather than showing a transcript whose row no longer exists.
   */
  async function deleteSession(sessionId: string) {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch(`/api/lecture-sessions?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "X-Site-Locale": locale },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      if (sessionId === activeSessionIdRef.current) prepareNewLecture();
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not delete the lecture." : "수업을 삭제하지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  /**
   * HIS-05. The learner's own copy, built in the browser and saved straight to
   * disk — no share link, nothing that leaves the device. Any lecture in the
   * sidebar can be exported, not just the open one, so the text is read back
   * from the same GET the workspace uses to reopen a lecture.
   */
  async function exportSession(sessionId: string) {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch(`/api/lecture-sessions?sessionId=${encodeURIComponent(sessionId)}`, { headers: { "X-Site-Locale": locale } });
      const data = await response.json() as {
        session?: SessionSummary;
        segments?: Segment[];
        questions?: Array<{ question: string; answer: string }>;
        error?: string;
      };
      if (!response.ok || !data.session) throw new Error(data.error);

      const lines = [
        data.session.title,
        new Date(data.session.started_at).toLocaleString(locale === "en" ? "en-US" : "ko-KR"),
        "",
        isEnglish ? "## Transcript" : "## 강의 스크립트",
        "",
        ...(data.segments ?? []).map((segment) => `[${formatTime(segment.startMs)}] ${segment.text}`),
      ];
      if (data.questions?.length) {
        lines.push("", isEnglish ? "## Questions" : "## 질문과 답변", "");
        for (const item of data.questions) {
          lines.push(`Q. ${item.question}`, `A. ${cleanAnswerText(item.answer)}`, "");
        }
      }

      const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      // Windows and macOS both reject these in a filename, and a lecture titled
      // "3/12 quiz review" would otherwise save as a broken path or not at all.
      link.download = `${data.session.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "lecture"}.txt`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not export the lecture." : "수업 기록을 내보내지 못했습니다.");
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
      setCreateOpen(false);
      prepareNewLecture();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  async function updateClassroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = editingClassroomTitle.trim();
    if (!editingClassroomId || !title || classroomPending) return;
    setClassroomPending(true);
    setError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ classroomId: editingClassroomId, title, glossary: editingGlossary }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setEditingClassroomId("");
      await loadClassrooms(editingClassroomId);
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save the classroom." : "강의실 정보를 저장하지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  async function openSession(sessionId: string) {
    if (status === "recording" || status === "connecting" || finishingRef.current) return;
    setClassroomPending(true);
    setError("");
    setNotice("");
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
      activeSessionIdRef.current = data.session.id;
      setLectureTitle(data.session.title);
      setSegments(restoredSegments);
      segmentIdsRef.current = new Set(restoredSegments.map((segment) => segment.id));
      // Restored segments are already saved, so /api/ask must not re-upload them.
      confirmedSegmentIdsRef.current = new Set(segmentIdsRef.current);
      setMessages((data.questions ?? []).flatMap((item) => [
        { id: `${item.id}-q`, role: "user" as const, text: item.question },
        // 저장된 provider는 내부 식별자다("lecture-live", "openai"). 그대로
        // 보여주지 않고 화면용 이름으로 바꾼다. 기본 AI는 모델명도 숨긴다.
        { id: `${item.id}-a`, role: "assistant" as const, text: cleanAnswerText(item.answer), sources: cleanSources(item.external_sources ?? []), lectureSources: item.lecture_sources, assistantLabel: item.provider === "lecture-live"
          ? (isEnglish ? "Lecture assistant · Default AI" : "강의 조교 · 기본 AI")
          : `${providerNames[item.provider as PersonalProvider] ?? item.provider} · ${item.model}` },
      ]));
      showInterim("");
      let recordedMs = data.session.recorded_ms ?? data.session.duration_seconds * 1_000;
      let nextStatus: Status = data.session.status === "draft" ? "idle"
        : data.session.status === "completed" ? "ended" : "paused";
      // A refresh closes the browser microphone but cannot close the old DB
      // session. Recover it as paused so wall-clock time never becomes audio.
      if (data.session.status === "recording") {
        const pauseResponse = await fetch("/api/lecture-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ action: "pause", sessionId: data.session.id }),
        });
        const pauseData = await pauseResponse.json() as { recordedMs?: number; error?: string };
        if (!pauseResponse.ok) throw new Error(pauseData.error);
        recordedMs = pauseData.recordedMs ?? recordedMs;
        nextStatus = "paused";
      }
      elapsedBaseMsRef.current = recordedMs;
      startedAtRef.current = 0;
      streamOffsetMsRef.current = recordedMs;
      setElapsedMs(recordedMs);
      setStatus(nextStatus);
      setMobilePane((data.questions?.length ?? 0) > 0 ? "chat" : "transcript");
      setMobileSidebarOpen(false);
      setNoteOpen(false);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not load the lecture." : "수업 기록을 불러오지 못했습니다.");
    } finally {
      setClassroomPending(false);
      setRestoring(false);
    }
  }

  function prepareNewLecture() {
    if (status === "recording" || status === "connecting" || finishingRef.current) return;
    setActiveSessionId("");
    activeSessionIdRef.current = "";
    setLectureTitle("");
    setSegments([]);
    segmentIdsRef.current.clear();
    confirmedSegmentIdsRef.current.clear();
    setMessages([]);
    showInterim("");
    setElapsedMs(0);
    setMobilePane("chat");
    setMobileSidebarOpen(false);
    elapsedBaseMsRef.current = 0;
    startedAtRef.current = 0;
    setNotice("");
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

  /** 실제 적용은 html의 data-theme 속성. layout.tsx의 스크립트와 같은 규칙이다. */
  function applyTheme(next: "system" | "light" | "dark") {
    setThemeState(next);
    if (next === "system") {
      window.localStorage.removeItem("lecue-theme");
      document.documentElement.dataset.theme =
        window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      window.localStorage.setItem("lecue-theme", next);
      document.documentElement.dataset.theme = next;
    }
  }

  // 가입 이후에 만들어진 계정은 이미 기록이 있다. 그 전에 만든 계정만 여기서
  // 한 번 걸리고, 그 뒤로는 다시 뜨지 않는다.
  useEffect(() => {
    void refreshConsent().then((satisfied) => setConsentGate(!satisfied));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dialog = consentDialogRef.current;
    if (!dialog) return;
    if (consentGate && !dialog.open) dialog.showModal();
    if (!consentGate && dialog.open) dialog.close();
  }, [consentGate]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (deletingSessionId && !dialog.open) dialog.showModal();
    if (!deletingSessionId && dialog.open) dialog.close();
  }, [deletingSessionId]);

  /** ACC-02/ACC-03. Asks the server, which owns the wording version. */
  async function refreshConsent() {
    try {
      const response = await fetch("/api/consents", { headers: { "X-Site-Locale": locale } });
      if (!response.ok) return false;
      const data = await response.json() as { satisfied?: boolean };
      const satisfied = data.satisfied === true;
      setConsentSatisfied(satisfied);
      return satisfied;
    } catch {
      // Offline or a failed check does not get to wave a learner through: the
      // gate stays and asking again is cheap.
      return false;
    }
  }

  async function acceptConsentGate() {
    if (!consentAge || !consentRecording) return;
    setConsentPending(true);
    setError("");
    try {
      const response = await fetch("/api/consents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ types: ["age_14", "recording"] }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setConsentSatisfied(true);
      setConsentGate(false);
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save your agreement." : "동의 기록을 저장하지 못했습니다.");
    } finally {
      setConsentPending(false);
    }
  }

  const hasTranscript = segments.length > 0 || interim.length > 0;
  // 진행 중인 강의는 크레딧이 다 떨어져도 질문까지는 막지 않는다.
  const creditsAllowAsk = creditStatus === null || creditStatus.credits > 0 || status === "recording" || status === "paused";
  const outOfCredits = creditStatus !== null && creditStatus.credits <= 0;
  const canAsk = hasTranscript
    && !messages.some((message) => message.pending)
    && creditsAllowAsk;

  /**
   * 놓친 구간 복구. 질문을 문장으로 못 쓰는 순간이 강의에서는 훨씬 잦다 — 무엇을
   * 물어야 할지 모르는 채로 흐름만 놓치기 때문이다. 서버가 창을 마지막 90초로
   * 좁히고 검색을 끄므로 이 경로가 가장 빠르고 가장 싸다.
   */
  function askCatchup() {
    void submitQuestion(
      isEnglish ? "I missed that — what was just said?" : "방금 놓쳤어요. 지금까지 무슨 말이었나요?",
      false,
      "catchup",
    );
  }

  function askQuestion(event: FormEvent) {
    event.preventDefault();
    void submitQuestion(question, true);
  }

  // Typing during a lecture is itself a distraction, so a transcript paragraph
  // can send its own question with one press (PRD 36.3.3). Both entry points
  // land here; only the composer clears itself, or a half-typed draft would
  // disappear when the learner tapped a paragraph instead.
  async function submitQuestion(text: string, fromComposer = false, mode?: "catchup") {
    const cleanQuestion = text.trim().slice(0, 1_000);
    if (!cleanQuestion || !canAsk || messages.some((message) => message.pending)) return;
    if (aiProvider !== "lecture-live" && !personalApiKey.trim() && !savedCredential) {
      setError(isEnglish
        ? "Enter or save an API key for the selected provider in Answer model settings."
        : "답변 모델 설정에서 선택한 공급자의 API 키를 입력하거나 저장해 주세요.");
      return;
    }

    setMobilePane("chat");
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
          mode,
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
      let finalDone: { answer: string; sources?: Source[]; lectureSources?: LectureSource[]; materialSources?: MaterialSource[] } | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let sawDelta = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as { delta?: string; done?: typeof finalDone; error?: string };
          if (typeof parsed.delta === "string") {
            streamedText += parsed.delta;
            sawDelta = true;
          } else if (parsed.done) {
            finalDone = parsed.done;
          } else if (parsed.error) {
            streamError = parsed.error;
          }
        }
        // 델타 줄마다가 아니라 도착한 청크당 한 번만 그린다.
        if (sawDelta) {
          const text = streamedText;
          setMessages((current) =>
            current.map((message) => (message.id === assistantId ? { ...message, text, pending: true } : message)),
          );
        }
      }

      if (streamError) throw new Error(streamError);
      if (!finalDone) throw new Error(isEnglish ? "Could not receive an answer." : "답변을 받지 못했습니다.");
      const { answer, sources, lectureSources, materialSources } = finalDone;

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

  // 끝난 수업은 다시 시작하지 않는다. 새 수업은 사이드바의 "새 수업"으로 연다.
  const canStart = (status === "idle" || status === "error")
    && (creditStatus === null || creditStatus.credits > 0);
  const [noteOpen, setNoteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 새로고침 직후, URL의 세션을 다시 여는 동안. 빈 새 수업 화면 대신 베일을 덮는다.
  const [restoring, setRestoring] = useState(Boolean(restoreSessionId));

  // 설정을 열 때만 장치 목록을 읽는다. 마이크 권한 전에는 라벨이 비어 온다.
  useEffect(() => {
    if (!settingsOpen || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices()
      .then((devices) => setMicDevices(devices.filter((device) => device.kind === "audioinput")))
      .catch(() => {});
  }, [settingsOpen]);
  const activeModelLabel =
    aiProvider === "lecture-live"
      ? isEnglish ? "Default AI" : "기본 AI"
      : personalModelOptions[aiProvider].find((model) => model.id === aiModel)?.label ??
        personalModelOptions[aiProvider][0].label;
  const planLabel = getPlanLabel(creditStatus?.planCode, locale);
  const activeClassroomTitle = classrooms.find((classroom) => classroom.id === activeClassroomId)?.title
    ?? (isEnglish ? "Unassigned" : "미분류 수업");

  const sidebarLocked = classroomPending || status === "recording" || status === "connecting" || status === "paused";

  /** One lecture row: open it, rename it in place, or drag it into a classroom. */
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
            if (event.nativeEvent.isComposing) return;
            // Escape restores the stored title first, so the blur below is a no-op.
            if (event.key === "Escape") event.currentTarget.value = session.title;
            if (event.key === "Escape" || event.key === "Enter") event.currentTarget.blur();
          }}
        />
      );
    }
    return (
      <DraggableSession key={session.id} id={session.id} title={session.title} disabled={sidebarLocked} active={session.id === activeSessionId} isEnglish={isEnglish}>
        <button
          type="button"
          className={session.id === activeSessionId ? "active" : undefined}
          onClick={() => void openSession(session.id)}
          disabled={sidebarLocked}
          title={session.title}
        >{session.title}</button>
        <details className="session-menu">
          <summary aria-label={isEnglish ? "Lecture options" : "수업 옵션"}>⋮</summary>
          <div className="session-menu-panel">
            <button type="button" onClick={(event) => { closeMenu(event); setRenamingSessionId(session.id); }}>
              {isEnglish ? "Rename" : "이름 변경"}
            </button>
            <button type="button" onClick={(event) => { closeMenu(event); void exportSession(session.id); }}>
              {isEnglish ? "Export as text" : "텍스트로 내보내기"}
            </button>
            <details
              className="session-submenu"
              onToggle={(event) => {
                // 사이드바의 세로 스크롤 컨테이너가 옆으로 나온 패널을 잘라먹는다.
                // fixed로 띄우고 열리는 순간 트리거 옆 좌표를 계산해 앉힌다.
                const details = event.currentTarget;
                const panel = details.querySelector<HTMLElement>(".session-submenu-panel");
                if (!panel || !details.open) return;
                const rect = details.getBoundingClientRect();
                panel.style.left = `${rect.right + 6}px`;
                panel.style.top = `${Math.max(8, Math.min(rect.top - 6, window.innerHeight - panel.offsetHeight - 8))}px`;
              }}
            >
              <summary>
                <span>{isEnglish ? "Move to" : "강의실로 이동"}</span>
                <span className="session-submenu-caret" aria-hidden="true">›</span>
              </summary>
              <div className="session-submenu-panel">
                {(session.classroom_id ? [{ id: "", title: isEnglish ? "Unassigned" : "미분류 수업" }] : [])
                  .concat(classrooms.filter((classroom) => classroom.id !== session.classroom_id).map((classroom) => ({ id: classroom.id, title: classroom.title })))
                  .map((classroom) => (
                    <button key={classroom.id || "unassigned"} type="button" onClick={(event) => {
                      closeMenu(event);
                      void moveSession(session.id, classroom.id || null);
                    }}>{classroom.title}</button>
                  ))}
              </div>
            </details>
            <button
              type="button"
              className="session-menu-delete"
              onClick={(event) => { closeMenu(event); setDeletingSessionId(session.id); }}
            >{isEnglish ? "Delete lecture" : "수업 삭제"}</button>
          </div>
        </details>
      </DraggableSession>
    );
  }

  /** A classroom and its lectures. The whole group is a drop target. */
  function renderClassroomGroup(key: string, label: string, sessions: SessionSummary[], glossary = "") {
    const query = sessionQuery.trim().toLowerCase();
    const visibleSessions = query
      ? sessions.filter((session) => session.title.toLowerCase().includes(query))
      : sessions;
    // 검색 중에는 결과 없는 강의실을 치운다. 빈 그룹 목록은 소음이다.
    if (query && visibleSessions.length === 0) return null;
    return (
      <ClassroomDropTarget key={key || "unassigned"} id={key} disabled={sidebarLocked}>
        <div className="sidebar-classroom-row">
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
            <small>{visibleSessions.length}</small>
          </button>
          {key && (
            <button
              type="button"
              className="classroom-settings-button"
              aria-label={isEnglish ? `${label} settings` : `${label} 설정`}
              onClick={() => {
                setEditingClassroomId(key);
                setEditingClassroomTitle(label);
                setEditingGlossary(glossary);
              }}
            >⋯</button>
          )}
        </div>
        <div className="sidebar-sessions">{visibleSessions.map(renderSessionRow)}</div>
      </ClassroomDropTarget>
    );
  }

  return (
    <main className="workspace">
      <aside className={`workspace-sidebar${mobileSidebarOpen ? " is-mobile-open" : ""}`}>
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

        <button
          type="button"
          className="sidebar-mobile-toggle"
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen((open) => !open)}
        >{mobileSidebarOpen
            ? isEnglish ? "Close" : "닫기"
            : isEnglish ? "Lectures" : "수업 목록"}</button>

        <div className="sidebar-library">
          {/* 검색·추가는 상시 노출 대신 헤딩의 아이콘으로 접어 둔다. 누르면 아래로 펼쳐진다. */}
          <div className="sidebar-section-heading">
            <span>{isEnglish ? "Classrooms" : "강의실"}</span>
            <div className="sidebar-heading-actions">
              <button
                type="button"
                className={sidebarSearchOpen ? "active" : undefined}
                aria-expanded={sidebarSearchOpen}
                aria-label={isEnglish ? "Search lectures" : "수업 검색"}
                onClick={() => setSidebarSearchOpen((open) => {
                  if (open) setSessionQuery("");
                  return !open;
                })}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
              <button
                type="button"
                className={createOpen ? "active" : undefined}
                aria-expanded={createOpen}
                aria-label={isEnglish ? "Add a classroom" : "강의실 추가"}
                onClick={() => setCreateOpen((open) => !open)}
              >＋</button>
            </div>
          </div>

          {sidebarSearchOpen && (
            <input
              className="sidebar-search"
              type="search"
              autoFocus
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSessionQuery("");
                  setSidebarSearchOpen(false);
                }
              }}
              placeholder={isEnglish ? "Search lectures" : "수업 검색"}
              aria-label={isEnglish ? "Search lectures" : "수업 검색"}
            />
          )}

          {createOpen && (
            <form className="sidebar-create-classroom" onSubmit={createClassroom}>
              <div>
                <input
                  autoFocus
                  value={newClassroomTitle}
                  onChange={(event) => setNewClassroomTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setCreateOpen(false); }}
                  placeholder={isEnglish ? "e.g. Economics" : "예: 경제학개론"}
                  maxLength={80}
                  disabled={classroomPending}
                  aria-label={isEnglish ? "New classroom name" : "새 강의실 이름"}
                />
                <button type="submit" disabled={classroomPending || !newClassroomTitle.trim()} aria-label={isEnglish ? "Add classroom" : "강의실 추가"}>＋</button>
              </div>
            </form>
          )}

          <DragDropProvider onDragEnd={(event) => {
            if (event.canceled) return;
            const source = String(event.operation.source?.id ?? "");
            const target = String(event.operation.target?.id ?? "");
            if (!source.startsWith("session:") || !target.startsWith("classroom:")) return;
            const classroomId = target.slice("classroom:".length);
            void moveSession(source.slice("session:".length), classroomId === "unassigned" ? null : classroomId);
          }}>
            <nav className="sidebar-classrooms" aria-label={isEnglish ? "Classrooms and lectures" : "강의실과 수업 목록"}>
              {renderClassroomGroup("", isEnglish ? "Unassigned" : "미분류 수업", unassignedSessions)}
              {classrooms.map((classroom) => renderClassroomGroup(classroom.id, classroom.title, classroom.sessions, classroom.glossary))}
            </nav>
          </DragDropProvider>

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

              {/* Claude식 슬림 메뉴: 세부 설정은 전용 모달로 옮기고 여기는 목록만. */}
              <div className="profile-menu-items">
                <button type="button" onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  setSettingsOpen(true);
                }}>
                  {isEnglish ? "Settings" : "설정"}
                </button>
                {/* A plain anchor, not a Link: the language lives in a cookie the
                    proxy sets on this request and acts on for the next one, and a
                    client-side navigation would skip that round trip. */}
                <a href={isEnglish ? "?lang=ko" : "?lang=en"}>
                  {isEnglish ? "한국어로 보기" : "View in English"}
                </a>
              </div>

              <form className="profile-signout" action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
                <button type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
              </form>
            </div>
          </details>
        </div>
      </aside>

      {settingsOpen && (
        <div className="note-overlay" role="dialog" aria-modal="true" aria-label={isEnglish ? "Settings" : "설정"}>
          <div className="note-panel settings-panel">
            <header className="note-topbar">
              <strong>{isEnglish ? "Settings" : "설정"}</strong>
              <button type="button" className="banner-dismiss" onClick={() => setSettingsOpen(false)} aria-label={isEnglish ? "Close" : "닫기"}>✕</button>
            </header>
            <div className="settings-body">
              <section className="settings-row">
                <div>
                  <h3>{isEnglish ? "Appearance" : "화면 테마"}</h3>
                  <p>{isEnglish ? "How Lecue looks on this device." : "이 기기에서 Lecue가 보이는 방식입니다."}</p>
                </div>
                <SegmentedControl
                  value={theme}
                  options={[
                    { id: "system", label: isEnglish ? "System" : "시스템" },
                    { id: "light", label: isEnglish ? "Light" : "라이트" },
                    { id: "dark", label: isEnglish ? "Dark" : "다크" },
                  ]}
                  onChange={(next) => applyTheme(next)}
                />
              </section>

              <section className="settings-row">
                <div>
                  <h3>{isEnglish ? "Lecture language" : "음성 인식 언어"}</h3>
                  <p>{isEnglish
                    ? "Korean also recognizes English terms mixed into the lecture."
                    : "한국어 모드는 수업에 섞인 영어 용어와 문장까지 함께 인식합니다."}</p>
                </div>
                <SegmentedControl
                  value={speechLanguage}
                  disabled={status === "recording" || status === "connecting"}
                  options={[
                    { id: "multi" as DeepgramLanguage, label: isEnglish ? "Korean" : "한국어" },
                    { id: "en" as DeepgramLanguage, label: "English" },
                  ]}
                  onChange={(next) => {
                    setSpeechLanguage(next);
                    window.localStorage.setItem("lecue-speech-language", next);
                  }}
                />
              </section>

              <section className="settings-row">
                <div>
                  <h3>{isEnglish ? "Microphone" : "마이크"}</h3>
                  <p>{isEnglish
                    ? "Applies from the next recording."
                    : "다음 녹음부터 적용됩니다."}</p>
                </div>
                <select
                  className="settings-select"
                  value={micDeviceId}
                  disabled={status === "recording" || status === "connecting"}
                  onChange={(event) => {
                    setMicDeviceId(event.target.value);
                    if (event.target.value) window.localStorage.setItem("lecue-mic-device", event.target.value);
                    else window.localStorage.removeItem("lecue-mic-device");
                  }}
                >
                  <option value="">{isEnglish ? "System default" : "시스템 기본"}</option>
                  {micDevices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || (isEnglish ? `Microphone ${index + 1}` : `마이크 ${index + 1}`)}
                    </option>
                  ))}
                </select>
              </section>


              {/* 한 층 접어 둔다: 개인 API 키 기능이 기본 제공 무료 기능으로
                  오해되지 않게, 열어야만 보이고 비용 주체를 먼저 말한다. */}
              <details className="profile-advanced">
                <summary>{isEnglish ? "Advanced · answer with your own AI key" : "고급 · 내 API 키로 답변 모델 바꾸기"}</summary>
                <p className="profile-advanced-note">{isEnglish
                  ? "Optional. Questions answered this way are billed to your own provider account, not to Lecue credits."
                  : "선택 기능입니다. 이 방식의 답변 비용은 Lecue 크레딧이 아니라 본인 공급자 계정에 청구됩니다."}</p>
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
                          window.localStorage.setItem("lecue-ai-provider", provider);
                          if (provider !== "lecture-live") {
                            const model = personalModelOptions[provider][0].id;
                            setAiModel(model);
                            window.localStorage.setItem("lecue-ai-model", model);
                          }
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
                            onClick={() => {
                              setAiModel(model.id);
                              window.localStorage.setItem("lecue-ai-model", model.id);
                            }}
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
              </details>
            </div>
          </div>
        </div>
      )}

      <div className="workspace-main">
        <header className="topbar">
          <label className="lecture-title-field">
            <span>{activeClassroomTitle}</span>
            <input
              value={lectureTitle}
              onChange={(event) => setLectureTitle(event.target.value)}
              onBlur={(event) => {
                if (activeSessionId) void renameSession(activeSessionId, event.target.value);
                else setLectureTitle(event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" && activeSessionId) {
                  setLectureTitle(sessionsById.get(activeSessionId)?.title ?? "");
                }
                if (event.key === "Escape" || event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder={isEnglish ? "Name this lecture" : "수업 이름을 입력하세요"}
              aria-label={isEnglish ? "Lecture name" : "수업 이름"}
              maxLength={80}
            />
          </label>

          <div className="session-state" aria-live="polite">
            <span className={`state-dot state-${status}`} />
            {status === "recording" && <span className="mic-meter" ref={meterRef} aria-hidden="true" />}
            <span>{statusCopy[status]}</span>
            <time>{formatTime(elapsedMs)}</time>
          </div>

          {status === "recording" || status === "connecting" || status === "paused" ? (
            <div className="lecture-controls">
              <button
                className="pause-button"
                type="button"
                onClick={status === "paused" ? resumeLecture : pauseLecture}
                disabled={status === "connecting"}
              >{status === "paused"
                  ? isEnglish ? "Resume" : "이어하기"
                  : isEnglish ? "Pause" : "일시정지"}</button>
              <button className="stop-button" type="button" onClick={stopLecture} disabled={status === "connecting"}>
                {isEnglish ? "End lecture" : "강의 종료"}
              </button>
            </div>
          ) : (
            <div className="lecture-controls">
              {/* UPL-01. A lecture already recorded on a phone takes the same
                  path as a live one; it just arrives all at once. */}
              <label className="audio-upload-button">
                <input
                  type="file"
                  accept=".mp3,.m4a,.wav,.webm,.mp4,audio/*"
                  disabled={audioBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadLectureAudio(file);
                  }}
                />
                {audioBusy
                  ? isEnglish ? "Transcribing…" : "변환 중…"
                  : isEnglish ? "Upload recording" : "녹음 파일"}
              </label>
              {status === "ended" && activeSessionId && (
                <button className="note-button" type="button" onClick={() => setNoteOpen(true)}>
                  <span aria-hidden="true">✦</span>
                  {isEnglish ? "Lecture note" : "강의 노트"}
                </button>
              )}
              {status !== "ended" && (
                <button className="start-button" type="button" onClick={startLecture} disabled={!canStart}>
                  {isEnglish ? "Start lecture" : "강의 시작"}
                </button>
              )}
            </div>
          )}
        </header>

        {noteOpen && activeSessionId && (
          <LectureNotePanel sessionId={activeSessionId} isEnglish={isEnglish} onClose={() => setNoteOpen(false)} />
        )}

        {/* 사이드바 팝오버는 좁아서 잘렸다. 설정은 화면 가운데 모달로 연다. */}
        {editingClassroomId && (
          <div className="note-overlay" role="dialog" aria-modal="true" aria-label={isEnglish ? "Classroom settings" : "강의실 설정"}>
            <div className="note-panel classroom-edit-panel">
              <header className="note-topbar">
                <strong>{isEnglish ? "Classroom settings" : "강의실 설정"}</strong>
                <button type="button" className="banner-dismiss" onClick={() => setEditingClassroomId("")} aria-label={isEnglish ? "Close" : "닫기"}>✕</button>
              </header>
              <form className="classroom-edit-form" onSubmit={updateClassroom}>
                <label>
                  <span>{isEnglish ? "Classroom name" : "강의실 이름"}</span>
                  <input value={editingClassroomTitle} onChange={(event) => setEditingClassroomTitle(event.target.value)} maxLength={80} autoFocus />
                </label>
                <label>
                  <span>{isEnglish ? "Technical terms" : "전문용어"}</span>
                  <textarea
                    value={editingGlossary}
                    onChange={(event) => setEditingGlossary(event.target.value)}
                    maxLength={1_200}
                    rows={5}
                    placeholder={isEnglish ? "e.g. duration, coupon rate, YTM" : "예: 듀레이션, 표면금리, 만기수익률"}
                  />
                  <small>{isEnglish
                    ? "Comma-separated. Helps the transcript spell these words correctly."
                    : "쉼표로 구분합니다. 받아쓰기가 이 단어들을 정확히 적는 데 쓰여요."}</small>
                </label>
                <footer>
                  <button type="button" className="classroom-edit-cancel" onClick={() => setEditingClassroomId("")}>
                    {isEnglish ? "Cancel" : "취소"}
                  </button>
                  <button type="submit" disabled={classroomPending || !editingClassroomTitle.trim()}>
                    {classroomPending ? (isEnglish ? "Saving…" : "저장 중…") : (isEnglish ? "Save" : "저장")}
                  </button>
                </footer>
              </form>
            </div>
          </div>
        )}

        <dialog
          ref={consentDialogRef}
          className="consent-modal"
          aria-label={isEnglish ? "Before your first recording" : "첫 녹음을 시작하기 전에"}
          onCancel={(event) => event.preventDefault()}
        >
          <div className="consent-gate">
            <p>{isEnglish
              ? "Before Lecue records for the first time, confirm both. Your answer is stored on your account with the date and the wording version."
              : "Lecue가 처음 녹음하기 전에 두 가지를 확인합니다. 확인한 문구의 버전과 시각이 계정에 기록됩니다."}</p>
            <label>
              <input autoFocus type="checkbox" checked={consentAge} onChange={(event) => setConsentAge(event.target.checked)} />
              {CONSENT_COPY.age_14[isEnglish ? "en" : "ko"]}
            </label>
            <label>
              <input type="checkbox" checked={consentRecording} onChange={(event) => setConsentRecording(event.target.checked)} />
              {CONSENT_COPY.recording[isEnglish ? "en" : "ko"]}
            </label>
            <span>
              <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
              <Link href={`${basePath}/terms`}>{isEnglish ? "Terms" : "이용약관"}</Link>
              <button
                type="button"
                onClick={() => void acceptConsentGate()}
                disabled={!consentAge || !consentRecording || consentPending}
              >{consentPending
                ? isEnglish ? "Saving…" : "저장 중…"
                : isEnglish ? "Agree and continue" : "동의하고 계속"}</button>
            </span>
          </div>
        </dialog>
        {/* HIS-03. window.confirm 대신 앱과 같은 모양의 확인 창. Esc·바깥 클릭은 취소. */}
        <dialog
          ref={deleteDialogRef}
          className="consent-modal confirm-modal"
          aria-label={isEnglish ? "Delete lecture" : "수업 삭제"}
          onClose={() => setDeletingSessionId("")}
        >
          <div className="consent-gate">
            <p>{isEnglish
              ? `Delete "${sessionsById.get(deletingSessionId)?.title ?? ""}"? Its transcript and questions are deleted with it. This cannot be undone.`
              : `"${sessionsById.get(deletingSessionId)?.title ?? ""}" 수업을 삭제할까요? 스크립트와 질문 기록도 함께 지워지며 되돌릴 수 없습니다.`}</p>
            <span>
              <button type="button" className="confirm-cancel" onClick={() => setDeletingSessionId("")}>
                {isEnglish ? "Cancel" : "취소"}
              </button>
              <button
                type="button"
                className="confirm-delete"
                onClick={() => {
                  const sessionId = deletingSessionId;
                  setDeletingSessionId("");
                  void deleteSession(sessionId);
                }}
              >{isEnglish ? "Delete lecture" : "수업 삭제"}</button>
            </span>
          </div>
        </dialog>
        <div className="error-banner" role="alert">{error && <>
          <span>{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError("")} aria-label={isEnglish ? "Dismiss" : "닫기"}>✕</button>
        </>}</div>
        <div className="notice-banner" role="status">{notice && <>
          <span>{notice}</span>
          <button type="button" className="banner-dismiss" onClick={() => setNotice("")} aria-label={isEnglish ? "Dismiss" : "닫기"}>✕</button>
        </>}</div>
        {/* 크레딧 0은 버튼만 죽는 게 아니라 이유와 다음 행동이 보여야 한다. */}
        {outOfCredits && status !== "recording" && status !== "paused" && (
          <div className="notice-banner">
            <span>{isEnglish
              ? "You are out of credits, so new recordings and questions are paused."
              : "크레딧을 모두 사용해 새 녹음과 질문이 잠시 멈춰 있습니다."}</span>
            <Link className="banner-action" href={`${basePath}/billing`}>{FREE_PILOT ? (isEnglish ? "See details" : "안내 보기") : (isEnglish ? "Get credits" : "크레딧 충전하기")}</Link>
          </div>
        )}

        <div className="mobile-pane-switch" aria-label={isEnglish ? "Workspace view" : "작업 화면 선택"}>
          <button type="button" aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>
            {isEnglish ? "Questions" : "질문"}
            <span>{messages.filter((message) => message.role === "user").length}</span>
          </button>
          <button type="button" aria-pressed={mobilePane === "transcript"} onClick={() => setMobilePane("transcript")}>
            {isEnglish ? "Transcript" : "스크립트"}
            <span>{sentenceCount}</span>
          </button>
        </div>

        <section className="panes">
          {restoring && (
            <div className="restore-veil" role="status">
              <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />
              <span>{isEnglish ? "Reopening your lecture…" : "보던 수업을 다시 여는 중…"}</span>
            </div>
          )}
          <section
            className={`chat-pane${mobilePane === "chat" ? " is-mobile-active" : ""}${materialDragOver ? " material-drop-active" : ""}`}
            aria-labelledby="chat-title"
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setMaterialDragOver(true);
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setMaterialDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setMaterialDragOver(false);
              const file = event.dataTransfer.files[0];
              if (file) void uploadMaterial(file);
            }}
          >
          {materialDragOver && (
            <div className="material-drop-overlay">
              {isEnglish ? "Drop a material into this lecture" : "자료를 이 수업에 놓으세요"}
            </div>
          )}
          <div className="pane-heading">
            <div>
              <h1 id="chat-title">{isEnglish ? "Ask about the lecture" : "강의에 질문하기"}</h1>
            </div>
            <div className="pane-heading-actions">
              <button type="button" className="catchup-button" disabled={!canAsk} onClick={askCatchup}>
                {isEnglish ? "I missed that" : "방금 놓쳤어요"}
              </button>
              <span className="count">{messages.filter((message) => message.role === "user").length}{isEnglish ? " questions" : "개 질문"}</span>
            </div>
          </div>

          {/* Likewise: announce the newest answer, not the whole thread. */}
          <p className="sr-only" aria-live="polite">
            {messages.at(-1)?.role === "assistant" && !messages.at(-1)?.pending ? messages.at(-1)!.text : ""}
          </p>

          <div
            className="messages"
            ref={messagesScrollRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              messagesFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>{isEnglish ? "Ask as soon as the lecture starts." : "강의가 시작되면 바로 물어보세요."}</p>
                <span>{isEnglish
                  ? "You can ask ‘What did CIB mean just now?’ and get an answer grounded in the lecture flow."
                  : "“방금 말한 CIB가 뭐야?”처럼 질문해도 강의 흐름을 기준으로 답합니다."}</span>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`} aria-busy={message.pending || undefined}>
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
                      {message.materialSources.map((source) => (
                        <span className="material-source" key={`${source.documentId}-${source.startPage}`}>
                          {source.filename} p.{source.startPage}
                          {source.endPage !== source.startPage ? `-${source.endPage}` : ""}
                        </span>
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
                // 한글 조합 중의 Enter는 글자 확정이지 전송이 아니다.
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={!creditsAllowAsk
                ? isEnglish ? "Add credits to keep asking" : "크레딧을 충전하면 질문할 수 있습니다"
                : hasTranscript
                  ? isEnglish ? "Ask about this lecture" : "이 강의에 대해 질문하세요"
                  : isEnglish ? "You can ask once the transcript begins" : "스크립트가 들어오면 질문할 수 있습니다"}
              maxLength={1_000}
              // 답변을 기다리는 동안에도 다음 질문은 미리 쓸 수 있다. 전송만 막는다.
              disabled={!hasTranscript || !creditsAllowAsk}
              rows={1}
            />
            <button type="submit" disabled={!canAsk || !question.trim()} aria-label={isEnglish ? "Send question" : "질문 보내기"}>
              ↑
            </button>
          </form>
          </section>

          <section className={`transcript-pane${mobilePane === "transcript" ? " is-mobile-active" : ""}`} aria-labelledby="transcript-title">
          <div className="pane-heading transcript-heading">
            <div>
              <h2 id="transcript-title">{isEnglish ? "Live transcript" : "실시간 스크립트"}</h2>
            </div>
            <span className="count">{sentenceCount}{isEnglish ? " sentences" : "개 문장"}</span>
          </div>

          <div className="material-toolbar">
            <div>
              <strong>{isEnglish ? "Lecture materials" : "강의 자료"}</strong>
              <span>{isEnglish ? `${materials.length} materials · also improves term recognition` : `자료 ${materials.length}개 · 전문용어 인식에도 반영`}</span>
            </div>
            <label className={`material-upload-button${materialPending ? " is-pending" : ""}`} aria-busy={materialPending}>
              <input
                type="file"
                accept=".pdf,.docx,.pptx,.txt,.csv,.tsv,.xlsx,.xls"
                disabled={materialPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadMaterial(file);
                }}
              />
              {materialPending && <span className="material-upload-spinner" aria-hidden="true" />}
              {materialPending ? (isEnglish ? "Reading…" : "읽는 중…") : (isEnglish ? "Add material" : "자료 추가")}
            </label>
            {materials.length > 0 && (
              <details className="material-list">
                <summary>{isEnglish ? "Manage" : "관리"}</summary>
                <ul>
                  {materials.map((document) => (
                    <li key={document.id}>
                      <span>{document.filename}</span>
                      <small>{document.page_count}{isPdfMaterial(document) ? (isEnglish ? " pages" : "쪽") : (isEnglish ? " sections" : "개 구간")}</small>
                      <button type="button" disabled={materialPending} onClick={() => void deleteMaterial(document.id)}>
                        {isEnglish ? "Remove" : "삭제"}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {activeSessionId && materials.length === 0 && (
            <p className="material-hint">{isEnglish
              ? "Add material to this lecture and answers will use it too."
              : "이 수업에 강의 자료를 올리면 답변에 반영합니다."}</p>
          )}

          {/* The live region is the newest line only. On the scrollback
              container a screen reader re-read the entire lecture every time a
              segment arrived, roughly every five seconds. */}
          <p className="sr-only" aria-live="polite">
            {interim || transcriptParagraphs.at(-1)?.text || ""}
          </p>

          <div
            className="transcript"
            ref={transcriptScrollRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              transcriptFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            {segments.length === 0 && !interim ? (
              <div className="empty-transcript">
                <p>{status === "connecting"
                  ? isEnglish ? "Connecting to the microphone" : "마이크와 연결하는 중입니다"
                  : isEnglish ? "Speech will appear here once you start the lecture" : "강의를 시작하면 말이 이곳에 쌓입니다"}</p>
                <span>{isEnglish
                  ? "Place your laptop near the speaker for better recognition."
                  : "노트북을 강사와 가까운 곳에 두면 인식률이 좋아집니다."}</span>
                {/* 이 화면의 유일한 할 일이 우상단 구석에만 있으면 멀다.
                    빈 화면 한가운데에서도 바로 시작할 수 있게 한다. */}
                {status === "idle" && canStart && (
                  <button type="button" className="start-button empty-start-button" onClick={startLecture}>
                    {isEnglish ? "Start lecture" : "강의 시작"}
                  </button>
                )}
              </div>
            ) : (
              <div className="transcript-copy">
                {transcriptParagraphs.map((paragraph) => {
                  const key = `${paragraph.startMs}-${paragraph.endMs}`;
                  const reported = reportedKeys.includes(`stt:${key}`);
                  return (
                    <div className="transcript-line" key={key}>
                      <time dateTime={`PT${Math.floor(paragraph.startMs / 1000)}S`}>{formatTime(paragraph.startMs)}</time>
                      <p>{paragraph.text}</p>
                      <div className="transcript-line-actions">
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
                    </div>
                  );
                })}
                {interim && <p className="interim-line">{interim}</p>}
              </div>
            )}
          </div>
          </section>
        </section>

        <footer className="footnote">
          <span>{isEnglish ? "AI transcription · errors may occur" : "AI 자동 변환 · 오류가 있을 수 있습니다"}</span>
          <span className="footnote-links">
            <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
            <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
            <Link href={`${basePath}/policy`}>{isEnglish ? "Classroom use policy" : "강의 사용 정책"}</Link>
            <span>{isEnglish ? "Confirm recording permission before use" : "현장 녹음 권한을 확인한 뒤 사용하세요"}</span>
          </span>
        </footer>
      </div>
    </main>
  );
}
