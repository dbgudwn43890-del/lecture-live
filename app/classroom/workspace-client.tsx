"use client";

import { CSSProperties, FormEvent, ReactNode, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, ChevronLeft, ChevronRight, CreditCard, LogOut, Mic, MonitorPlay, MoreHorizontal, MoreVertical, PanelLeft, Paperclip, Plus, Search, Settings2, Smartphone, Upload, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import WorkspaceDialog from "./workspace-dialog";
import ListeningIndicator from "./listening-indicator";
import MicrophoneSwitch from "./microphone-switch";
import type { DesktopPhoneMic } from "../lib/phone-mic-client";
import LanguageChoices from "./language-choices";
import CreditUsage, { type UsageStatus } from "../credit-usage";
import { initialSpeechLanguage, lectureLanguageChoices } from "../lib/lecture-language-ui";
import { isSpeechLanguage } from "../lib/speech-languages";
import LecturePreview from "./lecture-preview";
import { trackAnalytics } from "../lib/analytics-client";
import { useOnlineLayout } from "./use-online-layout";
import { useConversationScroll } from "./use-conversation-scroll";
import { audioUploadKey, createTitleSaveQueue, hasReadyMaterials, preparationTitle } from "./lecture-preparation";
import type { AudioUploadAvailability } from "../lib/lecture-audio-availability";
import { useLectureNote } from "./use-lecture-note";
import { useNoteLanguage } from "./use-note-language";
import NoteLanguagePicker from "./note-language-picker";
import { useLiveAssist } from "./use-live-assist";
import { useLiveScript } from "./use-live-script";
import { buildLiveConversation, buildLiveMaterialRevision } from "../lib/live-assist-client";
import { NoteGenerationIcon } from "./note-generation";
import RecordingPreparation from "./recording-preparation";
import MaterialList, { type MaterialUploadState } from "./material-list";
import { AudioTransferError, transferRecording } from "./audio-transfer";
import type { AudioUploadTransfer } from "../lib/lecture-audio-transfer";
import { languageSwitchUrl } from "../lib/site-locale";
import { usePaymentReturn } from "../lib/use-payment-return";
import "./workspace.css";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";

// KaTeX·Mermaid를 노트를 열 때만 내려받는다. 평소 강의 화면 번들에서 제외.
const LectureNotePanel = dynamic(() => import("./lecture-note"), { ssr: false });
const PhoneMicDialog = dynamic(() => import("./phone-mic-dialog"), { ssr: false });
const LearningAnswer = dynamic(() => import("./learning-answer"), {
  loading: () => <span className="answer-loading" aria-hidden="true">…</span>,
});

/** 같은 폭의 선택지와 방향키 이동을 제공하는 설정 컨트롤. */
function SegmentedControl<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
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
      aria-label={label}
      style={{ "--seg-count": options.length, "--seg-index": index } as CSSProperties}
    >
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          tabIndex={value === option.id ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
              : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
            onChange(options[next].id);
            event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
          }}
        >{option.label}</button>
      ))}
    </div>
  );
}

