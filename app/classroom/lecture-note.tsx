"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { AnswerMarkdown } from "./answer-markdown";
import LearningAnswer from "./learning-answer";
import "./learning-answer.css";
import "./lecture-note.css";
import WorkspaceDialog from "./workspace-dialog";
import { noteOverview } from "./note-overview";
import { NoteGenerationAnimation } from "./note-generation";
import type { useLectureNote } from "./use-lecture-note";
import NoteLanguagePicker from "./note-language-picker";
import type { NoteLanguage, NoteLanguagePreference } from "../lib/note-language";

import type { LectureNote, NoteBlock } from "../lib/lecture-note";
import { safeNoteDiagram } from "../lib/mermaid-safety";

/** The workspace owns generation state, so closing the dialog does not reset it. */
export default function LectureNotePanel({
  state, isEnglish, languagePreference, systemLanguage, outputLanguage, onLanguageChange, onClose,
}: { state: ReturnType<typeof useLectureNote>; isEnglish: boolean; languagePreference: NoteLanguagePreference;
  systemLanguage: NoteLanguage; outputLanguage: NoteLanguage; onLanguageChange(value: NoteLanguagePreference): void; onClose: () => void }) {
  const { phase, note, message, remaining, startedAt, generate, reload } = state;
  return (
    <WorkspaceDialog label={isEnglish ? "Review note" : "복습 노트"} onClose={onClose}>
      <div className={`note-panel review-note-panel${!note || phase === "generating" ? " is-preparing" : ""}`}>
        <header className="note-topbar">
          <strong>{isEnglish ? "Review note" : "복습 노트"}</strong>
          <div>
            {remaining !== null && phase !== "loading" && (
              <span className="note-quota">{isEnglish ? `${remaining} left today` : `오늘 ${remaining}회 남음`}</span>
            )}
            {note && phase !== "generating" && (
              <button type="button" className="note-regenerate" onClick={() => window.print()}>
                {isEnglish ? "Save as PDF" : "PDF 저장"}
              </button>
            )}
            {note && phase !== "generating" && (
              <button type="button" className="note-regenerate" onClick={() => phase === "error" ? void reload() : void generate(true)} disabled={phase !== "error" && remaining === 0}>
                {phase === "error" ? (isEnglish ? "Check status" : "상태 다시 확인") : (isEnglish ? "Regenerate" : "다시 만들기")}
              </button>
            )}
            <button type="button" className="banner-dismiss" onClick={onClose} aria-label={isEnglish ? "Back to lecture" : "강의실로 돌아가기"}>✕</button>
          </div>
        </header>

        <div className="note-language-toolbar">
          <span>{isEnglish ? "Write in" : "작성 언어"}</span>
          <NoteLanguagePicker value={languagePreference} systemLanguage={systemLanguage} isEnglish={isEnglish}
            onChange={onLanguageChange} disabled={phase === "loading" || phase === "generating"} />
          {note && phase !== "generating" && note.language !== outputLanguage && <p>
            {isEnglish ? "Regenerate to apply this language." : "다시 만들면 선택한 언어로 작성돼요."}
          </p>}
        </div>

        {phase === "loading" && <p className="note-status">{isEnglish ? "Loading…" : "불러오는 중…"}</p>}
        {phase === "none" && (
          <div className="note-empty">
            <h2>{isEnglish ? "Review this lecture" : "수업 복습하기"}</h2>
            <p>{isEnglish
              ? "Create a note with the main points, explanations, and your questions."
              : "핵심 내용과 필요한 설명, 수업 중 했던 질문을 정리합니다."}</p>
            <button type="button" className="note-create-button" disabled={remaining === 0} onClick={() => void generate(false)}>
              {isEnglish ? "Create note" : "노트 만들기"}
            </button>
          </div>
        )}
        {phase === "generating" && <GeneratingState isEnglish={isEnglish} startedAt={startedAt} message={message} />}
        {(phase === "failed" || phase === "error") && !note && (
          <div className="note-empty">
            <span className="note-mark" aria-hidden="true">✎</span>
            <p>{message || (isEnglish ? "Could not create the note." : "노트를 만들지 못했습니다.")}</p>
            <button type="button" className="note-create-button" disabled={phase === "failed" && remaining === 0} onClick={() => phase === "error" ? void reload() : void generate(true)}>
              {phase === "error" ? (isEnglish ? "Reload note" : "노트 다시 불러오기") : (isEnglish ? "Try again" : "다시 시도")}
            </button>
          </div>
        )}

        {phase !== "generating" && note && <>
          {(message || phase === "failed") && <p className="note-update-message" role="alert">
            <strong>{isEnglish ? "Your previous note is still available." : "이전에 만든 노트는 그대로 있어요."}</strong>
            <span>{message || (isEnglish ? "The new note could not be completed. You can try again." : "새 노트를 완성하지 못했습니다. 다시 시도해 주세요.")}</span>
          </p>}
          <NoteArticle note={note} isEnglish={isEnglish} />
        </>}
      </div>
    </WorkspaceDialog>
  );
}

