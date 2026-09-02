"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { useEffect, useRef, useState } from "react";

import type { LectureNote, NoteBlock } from "../lib/lecture-note";

type Phase = "loading" | "none" | "generating" | "ready" | "failed" | "error";

/** 강의 종료 후 복습 노트. 열릴 때 조회하고, 없으면 생성 버튼을 보여준다. */
export default function LectureNotePanel({
  sessionId, isEnglish, onClose,
}: { sessionId: string; isEnglish: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [note, setNote] = useState<LectureNote | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const response = await fetch(`/api/lecture-notes?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await response.json() as { note?: { status: string; content: LectureNote | null } | null; error?: string };
      if (!response.ok) throw new Error(data.error);
      if (!data.note) setPhase("none");
      else if (data.note.status === "ready" && data.note.content) { setNote(data.note.content); setPhase("ready"); }
      else if (data.note.status === "generating") setPhase("generating");
      else setPhase("failed");
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not load the note." : "노트를 불러오지 못했습니다.");
      setPhase("error");
    }
  }

  async function generate(force: boolean) {
    setPhase("generating");
    setMessage("");
    try {
      const response = await fetch("/api/lecture-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, force }),
      });
      const data = await response.json() as { note?: { status: string; content: LectureNote | null }; error?: string };
      if (!response.ok && response.status !== 202) throw new Error(data.error);
      if (data.note?.status === "ready" && data.note.content) { setNote(data.note.content); setPhase("ready"); }
      else setPhase("generating");
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : isEnglish ? "Could not create the note." : "노트를 만들지 못했습니다.");
      setPhase("failed");
    }
  }

  useEffect(() => { void load(); }, [sessionId]);

  // 다른 탭이 생성 중이거나 POST가 202로 돌아온 경우. 끝났는지 주기적으로 본다.
  useEffect(() => {
    if (phase !== "generating") return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [phase]);

  return (
    <div className="note-overlay" role="dialog" aria-modal="true" aria-label={isEnglish ? "Lecture note" : "강의 노트"}>
      <div className="note-panel">
        <header className="note-topbar">
          <strong>{isEnglish ? "Lecture note" : "강의 노트"}</strong>
          <div>
            {phase === "ready" && (
              <button type="button" className="note-regenerate" onClick={() => void generate(true)}>
                {isEnglish ? "Regenerate" : "다시 만들기"}
              </button>
            )}
            <button type="button" className="banner-dismiss" onClick={onClose} aria-label={isEnglish ? "Close" : "닫기"}>✕</button>
          </div>
        </header>

        {phase === "loading" && <p className="note-status">{isEnglish ? "Loading…" : "불러오는 중…"}</p>}
        {phase === "none" && (
          <div className="note-empty">
            <p>{isEnglish
              ? "Build a structured review note from this lecture's transcript, your questions, and the materials."
              : "이 수업의 스크립트, 내 질문, 강의 자료를 바탕으로 구조화된 복습 노트를 만듭니다."}</p>
            <button type="button" className="start-button" onClick={() => void generate(false)}>
              {isEnglish ? "Create note" : "노트 만들기"}
            </button>
          </div>
        )}
        {phase === "generating" && (
          <p className="note-status">
            <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />
            {isEnglish ? "Writing the note… this can take a minute or two." : "노트를 작성하는 중입니다… 1~2분 정도 걸릴 수 있어요."}
          </p>
        )}
        {(phase === "failed" || phase === "error") && (
          <div className="note-empty">
            <p>{message || (isEnglish ? "Could not create the note." : "노트를 만들지 못했습니다.")}</p>
            <button type="button" className="start-button" onClick={() => void generate(true)}>
              {isEnglish ? "Try again" : "다시 시도"}
            </button>
          </div>
        )}

        {phase === "ready" && note && (
          <article className="note-body">
            <h1>{note.title}</h1>
            <p className="note-summary">{note.summary}</p>
            {note.sections.map((section, sectionIndex) => (
              <section key={sectionIndex}>
                <h2>{section.heading}</h2>
                {section.blocks.map((block, blockIndex) => <Block key={blockIndex} block={block} />)}
              </section>
            ))}
          </article>
        )}
      </div>
    </div>
  );
}

function Block({ block }: { block: NoteBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p>{block.text}</p>;
    case "list":
      return <ul>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
    case "callout":
      return <aside className="note-callout"><strong>{block.label}</strong><p>{block.text}</p></aside>;
    case "qa":
      return <aside className="note-qa"><strong>Q. {block.label}</strong><p>{block.text}</p></aside>;
    case "formula":
      return <Formula block={block} />;
    case "diagram":
      return <Diagram block={block} />;
    default:
      return null;
  }
}

function Formula({ block }: { block: NoteBlock }) {
  // throwOnError:false — 모델이 문법을 틀려도 원문을 빨간 글씨로 보여줄 뿐 죽지 않는다.
  const html = katex.renderToString(block.latex, { throwOnError: false, displayMode: true });
  return (
    <figure className="note-formula">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {block.text && <figcaption>{block.text}</figcaption>}
    </figure>
  );
}

let diagramSequence = 0;

function Diagram({ block }: { block: NoteBlock }) {
  const [svg, setSvg] = useState("");
  const [broken, setBroken] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
        const { svg: rendered } = await mermaid.render(`lecture-note-diagram-${diagramSequence++}`, block.mermaid);
        if (!cancelled) setSvg(rendered);
      } catch {
        // 모델이 낸 Mermaid가 문법 오류일 때. 다이어그램만 접고 캡션은 남긴다.
        if (!cancelled) setBroken(true);
      }
    })();
    return () => { cancelled = true; };
  }, [block.mermaid]);

  if (broken) return block.text ? <p>{block.text}</p> : null;
  return (
    <figure className="note-diagram">
      <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />
      {block.text && <figcaption>{block.text}</figcaption>}
    </figure>
  );
}