import { mergeListedSession, patchListedSession } from "../lib/classroom-session-list";
import { cleanAnswerMarkdown, cleanSources } from "../lib/answer-format";
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
type MaterialDocument = { id: string; classroom_id: string | null; session_id: string; filename: string; page_count: number; created_at?: string };
type Classroom = { id: string; title: string; locale: "ko" | "en"; glossary?: string; sessions: SessionSummary[] };
type AudioUpload = {
  id: string;
  session_id: string;
  status: "uploading" | "queued" | "processing" | "completed" | "failed" | "deleted";
  filename: string;
  error_code?: string | null;
  created_at?: string;
};
type UserProfile = { displayName: string; email: string };
type AiProvider = "lecture-live" | PersonalProvider;
type SavedCredential = { provider: PersonalProvider; model: string; updated_at: string };
type CreditStatus = UsageStatus & { credits: number; nextExpiry: string | null; latestGrantAt: string | null; subscriptionStatus: string | null; trialUsed: boolean; planCode: string | null; nextGrantAt?: string | null; nextGrantCredits?: number };
type Message = {
  id: string;
  kind?: "live-assist";
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sources?: Source[];
  lectureSources?: LectureSource[];
  materialSources?: MaterialSource[];
  assistantLabel?: string;
  questionAtMs?: number;
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

function positionSessionMenu(details: HTMLDetailsElement) {
  const panel = details.querySelector<HTMLElement>(".session-menu-panel");
  if (!details.open || !panel) return;
  const rect = details.querySelector("summary")!.getBoundingClientRect();
  panel.style.maxHeight = `${window.innerHeight - 16}px`;
  const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - panel.offsetHeight - 8));
  panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${window.innerHeight - top - 8}px`;
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

export default function LectureWorkspace({ locale = "ko", region = locale === "ko" ? "kr" : "global", initial, restoreSessionId, liveAssistAvailable = false }: { locale?: "ko" | "en"; region?: "kr" | "global"; initial?: InitialData; restoreSessionId?: string; liveAssistAvailable?: boolean }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const statusCopy: Record<Status, string> = isEnglish
    ? { idle: "Not started", connecting: "Connecting", recording: "Recording", paused: "Paused", ended: "Ended", error: "Check connection" }
    : { idle: "시작 전", connecting: "연결 중", recording: "기록 중", paused: "일시정지", ended: "종료됨", error: "연결 확인 필요" };
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [questionFocused, setQuestionFocused] = useState(false);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  // 시간대 인사·질문 예시는 클라이언트 시계 기준이라 마운트 후에 채운다(SSR 불일치 방지).
  const [askHint, setAskHint] = useState("");
  useEffect(() => {
    const hour = new Date().getHours();
    const slot = hour < 5 ? 3 : hour < 11 ? 0 : hour < 17 ? 1 : hour < 22 ? 2 : 3;
    setAskHint((isEnglish
      ? ["e.g. Explain that with an example", "e.g. How might this show up on the exam?", "e.g. Summarize the key points so far", "e.g. What did that term mean?"]
      : ["예: 방금 내용 예시 들어서 설명해줘", "예: 이 개념 시험에 어떻게 나올까?", "예: 지금까지 핵심만 요약해줘", "예: 방금 그 용어 무슨 뜻이야?"])[slot]);
  }, [isEnglish]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [displayLocale, setDisplayLocale] = useState<"ko" | "en">(locale);
  const localeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [onlineAspectRatio, setOnlineAspectRatio] = useState(16 / 9);
  // null until the first check answers; the gate never flashes on a returning
  // account that already agreed.
  const [consentSatisfied, setConsentSatisfied] = useState<boolean | null>(null);
  const [consentGate, setConsentGate] = useState(false);
  const [consentAge, setConsentAge] = useState(false);
  const [consentRecording, setConsentRecording] = useState(false);
  const [consentPending, setConsentPending] = useState(false);
  const [consentAction, setConsentAction] = useState<"microphone" | "browser-tab" | "phone" | "upload" | null>(null);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const phonePairRef = useRef<DesktopPhoneMic | null>(null);
  const phoneResumeRef = useRef(false);
  const phoneSwitchRef = useRef(false);
  const phonePauseRef = useRef<() => void>(() => {});
  const phonePause = useMemo(() => () => phonePauseRef.current(), []);
  const consentSaveRef = useRef<Promise<void> | null>(null);
  const consentAbortRef = useRef<AbortController | null>(null);
  const consentConfirmedRef = useRef(false);
  const audioUploadInputRef = useRef<HTMLInputElement | null>(null);
  const microphoneCheckStopRef = useRef<() => void>(() => {});
  const [lectureTitle, setLectureTitleState] = useState("");
  const lectureTitleRef = useRef("");
  const [titleSaveStatus, setTitleSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const titleSaveQueueRef = useRef(createTitleSaveQueue());
  const titleNavigationRef = useRef(false);
  const [titleNavigationPending, setTitleNavigationPending] = useState(false);
  function setLectureTitle(title: string) {
    lectureTitleRef.current = title;
    setLectureTitleState(title);
  }
  const [aiProvider, setAiProvider] = useState<AiProvider>("lecture-live");
  const [aiModel, setAiModel] = useState<string>(personalModelOptions.openai[0].id);
  const [speechLanguage, setSpeechLanguage] = useState<DeepgramLanguage>(() => initialSpeechLanguage(null, region));
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("");
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
  const [credentialPending, setCredentialPending] = useState(false);
  const [classroomLists, setClassroomLists] = useState({
    classrooms: initial?.classrooms ?? [] as Classroom[],
    unassignedSessions: initial?.unassignedSessions ?? [] as SessionSummary[],
  });
  const { classrooms, unassignedSessions } = classroomLists;
  function setClassrooms(value: SetStateAction<Classroom[]>) {
    setClassroomLists((current) => ({ ...current, classrooms: typeof value === "function" ? value(current.classrooms) : value }));
  }
  function setUnassignedSessions(value: SetStateAction<SessionSummary[]>) {
    setClassroomLists((current) => ({ ...current, unassignedSessions: typeof value === "function" ? value(current.unassignedSessions) : value }));
  }
  const [activeClassroomId, setActiveClassroomId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [remoteRecording, setRemoteRecording] = useState(false);
  const classroomRevisionRef = useRef(0);
  const classroomLoadRef = useRef(0);
  // Opt-in for this browser session only. API authorization is checked separately.
  const [liveAssistEnabled, setLiveAssistEnabled] = useState(false);
  const [classroomPending, setClassroomPending] = useState(false);
  const [newClassroomTitle, setNewClassroomTitle] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [classroomCreateError, setClassroomCreateError] = useState("");
  const classroomCreateToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [editingClassroomId, setEditingClassroomId] = useState("");
  const [editingClassroomTitle, setEditingClassroomTitle] = useState("");
  const [editingGlossary, setEditingGlossary] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(initial?.profile ?? null);
  const [creditStatus, setCreditStatus] = useState<CreditStatus | null>(initial?.creditStatus ?? null);
  usePaymentReturn(locale, loadCredits, setNotice);
  const [reportedKeys, setReportedKeys] = useState<string[]>([]);
  const [materials, setMaterials] = useState<MaterialDocument[]>([]);
  const [materialPending, setMaterialPending] = useState(false);
  const [materialUploadState, setMaterialUploadState] = useState<MaterialUploadState>();
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const audioTransferRef = useRef<AbortController | null>(null);
  const audioRequestPendingRef = useRef(false);
  useEffect(() => () => audioTransferRef.current?.abort(), []);
  // UPL-03. The upload being watched right now, if any.
  const [audioUpload, setAudioUpload] = useState<AudioUpload | null>(null);
  const [audioAvailability, setAudioAvailability] = useState<AudioUploadAvailability | null>(null);
  const [audioAvailabilityChecking, setAudioAvailabilityChecking] = useState(true);
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
    clearMessages: () => { if (status !== "idle" || !activeSessionId) setMessages([]); },
    setActiveSessionId,
    setLectureTitle: (serverTitle) => {
      // Starting a draft may return its older persisted title. Keep edits made
      // while microphone permission or the session request was in flight.
      const current = lectureTitleRef.current.trim();
      if (!current) setLectureTitle(serverTitle);
      else if (current !== serverTitle) void renameSession(activeSessionIdRef.current, current);
    },
    onCredits: (credits) => setCreditStatus((current) => (current ? { ...current, credits } : current)),
    loadClassrooms,
    onSessionSaved: upsertListedSession,
    loadCredits: async () => { await loadCredits(); },
  });
  const {
    status, setStatus, elapsedMs, setElapsedMs, segments, setSegments, interim, showInterim,
    connectingPhase, pauseReason, inputSource, phoneInput, restoreInputSource, previewStream, waitingForAudio, isFinalizing, isPausing,
    isSwitchingMicrophone, switchMicrophone, isCurrentPhoneSource,
    meterRef, segmentsRef, segmentIdsRef, confirmedSegmentIdsRef, activeSessionIdRef,
    finishingRef, saveFailuresRef, elapsedBaseMsRef, startedAtRef, streamOffsetMsRef,
    flushUtterance, startLecture, pauseLecture, resumeLecture, finishLecture, stopLecture,
  } = recorder;
  // Final speech is condensed independently of capture and the Jarvis popover.
  const liveScript = useLiveScript({ sessionId: activeSessionId, segments, status, locale });
  phonePauseRef.current = () => { if (status === "recording" && phoneInput && !isSwitchingMicrophone) void pauseLecture(); };
  useEffect(() => {
    if (!phonePairRef.current || !phoneInput) return;
    phonePairRef.current.status(status, elapsedMs);
    // The capability is never persisted here. A reload asks for a new QR,
    // rather than silently switching the lecture to the laptop microphone.
    if (activeSessionId && ["connecting", "recording", "paused"].includes(status)) {
      try { sessionStorage.setItem(`lecue-phone-session:${activeSessionId}`, "1"); } catch { /* session-only hint */ }
    }
  }, [phoneInput, status, elapsedMs, activeSessionId]);
  useEffect(() => {
    if (status !== "ended" || !activeSessionId) return;
    try { sessionStorage.removeItem(`lecue-phone-session:${activeSessionId}`); } catch { /* best effort */ }
  }, [status, activeSessionId]);
  useEffect(() => () => { phonePairRef.current?.dispose(); }, []);
  const liveConversation = useMemo(() => buildLiveConversation(messages), [messages]);
  const liveMaterialRevision = useMemo(() => buildLiveMaterialRevision(materials, activeSessionId), [materials, activeSessionId]);
  const manualQuestionPending = messages.some((message) => message.pending && message.kind !== "live-assist");
  const liveAssist = useLiveAssist({
    enabled: liveAssistAvailable && liveAssistEnabled,
    sessionId: activeSessionId, status, segments, interim, locale, elapsedMs,
    conversation: liveConversation, materialRevision: liveMaterialRevision, manualQuestionPending,
  });
  useEffect(() => {
    const answers = liveAssist.answers.filter((answer) => answer.sessionId === activeSessionId);
    setMessages((current) => {
      let changed = false;
      const next = current.flatMap((message) => {
        if (message.kind !== "live-assist" || !message.pending || answers.some((answer) => answer.id === message.id)) return [message];
        changed = true;
        return message.text ? [{ ...message, pending: false }] : [];
      });
      for (const answer of answers) {
        const index = next.findIndex((message) => message.id === answer.id);
        const previous = index < 0 ? null : next[index];
        if (previous?.text === answer.text && previous.pending === answer.pending) continue;
        const message: Message = {
          id: answer.id, role: "assistant", kind: "live-assist",
          text: answer.text, pending: answer.pending,
          assistantLabel: isEnglish ? "Live assist · AI" : "실시간 답변 · AI",
        };
        if (index < 0) next.push(message);
        else next[index] = message;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [liveAssist.answers, activeSessionId, isEnglish]);
  const onlineLecture = inputSource === "browser-tab";
  const onlineViewing = onlineLecture && ["connecting", "recording", "paused"].includes(status);
  const onlineLayout = useOnlineLayout(onlineViewing, onlineAspectRatio);
  const sidebarBeforeOnline = useRef<boolean | null>(null);
  useEffect(() => {
    if (onlineViewing && sidebarBeforeOnline.current === null) {
      sidebarBeforeOnline.current = sidebarCollapsed;
      setSidebarCollapsed(true);
    } else if (!onlineViewing && sidebarBeforeOnline.current !== null) {
      setSidebarCollapsed(sidebarBeforeOnline.current);
      sidebarBeforeOnline.current = null;
    }
  }, [onlineViewing, sidebarCollapsed]);
  useEffect(() => {
    const input = questionInputRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "40px";
      if (input.value) input.style.height = `${Math.min(144, Math.max(40, input.scrollHeight))}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [question]);
  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem("lecue-sidebar-collapsed") === "true");
    return () => { if (localeTimerRef.current) clearTimeout(localeTimerRef.current); };
  }, []);
  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    window.localStorage.setItem("lecue-sidebar-collapsed", String(collapsed));
  }
  function changeDisplayLocale(next: "ko" | "en") {
    if (next === displayLocale) return;
    if (localeTimerRef.current) clearTimeout(localeTimerRef.current);
    setDisplayLocale(next);
    if (next === locale) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240;
    localeTimerRef.current = setTimeout(() => window.location.assign(languageSwitchUrl(window.location.href, next)), delay);
  }
  // 온라인 시작만 배포 설정으로 끌 수 있다. 기존 세션 열기·현장 강의는 막지 않는다.
  const onlineLectureEnabled = process.env.NEXT_PUBLIC_ONLINE_LECTURE !== "off";
  // 온라인 강의는 준비/기록 상태 문구가 다르다. 처음부터 "소리가 들린다"고 말하지 않는다.
  const statusLabel = remoteRecording ? (isEnglish ? "Recording connection in use" : "녹음 연결 사용 중") : isSwitchingMicrophone ? (isEnglish ? "Switching microphone…" : "마이크 전환 중…") : isPausing ? (isEnglish ? "Paused" : "일시정지") : isFinalizing ? (isEnglish ? "Saving…" : "저장 중…") : onlineLecture
    ? status === "connecting"
      ? connectingPhase === "selecting"
        ? (isEnglish ? "Choose your lecture tab" : "강의 탭을 선택해 주세요")
        : (isEnglish ? "Connecting your lecture audio…" : "강의 소리를 연결하고 있어요…")
      : status === "recording" ? (isEnglish ? "Online lecture · Recording" : "온라인 강의 · 기록 중")
      : statusCopy[status]
    : phoneInput && status === "recording" ? (isEnglish ? "Phone mic · Recording" : "휴대폰 마이크 · 기록 중") : statusCopy[status];
  const resumeLabel = pauseReason === "capture-ended" && onlineLecture
    ? (isEnglish ? "Choose lecture tab" : "강의 다시 선택")
    : onlineLecture ? (isEnglish ? "Resume" : "이어 듣기") : (isEnglish ? "Resume" : "이어하기");

  function requestLectureStart(source: "microphone" | "browser-tab") {
    if (consentSaveRef.current || titleNavigationRef.current || !canStart || materialPending) return;
    microphoneCheckStopRef.current();
    if (consentSatisfied !== true) { openConsentGate(source); return; }
    // Open the picker in the click's activation, without a network wait first.
    void startLecture(source);
  }

  function requestPhoneStart(resume = false, switchInput = false) {
    if (consentSaveRef.current || titleNavigationRef.current || (!resume && !switchInput && (!canStart || materialPending))) return;
    microphoneCheckStopRef.current();
    phoneResumeRef.current = resume;
    phoneSwitchRef.current = switchInput;
    if (consentSatisfied !== true) { openConsentGate("phone"); return; }
    setPhoneDialogOpen(true);
  }

  async function acceptPhone(controller: DesktopPhoneMic) {
    if (phoneSwitchRef.current) {
      phoneSwitchRef.current = false;
      setPhoneDialogOpen(false);
      const previous = phonePairRef.current;
      const sessionId = activeSessionIdRef.current;
      const resumed = await switchMicrophone("phone", controller.source);
      if (isCurrentPhoneSource(controller.source)) {
        phonePairRef.current = controller;
        if (previous !== controller) previous?.dispose();
        controller.status(resumed ? "recording" : "paused", elapsedMs);
        try { sessionStorage.setItem(`lecue-phone-session:${sessionId}`, "1"); } catch { /* no capability persisted */ }
      } else controller.dispose();
      return;
    }
    phonePairRef.current?.dispose();
    phonePairRef.current = controller;
    setPhoneDialogOpen(false);
    if (phoneResumeRef.current) void resumeLecture(controller.source);
    else void startLecture("microphone", undefined, controller.source);
  }

  function requestResume() {
    if (remoteRecording || isSwitchingMicrophone) return;
    let usedPhone = phoneInput;
    try { usedPhone ||= sessionStorage.getItem(`lecue-phone-session:${activeSessionId}`) === "1"; } catch { /* current state remains authoritative */ }
    if (usedPhone && !phonePairRef.current?.source.isLive()) { requestPhoneStart(true); return; }
    void resumeLecture(usedPhone ? phonePairRef.current?.source : undefined);
  }

  async function changeMicrophone(target: "computer" | "phone") {
    if (remoteRecording || isSwitchingMicrophone || isFinalizing || inputSource !== "microphone") return;
    if (target === "phone") { requestPhoneStart(true, true); return; }
    const previous = phonePairRef.current;
    await switchMicrophone("computer");
    if (!previous || !isCurrentPhoneSource(previous.source)) {
      previous?.dispose();
      phonePairRef.current = null;
      try { sessionStorage.removeItem(`lecue-phone-session:${activeSessionId}`); } catch { /* optional restoration hint */ }
    }
  }

  function openConsentGate(action: "microphone" | "browser-tab" | "phone" | "upload") {
    setConsentAction(action);
    setError("");
    setNotice("");
    setConsentGate(true);
  }

  function dismissConsentGate() {
    if (consentSaveRef.current) return;
    setConsentAction(null);
    setConsentGate(false);
    setError("");
  }

  /** 두 시작 동작. 동의한 계정은 클릭이 곧 시작이다. */
  function renderStartButtons(disabled: boolean, className = "", icons = false) {
    return (
      <div className={`start-choice${className ? ` ${className}` : ""}`}>
        <button type="button" className="start-button" onClick={() => requestLectureStart("microphone")} disabled={disabled || consentPending}>
          {icons && <Mic size={17} aria-hidden="true" />}{status === "connecting" && inputSource === "microphone" ? (isEnglish ? "Connecting…" : "연결 중…") : (isEnglish ? "In-person lecture" : "현장 강의 듣기")}
        </button>
        {onlineLectureEnabled && (
          <button type="button" className="start-button start-online" onClick={() => requestLectureStart("browser-tab")} disabled={disabled || consentPending}>
            {icons && <MonitorPlay size={17} aria-hidden="true" />}{isEnglish ? "Online lecture" : "온라인 강의 듣기"}
          </button>
        )}
        <button type="button" className="phone-mic-choice" onClick={() => requestPhoneStart()} disabled={disabled || consentPending}>
          <Smartphone size={16} aria-hidden="true" />{isEnglish ? "Use phone as microphone" : "휴대폰을 마이크로 사용"}
        </button>
      </div>
    );
  }
  const onlineHint = isEnglish ? "Choose your lecture tab to start." : "강의가 재생되는 탭을 선택하면 바로 시작해요.";

  const sessionsById = useMemo(
    () => new Map([...unassignedSessions, ...classrooms.flatMap((classroom) => classroom.sessions)].map((session) => [session.id, session])),
    [unassignedSessions, classrooms],
  );

  const { messagesScrollRef, isFollowingLatest, jumpToLatest } = useConversationScroll(messages, activeSessionId);
  const initialRouteRef = useRef(false);
  const consentDialogRef = useRef<HTMLDialogElement | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("lecue-speech-language");
    // Keep saved choices across regions; only first-time defaults depend on location.
    const language = initialSpeechLanguage(saved, region);
    setSpeechLanguage(language);
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

  // Once the session has finished saving, its last (possibly short) section can
  // be summarized too. Opening the flow itself never starts a model request.
  useEffect(() => {
    if (status === "ended" && !isFinalizing && activeSessionId) void foldSummaries(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isFinalizing, activeSessionId]);

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

  async function checkAudioAvailability() {
    setAudioAvailabilityChecking(true);
    try {
      const response = await fetch("/api/lecture-audio", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      if (!response.ok) { setAudioAvailability(null); return null; }
      const data = await response.json() as { uploads?: AudioUpload[]; availability?: AudioUploadAvailability };
      setAudioAvailability(data.availability ?? null);
      return data;
    } catch {
      setAudioAvailability(null);
      return null;
    } finally {
      setAudioAvailabilityChecking(false);
    }
  }

  // "떠나도 된다"고 안내한 업로드의 뒷일: 탭을 닫았다 돌아와도 진행 중이면
  // 폴링을 다시 붙이고, 최근 실패는 여기서라도 알려준다.
  useEffect(() => {
    void (async () => {
      try {
        const data = await checkAudioAvailability();
        if (!data) return;
        const rows = data.uploads ?? [];
        const inFlight = rows.find((row) => row.status === "processing" || row.status === "queued");
        if (inFlight) {
          setAudioUpload(inFlight);
          return;
        }
        const recentFailed = rows.find((row) => row.status === "failed"
          && row.created_at && Date.now() - new Date(row.created_at).getTime() < 86_400_000);
        if (recentFailed) {
          setError(isEnglish
            ? `The recording "${recentFailed.filename}" could not be transcribed. Try uploading it again.`
            : `녹음 파일 "${recentFailed.filename}"을 옮기지 못했습니다. 다시 올려 주세요.`);
        }
      } catch { /* 다음 방문에 다시 확인한다 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setMaterials([]);
    if (!activeSessionId) {
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
          // Do not erase an upload that finished after this GET started.
          setMaterials((current) => [...new Map([...documents, ...current.filter((item) => item.session_id === activeSessionId)].map((item) => [item.id, item])).values()]);
        }
      } catch {
        // 자료 유무 확인 실패는 강의 진행을 막지 않는다.
      }
    })();
    return () => { cancelled = true; };
  }, [activeSessionId, locale]);

  // This optional metadata check catches long recordings early. The server
  // measures the actual audio before reserving credits or transcribing it.
  async function readDurationMs(file: File): Promise<number> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("audio");
      probe.preload = "metadata";
      let settled = false;
      const done = (value: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        probe.onloadedmetadata = null;
        probe.onerror = null;
        URL.revokeObjectURL(url);
        resolve(value);
      };
      const timeout = setTimeout(() => done(0), 5_000);
      probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? Math.round(probe.duration * 1_000) : 0);
      // A container the browser cannot read is not necessarily one Deepgram
      // cannot: send 0 and let the server decide.
      probe.onerror = () => done(0);
      probe.src = url;
    });
  }

  async function uploadLectureAudio(file: File, consentReady = consentSaveRef.current) {
    if (!audioAvailability?.available || audioAvailabilityChecking) return;
    if (consentReady) {
      try { await consentReady; } catch { return; }
    }
    if (finishingRef.current) return;
    if (consentSatisfied !== true && !consentConfirmedRef.current) { openConsentGate("upload"); return; }
    if (audioBusy || audioRequestPendingRef.current) return;
    if (file.size > audioAvailability.maxFileBytes) {
      setError(isEnglish ? `Choose a recording up to ${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))} MB.` : `${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))}MB 이하의 녹음 파일을 선택해 주세요.`);
      return;
    }
    audioRequestPendingRef.current = true;
    setError("");
    setNotice(isEnglish ? "Uploading the recording…" : "녹음 파일을 올리는 중입니다…");
    setAudioUpload({ id: "", session_id: "", status: "uploading", filename: file.name });
    try {
      const durationMs = await readDurationMs(file);
      if (durationMs > MAX_LECTURE_MS) throw new Error(isEnglish ? "A lecture can be up to 3 hours long." : "한 수업은 최대 3시간까지 변환할 수 있습니다.");
      const control = async (body: object) => {
        const response = await fetch("/api/lecture-audio", { method: "POST", headers: { "Content-Type": "application/json", "X-Site-Locale": locale }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({})) as { upload?: AudioUpload; session?: SessionSummary; transfer?: AudioUploadTransfer; readyToComplete?: boolean; pending?: boolean; error?: string; code?: string };
        if (data.code === "AUDIO_UPLOAD_UNAVAILABLE") void checkAudioAvailability();
        if (!response.ok || !data.upload) throw new Error(data.error || (isEnglish ? "The recording upload failed. Try again shortly." : "녹음 파일 업로드에 실패했습니다. 잠시 뒤 다시 시도해 주세요."));
        return data;
      };
      let data = await control({ action: "prepare", filename: file.name, byteSize: file.size,
        title: lectureTitleRef.current.trim() || file.name.replace(/\.[^.]+$/, "").slice(0, 80) || (isEnglish ? "Uploaded lecture" : "올린 수업"),
        language: speechLanguage, classroomId: activeClassroomId || null, idempotencyKey: await audioUploadKey(file) });
      setAudioUpload({ ...data.upload!, filename: file.name });
      if (data.transfer) {
        const controller = new AbortController();
        audioTransferRef.current = controller;
        await transferRecording(file, data.transfer, percent => setNotice(isEnglish ? `Uploading the recording… ${percent}%` : `녹음 파일을 올리는 중입니다… ${percent}%`), controller.signal);
        audioTransferRef.current = null;
        setNotice(isEnglish ? "Checking the audio and preparing transcription…" : "오디오를 확인하고 받아쓰기를 준비하고 있어요…");
        data.readyToComplete = true;
      }
      if (data.readyToComplete) {
        const uploadId = data.upload!.id;
        const deadline = Date.now() + 10 * 60_000;
        do {
          data = await control({ action: "complete", uploadId });
          if (!data.pending) break;
          if (Date.now() >= deadline) throw new Error(isEnglish ? "Audio verification is taking longer than expected. Choose the same file to retry." : "오디오 확인이 예상보다 오래 걸립니다. 같은 파일을 다시 선택해 이어서 처리해 주세요.");
          await new Promise(resolve => setTimeout(resolve, 5_000));
        } while (data.pending);
      }
      setAudioUpload(data.upload!);
      setNotice(data.upload!.status === "completed" ? (isEnglish ? "This recording is already transcribed. Open it from your lecture list." : "이미 변환된 녹음 파일입니다. 수업 목록에서 열어 보세요.") : isEnglish
        ? "Transcribing. You can leave this page — the lecture appears in the sidebar when it is done."
        : "받아쓰는 중입니다. 이 화면을 떠나도 되며, 끝나면 왼쪽 목록에 수업이 나타납니다.");
      await loadClassrooms();
    } catch (caught) {
      setNotice("");
      setAudioUpload(null);
      setError(caught instanceof AudioTransferError ? caught.code === "expired"
        ? (isEnglish ? "Upload authorization expired. Choose the same file again to resume." : "업로드 인증 시간이 지났습니다. 같은 파일을 다시 선택해 이어서 올려 주세요.")
        : caught.code === "too_large" ? (isEnglish ? "This file exceeds the storage upload limit. Choose a smaller recording." : "저장소 업로드 한도를 넘었습니다. 더 작은 녹음 파일을 선택해 주세요.")
        : (isEnglish ? "The file transfer did not finish. Choose the same file to retry and resume." : "파일 전송을 완료하지 못했습니다. 같은 파일을 다시 선택해 이어서 올려 주세요.")
        : caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not upload this recording." : "녹음 파일을 올리지 못했습니다.");
    } finally {
      audioRequestPendingRef.current = false;
      audioTransferRef.current = null;
    }
  }

  async function uploadMaterial(file: File, replacingId?: string) {
    if (materialPending) return false;
    setMaterialPending(true);
    setMaterialsOpen(true);
    setMaterialUploadState({ filename: file.name, status: "pending", replacingId });
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
            title: preparationTitle(lectureTitleRef.current, isEnglish),
          }),
        });
        const data = await response.json() as { session?: SessionSummary; error?: string };
        if (!response.ok || !data.session) throw new Error(data.error);
        sessionId = data.session.id;
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        upsertListedSession(data.session);
        if (!lectureTitleRef.current.trim()) setLectureTitle(data.session.title);
        else if (lectureTitleRef.current.trim() !== data.session.title) await renameSession(sessionId, lectureTitleRef.current);
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
      if (activeSessionIdRef.current === sessionId) {
        setMaterials((current) => [data.document!, ...current.filter((item) => item.session_id === sessionId && item.id !== data.document!.id)]);
        setNotice(isEnglish ? "The material is ready. You can ask questions now." : "자료를 읽었습니다. 바로 질문할 수 있어요.");
      }
      if (replacingId) {
        let removed = false;
        try {
          const removal = await fetch(`/api/materials?documentId=${encodeURIComponent(replacingId)}`, { method: "DELETE", headers: { "X-Site-Locale": locale } });
          removed = removal.ok;
        } catch { /* The new document is already ready; retain both on a missed delete. */ }
        if (!removed) {
          setError(isEnglish ? "The new material is ready, but the previous file could not be removed. Both files are kept; remove the previous file when you are ready." : "새 자료는 읽었지만 이전 파일을 삭제하지 못했습니다. 두 파일 모두 유지했으니 이전 파일을 확인하고 삭제해 주세요.");
        } else if (activeSessionIdRef.current === sessionId) {
          setMaterials(current => current.filter(item => item.id !== replacingId));
          setNotice(isEnglish ? "The material has been replaced. Check the text preview." : "자료를 교체했습니다. 읽은 내용 미리보기로 확인해 보세요.");
        }
      }
      setMaterialUploadState(undefined);
      return true;
    } catch (caught) {
      setNotice("");
      const message = caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not upload this material." : "강의 자료를 올리지 못했습니다.";
      setError(message);
      setMaterialUploadState({ filename: file.name, status: "failed", error: message, replacingId });
      return false;
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
      return document.querySelectorAll<HTMLDetailsElement>("details.session-menu[open], details.session-submenu[open], details.profile-menu[open], details.material-list[open], details.conversation-materials[open]");
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
    function closeOnLayoutChange(event: Event) {
      const menus = document.querySelectorAll<HTMLDetailsElement>("details.session-menu[open]");
      if (event.type === "resize") {
        for (const menu of menus) positionSessionMenu(menu);
      } else if (event.target instanceof HTMLElement && event.target.matches(".sidebar-library")) {
        for (const menu of menus) menu.open = false;
      }
    }
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeOnLayoutChange, true);
    window.addEventListener("resize", closeOnLayoutChange);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeOnLayoutChange, true);
      window.removeEventListener("resize", closeOnLayoutChange);
    };
  }, []);

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
    if (!sessionId) return true;
    if (!title) {
      if (sessionId === activeSessionIdRef.current && lectureTitleRef.current === raw) setLectureTitle(stored ?? "");
      return true;
    }
    const isCurrentEdit = () => sessionId === activeSessionIdRef.current && lectureTitleRef.current.trim() === title;
    if (isCurrentEdit()) setTitleSaveStatus("saving");
    try {
      await titleSaveQueueRef.current(sessionId, title, async () => {
        const response = await fetch("/api/lecture-sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ action: "rename", sessionId, title }),
        });
        if (!response.ok) throw new Error("title-save-failed");
        classroomRevisionRef.current += 1;
        setClassroomLists((current) => patchListedSession(current, sessionId, { title }));
      });
      if (isCurrentEdit()) { setLectureTitle(title); setTitleSaveStatus("saved"); }
      return true;
    } catch {
      if (isCurrentEdit()) setTitleSaveStatus("error");
      setError(isEnglish ? "The lecture name was not saved. Your text is still here; try saving again." : "수업 이름을 저장하지 못했습니다. 입력한 이름은 유지했으니 다시 저장해 주세요.");
      return false;
    }
  }

  useEffect(() => {
    if (!activeSessionId || !lectureTitle.trim() || lectureTitle.trim() === sessionsById.get(activeSessionId)?.title) return;
    const timer = setTimeout(() => { void renameSession(activeSessionId, lectureTitle); }, 600);
    return () => clearTimeout(timer);
    // The editable draft and its lecture define this save, not sidebar refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, lectureTitle]);

  async function flushLectureTitle() {
    if (titleNavigationRef.current) return false;
    titleNavigationRef.current = true;
    setTitleNavigationPending(true);
    try {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return true;
      for (;;) {
        const title = lectureTitleRef.current;
        if (!(await renameSession(sessionId, title))) return false;
        if (lectureTitleRef.current.trim() === title.trim() || !title.trim()) return true;
      }
    } finally {
      titleNavigationRef.current = false;
      setTitleNavigationPending(false);
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
      classroomRevisionRef.current += 1;
      setClassroomLists((current) => patchListedSession(current, sessionId, { classroom_id: classroomId }));
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
    setError("");
    // 낙관적 삭제: 목록에서 먼저 지우고 서버 cascade는 뒤에서 돈다.
    // 긴 강의는 문장 수천 행을 지우느라 서버가 느려서, 기다리면 UI가 몇 초 얼었다.
    classroomRevisionRef.current += 1;
    setClassrooms((current) => current.map((classroom) => ({
      ...classroom,
      sessions: classroom.sessions.filter((item) => item.id !== sessionId),
    })));
    setUnassignedSessions((current) => current.filter((item) => item.id !== sessionId));
    if (sessionId === activeSessionIdRef.current) await prepareNewLecture(false);
    try {
      const response = await fetch(`/api/lecture-sessions?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "X-Site-Locale": locale },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not delete the lecture." : "수업을 삭제하지 못했습니다.");
      await loadClassrooms(); // 실패: 서버 상태로 복원
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
          lines.push(`Q. ${item.question}`, "", cleanAnswerMarkdown(item.answer), "");
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

  useEffect(() => {
    if (!profileMenuOpen) return;
    const controller = new AbortController();
    const refresh = () => {
      if (document.hidden) return;
      fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store", signal: controller.signal })
        .then(async response => { if (response.ok) setCreditStatus(await response.json()); })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileMenuOpen, creditStatus?.credits, locale]);

  async function loadCredits() {
    try {
      const response = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      if (!response.ok) return false;
      setCreditStatus(await response.json() as CreditStatus);
      return true;
    } catch {
      // The server enforces credits even when this display cannot refresh.
      return false;
    }
  }

  function upsertListedSession(session: Omit<SessionSummary, "question_count"> & { question_count?: number }) {
    classroomRevisionRef.current += 1;
    setClassroomLists((current) => mergeListedSession(current, session));
  }

  async function loadClassrooms(preferredId?: string) {
    const revision = classroomRevisionRef.current;
    const requestId = ++classroomLoadRef.current;
    try {
      const response = await fetch("/api/classrooms", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      const data = await response.json() as { classrooms?: Classroom[]; unassignedSessions?: SessionSummary[]; profile?: UserProfile; error?: string };
      if (!response.ok) throw new Error(data.error);
      // A slow refresh must not undo a successful edit or a newer response.
      if (revision !== classroomRevisionRef.current || requestId !== classroomLoadRef.current) return;
      const next = data.classrooms ?? [];
      setClassroomLists({ classrooms: next, unassignedSessions: data.unassignedSessions ?? [] });
      setProfile(data.profile ?? null);
      if (preferredId !== undefined) setActiveClassroomId(preferredId);
      if (!initialRouteRef.current) {
        initialRouteRef.current = true;
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get("session");
        const classroomId = params.get("classroom");
        if (sessionId) void openSession(sessionId);
        else if (classroomId && next.some((classroom) => classroom.id === classroomId)) setActiveClassroomId(classroomId);
      }
    } catch (caught) {
      if (revision !== classroomRevisionRef.current || requestId !== classroomLoadRef.current) return;
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
    setClassroomCreateError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ title, locale }),
      });
      const data = await response.json() as { classroom?: Classroom; error?: string };
      if (!response.ok || !data.classroom) throw new Error(data.error);
      classroomRevisionRef.current += 1;
      setClassrooms((current) => [data.classroom!, ...current]);
      if (await prepareNewLecture()) setActiveClassroomId(data.classroom.id);
      setNewClassroomTitle("");
      setCreateOpen(false);
      const mobileToggle = mobileSidebarToggleRef.current;
      if (mobileToggle?.getClientRects().length) mobileToggle.focus();
      else classroomCreateToggleRef.current?.focus();
    } catch (caught) {
      setClassroomCreateError(caught instanceof Error && caught.message
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
      const data = await response.json() as { classroom?: Omit<Classroom, "sessions">; error?: string };
      if (!response.ok || !data.classroom) throw new Error(data.error);
      classroomRevisionRef.current += 1;
      setClassrooms((current) => current.map((classroom) => classroom.id === data.classroom!.id
        ? { ...classroom, ...data.classroom } : classroom));
      setEditingClassroomId("");
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save the classroom." : "강의실 정보를 저장하지 못했습니다.");
    } finally {
      setClassroomPending(false);
    }
  }

  async function openSession(sessionId: string) {
    if (classroomPending || status === "recording" || status === "connecting" || finishingRef.current) return;
    if (!(await flushLectureTitle())) return;
    setMaterialsOpen(false);
    setMaterialUploadState(undefined);
    setClassroomPending(true);
    setRestoring(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/lecture-sessions?sessionId=${encodeURIComponent(sessionId)}`, { headers: { "X-Site-Locale": locale } });
      const data = await response.json() as {
        session?: SessionSummary;
        segments?: Segment[];
        questions?: Array<{ id: string; question: string; answer: string; question_at_ms?: number; external_sources?: Source[]; lecture_sources?: LectureSource[]; material_sources?: MaterialSource[]; provider: string; model: string }>;
        error?: string;
      };
      if (!response.ok || !data.session) throw new Error(data.error);
      let recoveredStatus = data.session.status;
      let recordedMs = data.session.recorded_ms ?? data.session.duration_seconds * 1_000;
      let activeElsewhere = false;
      if (data.session.status === "recording") {
        const recoveryResponse = await fetch("/api/lecture-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ action: "recover", sessionId: data.session.id }),
        });
        const recovery = await recoveryResponse.json() as { status?: SessionSummary["status"]; recordedMs?: number; activeRecording?: boolean; error?: string };
        if (!recoveryResponse.ok || !recovery.status) throw new Error(recovery.error);
        recoveredStatus = recovery.status;
        recordedMs = recovery.recordedMs ?? recordedMs;
        activeElsewhere = recovery.activeRecording === true;
      }
      setRemoteRecording(activeElsewhere);
      if (activeElsewhere) setNotice(isEnglish
        ? "This lecture already has a recording connection. You can read it here while keeping that connection active."
        : "이 수업의 녹음 연결이 이미 사용 중입니다. 기존 연결을 유지한 채 기록을 보여드립니다.");
      const restoredSegments = data.segments ?? [];
      setActiveClassroomId(data.session.classroom_id ?? "");
      setActiveSessionId(data.session.id);
      activeSessionIdRef.current = data.session.id;
      setLectureTitle(data.session.title);
      setTitleSaveStatus("idle");
      setSegments(restoredSegments);
      segmentIdsRef.current = new Set(restoredSegments.map((segment) => segment.id));
      // Restored segments are already saved, so /api/ask must not re-upload them.
      confirmedSegmentIdsRef.current = new Set(segmentIdsRef.current);
      setMessages((data.questions ?? []).flatMap((item) => [
        { id: `${item.id}-q`, role: "user" as const, text: item.question, questionAtMs: item.question_at_ms },
        // 저장된 provider는 내부 식별자다("lecture-live", "openai"). 그대로
        // 보여주지 않고 화면용 이름으로 바꾼다. 기본 AI는 모델명도 숨긴다.
        { id: `${item.id}-a`, role: "assistant" as const, text: cleanAnswerMarkdown(item.answer), sources: cleanSources(item.external_sources ?? []), lectureSources: item.lecture_sources, materialSources: item.material_sources, questionAtMs: item.question_at_ms, assistantLabel: item.provider === "lecture-live"
          ? (isEnglish ? "Lecture assistant · Default AI" : "강의 조교 · 기본 AI")
          : `${providerNames[item.provider as PersonalProvider] ?? item.provider} · ${item.model}` },
      ]));
      showInterim("");
      const nextStatus: Status = recoveredStatus === "draft" ? "idle"
        : recoveredStatus === "completed" ? "ended" : "paused";
      elapsedBaseMsRef.current = recordedMs;
      startedAtRef.current = 0;
      streamOffsetMsRef.current = recordedMs;
      setElapsedMs(recordedMs);
      // 새로고침은 브라우저 공유를 닫는다. 자동으로 다시 캡처하지 않고, 이어 듣기
      // 클릭에서 선택창을 연다(LIFE-05).
      restoreInputSource(data.session.input_source);
      setStatus(nextStatus);
      setMobileSidebarOpen(false);
      setNoteOpen(false);
      // 업로드로 만들어진 강의는 실시간 접기(2분 주기)를 거치지 않아 요약이
      // 없고, 질문마다 원문 전체가 나간다. 열 때 뒤에서 마저 접는다.
      // 서버가 할 일이 없으면 written:0으로 바로 끝난다.
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not load the lecture." : "수업 기록을 불러오지 못했습니다.");
    } finally {
      setClassroomPending(false);
      setRestoring(false);
    }
  }

  /** 3시간 강의는 창 18개 = 서버 호출당 3개씩 최대 6번. 다 접히면 멈춘다. */
  async function foldSummaries(sessionId: string) {
    for (let round = 0; round < 8; round += 1) {
      try {
        const response = await fetch("/api/lecture-summaries", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ sessionId }),
        });
        if (!response.ok) return;
        const data = await response.json() as { written?: number };
        if (!data.written) return;
      } catch {
        return; // 다음에 열 때 다시 시도된다.
      }
    }
  }

  async function prepareNewLecture(saveTitle = true) {
    if (status === "recording" || status === "connecting" || finishingRef.current) return false;
    if (saveTitle && !(await flushLectureTitle())) return false;
    restoreInputSource("microphone");
    setRemoteRecording(false);
    phonePairRef.current?.dispose();
    phonePairRef.current = null;
    setError("");
    setNoteOpen(false);
    setActiveSessionId("");
    activeSessionIdRef.current = "";
    setLectureTitle("");
    setMaterialUploadState(undefined);
    setTitleSaveStatus("idle");
    setMaterialsOpen(false);
    setSegments([]);
    segmentIdsRef.current.clear();
    confirmedSegmentIdsRef.current.clear();
    setMessages([]);
    showInterim("");
    setElapsedMs(0);
    setMobileSidebarOpen(false);
    elapsedBaseMsRef.current = 0;
    startedAtRef.current = 0;
    setNotice("");
    saveFailuresRef.current = 0;
    setStatus("idle");
    return true;
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

  // Browsing is available before consent; recording/upload still fail closed.
  useEffect(() => {
    void refreshConsent();
    return () => { consentAbortRef.current?.abort(); };
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
    // 일시적 네트워크 실패로 이미 동의한 사용자에게 동의창을 다시 들이밀지
    // 않도록 한 번 재시도한다. 두 번 다 실패하면 게이트 유지(fail-closed).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch("/api/consents", { headers: { "X-Site-Locale": locale } });
        if (!response.ok) throw new Error();
        const data = await response.json() as { satisfied?: boolean };
        // A late initial GET must not undo a newer successful consent POST.
        const satisfied = data.satisfied === true || consentConfirmedRef.current;
        if (satisfied) {
          consentConfirmedRef.current = true;
          setConsentAge(true);
          setConsentRecording(true);
        }
        setConsentSatisfied(satisfied);
        return satisfied;
      } catch {
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
    return false;
  }

  async function acceptConsentGate() {
    if (!consentAge || !consentRecording || consentSaveRef.current) return;
    const action = consentAction;
    const controller = new AbortController();
    consentAbortRef.current = controller;
    setConsentPending(true);
    setError("");
    setNotice("");
    const saving = (async () => {
      const response = await fetch("/api/consents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ types: ["age_14", "recording"] }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      controller.signal.throwIfAborted();
      consentConfirmedRef.current = true;
      setConsentSatisfied(true);
    })();
    consentSaveRef.current = saving;
    setConsentGate(false);
    // Native pickers need this click's activation and a non-inert target.
    consentDialogRef.current?.close();
    try {
      if (action === "microphone" || action === "browser-tab") {
        // Only permission/source selection starts now. The recorder waits for
        // saved consent before its meter, PCM, session, or provider connection.
        void startLecture(action, saving);
      } else if (action === "upload") {
        const input = audioUploadInputRef.current;
        if (input?.showPicker) input.showPicker();
        else input?.click();
      }
      await saving;
      if (action === "phone") setPhoneDialogOpen(true);
      setConsentAction(null);
    } catch (caught) {
      // Also observe the save if opening a native picker threw synchronously.
      await saving.catch(() => {});
      if (controller.signal.aborted) return;
      setConsentGate(true);
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save your agreement." : "동의 기록을 저장하지 못했습니다.");
    } finally {
      if (consentSaveRef.current === saving) consentSaveRef.current = null;
      if (consentAbortRef.current === controller) consentAbortRef.current = null;
      setConsentPending(false);
    }
  }

  const hasTranscript = segments.length > 0 || interim.length > 0;
  const hasMaterials = hasReadyMaterials(activeSessionId, materials);
  const hasQuestionContext = hasTranscript || hasMaterials;
  // 진행 중인 강의는 크레딧이 다 떨어져도 질문까지는 막지 않는다.
  const creditsAllowAsk = creditStatus === null || creditStatus.credits > 0 || status === "recording" || status === "paused";
  const outOfCredits = creditStatus !== null && creditStatus.credits <= 0;
  const canAsk = hasQuestionContext
    && !isFinalizing
    && !messages.some((message) => message.pending && message.kind !== "live-assist")
    && creditsAllowAsk;

  function askQuestion(event: FormEvent) {
    event.preventDefault();
    void submitQuestion(question, true);
  }

  // Follow-up suggestions preserve an in-progress draft in the composer.
  async function submitQuestion(text: string, fromComposer = false, mode?: "catchup", atMs = elapsedMs) {
    const cleanQuestion = text.trim().slice(0, 1_000);
    if (!cleanQuestion || !canAsk || messages.some((message) => message.pending && message.kind !== "live-assist")) return;
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

    const askedAt = atMs;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: cleanQuestion,
      questionAtMs: askedAt,
    };
    const assistantId = crypto.randomUUID();
    jumpToLatest();
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        text: "",
        pending: true,
        questionAtMs: askedAt,
        assistantLabel,
      },
    ]);
    if (fromComposer) setQuestion("");

    // 스트리밍이 중간에 끊겨도 이미 받은 답변은 지우지 않는다.
    let streamedText = "";
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
          liveAssistAnswers: liveAssistAvailable
            ? messages.filter((message) => message.kind === "live-assist" && !message.pending && message.text.trim())
              .slice(-3).map((message) => message.text.slice(0, 2_000))
            : undefined,
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
      // (or {"error"} if the provider failed mid-stream). Keep Markdown intact;
      // LearningAnswer renders partial and completed text through the same path.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
      trackAnalytics("answer_complete");

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: cleanAnswerMarkdown(answer),
                pending: false,
                sources: cleanSources(sources ?? []),
                lectureSources: lectureSources ?? [],
                materialSources: materialSources ?? [],
              }
            : message,
        ),
      );
    } catch (caught) {
      const reason = caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not create an answer." : "답변을 만들지 못했습니다.";
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                // 부분 답변이 있으면 남기고 아래에 중단 사유를 덧붙인다.
                text: streamedText
                  ? `${streamedText}\n\n⚠ ${isEnglish ? "The answer was cut off: " : "답변이 중간에 끊겼습니다: "}${reason}`
                  : reason,
                pending: false,
              }
            : message,
        ),
      );
    }
  }

  const [noteOpen, setNoteOpen] = useState(false);
  const noteLanguage = useNoteLanguage(locale);
  const noteState = useLectureNote(status === "ended" && !isFinalizing ? activeSessionId : null, isEnglish, noteLanguage.language);
  useEffect(() => { setNoteOpen(false); }, [activeSessionId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 새로고침 직후, URL의 세션을 다시 여는 동안. 빈 새 수업 화면 대신 베일을 덮는다.
  const [restoring, setRestoring] = useState(Boolean(restoreSessionId));
  // Keep the active lecture stable while saving its name or restoring another.
  const canStart = (status === "idle" || status === "error")
    && !isFinalizing && !classroomPending && !titleNavigationPending && !restoring
    && (creditStatus === null || creditStatus.credits > 0);

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

  // Keep a fresh microphone lecture here until its audio connection opens.
  const startingMicrophone = status === "connecting" && inputSource === "microphone" && elapsedMs === 0 && messages.length === 0;
  const preparing = (status === "idle" || status === "error" || startingMicrophone) && !hasQuestionContext && !restoring;
  const questions = messages.filter((message) => message.role === "user");
  function changeSpeechLanguage(next: string) {
    if (!isSpeechLanguage(next)) return;
    setSpeechLanguage(next);
    window.localStorage.setItem("lecue-speech-language", next);
  }
  const languageChoices = lectureLanguageChoices(region, locale);
  const selectedLanguageLabel = [...languageChoices.primary, ...languageChoices.other].find(item => item.id === speechLanguage)?.label ?? speechLanguage;
  const otherLanguageLabel = isEnglish ? "Other languages" : "다른 언어";
  const sidebarLocked = isFinalizing || classroomPending || titleNavigationPending || materialPending || status === "recording" || status === "connecting" || (!remoteRecording && status === "paused");

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
            if (session.id === activeSessionIdRef.current) setLectureTitle(event.target.value);
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
        ><span className="sidebar-session-title">{session.title}</span><small className="sidebar-session-details">
          {Number.isFinite(Date.parse(session.started_at)) ? new Intl.DateTimeFormat(isEnglish ? "en-US" : "ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(session.started_at)) : ""}
          {" · "}{session.status === "draft" ? (isEnglish ? "Not started" : "시작 전") : `${Math.ceil(session.duration_seconds / 60)}${isEnglish ? " min" : "분"}`}
          {" · "}{isEnglish ? `${session.question_count} questions` : `질문 ${session.question_count}개`}
        </small></button>
        <details className="session-menu" onToggle={(event) => positionSessionMenu(event.currentTarget)}>
          <summary aria-label={isEnglish ? "Lecture options" : "수업 옵션"}><MoreVertical size={14} aria-hidden="true" /></summary>
          <div className="session-menu-panel">
            <button type="button" onClick={(event) => { closeMenu(event); setRenamingSessionId(session.id); }}>
              {isEnglish ? "Rename" : "이름 변경"}
            </button>
            <button type="button" onClick={(event) => { closeMenu(event); void exportSession(session.id); }}>
              {isEnglish ? "Export as text" : "텍스트로 내보내기"}
            </button>
            <details className="session-submenu">
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
            onClick={async () => {
              if (await prepareNewLecture()) setActiveClassroomId(key);
            }}
            disabled={sidebarLocked}
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
            ><MoreHorizontal size={14} aria-hidden="true" /></button>
          )}
        </div>
        <div className="sidebar-sessions">{visibleSessions.map(renderSessionRow)}</div>
      </ClassroomDropTarget>
    );
  }

  return (
    <main className={`workspace experience question-workspace${preparing ? " is-preparing" : ""}${onlineViewing ? " is-online" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside id="lecture-sidebar" className={`workspace-sidebar${mobileSidebarOpen ? " is-mobile-open" : ""}`}>
        <div className="sidebar-header">
          <Link className="sidebar-brand" href={basePath || "/"} aria-label={isEnglish ? "Lecue home" : "Lecue 홈"}>L<span className="sidebar-wordmark">ecue</span><span className="sidebar-brand-dot" aria-hidden="true">.</span></Link>
      <button className="sidebar-desktop-toggle" type="button" onClick={toggleSidebar} aria-controls="lecture-sidebar" aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? (isEnglish ? "Show lecture list" : "수업 목록 펼치기") : (isEnglish ? "Hide lecture list" : "수업 목록 접기")} title={sidebarCollapsed ? (isEnglish ? "Show lecture list" : "수업 목록 펼치기") : (isEnglish ? "Hide lecture list" : "수업 목록 접기")}>
        <span className="sidebar-toggle-mark" aria-hidden="true">L<span>.</span></span>
        <PanelLeft size={16} strokeWidth={1.7} aria-hidden="true" />
      </button>
        </div>

        <button
          type="button"
          className="sidebar-new-lecture"
          onClick={() => void prepareNewLecture()}
          disabled={sidebarLocked}
          aria-label={isEnglish ? "New lecture" : "새 수업"}
          title={isEnglish ? "New lecture" : "새 수업"}
        >
          <Plus size={16} aria-hidden="true" />
          <span className="sidebar-action-label">{isEnglish ? "New lecture" : "새 수업"}</span>
        </button>
        <button className="sidebar-rail-search" type="button" aria-label={isEnglish ? "Search lectures" : "수업 검색"} title={isEnglish ? "Search lectures" : "수업 검색"} onClick={() => { toggleSidebar(); setSidebarSearchOpen(true); }}><Search size={16} aria-hidden="true" /></button>

        <button
          type="button"
          className="sidebar-mobile-toggle"
          ref={mobileSidebarToggleRef}
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
                <Search size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                ref={classroomCreateToggleRef}
                className={createOpen ? "active" : undefined}
                aria-expanded={createOpen}
                aria-controls="classroom-create-form"
                aria-label={createOpen ? (isEnglish ? "Close classroom form" : "강의실 추가 닫기") : (isEnglish ? "Add a classroom" : "강의실 추가")}
                aria-disabled={classroomPending || undefined}
                onClick={() => { if (classroomPending) return; setClassroomCreateError(""); setCreateOpen((open) => !open); }}
              >{createOpen ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}</button>
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
            <form id="classroom-create-form" className="classroom-create-form" onSubmit={createClassroom}
              aria-busy={classroomPending}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || classroomPending) return;
                event.preventDefault();
                setCreateOpen(false);
                classroomCreateToggleRef.current?.focus();
              }}>
              <label htmlFor="classroom-create-name">{isEnglish ? "Classroom name" : "강의실 이름"}</label>
              <input
                id="classroom-create-name"
                name="classroomName"
                autoFocus
                autoComplete="off"
                value={newClassroomTitle}
                onChange={(event) => { setNewClassroomTitle(event.target.value); setClassroomCreateError(""); }}
                placeholder={isEnglish ? "e.g. Economics" : "예: 경제학개론"}
                maxLength={80}
                disabled={classroomPending}
                aria-invalid={classroomCreateError ? true : undefined}
                aria-describedby={classroomCreateError ? "classroom-create-error" : undefined}
              />
              {classroomCreateError && <p id="classroom-create-error" className="classroom-create-error" role="alert">{classroomCreateError}</p>}
              <div className="classroom-create-actions">
                <button type="button" disabled={classroomPending} onClick={() => {
                  setCreateOpen(false);
                  classroomCreateToggleRef.current?.focus();
                }}>{isEnglish ? "Cancel" : "취소"}</button>
                <button type="submit" disabled={classroomPending || !newClassroomTitle.trim()}>
                  {classroomPending ? (isEnglish ? "Creating…" : "만드는 중…") : (isEnglish ? "Create" : "만들기")}
                </button>
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
              {sessionQuery.trim() && ![...sessionsById.values()].some((session) => session.title.toLowerCase().includes(sessionQuery.trim().toLowerCase())) && (
                <div className="sidebar-search-empty" role="status"><p>{isEnglish ? `No lectures match “${sessionQuery.trim()}”.` : `‘${sessionQuery.trim()}’에 해당하는 수업이 없어요.`}</p><p>{isEnglish ? "Try another name or clear your search." : "다른 이름으로 검색하거나 검색어를 지워 주세요."}</p><button type="button" onClick={() => setSessionQuery("")}>{isEnglish ? "Clear search" : "검색어 지우기"}</button></div>
              )}
            </nav>
          </DragDropProvider>

        </div>

        <div className="sidebar-account">
          <details className="profile-menu" onToggle={(event) => setProfileMenuOpen(event.currentTarget.open)} onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary className="sidebar-profile" aria-label={isEnglish ? "My account" : "내 계정"} title={isEnglish ? "My account" : "내 계정"}>
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
                <span className="profile-identity">
                  <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
                  <small title={profile?.email}>{profile?.email}</small>
                </span>
                <button type="button" className="profile-close" aria-label={isEnglish ? "Close account menu" : "계정 메뉴 닫기"} onClick={(event) => {
                  const menu = event.currentTarget.closest("details");
                  menu?.removeAttribute("open");
                  menu?.querySelector("summary")?.focus();
                }}><X size={16} aria-hidden="true" /></button>
              </header>

              <div className="profile-usage">
                <CreditUsage status={creditStatus} locale={locale} compact onRefresh={() => void loadCredits()} />
                <Link className="profile-topup" href={`${basePath}/billing?plan=topup`}>{isEnglish ? "Add credits" : "크레딧 추가"}<Plus size={13} aria-hidden="true" /></Link>
              </div>

              <div className="profile-menu-items">
                <Link href={`${basePath}/billing`}><CreditCard size={16} aria-hidden="true" /><span>{isEnglish ? "Plan and billing" : "요금제 및 결제 관리"}</span><ChevronRight className="profile-action-arrow" size={14} aria-hidden="true" /></Link>
                <button type="button" onClick={(event) => {
                  const menu = event.currentTarget.closest("details");
                  menu?.removeAttribute("open");
                  menu?.querySelector("summary")?.focus();
                  setSettingsOpen(true);
                }}>
                  <Settings2 size={16} aria-hidden="true" /><span>{isEnglish ? "Settings" : "설정"}</span><ChevronRight className="profile-action-arrow" size={14} aria-hidden="true" />
                </button>
              </div>

              <form className="profile-signout" action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
                <button type="submit"><LogOut size={16} aria-hidden="true" /><span>{isEnglish ? "Sign out" : "로그아웃"}</span></button>
              </form>
            </div>
          </details>
        </div>
      </aside>

      {settingsOpen && (
        <WorkspaceDialog label={isEnglish ? "Settings" : "설정"} onClose={() => setSettingsOpen(false)}>
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
                  label={isEnglish ? "Appearance" : "화면 테마"}
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
                  <h3>{isEnglish ? "Display language" : "표시 언어"}</h3>
                  <p>{["recording", "connecting", "paused"].includes(status)
                    ? (isEnglish ? "You can change this after ending the lecture." : "수업을 종료한 뒤 변경할 수 있어요.")
                    : (isEnglish ? "The language of menus and screens." : "메뉴와 화면에 쓰는 언어입니다.")}</p>
                </div>
                <LanguageChoices
                  label={isEnglish ? "Display language" : "표시 언어"}
                  value={displayLocale}
                  primary={region === "kr" ? [{ id: "ko", label: "한국어" }, { id: "en", label: "English" }] : [{ id: "en", label: "English" }]}
                  other={region === "kr" ? [] : [{ id: "ko", label: "한국어" }]}
                  otherLabel={otherLanguageLabel}
                  onChange={next => { if (next === "ko" || next === "en") changeDisplayLocale(next); }}
                  disabled={status === "recording" || status === "connecting" || status === "paused"}
                />
              </section>

              <section className="settings-row settings-language-row">
                <div>
                  <h3>{isEnglish ? "Lecture language" : "수업 언어"}</h3>
                </div>
                <LanguageChoices
                  label={isEnglish ? "Lecture language" : "수업 언어"}
                  value={speechLanguage}
                  disabled={status === "recording" || status === "connecting" || status === "paused"}
                  {...languageChoices}
                  otherLabel={otherLanguageLabel}
                  onChange={changeSpeechLanguage}
                />
              </section>

              <section className="settings-row">
                <div>
                  <h3>{isEnglish ? "Note language" : "노트 작성 언어"}</h3>
                  <p>{isEnglish ? "For new notes. System default follows your device’s language." : "새로 만드는 노트에 적용돼요. 기본은 기기의 언어를 따라갑니다."}</p>
                </div>
                <NoteLanguagePicker value={noteLanguage.preference} systemLanguage={noteLanguage.systemLanguage}
                  isEnglish={isEnglish} onChange={noteLanguage.change} disabled={noteState.phase === "generating"} />
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
                  aria-label={isEnglish ? "Microphone" : "마이크"}
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


              {liveAssistAvailable && <details className="profile-advanced live-assist-settings">
                <summary>{isEnglish ? "Admin lab" : "관리자 실험실"}</summary>
                <section className="settings-row">
                  <div>
                    <h3 id="live-assist-setting-label">{isEnglish ? "Live assist" : "실시간 답변"}</h3>
                    <p id="live-assist-setting-help">{isEnglish
                      ? "Get a direct answer when a question comes up in the conversation."
                      : "대화에서 질문을 감지하면, 바로 활용할 수 있는 답변을 보여줘요."}</p>
                  </div>
                  <input type="checkbox" role="switch" className="live-assist-switch"
                    aria-labelledby="live-assist-setting-label" aria-describedby="live-assist-setting-help"
                    checked={liveAssistEnabled} onChange={(event) => setLiveAssistEnabled(event.target.checked)} />
                </section>
              </details>}

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
        </WorkspaceDialog>
      )}

      {phoneDialogOpen && <PhoneMicDialog open={phoneDialogOpen} locale={locale} onClose={() => setPhoneDialogOpen(false)} onReady={acceptPhone} onPause={phonePause} />}

      <div className="workspace-main">
        <header className="topbar">
          <div className="lecture-title-field">
            <span>{activeClassroomTitle}</span>
            <input
              value={lectureTitle}
              disabled={titleNavigationPending || restoring}
              onChange={(event) => { setLectureTitle(event.target.value); setTitleSaveStatus("idle"); }}
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
              placeholder={isEnglish ? "Lecture name (optional)" : "수업 이름 (선택)"}
              aria-label={isEnglish ? "Lecture name" : "수업 이름"}
              maxLength={80}
              aria-describedby={activeSessionId ? "lecture-title-save-status" : undefined}
            />
            {activeSessionId && <small id="lecture-title-save-status" className={titleSaveStatus === "error" ? "lecture-title-save-status" : "sr-only"} role="status">
              {titleSaveStatus === "saving" ? (isEnglish ? "Saving name…" : "이름 저장 중…")
                : titleSaveStatus === "saved" ? (isEnglish ? "Name saved" : "이름 저장됨")
                : titleSaveStatus === "error" ? <button type="button" onClick={() => void renameSession(activeSessionId, lectureTitleRef.current)}>{isEnglish ? "Name not saved · Retry" : "이름 저장 실패 · 다시 저장"}</button> : ""}
            </small>}
          </div>

          <div className="session-state" aria-live="polite">
            <span className={`state-dot state-${status}`} />
            {status === "recording" && <span className="mic-meter" ref={meterRef} aria-hidden="true"><i /><i /><i /><i /><i /></span>}
            <span>{statusLabel}</span>
            <time>{formatTime(elapsedMs)}</time>
          </div>

          {remoteRecording ? (
            <div className="lecture-controls">
              <button className="pause-button" type="button" disabled={classroomPending} onClick={() => void openSession(activeSessionId)}>
                {isEnglish ? "Check recording status" : "녹음 상태 확인"}
              </button>
            </div>
          ) : status === "recording" || status === "connecting" || status === "paused" ? (
            <div className="lecture-controls">
              <button
                className="pause-button"
                type="button"
                onClick={() => { if (status === "paused") requestResume(); else void pauseLecture(); }}
                disabled={isFinalizing || isSwitchingMicrophone || status === "connecting"}
              aria-busy={isPausing}
                title={isPausing ? (isEnglish ? "Finishing the last audio before you can resume." : "마지막 음성을 정리한 뒤 이어서 녹음할 수 있어요.") : undefined}
              >{isPausing ? (isEnglish ? "Finishing audio…" : "기록 정리 중…") : status === "paused" ? resumeLabel : isEnglish ? "Pause" : "일시정지"}</button>
              <button className="stop-button" type="button" onClick={stopLecture} disabled={isFinalizing || isSwitchingMicrophone || status === "connecting"}>
                {isEnglish ? "End lecture" : "강의 종료"}
              </button>
              {inputSource === "microphone" && <MicrophoneSwitch
                phone={phoneInput} english={isEnglish}
                disabled={isSwitchingMicrophone || isFinalizing || status === "connecting"}
                onChange={target => { void changeMicrophone(target); }}
              />}
            </div>
          ) : (
            <div className="lecture-controls">
              {/* UPL-01. A lecture already recorded on a phone takes the same
                  path as a live one; it just arrives all at once. */}
              <label className="audio-upload-button" aria-disabled={!audioAvailability?.available || audioAvailabilityChecking || audioBusy || isFinalizing} title={audioAvailability?.available ? (isEnglish ? `Maximum file size: ${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))} MB` : `파일당 최대 ${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))}MB`) : undefined}>
                <input
                  ref={audioUploadInputRef}
                  type="file"
                  accept=".mp3,.m4a,.wav,.webm,.mp4,audio/*"
                  disabled={!audioAvailability?.available || audioAvailabilityChecking || audioBusy || isFinalizing}
                  aria-describedby="audio-upload-availability"
                  onClick={(event) => {
                    if (!audioAvailability?.available || audioAvailabilityChecking) { event.preventDefault(); return; }
                    if (consentSatisfied !== true && !consentSaveRef.current && !consentConfirmedRef.current) {
                      event.preventDefault();
                      openConsentGate("upload");
                    }
                  }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadLectureAudio(file);
                  }}
                />
                {audioBusy
                  ? isEnglish ? "Transcribing…" : "변환 중…"
                  : audioAvailabilityChecking ? (isEnglish ? "Checking upload…" : "업로드 확인 중…")
                  : !audioAvailability?.available ? (isEnglish ? "Recording upload unavailable" : "녹음 파일 업로드 불가")
                  : isEnglish ? "Upload recording" : "녹음 파일"}
              </label>
              {status === "ended" && activeSessionId && hasTranscript && (<>
                <button className={`note-button${noteState.phase === "generating" ? " is-generating" : ""}`} type="button" disabled={isFinalizing} onClick={() => setNoteOpen(true)} aria-label={noteState.phase === "generating" ? (isEnglish ? "Review note — creating" : "복습 노트 — 작성 중") : undefined}>
                  {noteState.phase === "generating" ? <NoteGenerationIcon /> : <BookOpen size={15} aria-hidden="true" />}
                  {isEnglish ? "Review note" : "복습 노트"}
                  {noteState.phase === "generating" && <span className="note-button-status" role="status">{isEnglish ? "Creating" : "작성 중"}</span>}
                </button>
                <button className="review-export" type="button" disabled={isFinalizing} onClick={() => void exportSession(activeSessionId)}>{isEnglish ? "Export" : "기록 내려받기"}</button>
              </>)}
              {/* 빈 화면 한가운데 시작 버튼이 떠 있는 동안엔 상단 중복을 데스크톱에서만
                  숨긴다(CSS). 모바일 채팅 탭에선 가운데 버튼이 안 보여 상단이 유일한 시작점. */}
              {status !== "ended" && renderStartButtons(!canStart || materialPending, preparing ? "is-duplicate-of-center" : "")}
            </div>
          )}
          <button type="button" className="online-settings-button" aria-label={isEnglish ? "Settings" : "설정"} title={isEnglish ? "Settings" : "설정"} onClick={() => setSettingsOpen(true)}><Settings2 size={16} aria-hidden="true" /></button>
        </header>

        {status !== "recording" && status !== "connecting" && status !== "paused" && !audioBusy && (
          <p id="audio-upload-availability" className={audioAvailabilityChecking || audioAvailability?.available ? "sr-only" : "audio-upload-availability"} role="status">
            {audioAvailabilityChecking ? (isEnglish ? "Checking recording upload availability…" : "녹음 파일 업로드 가능 여부를 확인하고 있어요…")
              : audioAvailability?.available ? (isEnglish ? `Recording uploads: up to ${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))} MB per file.` : `녹음 파일은 ${Math.floor(audioAvailability.maxFileBytes / (1024 * 1024))}MB까지 올릴 수 있어요.`)
              : audioAvailability ? (isEnglish ? "Recording uploads are currently unavailable on our service. You can still record a live lecture or add materials." : "현재 서비스에서 녹음 파일 업로드를 사용할 수 없습니다. 실시간 강의 기록과 자료 추가는 이용할 수 있어요.")
              : (isEnglish ? "Could not check recording upload availability. Try again." : "녹음 파일 업로드 가능 여부를 확인하지 못했습니다. 다시 확인해 주세요.")}
            {!audioAvailabilityChecking && !audioAvailability?.available && <button type="button" onClick={() => void checkAudioAvailability()}>{isEnglish ? "Check again" : "다시 확인"}</button>}
          </p>
        )}

        <div className="session-wayfinding" hidden={!preparing}>
          <ol aria-label={isEnglish ? "Lecture progress" : "수업 진행 단계"}>
            {(isEnglish ? ["Prepare", "Learn", "Review"] : ["수업 준비", "수업 중", "복습"]).map((label, index) => (
              <li key={label} aria-current={index === (status === "ended" ? 2 : preparing ? 0 : 1) ? "step" : undefined}>{label}</li>
            ))}
          </ol>
          {status === "ended" && activeSessionId && <span className="review-summary">{isEnglish ? `${questions.length} questions · ${materials.length} materials` : `질문 ${questions.length}개 · 자료 ${materials.length}개`}</span>}
        </div>

        <div className="session-listening-space">
          <ListeningIndicator key={activeSessionId} sessionId={activeSessionId} status={status} waitingForAudio={waitingForAudio} finalizing={isFinalizing && !isPausing} english={isEnglish} script={liveScript} />
        </div>

        {noteOpen && activeSessionId && (
          <LectureNotePanel state={noteState} isEnglish={isEnglish} languagePreference={noteLanguage.preference}
            systemLanguage={noteLanguage.systemLanguage} outputLanguage={noteLanguage.language}
            onLanguageChange={noteLanguage.change} onClose={() => setNoteOpen(false)} />
        )}

        {/* 사이드바 팝오버는 좁아서 잘렸다. 설정은 화면 가운데 모달로 연다. */}
        {editingClassroomId && (
          <WorkspaceDialog label={isEnglish ? "Classroom settings" : "강의실 설정"} onClose={() => setEditingClassroomId("")}>
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
                    ? "Separate with commas."
                    : "쉼표로 구분하세요."}</small>
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
          </WorkspaceDialog>
        )}

        <dialog
          ref={consentDialogRef}
          className="consent-modal"
          aria-label={isEnglish ? "Before your first recording" : "첫 녹음을 시작하기 전에"}
          onCancel={(event) => { event.preventDefault(); dismissConsentGate(); }}
        >
          <div className="consent-gate">
            <p>{isEnglish
              ? "Please confirm these before recording or transcribing an audio file."
              : "녹음이나 음성 파일 변환을 시작하기 전에 확인해 주세요."}</p>
            <label>
              <input autoFocus type="checkbox" checked={consentAge} onChange={(event) => setConsentAge(event.target.checked)} />
              {CONSENT_COPY.age_14[isEnglish ? "en" : "ko"]}
            </label>
            <label>
              <input type="checkbox" checked={consentRecording} onChange={(event) => setConsentRecording(event.target.checked)} />
              {CONSENT_COPY.recording[isEnglish ? "en" : "ko"]}
            </label>
            {error && <p role="alert">{error}</p>}
            <span>
              <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
              <Link href={`${basePath}/terms`}>{isEnglish ? "Terms" : "이용약관"}</Link>
              <button
                type="button"
                onClick={() => void acceptConsentGate()}
                disabled={!consentAge || !consentRecording || consentPending}
              >{consentPending
                ? isEnglish ? "Saving…" : "저장 중…"
                : consentAction === "upload"
                  ? isEnglish ? "Agree and choose a file" : "동의하고 파일 선택"
                  : isEnglish ? "Agree and start lecture" : "동의하고 강의 시작"}</button>
            </span>
            <button type="button" className="consent-browse" disabled={consentPending} onClick={dismissConsentGate}>{isEnglish ? "Browse first" : "먼저 둘러보기"}</button>
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

        {preparing && (
          <section className="lecture-preparation" aria-labelledby="prepare-title">
            <div className="preparation-intro">
              <p>{activeClassroomId ? activeClassroomTitle : (isEnglish ? "Your space to follow along" : "수업의 흐름을, 내 속도로.")}</p>
              <h1 id="prepare-title">{isEnglish ? <>Ready for<br />today’s lecture?</> : <>오늘 수업도,<br />놓치는 순간 없이.</>}</h1>
              <span>{isEnglish ? "Lecue keeps the lecture context. You focus on understanding." : "강의의 맥락은 Lecue가 기억할게요. 이해하는 데 집중하세요."}</span>
            </div>
            <div className="preparation-sheet">
              <div className="preparation-sheet-heading"><h2>{isEnglish ? "Start your lecture" : "수업을 시작해 볼까요?"}</h2></div>
              <div className="preparation-language"><span className="preparation-language-label">{isEnglish ? "Lecture language" : "수업에서 쓰는 언어"}</span>
                <LanguageChoices label={isEnglish ? "Lecture language" : "수업에서 쓰는 언어"} value={speechLanguage} {...languageChoices} otherLabel={otherLanguageLabel} onChange={changeSpeechLanguage} />
              </div>
              {renderStartButtons(!canStart || materialPending, "preparation-start", true)}
              <RecordingPreparation english={isEnglish} language={selectedLanguageLabel} deviceId={micDeviceId} deviceLabel={micDevices.find(device => device.deviceId === micDeviceId)?.label} enabled={canStart && !materialPending} stopRef={microphoneCheckStopRef} />
              <details className="preparation-options">
                <summary>{isEnglish ? "Materials & microphone" : "자료 · 마이크 설정"}<span>{materialPending ? (isEnglish ? "Reading…" : "읽는 중…") : materials.length ? (isEnglish ? `${materials.length} ready` : `자료 ${materials.length}개`) : (isEnglish ? "Optional" : "선택")}</span><ChevronRight size={14} aria-hidden="true" /></summary>
              <label className="preparation-material"><input type="file" accept=".pdf,.docx,.pptx,.txt,.csv,.tsv,.xlsx,.xls" disabled={materialPending} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadMaterial(file); }} /><Upload size={18} aria-hidden="true" /><span><strong>{materialPending ? (isEnglish ? "Reading material…" : "자료를 읽고 있어요…") : materials.length ? (isEnglish ? `${materials.length} materials ready · add more` : `자료 ${materials.length}개 준비됨 · 더 추가하기`) : (isEnglish ? "Add lecture material" : "강의 자료 추가하기")}</strong></span></label>
              <MaterialList documents={materials} locale={locale} upload={materialUploadState} busy={materialPending} defaultOpen onRemove={deleteMaterial} onReplace={(id, file) => uploadMaterial(file, id)} />
              <div className="preparation-mic"><span><strong>{isEnglish ? "Microphone" : "마이크"}</strong></span><button type="button" onClick={() => setSettingsOpen(true)}>{isEnglish ? "Choose mic" : "장치 선택"}</button></div>
              </details>
            </div>
          </section>
        )}

        <section ref={onlineLayout.panesRef} style={{ maxWidth: onlineLayout.maxWidth }} className={`panes${onlineViewing ? " online-panes" : ""}`} hidden={preparing}>
          {onlineViewing && <section className="online-video-pane" aria-label={isEnglish ? "Lecture screen" : "강의 화면"}>
            <LecturePreview stream={previewStream} isEnglish={isEnglish} waitingForAudio={waitingForAudio} onAspectRatioChange={setOnlineAspectRatio} />
          </section>}
          {restoring && (
            <div className="restore-veil" role="status">
              <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />
              <span>{isEnglish ? "Reopening your lecture…" : "보던 수업을 다시 여는 중…"}</span>
            </div>
          )}
          <section
            className={`chat-pane is-mobile-active${messages.length === 0 ? " is-empty" : ""}${materialDragOver ? " material-drop-active" : ""}`}
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
          <h1 id="chat-title" className="sr-only" tabIndex={-1}>{isEnglish ? "Ask about your lecture" : "강의에 대해 질문하기"}</h1>
          {liveAssistAvailable && liveAssistEnabled && <div className="live-assist-status">
            <div role="status">
              <strong>{isEnglish ? "Live assist" : "실시간 답변"}</strong>
              <span>{liveAssist.error || (status !== "recording"
                ? (isEnglish ? "Waiting for the conversation" : "대화 시작을 기다리고 있어요")
                : liveAssist.phase === "answering" ? (isEnglish ? "Answering…" : "답변 중…")
                : liveAssist.phase === "thinking" ? (isEnglish ? "Reading the conversation…" : "대화를 살펴보고 있어요")
                : (isEnglish ? "Listening for a question" : "질문을 듣고 있어요"))}</span>
            </div>
            {liveAssist.error && <button type="button" onClick={liveAssist.retry}>{isEnglish ? "Retry" : "다시 연결"}</button>}
            <button type="button" onClick={() => setLiveAssistEnabled(false)}>{isEnglish ? "Turn off" : "끄기"}</button>
          </div>}

          {/* Announce completion without revealing a folded practice solution. */}
          <p className="sr-only" aria-live="polite">
            {messages.at(-1)?.role === "assistant" && !messages.at(-1)?.pending ? (isEnglish ? "Your answer is ready below." : "아래에 답변이 준비됐어요.") : ""}
          </p>

          <div
            className="messages"
            ref={messagesScrollRef}
            tabIndex={messages.length > 0 ? 0 : undefined}
            aria-label={isEnglish ? "Conversation" : "대화 내용"}
          >
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>{liveAssistEnabled && liveAssistAvailable ? (isEnglish ? "Speak naturally." : "편하게 대화하세요.") : (isEnglish ? "What would you like to understand?" : "무엇이 궁금한가요?")}</p>
                {hasMaterials && !hasTranscript ? <span>{isEnglish ? "Ask about your materials. You can start recording whenever you need it." : "올린 자료에 대해 바로 질문하세요. 녹음은 필요할 때 시작할 수 있어요."}</span>
                  : liveAssistEnabled && liveAssistAvailable ? <span>{isEnglish ? "When a question comes up, an answer appears here." : "답변이 필요한 순간, 여기에 바로 보여드릴게요."}</span> : !hasTranscript && <span>{status === "ended"
                  ? (isEnglish ? "No lecture content was saved. Add materials to ask questions." : "저장된 강의 내용이 없습니다. 자료를 추가하면 질문할 수 있어요.")
                  : (isEnglish ? "Add materials or record the lecture to ask questions." : "자료를 추가하거나 강의를 기록하면 질문할 수 있어요.")}</span>}
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`} aria-busy={message.pending || undefined}>
                  {message.role === "assistant" && (
                    <span className="message-label">{message.assistantLabel ?? (isEnglish ? "Lecture assistant · AI" : "강의 조교 · AI")}</span>
                  )}
                  {message.role === "assistant"
                    ? <LearningAnswer text={message.text} pending={message.pending} isEnglish={isEnglish} />
                    : <p>{message.text}</p>}
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
                  {message.lectureSources && message.lectureSources.length > 0 && (
                    <div className="lecture-sources">
                      <span>{isEnglish ? "Earlier lecture used" : "이전 수업 참고"}</span>
                      {message.lectureSources.map((source) => (
                        <button type="button" key={`${source.sessionId}-${source.startMs}`} disabled={sidebarLocked || source.sessionId === activeSessionId} onClick={() => void openSession(source.sessionId)}>
                          {source.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {message.role === "assistant" && message.kind !== "live-assist" && !message.pending && message.id === messages.at(-1)?.id && message.text.length > 100 && (
                    <div className="answer-followups" aria-label={isEnglish ? "Keep learning" : "이어서 이해하기"}>
                      <button type="button" disabled={!canAsk} onClick={() => void submitQuestion(isEnglish ? "Explain your last answer with one simple, concrete example." : "방금 답변을 구체적인 예시 하나로 쉽게 설명해 줘.", false, undefined, message.questionAtMs)}>{isEnglish ? "Give an example" : "예시로 더 쉽게"}</button>
                      <button type="button" disabled={!canAsk} onClick={() => void submitQuestion(isEnglish ? "Give me one practice question to check that I understand your last explanation, with its answer and a short reason." : "방금 설명을 이해했는지 확인할 문제 하나와 정답, 짧은 이유를 알려 줘.", false, undefined, message.questionAtMs)}>{isEnglish ? "Check my understanding" : "이해 확인하기"}</button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>

          <div className="conversation-composer">
          <div className="conversation-compose-row">
          {!isFollowingLatest && messages.length > 0 && <button type="button" className="conversation-jump-latest" onClick={jumpToLatest} aria-label={isEnglish ? "Back to latest answer" : "최신 답변으로 이동"} title={isEnglish ? "Back to latest answer" : "최신 답변으로 이동"}><ArrowDown size={17} aria-hidden="true" /></button>}
            <details className="conversation-materials" open={materialsOpen} onToggle={event => setMaterialsOpen(event.currentTarget.open)}>
              <summary aria-label={isEnglish ? `Lecture materials · ${materials.length}` : `강의 자료 ${materials.length}개`} title={isEnglish ? "Lecture materials" : "강의 자료"} aria-busy={materialPending}><Paperclip size={18} aria-hidden="true" />{materials.length > 0 && <span className="material-count" aria-hidden="true">{materials.length}</span>}</summary>
          <div className="material-toolbar">
            <div>
              <strong>{isEnglish ? "Lecture materials" : "강의 자료"}</strong>
              <span>{isEnglish ? `${materials.length} materials` : `자료 ${materials.length}개`}</span>
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
            <MaterialList documents={materials} locale={locale} upload={materialUploadState} busy={materialPending} defaultOpen onRemove={deleteMaterial} onReplace={(id, file) => uploadMaterial(file, id)} />
          </div>
            </details>
          <form className="question-form" onSubmit={askQuestion}>
            <label htmlFor="question" className="sr-only">{isEnglish ? "Enter a question" : "질문 입력"}</label>
            <textarea
              id="question"
              ref={questionInputRef}
              onFocus={() => setQuestionFocused(true)}
              onBlur={() => setQuestionFocused(false)}
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
                : hasMaterials && !hasTranscript
                  ? (questionFocused ? "" : isEnglish ? "Ask about your materials" : "올린 자료에 대해 질문하세요")
                : hasTranscript
                  ? questionFocused ? "" : messages.length ? (isEnglish ? "Ask about this lecture" : "이 강의에 대해 질문하세요") : askHint || (isEnglish ? "Ask about this lecture" : "이 강의에 대해 질문하세요")
                  : isEnglish ? "Add materials or record the lecture to ask" : "자료를 추가하거나 강의를 기록하면 질문할 수 있어요"}
              maxLength={1_000}
              aria-describedby={question.length >= 800 ? "question-length" : undefined}
              // 답변을 기다리는 동안에도 다음 질문은 미리 쓸 수 있다. 전송만 막는다.
              disabled={!hasQuestionContext || !creditsAllowAsk}
              rows={1}
            />
            <button type="submit" disabled={!canAsk || !question.trim()} aria-label={isEnglish ? "Send question" : "질문 보내기"}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </form>
          </div>
          {question.length >= 800 && <p id="question-length" className="question-length" role="status">{question.length.toLocaleString(isEnglish ? "en-US" : "ko-KR")} / 1,000{isEnglish ? " characters" : "자"}{question.length >= 1_000 ? (isEnglish ? " · Limit reached. Attach longer content as a material." : " · 최대 길이입니다. 긴 내용은 자료로 첨부해 주세요.") : ""}</p>}
          </div>
          </section>

        </section>

        <footer className="footnote">
          <Link href={basePath || "/"}><ChevronLeft size={12} aria-hidden="true" />{isEnglish ? "Lecue home" : "Lecue 홈으로"}</Link>
          <span className="footnote-links">
            <a href={`${basePath}/privacy#cookies`} data-analytics-settings>{isEnglish ? "Cookie settings" : "쿠키 설정"}</a>
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