/** Elapsed time comes from the persisted job start, never from opening the dialog. */
export function GeneratingState({ isEnglish, startedAt, message }: { isEnglish: boolean; startedAt: string | null; message?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1_000)) : null;
  const elapsed = seconds === null ? null : isEnglish
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} elapsed`
    : `${seconds >= 60 ? `${Math.floor(seconds / 60)}분 ` : ""}${seconds % 60}초 경과`;
  return (
    <div className="note-generating">
      <NoteGenerationAnimation />
      <strong role="status">{isEnglish ? "Creating your note" : "노트 작성 중"}</strong>
      <p>{isEnglish ? "Organizing the lecture and your questions." : "강의 내용과 질문을 정리하고 있어요."}</p>
      <span className="note-wait-detail" aria-live="off">{elapsed ?? (isEnglish ? "Preparing…" : "생성 준비 중…")}</span>
      <p className="note-generation-reassurance">{isEnglish ? "You can leave this view. Your note will keep being created." : "다른 화면을 보고 와도 노트는 계속 만들어집니다."}</p>
      {message && <p className="note-generation-error" role="status">{message}</p>}
    </div>
  );
}

/** The same article is used by the saved note, local preview and print view. */
export function NoteArticle({ note, isEnglish }: { note: LectureNote; isEnglish: boolean }) {
  const articleRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState(0);
  const questions = note.sections.flatMap((section, sectionIndex) => section.blocks
    .flatMap((block, blockIndex) => block.type === "qa" && block.label.trim() && isStudentQuestion(block)
      ? [{ question: block.label, anchor: `note-block-${sectionIndex}-${blockIndex}` }] : []));
  const overview = noteOverview(note);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const sections = [...article.querySelectorAll<HTMLElement>(".note-section")];
    let frame = 0;
    const update = () => {
      frame = 0;
      const readingLine = article.getBoundingClientRect().top + 100;
      const atEnd = article.scrollHeight > article.clientHeight && article.scrollTop + article.clientHeight >= article.scrollHeight - 2;
      const current = atEnd ? sections.at(-1) : sections.filter(section => section.getBoundingClientRect().top <= readingLine).at(-1);
      setActiveSection(Number(current?.dataset.section ?? 0));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    article.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(article);
    schedule();
    return () => { article.removeEventListener("scroll", schedule); resize.disconnect(); cancelAnimationFrame(frame); };
  }, [note]);

  useEffect(() => {
    let openedForPrint: HTMLDetailsElement[] = [];
    function beforePrint() {
      openedForPrint = [...(articleRef.current?.querySelectorAll<HTMLDetailsElement>(".note-check-answer:not([open]), .note-check-hint:not([open]), .note-overview-details:not([open]), .note-diagram-details:not([open]), .answer-check details:not([open])") ?? [])];
      openedForPrint.forEach(detail => { detail.open = true; });
    }
    function afterPrint() {
      openedForPrint.forEach(detail => { detail.open = false; });
      openedForPrint = [];
    }
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => { window.removeEventListener("beforeprint", beforePrint); window.removeEventListener("afterprint", afterPrint); };
  }, []);

  return (
    <article className="note-body note-reading" ref={articleRef}>
      <details className="note-mobile-outline">
        <summary><span>{isEnglish ? "Contents" : "목차"}</span><span className="note-current-section">{note.sections[activeSection]?.heading}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <nav aria-label={isEnglish ? "Note contents" : "노트 목차"} onClick={event => {
          const link = event.target instanceof Element ? event.target.closest("a") : null;
          const anchor = link?.getAttribute("href");
          const destination = anchor?.startsWith("#") ? articleRef.current?.querySelector<HTMLElement>(anchor) : null;
          if (!destination) return;
          event.preventDefault();
          event.currentTarget.closest("details")?.removeAttribute("open");
          destination.focus({ preventScroll: true });
          destination.scrollIntoView({ block: "start", behavior: "instant" });
        }}>
          {note.sections.map((section, index) => <a href={`#note-section-${index}`} aria-current={activeSection === index ? "location" : undefined} key={index}>{section.heading}</a>)}
          {questions.length > 0 && <><h2>{isEnglish ? "Your questions" : "내 질문"}</h2>{questions.map(({ question, anchor }, index) => <a href={`#${anchor}`} key={`question-${index}`}>{question}</a>)}</>}
        </nav>
      </details>
      <div className="note-document" lang={note.language ?? (isEnglish ? "en" : "ko")}>
      <header className="note-cover">
        <h1>{note.title}</h1>
        {overview.summary && <div className="note-one-line-summary"><span>{isEnglish ? "In one sentence" : "한 줄 요약"}</span><AnswerMarkdown text={overview.summary} /></div>}
      </header>
      {(overview.points.length > 0 || overview.details.length > 0) && <section className="note-key-points" data-kind={overview.kind} aria-label={overview.kind === "keyPoints" ? (isEnglish ? "Key points" : "핵심") : (isEnglish ? "Topics" : "주요 주제")}>
        <h2>{overview.kind === "keyPoints" ? (isEnglish ? "Key points" : "핵심") : (isEnglish ? "Topics" : "주요 주제")}</h2>
        <ul>{overview.points.map((point, index) => <li key={index}>{overview.kind === "topics" ? point : <AnswerMarkdown text={point} />}</li>)}</ul>
        {overview.details.length > 0 && <details className="note-overview-details">
          <summary>{isEnglish ? "More detail" : "추가 설명"}<ChevronDown size={14} aria-hidden="true" /></summary>
          {overview.details.map((point, index) => <AnswerMarkdown text={point} key={index} />)}
        </details>}
      </section>}
      {note.sections.map((section, sectionIndex) => (
        <section className="note-section" id={`note-section-${sectionIndex}`} data-section={sectionIndex} key={sectionIndex} tabIndex={-1}>
          <h2>{section.heading}</h2>
          {section.blocks.map((block, blockIndex) => <div className="note-block" id={`note-block-${sectionIndex}-${blockIndex}`} key={blockIndex} tabIndex={-1}>
            <Block block={block} isEnglish={isEnglish} />
            {!!block.sources?.length && <BlockSources sources={block.sources} isEnglish={isEnglish} />}
          </div>)}
        </section>
      ))}
      </div>
      <aside className="note-outline" aria-label={isEnglish ? "Note navigation" : "노트 탐색"}>
        <nav aria-label={isEnglish ? "Contents" : "목차"}>
          <h2>{isEnglish ? "Contents" : "목차"}</h2>
          {note.sections.map((section, index) => <a href={`#note-section-${index}`} aria-current={activeSection === index ? "location" : undefined} key={index}>{section.heading}</a>)}
        </nav>
        {questions.length > 0 && <nav className="note-question-nav" aria-label={isEnglish ? "Your questions" : "내 질문"}>
          <h2>{isEnglish ? "Your questions" : "내 질문"}</h2>
          {questions.map(({ question, anchor }, index) => <a href={`#${anchor}`} key={index}>{question}</a>)}
        </nav>}
      </aside>
    </article>
  );
}

