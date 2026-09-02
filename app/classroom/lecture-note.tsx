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
  const [remaining, setRemaining] = useState<number | null>(null);

  async function load() {
    try {
      const response = await fetch(`/api/lecture-notes?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await response.json() as { note?: { status: string; content: LectureNote | null } | null; remainingGenerations?: number | null; error?: string };
      if (!response.ok) throw new Error(data.error);
      if (typeof data.remainingGenerations === "number") setRemaining(data.remainingGenerations);
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
    // 생성은 1~2분 걸린다. 다른 탭에 가 있어도 끝나면 알려줄 수 있게 미리 허락을 받는다.
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
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
      setRemaining((current) => (current === null ? null : Math.max(0, current - 1)));
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

  // 생성 완료 순간, 사용자가 이 탭을 보고 있지 않을 때만 브라우저 알림.
  const previousPhaseRef = useRef(phase);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previous === "generating" && phase === "ready" && document.hidden
      && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(isEnglish ? "Your lecture note is ready" : "강의 노트가 완성됐어요", {
        body: isEnglish ? "Come back to review today's lecture." : "돌아와서 오늘 강의를 복습해 보세요.",
      });
    }
  }, [phase, isEnglish]);

  return (
    <div
      className="note-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={isEnglish ? "Lecture note" : "강의 노트"}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="note-panel">
        <header className="note-topbar">
          <strong>{isEnglish ? "Lecture note" : "강의 노트"}</strong>
          <div>
            {remaining !== null && phase !== "loading" && (
              <span className="note-quota">{isEnglish ? `${remaining} left this hour` : `이번 시간 ${remaining}회 남음`}</span>
            )}
            {phase === "ready" && (
              <button type="button" className="note-regenerate" onClick={() => window.print()}>
                {isEnglish ? "Save as PDF" : "PDF 저장"}
              </button>
            )}
            {phase === "ready" && (
              <button type="button" className="note-regenerate" onClick={() => void generate(true)} disabled={remaining === 0}>
                {isEnglish ? "Regenerate" : "다시 만들기"}
              </button>
            )}
            <button type="button" className="banner-dismiss" onClick={onClose} aria-label={isEnglish ? "Close" : "닫기"}>✕</button>
          </div>
        </header>

        {phase === "loading" && <p className="note-status">{isEnglish ? "Loading…" : "불러오는 중…"}</p>}
        {phase === "none" && (
          <div className="note-empty">
            <span className="note-mark" aria-hidden="true">✎</span>
            <h2>{isEnglish ? "Turn this lecture into a note" : "이 강의를 한 권의 노트로"}</h2>
            <p>{isEnglish
              ? "A structured review note built from everything this lecture left behind — with formulas, diagrams, and the material pages that matter."
              : "이 수업이 남긴 모든 기록으로 구조화된 복습 노트를 만듭니다. 수식과 개념 도식, 중요한 자료 페이지까지 함께 정리됩니다."}</p>
            <ul className="note-ingredients">
              <li>{isEnglish ? "Live transcript" : "실시간 스크립트"}</li>
              <li>{isEnglish ? "My questions" : "내가 한 질문"}</li>
              <li>{isEnglish ? "Lecture materials" : "강의 자료"}</li>
            </ul>
            <button type="button" className="note-create-button" onClick={() => void generate(false)}>
              {isEnglish ? "Create note" : "노트 만들기"}
            </button>
          </div>
        )}
        {phase === "generating" && <GeneratingState isEnglish={isEnglish} />}
        {(phase === "failed" || phase === "error") && (
          <div className="note-empty">
            <span className="note-mark" aria-hidden="true">✎</span>
            <p>{message || (isEnglish ? "Could not create the note." : "노트를 만들지 못했습니다.")}</p>
            <button type="button" className="note-create-button" onClick={() => void generate(true)}>
              {isEnglish ? "Try again" : "다시 시도"}
            </button>
          </div>
        )}

        {phase === "ready" && note && <NoteArticle note={note} isEnglish={isEnglish} />}
      </div>
    </div>
  );
}

/** 생성은 1~2분 걸린다. 침묵하는 스피너 대신 지금 어느 단계인지 보여준다. */
function GeneratingState({ isEnglish }: { isEnglish: boolean }) {
  const stages = isEnglish
    ? ["Re-reading the transcript", "Grouping the key concepts", "Setting formulas and diagrams", "Finishing the note"]
    : ["스크립트를 다시 읽는 중", "핵심 개념을 묶는 중", "수식과 도식을 정리하는 중", "노트를 마무리하는 중"];
  const [stage, setStage] = useState(0);

  useEffect(() => {
    // ponytail: 실제 진행률 신호가 없다. 경과 시간으로 단계만 짐작해 보여준다.
    const boundaries = [15_000, 40_000, 75_000];
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setStage(boundaries.filter((boundary) => elapsed >= boundary).length);
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="note-generating" role="status">
      <div className="note-generating-art" aria-hidden="true"><span /><span /><span /></div>
      <strong>{stages[stage]}</strong>
      <div className="note-progress" aria-hidden="true"><i /></div>
      <ol className="note-stages" aria-hidden="true">
        {stages.map((label, index) => (
          <li key={label} className={index < stage ? "done" : index === stage ? "current" : undefined}>{label}</li>
        ))}
      </ol>
      <p>{isEnglish ? "This can take a minute or two. You can close this — the note keeps writing." : "1~2분 정도 걸립니다. 창을 닫아도 노트는 계속 만들어져요."}</p>
    </div>
  );
}

/** 완성된 노트 본문. 패널과 분리해 두면 미리보기·인쇄 화면에서도 그대로 쓴다. */
export function NoteArticle({ note, isEnglish }: { note: LectureNote; isEnglish: boolean }) {
  return (
    <article className="note-body">
      <header className="note-cover">
        <span className="note-cover-label">{isEnglish ? "Lecture note" : "강의 노트"}</span>
        <h1>{note.title}</h1>
        <p className="note-summary">{note.summary}</p>
      </header>
      {note.sections.map((section, sectionIndex) => (
        <section className="note-section" key={sectionIndex}>
          <h2>
            <span aria-hidden="true">{String(sectionIndex + 1).padStart(2, "0")}</span>
            {section.heading}
          </h2>
          {section.blocks.map((block, blockIndex) => <Block key={blockIndex} block={block} />)}
        </section>
      ))}
      <footer className="note-end" aria-hidden="true">◆</footer>
    </article>
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
    case "material":
      return <MaterialPage block={block} />;
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

/**
 * 자료 PDF를 문서 단위로 한 번만 내려받아 여러 material 블록이 나눠 쓴다.
 * ponytail: 모듈 수명 캐시. 서명 URL(15분)이 지나도 이미 연 문서는 계속 그려진다.
 */
const materialPdfCache = new Map<string, Promise<import("pdfjs-dist").PDFDocumentProxy>>();

async function openMaterialPdf(documentId: string) {
  let cached = materialPdfCache.get(documentId);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(`/api/materials?documentId=${encodeURIComponent(documentId)}`);
      const data = await response.json() as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error);
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc =
        new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfjs.getDocument({ url: data.url }).promise;
    })();
    materialPdfCache.set(documentId, cached);
    cached.catch(() => materialPdfCache.delete(documentId));
  }
  return cached;
}

function MaterialPage({ block }: { block: NoteBlock }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!block.documentId) return;
    let cancelled = false;
    (async () => {
      try {
        const pdf = await openMaterialPdf(block.documentId!);
        const page = await pdf.getPage(block.page);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      } catch {
        // 원본 미보관·서명 만료·렌더 실패. 이미지만 접고 캡션은 남긴다.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [block.documentId, block.page]);

  if (!block.documentId || failed) return block.text ? <p>{block.text}</p> : null;
  return (
    <figure className="note-material">
      <canvas ref={canvasRef} />
      <figcaption>{block.label} · p.{block.page}{block.text ? ` — ${block.text}` : ""}</figcaption>
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
