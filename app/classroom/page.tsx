"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { personalModelOptions, type PersonalProvider } from "../lib/llm-models";

type Status = "idle" | "connecting" | "recording" | "ended" | "error";

type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type Source = { title: string; url: string };
type LectureSource = { sessionId: string; title: string; startMs: number; endMs: number };
type SessionSummary = {
  id: string;
  classroom_id: string;
  title: string;
  status: "recording" | "completed";
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  question_count: number;
};
type Classroom = { id: string; title: string; locale: "ko" | "en"; sessions: SessionSummary[] };
type AiProvider = "lecture-live" | PersonalProvider;
type SavedCredential = { provider: PersonalProvider; model: string; updated_at: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sources?: Source[];
  lectureSources?: LectureSource[];
  assistantLabel?: string;
};

type DeepgramResult = {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

const providerNames: Record<PersonalProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

const MAX_LECTURE_MS = 10_800_000;

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function safeSource(source: Source) {
  try {
    const url = new URL(source.url);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export default function LectureWorkspace({ locale = "ko" }: { locale?: "ko" | "en" }) {
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
  const [lectureTitle, setLectureTitle] = useState("");
  const [aiProvider, setAiProvider] = useState<AiProvider>("lecture-live");
  const [aiModel, setAiModel] = useState<string>(personalModelOptions.openai[0].id);
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [savedCredentials, setSavedCredentials] = useState<SavedCredential[]>([]);
  const [credentialPending, setCredentialPending] = useState(false);
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [activeClassroomId, setActiveClassroomId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [newClassroomName, setNewClassroomName] = useState("");
  const [classroomPending, setClassroomPending] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const segmentIdsRef = useRef(new Set<string>());
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const activeSessionIdRef = useRef("");
  const finishingRef = useRef(false);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => {
      const elapsed = Math.min(MAX_LECTURE_MS, Date.now() - startedAtRef.current);
      setElapsedMs(elapsed);
      if (elapsed >= MAX_LECTURE_MS) void finishLecture();
    }, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

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

  useEffect(() => {
    void loadClassrooms();
  }, [locale]);

  async function loadClassrooms(preferredId?: string) {
    try {
      const response = await fetch("/api/classrooms", { headers: { "X-Site-Locale": locale } });
      if (!response.ok) return;
      const data = await response.json() as { classrooms?: Classroom[] };
      const next = data.classrooms ?? [];
      setClassrooms(next);
      setActiveClassroomId((current) => preferredId ?? (current || next[0]?.id || ""));
    } catch {
      // The live workspace still works without persistence while storage is being configured.
    }
  }

  async function createClassroom(event: FormEvent) {
    event.preventDefault();
    const title = newClassroomName.trim();
    if (!title) return;
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
      setNewClassroomName("");
      await loadClassrooms(data.classroom.id);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다.");
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
      setActiveClassroomId(data.session.classroom_id);
      setActiveSessionId(data.session.id);
      setLectureTitle(data.session.title);
      setSegments(restoredSegments);
      segmentIdsRef.current = new Set(restoredSegments.map((segment) => segment.id));
      setMessages((data.questions ?? []).flatMap((item) => [
        { id: `${item.id}-q`, role: "user" as const, text: item.question },
        { id: `${item.id}-a`, role: "assistant" as const, text: item.answer, sources: item.external_sources, lectureSources: item.lecture_sources, assistantLabel: `${item.provider} · ${item.model}` },
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
    setMessages([]);
    setInterim("");
    setElapsedMs(0);
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

  async function startLecture() {
    if (!activeClassroomId) {
      setError(isEnglish ? "Create or select a classroom first." : "먼저 강의실을 만들거나 선택해 주세요.");
      return;
    }
    setError("");
    startedAtRef.current = 0;
    activeSessionIdRef.current = "";
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

      const tokenResponse = await fetch("/api/deepgram-token", { method: "POST" });
      const tokenData = (await tokenResponse.json()) as { accessToken?: string; error?: string };
      if (!tokenResponse.ok || !tokenData.accessToken) {
        throw new Error(tokenData.error ?? (isEnglish
          ? "Could not obtain a speech-recognition token."
          : "음성 인식 토큰을 받지 못했습니다."));
      }

      const sessionResponse = await fetch("/api/lecture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({
          action: "start",
          classroomId: activeClassroomId,
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
      setMessages([]);

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
          const startMs = Math.round((result.start ?? 0) * 1_000);
          const endMs = Math.round(((result.start ?? 0) + (result.duration ?? 0)) * 1_000);
          const id = `${startMs}-${endMs}-${text}`;
          if (!segmentIdsRef.current.has(id)) {
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
              body: JSON.stringify({ action: "segment", sessionId: activeSessionIdRef.current, segment }),
            });
          }
          setInterim("");
        } else {
          setInterim(text);
        }
      };

      socket.onerror = () => {
        setError(isEnglish
          ? "Speech recognition could not connect. Check the network and API settings."
          : "음성 인식 연결에 실패했습니다. 네트워크와 API 설정을 확인해 주세요.");
        setStatus("error");
      };

      socket.onclose = () => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
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
      const message = caught instanceof Error
        ? caught.message
        : isEnglish ? "Could not start the microphone." : "마이크를 시작하지 못했습니다.";
      setError(message);
      setStatus("error");
    }
  }

  async function finishLecture() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
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
        if (Date.now() - startedAtRef.current >= MAX_LECTURE_MS) {
          setError(isEnglish ? "This lecture reached the 3-hour session limit and was saved." : "수업 1회 최대 3시간에 도달해 자동으로 저장·종료했습니다.");
        }
      } catch (caught) {
        setError(caught instanceof Error && caught.message ? caught.message : isEnglish ? "The lecture ended, but saving did not finish." : "강의는 종료됐지만 저장을 마치지 못했습니다.");
      }
    }
    finishingRef.current = false;
  }

  function stopLecture() {
    void finishLecture();
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!cleanQuestion || messages.some((message) => message.pending)) return;
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
    setQuestion("");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: cleanQuestion,
          questionAtMs: askedAt,
          segments,
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
      const data = (await response.json()) as { answer?: string; sources?: Source[]; lectureSources?: LectureSource[]; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error ?? (isEnglish
        ? "Could not receive an answer."
        : "답변을 받지 못했습니다."));

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: data.answer!,
                pending: false,
                sources: (data.sources ?? []).filter(safeSource),
                lectureSources: data.lectureSources ?? [],
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

  const canStart = status === "idle" || status === "ended" || status === "error";
  const canAsk = (segments.length > 0 || interim.length > 0) && !messages.some((message) => message.pending);
  const activeModelLabel =
    aiProvider === "lecture-live"
      ? isEnglish ? "Default AI" : "기본 AI"
      : personalModelOptions[aiProvider].find((model) => model.id === aiModel)?.label ??
        personalModelOptions[aiProvider][0].label;

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand" aria-label="Lecue">
          <span>Lecue</span>
        </div>

        <label className="title-field">
          <span className="sr-only">{isEnglish ? "Lecture title" : "강의 제목"}</span>
          <input
            value={lectureTitle}
            onChange={(event) => setLectureTitle(event.target.value)}
            placeholder={isEnglish ? "Enter a lecture title" : "강의 제목을 입력하세요"}
            maxLength={80}
          />
        </label>

        <div className="session-state" aria-live="polite">
          <span className={`state-dot state-${status}`} />
          <span>{statusCopy[status]}</span>
          <time>{formatTime(elapsedMs)}</time>
        </div>

        <details className="ai-settings">
          <summary>
            <span>{isEnglish ? "Answer model" : "답변 모델"}</span>
            <b>{activeModelLabel}</b>
          </summary>
          <div className="ai-settings-panel">
            <label>
              <span>{isEnglish ? "Provider" : "공급자"}</span>
              <select
                value={aiProvider}
                onChange={(event) => {
                  const provider = event.target.value as AiProvider;
                  setAiProvider(provider);
                  setPersonalApiKey("");
                  if (provider !== "lecture-live") setAiModel(personalModelOptions[provider][0].id);
                }}
              >
                <option value="lecture-live">{isEnglish ? "Lecue default AI" : "Lecue 기본 AI"}</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="google">Google Gemini</option>
              </select>
            </label>

            {aiProvider !== "lecture-live" && (
              <>
                <label>
                  <span>{isEnglish ? "Model" : "모델"}</span>
                  <select value={aiModel} onChange={(event) => setAiModel(event.target.value)}>
                    {personalModelOptions[aiProvider].map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                  </select>
                </label>
                <label>
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
                  <button
                    type="button"
                    onClick={saveCredential}
                    disabled={credentialPending || !personalApiKey.trim()}
                  >
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
                <p>
                  {savedCredential
                    ? isEnglish
                      ? "This provider's key is encrypted in your account. Its plaintext is never sent back to the browser."
                      : "이 공급자의 키는 계정에 암호화되어 저장됩니다. 키 원문은 브라우저로 다시 보내지 않습니다."
                    : isEnglish
                      ? "Without saving, the key is used only in this tab. Provider charges apply to your own account."
                      : "저장하지 않으면 이 탭에서만 사용합니다. 질문 비용은 선택한 공급자 계정에 별도로 청구됩니다."}
                </p>
              </>
            )}
          </div>
        </details>

        {status === "recording" || status === "connecting" ? (
          <button className="stop-button" type="button" onClick={stopLecture} disabled={status === "connecting"}>
            {isEnglish ? "End lecture" : "강의 종료"}
          </button>
        ) : (
          <button className="start-button" type="button" onClick={startLecture} disabled={!canStart}>
            {isEnglish ? "Start lecture" : "강의 시작"}
          </button>
        )}

        <form className="signout-form" action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
          <button className="signout-button" type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
        </form>
      </header>

      <div className="error-banner" role="alert">{error}</div>

      <section className="classroom-bar" aria-label={isEnglish ? "Classrooms and saved lectures" : "강의실과 저장된 수업"}>
        <div className="classroom-picker">
          <label>
            <span>{isEnglish ? "Classroom" : "강의실"}</span>
            <select
              value={activeClassroomId}
              onChange={(event) => {
                setActiveClassroomId(event.target.value);
                prepareNewLecture();
              }}
              disabled={status === "recording" || status === "connecting"}
            >
              <option value="">{isEnglish ? "Select a classroom" : "강의실 선택"}</option>
              {classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.title}</option>)}
            </select>
          </label>
          <form onSubmit={createClassroom}>
            <input
              value={newClassroomName}
              onChange={(event) => setNewClassroomName(event.target.value)}
              placeholder={isEnglish ? "New classroom name" : "새 강의실 이름"}
              maxLength={80}
            />
            <button type="submit" disabled={classroomPending || !newClassroomName.trim()}>{isEnglish ? "Create" : "만들기"}</button>
          </form>
          <button type="button" className="new-lecture-button" onClick={prepareNewLecture} disabled={!activeClassroomId || status === "recording" || status === "connecting"}>
            {isEnglish ? "New lecture" : "새 수업"}
          </button>
        </div>
        <div className="session-list">
          {(classrooms.find((classroom) => classroom.id === activeClassroomId)?.sessions ?? []).length === 0 ? (
            <span>{isEnglish ? "Saved lectures in this classroom will appear here." : "이 강의실에서 저장한 수업이 여기에 쌓입니다."}</span>
          ) : (
            classrooms.find((classroom) => classroom.id === activeClassroomId)?.sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className={session.id === activeSessionId ? "active" : undefined}
                onClick={() => void openSession(session.id)}
                disabled={classroomPending || status === "recording" || status === "connecting"}
              >
                <b>{session.title}</b>
                <span>{formatTime(session.duration_seconds * 1_000)} · {session.question_count}{isEnglish ? " Q" : "개 질문"}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="panes">
        <section className="chat-pane" aria-labelledby="chat-title">
          <div className="pane-heading">
            <div>
              <h1 id="chat-title">{isEnglish ? "Ask about the lecture" : "강의에 질문하기"}</h1>
            </div>
            <span className="count">{messages.filter((message) => message.role === "user").length}{isEnglish ? " questions" : "개 질문"}</span>
          </div>

          <div className="messages" aria-live="polite">
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
                  <p className={message.pending ? "pending" : undefined}>{message.text}</p>
                  {message.sources && message.sources.length > 0 && (
                    <div className="sources">
                      <span>{isEnglish ? "External search used" : "외부 검색 사용"}</span>
                      {message.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.title || new URL(source.url).hostname}
                        </a>
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
            <button type="submit" disabled={!canAsk || !question.trim()} aria-label="질문 보내기">
              {isEnglish ? "Send" : "보내기"}
            </button>
          </form>
        </section>

        <section className="transcript-pane" aria-labelledby="transcript-title">
          <div className="pane-heading transcript-heading">
            <div>
              <h2 id="transcript-title">{isEnglish ? "Live transcript" : "실시간 스크립트"}</h2>
            </div>
            <span className="count">{segments.length}{isEnglish ? " paragraphs" : "개 문단"}</span>
          </div>

          <div className="transcript" aria-live="polite" ref={transcriptScrollRef}>
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
                {segments.map((segment) => (
                  <p key={segment.id}>{segment.text}</p>
                ))}
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
          <span>{isEnglish ? "Confirm recording permission before use" : "현장 녹음 권한을 확인한 뒤 사용하세요"}</span>
        </span>
      </footer>
    </main>
  );
}