function isStudentQuestion(block: NoteBlock) {
  return block.sources?.some(source => /^Q\d+$/.test(source.id)) ?? false;
}

function Block({ block, isEnglish }: { block: NoteBlock; isEnglish: boolean }) {
  switch (block.type) {
    case "paragraph":
      return <AnswerMarkdown text={block.text} />;
    case "list":
    case "steps": {
      const List = block.type === "steps" ? "ol" : "ul";
      const entries = block.entries?.length ? block.entries : block.items.map(text => ({ text, children: [] }));
      return <List className={block.type === "steps" ? "note-steps" : "note-list"}>{entries.map((entry, index) => <li key={index}>
        <AnswerMarkdown text={entry.text} />
        {entry.children?.length > 0 && <ul>{entry.children.map((child, childIndex) => <li key={childIndex}><AnswerMarkdown text={child} /></li>)}</ul>}
      </li>)}</List>;
    }
    case "table":
      return <figure className="note-table">
        {block.label && <figcaption>{block.label}</figcaption>}
        <div className="note-table-scroll" tabIndex={0} role="region" aria-label={block.label || (isEnglish ? "Comparison table" : "비교 표")}>
          <table><thead><tr>{block.columns?.map((column, index) => <th scope="col" key={index}><AnswerMarkdown text={column} /></th>)}</tr></thead>
            <tbody>{block.rows?.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}><AnswerMarkdown text={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
        {block.text && <div className="note-caption"><AnswerMarkdown text={block.text} /></div>}
      </figure>;
    case "check":
      return <aside className="note-check">
        <span className="note-block-label">{isEnglish ? "Check your understanding" : "이해 확인"}</span>
        <div className="note-check-question"><AnswerMarkdown text={block.label} /></div>
        {block.hint && <details className="note-check-hint"><summary>{isEnglish ? "Hint" : "힌트 보기"}<ChevronDown size={14} aria-hidden="true" /></summary><AnswerMarkdown text={block.hint} /></details>}
        <details className="note-check-answer"><summary>{isEnglish ? "Answer & explanation" : "정답과 해설 보기"}<ChevronDown size={14} aria-hidden="true" /></summary><div className="note-check-solution"><AnswerMarkdown text={block.text} /></div></details>
      </aside>;
    case "callout":
      return <aside className="note-callout"><div className="note-block-title"><AnswerMarkdown text={block.label} /></div><AnswerMarkdown text={block.text} /></aside>;
    case "qa":
      return <aside className="note-qa"><span className="note-block-label">{isStudentQuestion(block) ? (isEnglish ? "Your question" : "내 질문") : (isEnglish ? "Q&A" : "질문 정리")}</span><div className="note-block-title"><AnswerMarkdown text={block.label} /></div>
        {block.originalAnswers?.length ? <>
          <p className="note-answer-provenance">{isEnglish ? "Saved AI answer · original examples and visuals" : "AI 답변 원문 · 예제와 시각화 포함"}</p>
          {block.originalAnswers.map(answer => <div className="note-original-answer" key={answer.id}><LearningAnswer text={answer.text} isEnglish={isEnglish} /></div>)}
        </> : <AnswerMarkdown text={block.text} />}
        {!!block.originalQuestions?.length && <details className="note-original-questions"><summary>{isEnglish ? "Original questions" : "원래 질문"}{block.originalQuestions.length > 1 && ` · ${block.originalQuestions.length}`}<ChevronDown size={13} aria-hidden="true" /></summary><ul>{block.originalQuestions.map(question => <li key={question.id}>{question.text}</li>)}</ul></details>}
      </aside>;
    case "formula":
      return <Formula block={block} />;
    case "diagram":
      return <Diagram key={block.mermaid} block={block} isEnglish={isEnglish} />;
    case "material":
      return <MaterialPage key={`${block.documentId}:${block.page}`} block={block} isEnglish={isEnglish} />;
    default:
      return null;
  }
}

function BlockSources({ sources, isEnglish }: { sources: NonNullable<NoteBlock["sources"]>; isEnglish: boolean }) {
  // Transcript and question provenance stays in the saved note, without timestamp clutter.
  const materials = sources.filter(source => source.documentId && source.page && Number.isInteger(source.page) && source.page > 0);
  if (!materials.length) return null;
  return <div className="note-block-sources" aria-label={isEnglish ? "Course materials" : "강의 자료"}>
    {materials.map(source => <MaterialSource key={source.id} documentId={source.documentId!} page={source.page!} label={source.label} isEnglish={isEnglish} />)}
  </div>;
}

function MaterialSource({ documentId, page, label, isEnglish }: { documentId: string; page: number; label: string; isEnglish: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="note-source-material" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<ChevronDown size={12} aria-hidden="true" /></summary>
    {open && <MaterialPage key={`${documentId}:${page}`} isEnglish={isEnglish} sourceCaption={label} block={{ type: "material", documentId, page, label, text: "", items: [], latex: "", mermaid: "" }} />}
  </details>;
}

function Formula({ block }: { block: NoteBlock }) {
  // throwOnError:false — 모델이 문법을 틀려도 원문을 빨간 글씨로 보여줄 뿐 죽지 않는다.
  const html = katex.renderToString(block.latex, { throwOnError: false, displayMode: true });
  return (
    <figure className="note-formula">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {block.text && <figcaption><AnswerMarkdown text={block.text} /></figcaption>}
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
        `/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
      return pdfjs.getDocument({ url: data.url }).promise;
    })();
    materialPdfCache.set(documentId, cached);
    cached.catch(() => materialPdfCache.delete(documentId));
  }
  return cached;
}

function MaterialPage({ block, isEnglish, sourceCaption }: { block: NoteBlock; isEnglish: boolean; sourceCaption?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const caption = sourceCaption ?? `${block.label} · p.${block.page}`;

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

  if (!block.documentId) return block.text ? <AnswerMarkdown text={block.text} /> : null;
  if (failed) return <div className="note-material-fallback"><p role="status">{isEnglish ? "The material preview is unavailable." : "자료 미리보기를 불러오지 못했어요."}</p>{block.text && <AnswerMarkdown text={block.text} />}</div>;
  return (
    <figure className="note-material">
      <canvas ref={canvasRef} role="img" aria-label={caption} />
      <figcaption><span>{caption}</span>{block.text && <AnswerMarkdown text={block.text} />}</figcaption>
    </figure>
  );
}

let diagramSequence = 0;

function Diagram({ block, isEnglish }: { block: NoteBlock; isEnglish: boolean }) {
  const [svg, setSvg] = useState("");
  const [broken, setBroken] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Persisted notes are untrusted too. Guard before Mermaid can fetch resources.
        const source = safeNoteDiagram(block.mermaid);
        if (!source) throw new Error("unsupported diagram");
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } });
        const { svg: rendered } = await mermaid.render(`lecture-note-diagram-${diagramSequence++}`, source);
        if (!cancelled) setSvg(rendered);
      } catch {
        // 모델이 낸 Mermaid가 문법 오류일 때. 다이어그램만 접고 캡션은 남긴다.
        if (!cancelled) setBroken(true);
      }
    })();
    return () => { cancelled = true; };
  }, [block.mermaid]);

  if (broken) return block.text ? <AnswerMarkdown text={block.text} /> : null;
  return (
    <figure className="note-diagram">
      {block.text && <figcaption><AnswerMarkdown text={block.text} /></figcaption>}
      <details className="note-diagram-details">
        <summary>{isEnglish ? "Diagram" : "도식 보기"}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />
      </details>
    </figure>
  );
}
