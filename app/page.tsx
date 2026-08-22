"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Status = "idle" | "connecting" | "recording" | "ended" | "error";

type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type Source = { title: string; url: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sources?: Source[];
};

type DeepgramResult = {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

const statusCopy: Record<Status, string> = {
  idle: "시작 전",
  connecting: "연결 중",
  recording: "기록 중",
  ended: "종료됨",
  error: "연결 확인 필요",
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

function safeSource(source: Source) {
  try {
    const url = new URL(source.url);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export default function LectureWorkspace() {
  const [status, setStatus] = useState<Status>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [lectureTitle, setLectureTitle] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const segmentIdsRef = useRef(new Set<string>());
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [status]);

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

  async function startLecture() {
    setError("");
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
        throw new Error(tokenData.error ?? "음성 인식 토큰을 받지 못했습니다.");
      }

      const params = new URLSearchParams({
        model: "nova-3",
        language: "ko",
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
            setSegments((current) => [...current, { id, startMs, endMs, text }]);
          }
          setInterim("");
        } else {
          setInterim(text);
        }
      };

      socket.onerror = () => {
        setError("음성 인식 연결에 실패했습니다. 네트워크와 API 설정을 확인해 주세요.");
        setStatus("error");
      };

      socket.onclose = () => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      };
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const message = caught instanceof Error ? caught.message : "마이크를 시작하지 못했습니다.";
      setError(message);
      setStatus("error");
    }
  }

  function stopLecture() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setStatus("ended");
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!cleanQuestion || messages.some((message) => message.pending)) return;

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
      { id: assistantId, role: "assistant", text: "강의 흐름을 확인하고 있습니다…", pending: true },
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
        }),
      });
      const data = (await response.json()) as { answer?: string; sources?: Source[]; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error ?? "답변을 받지 못했습니다.");

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: data.answer!,
                pending: false,
                sources: (data.sources ?? []).filter(safeSource),
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
                text: caught instanceof Error ? caught.message : "답변을 만들지 못했습니다.",
                pending: false,
              }
            : message,
        ),
      );
    }
  }

  const canStart = status === "idle" || status === "ended" || status === "error";
  const canAsk = (segments.length > 0 || interim.length > 0) && !messages.some((message) => message.pending);

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand" aria-label="Lecture Live">
          <span>Lecture Live</span>
        </div>

        <label className="title-field">
          <span className="sr-only">강의 제목</span>
          <input
            value={lectureTitle}
            onChange={(event) => setLectureTitle(event.target.value)}
            placeholder="강의 제목을 입력하세요"
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
            강의 종료
          </button>
        ) : (
          <button className="start-button" type="button" onClick={startLecture} disabled={!canStart}>
            강의 시작
          </button>
        )}

        <form className="signout-form" action="/auth/signout" method="post">
          <button className="signout-button" type="submit">로그아웃</button>
        </form>
      </header>

      <div className="error-banner" role="alert">{error}</div>

      <section className="panes">
        <section className="chat-pane" aria-labelledby="chat-title">
          <div className="pane-heading">
            <div>
              <h1 id="chat-title">강의에 질문하기</h1>
            </div>
            <span className="count">{messages.filter((message) => message.role === "user").length}개 질문</span>
          </div>

          <div className="messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>강의가 시작되면 바로 물어보세요.</p>
                <span>“방금 말한 CIB가 뭐야?”처럼 질문해도 강의 흐름을 기준으로 답합니다.</span>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`}>
                  <span className="message-label">{message.role === "user" ? "나" : "강의 조교 · AI"}</span>
                  <p className={message.pending ? "pending" : undefined}>{message.text}</p>
                  {message.sources && message.sources.length > 0 && (
                    <div className="sources">
                      <span>외부 검색 사용</span>
                      {message.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.title || new URL(source.url).hostname}
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              ))
            )}
          </div>

          <form className="question-form" onSubmit={askQuestion}>
            <label htmlFor="question" className="sr-only">질문 입력</label>
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
              placeholder={canAsk ? "이 강의에 대해 질문하세요" : "스크립트가 들어오면 질문할 수 있습니다"}
              maxLength={1_000}
              disabled={!canAsk}
              rows={2}
            />
            <button type="submit" disabled={!canAsk || !question.trim()} aria-label="질문 보내기">
              보내기
            </button>
          </form>
        </section>

        <section className="transcript-pane" aria-labelledby="transcript-title">
          <div className="pane-heading transcript-heading">
            <div>
              <h2 id="transcript-title">실시간 스크립트</h2>
            </div>
            <span className="count">{segments.length}개 문단</span>
          </div>

          <div className="transcript" aria-live="polite" ref={transcriptScrollRef}>
            {segments.length === 0 && !interim ? (
              <div className="empty-transcript">
                <p>{status === "connecting" ? "마이크와 연결하는 중입니다" : "강의를 시작하면 말이 이곳에 쌓입니다"}</p>
                <span>노트북을 강사와 가까운 곳에 두면 인식률이 좋아집니다.</span>
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
        <span>AI 자동 변환 · 오류가 있을 수 있습니다</span>
        <span>현장 녹음 권한을 확인한 뒤 사용하세요</span>
      </footer>
    </main>
  );
}
