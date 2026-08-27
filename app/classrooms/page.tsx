"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

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

type MaterialDocument = {
  id: string;
  classroom_id: string;
  filename: string;
  page_count: number;
  created_at: string;
};

type Classroom = {
  id: string;
  title: string;
  locale: "ko" | "en";
  glossary: string;
  created_at: string;
  updated_at: string;
  sessions: SessionSummary[];
};

function formatDuration(seconds: number, isEnglish: boolean) {
  if (seconds < 60) return isEnglish ? `${seconds}s` : `${seconds}초`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (!hours) return isEnglish ? `${minutes}m` : `${minutes}분`;
  return isEnglish ? `${hours}h ${minutes}m` : `${hours}시간 ${minutes}분`;
}

export default function ClassroomsPage({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [unassignedSessions, setUnassignedSessions] = useState<SessionSummary[]>([]);
  const [newClassroomName, setNewClassroomName] = useState("");
  const [renameId, setRenameId] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [glossaryId, setGlossaryId] = useState("");
  const [glossaryText, setGlossaryText] = useState("");
  const [materials, setMaterials] = useState<MaterialDocument[]>([]);
  const [materialsId, setMaterialsId] = useState("");
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { void loadClassrooms(); }, [locale]);

  async function loadClassrooms() {
    setLoading(true);
    try {
      const response = await fetch("/api/classrooms", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      const data = await response.json() as { classrooms?: Classroom[]; unassignedSessions?: SessionSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error);
      setClassrooms(data.classrooms ?? []);
      setUnassignedSessions(data.unassignedSessions ?? []);
      await loadMaterials();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not load your classrooms." : "강의실을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMaterials() {
    try {
      const response = await fetch("/api/materials", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      const data = await response.json() as { documents?: MaterialDocument[] };
      setMaterials(data.documents ?? []);
    } catch {
      // The library still renders without it; the upload row will just show none.
    }
  }

  // Indexing reads the whole PDF with a model, so this is the one action here
  // that takes tens of seconds. The row says so rather than looking frozen.
  async function uploadMaterial(classroomId: string, file: File) {
    setPending(`material-${classroomId}`);
    setError("");
    try {
      const body = new FormData();
      body.set("classroomId", classroomId);
      body.set("file", file);
      const response = await fetch("/api/materials", { method: "POST", headers: { "X-Site-Locale": locale }, body });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      await loadMaterials();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not index this material." : "이 자료를 색인하지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  async function deleteMaterial(documentId: string) {
    setPending(`material-delete-${documentId}`);
    setError("");
    try {
      const response = await fetch(`/api/materials?documentId=${encodeURIComponent(documentId)}`, {
        method: "DELETE",
        headers: { "X-Site-Locale": locale },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      await loadMaterials();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not delete this material." : "이 자료를 삭제하지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  async function createClassroom(event: FormEvent) {
    event.preventDefault();
    const title = newClassroomName.trim();
    if (!title) return;
    setPending("create");
    setError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ title, locale }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setNewClassroomName("");
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  async function renameClassroom(event: FormEvent, classroomId: string) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!title) return;
    setPending(`rename-${classroomId}`);
    setError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ classroomId, title }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setRenameId("");
      setRenameTitle("");
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not rename the classroom." : "강의실 이름을 바꾸지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  // The subject's own vocabulary, sent with every transcription request so a
  // general model stops guessing at terms it has never heard (PRD 36.3.1).
  async function saveGlossary(event: FormEvent, classroomId: string) {
    event.preventDefault();
    setPending(`glossary-${classroomId}`);
    setError("");
    try {
      const response = await fetch("/api/classrooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ classroomId, glossary: glossaryText }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setGlossaryId("");
      setGlossaryText("");
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not save the glossary." : "용어집을 저장하지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  async function moveSession(sessionId: string, classroomId: string | null) {
    setPending(`move-${sessionId}`);
    setError("");
    try {
      const response = await fetch("/api/lecture-sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ action: "move", sessionId, classroomId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      await loadClassrooms();
    } catch (caught) {
      setError(caught instanceof Error && caught.message
        ? caught.message
        : isEnglish ? "Could not move the lecture." : "수업을 이동하지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  function sessionRows(sessions: SessionSummary[], currentClassroomId: string | null) {
    if (!sessions.length) {
      return <p className="classroom-empty">{isEnglish ? "No lectures here yet." : "아직 저장된 수업이 없습니다."}</p>;
    }

    return (
      <div className="classroom-session-list">
        {sessions.map((session) => (
          <article className="classroom-session" key={session.id}>
            <Link href={`${basePath}/classroom?session=${encodeURIComponent(session.id)}`}>
              <strong>{session.title}</strong>
              <span>
                {new Date(session.started_at).toLocaleDateString(isEnglish ? "en-US" : "ko-KR")}
                {" · "}
                {session.status === "recording"
                  ? isEnglish ? "Recording" : "기록 중"
                  : formatDuration(session.duration_seconds, isEnglish)}
                {" · "}{session.question_count}{isEnglish ? " questions" : "개 질문"}
              </span>
            </Link>
            <details className="session-move">
              <summary>{pending === `move-${session.id}` ? (isEnglish ? "Moving…" : "이동 중…") : (isEnglish ? "Move" : "이동")}</summary>
              <div className="session-move-menu">
                {currentClassroomId !== null && (
                  <button type="button" onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    void moveSession(session.id, null);
                  }}>{isEnglish ? "Unassigned" : "미분류 수업"}</button>
                )}
                {classrooms.filter((classroom) => classroom.id !== currentClassroomId).map((classroom) => (
                  <button type="button" key={classroom.id} onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    void moveSession(session.id, classroom.id);
                  }}>{classroom.title}</button>
                ))}
              </div>
            </details>
          </article>
        ))}
      </div>
    );
  }

  return (
    <main className="classrooms-shell">
      <header className="classrooms-topbar">
        <Link className="brand" href={basePath || "/"}>Lecue</Link>
        <nav>
          <Link href={`${basePath}/classroom`}>{isEnglish ? "Live lecture" : "강의 실행"}</Link>
          <Link href={`${basePath}/billing`}>{isEnglish ? "Plans & credits" : "요금제·크레딧"}</Link>
          <form action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
            <button type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
          </form>
        </nav>
      </header>

      <section className="classrooms-intro">
        <div>
          <span>{isEnglish ? "Your lecture library" : "나의 강의 보관함"}</span>
          <h1>{isEnglish ? "Your classrooms" : "나의 강의실"}</h1>
          <p>{isEnglish
            ? "A classroom is the subject-level home. Each live recording becomes a lecture inside it, so Lecue can later connect related lessons. You can also record without choosing one."
            : "강의실은 과목 단위의 상위 공간이고, 녹음한 수업은 그 안에 쌓입니다. 강의실 없이 바로 녹음한 수업은 미분류로 보관했다가 나중에 옮길 수 있습니다."}</p>
        </div>
        <form className="classroom-create" onSubmit={createClassroom}>
          <label htmlFor="new-classroom">{isEnglish ? "New classroom" : "새 강의실"}</label>
          <div>
            <input
              id="new-classroom"
              value={newClassroomName}
              onChange={(event) => setNewClassroomName(event.target.value)}
              placeholder={isEnglish ? "e.g. Microeconomics" : "예: 경제학개론"}
              maxLength={80}
            />
            <button type="submit" disabled={pending === "create" || !newClassroomName.trim()}>
              {pending === "create" ? (isEnglish ? "Creating…" : "만드는 중…") : (isEnglish ? "Create" : "만들기")}
            </button>
          </div>
        </form>
      </section>

      {error && <p className="classrooms-error" role="alert">{error}</p>}

      <section className="classrooms-library" aria-busy={loading}>
        {loading ? (
          <p className="classrooms-loading">{isEnglish ? "Loading your lecture library…" : "강의 보관함을 불러오는 중입니다…"}</p>
        ) : (
          <>
            <article className="classroom-unit classroom-unit-unassigned">
              <header>
                <div className="classroom-index">00</div>
                <div>
                  <span>{isEnglish ? "No classroom" : "강의실 없음"}</span>
                  <h2>{isEnglish ? "Unassigned lectures" : "미분류 수업"}</h2>
                </div>
                <p>{unassignedSessions.length}{isEnglish ? " lectures" : "개 수업"}</p>
                <Link href={`${basePath}/classroom`}>{isEnglish ? "Start unassigned" : "바로 수업 시작"}</Link>
              </header>
              {sessionRows(unassignedSessions, null)}
            </article>

            {classrooms.map((classroom, index) => {
              const totalSeconds = classroom.sessions.reduce((sum, session) => sum + session.duration_seconds, 0);
              return (
                <article className="classroom-unit" key={classroom.id}>
                  <header>
                    <div className="classroom-index">{String(index + 1).padStart(2, "0")}</div>
                    <div>
                      <span>{isEnglish ? "Classroom" : "강의실"}</span>
                      <h2>{classroom.title}</h2>
                    </div>
                    <p>{classroom.sessions.length}{isEnglish ? " lectures" : "개 수업"} · {formatDuration(totalSeconds, isEnglish)}</p>
                    <div className="classroom-actions">
                      <button type="button" onClick={() => {
                        setRenameId(renameId === classroom.id ? "" : classroom.id);
                        setRenameTitle(classroom.title);
                      }}>{isEnglish ? "Rename" : "이름 변경"}</button>
                      <button type="button" onClick={() => {
                        setGlossaryId(glossaryId === classroom.id ? "" : classroom.id);
                        setGlossaryText(classroom.glossary ?? "");
                      }}>{isEnglish ? "Glossary" : "용어집"}</button>
                      <button type="button" onClick={() => setMaterialsId(materialsId === classroom.id ? "" : classroom.id)}>
                        {isEnglish ? "Materials" : "강의 자료"}
                      </button>
                      <Link href={`${basePath}/classroom?classroom=${encodeURIComponent(classroom.id)}`}>{isEnglish ? "Start lecture" : "수업 시작"}</Link>
                    </div>
                  </header>
                  {renameId === classroom.id && (
                    <form className="classroom-rename" onSubmit={(event) => void renameClassroom(event, classroom.id)}>
                      <label htmlFor={`rename-${classroom.id}`}>{isEnglish ? "Classroom name" : "강의실 이름"}</label>
                      <input id={`rename-${classroom.id}`} value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} maxLength={80} autoFocus />
                      <button type="submit" disabled={pending === `rename-${classroom.id}` || !renameTitle.trim()}>{isEnglish ? "Save" : "저장"}</button>
                    </form>
                  )}
                  {glossaryId === classroom.id && (
                    <form className="classroom-rename classroom-glossary" onSubmit={(event) => void saveGlossary(event, classroom.id)}>
                      <label htmlFor={`glossary-${classroom.id}`}>
                        {isEnglish ? "Subject terms, separated by commas" : "과목 용어 (쉼표로 구분)"}
                      </label>
                      <textarea
                        id={`glossary-${classroom.id}`}
                        value={glossaryText}
                        onChange={(event) => setGlossaryText(event.target.value)}
                        placeholder={isEnglish ? "e.g. Fourier transform, eigenvalue, convolution" : "예: 푸리에 변환, 고윳값, 합성곱"}
                        maxLength={1_200}
                        rows={3}
                      />
                      <button type="submit" disabled={pending === `glossary-${classroom.id}`}>
                        {pending === `glossary-${classroom.id}` ? (isEnglish ? "Saving…" : "저장 중…") : (isEnglish ? "Save" : "저장")}
                      </button>
                      <small>{isEnglish
                        ? "Up to 60 terms. They are sent with every transcription request for this classroom."
                        : "최대 60개. 이 강의실의 모든 받아쓰기 요청에 함께 전달됩니다."}</small>
                    </form>
                  )}
                  {materialsId === classroom.id && (
                    <div className="classroom-rename classroom-materials">
                      <label htmlFor={`material-${classroom.id}`}>{isEnglish ? "Lecture materials (PDF)" : "강의 자료 (PDF)"}</label>
                      <div>
                        <input
                          id={`material-${classroom.id}`}
                          type="file"
                          accept="application/pdf"
                          disabled={pending === `material-${classroom.id}`}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void uploadMaterial(classroom.id, file);
                          }}
                        />
                        <ul>
                          {materials.filter((document) => document.classroom_id === classroom.id).map((document) => (
                            <li key={document.id}>
                              <span>{document.filename}</span>
                              <small>{document.page_count}{isEnglish ? " pages" : "쪽"}</small>
                              <button
                                type="button"
                                onClick={() => void deleteMaterial(document.id)}
                                disabled={pending === `material-delete-${document.id}`}
                              >{isEnglish ? "Remove" : "삭제"}</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <small>{pending === `material-${classroom.id}`
                        ? isEnglish ? "Reading the slides… this can take up to a minute." : "슬라이드를 읽는 중입니다. 1분 정도 걸릴 수 있습니다."
                        : isEnglish
                          ? "Up to 20MB per PDF. Formulas, tables, and figures are read as text; the file itself is not stored."
                          : "PDF 1개당 20MB까지. 수식·표·그림을 텍스트로 읽어 답변 맥락에 씁니다. 원본 파일은 저장하지 않습니다."}</small>
                    </div>
                  )}
                  {sessionRows(classroom.sessions, classroom.id)}
                </article>
              );
            })}

            {!classrooms.length && !unassignedSessions.length && (
              <div className="classrooms-first-run">
                <strong>{isEnglish ? "Your first lecture can start now." : "첫 수업은 지금 바로 시작할 수 있습니다."}</strong>
                <p>{isEnglish ? "Create a classroom first, or record without one and organize it later." : "먼저 강의실을 만들어도 되고, 강의실 없이 녹음한 뒤 나중에 정리해도 됩니다."}</p>
                <Link href={`${basePath}/classroom`}>{isEnglish ? "Open live lecture" : "강의 실행 화면 열기"}</Link>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
