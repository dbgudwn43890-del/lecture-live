"use client";

import { useEffect, useRef, useState } from "react";
import "./material-list.css";

export type ListedMaterial = { id: string; filename: string; page_count: number };
export type MaterialUploadState = { filename: string; status: "pending" | "failed"; error?: string; replacingId?: string };
type Preview = { status: "ready" | "empty"; preview: string };
type MaterialListProps = {
  documents: ListedMaterial[];
  locale: "ko" | "en";
  upload?: MaterialUploadState | null;
  busy?: boolean;
  defaultOpen?: boolean;
  onRemove(id: string): unknown | Promise<unknown>;
  onReplace(id: string, file: File): unknown | Promise<unknown>;
};
const ACCEPTED_FILES = ".pdf,.docx,.pptx,.txt,.csv,.tsv,.xlsx,.xls";
const MAX_DOCUMENTS = 20;

function MaterialRow({ document, english, busy, replacementFull, onRemove, onReplace }: {
  document: ListedMaterial; english: boolean; busy: boolean; replacementFull: boolean;
  onRemove: MaterialListProps["onRemove"]; onReplace: MaterialListProps["onReplace"];
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPhase, setPreviewPhase] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [action, setAction] = useState<"remove" | "replace" | null>(null);
  const [actionError, setActionError] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const disabled = busy || action !== null;

  async function loadPreview() {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setPreviewPhase("loading");
    try {
      const response = await fetch(`/api/materials?documentId=${encodeURIComponent(document.id)}&preview=text`, {
        headers: { "X-Site-Locale": english ? "en" : "ko" }, cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      const data = await response.json() as Partial<Preview>;
      if (!response.ok || !["ready", "empty"].includes(data.status ?? "") || typeof data.preview !== "string") throw new Error();
      if (controller.signal.aborted) return;
      setPreview({ status: data.status as Preview["status"], preview: data.preview });
      setPreviewPhase("done");
    } catch {
      if (!controller.signal.aborted) setPreviewPhase("error");
    } finally { if (controllerRef.current === controller) controllerRef.current = null; }
  }

  async function perform(kind: "remove" | "replace", file?: File) {
    if (disabled || (kind === "replace" && (!file || replacementFull))) return;
    setAction(kind);
    setActionError(false);
    try {
      if (kind === "remove") await onRemove(document.id);
      else await onReplace(document.id, file!);
    } catch { setActionError(true); }
    finally { setAction(null); }
  }

  const pdf = document.filename.toLowerCase().endsWith(".pdf");
  const count = document.page_count > 0 ? english
    ? `${document.page_count} ${pdf ? (document.page_count === 1 ? "page" : "pages") : (document.page_count === 1 ? "section" : "sections")}`
    : `${document.page_count}${pdf ? "쪽" : "개 구간"}` : "";
  return <li className="material-entry">
    <div className="material-entry-heading">
      <strong>{document.filename}</strong>
      <span>{preview?.status === "empty" ? (english ? "Text not confirmed" : "본문 확인 안 됨")
        : (english ? "Reading complete" : "읽기 완료")}{count && ` · ${count}`}</span>
    </div>
    <details className="material-text-preview" onToggle={event => {
      if (event.currentTarget.open && previewPhase === "idle") void loadPreview();
    }}>
      <summary>{english ? "Read extracted text" : "읽은 내용 확인"}</summary>
      <div className="material-preview-body">
        {previewPhase === "idle" || previewPhase === "loading" ? <p role="status">{english ? "Loading extracted text…" : "읽은 내용을 불러오는 중…"}</p>
          : previewPhase === "error" ? <p role="status">{english ? "Could not load the preview." : "미리보기를 불러오지 못했어요."} <button type="button" onClick={() => void loadPreview()}>{english ? "Try again" : "다시 확인"}</button></p>
          : preview?.status === "empty" ? <p>{english ? "No readable text was found in the stored index. Try replacing the file." : "저장된 자료에서 읽을 수 있는 본문을 확인하지 못했어요. 파일을 교체해 주세요."}</p>
          : <><p className="material-preview-text">{preview?.preview}</p><small>{english ? "Excerpt of extracted text. Images and layout may differ from the original." : "추출한 본문의 일부입니다. 그림과 배치는 원본과 다를 수 있어요."}</small></>}
      </div>
    </details>
    <div className="material-entry-actions">
      <label className="material-replace" aria-disabled={disabled || replacementFull}>
        <input type="file" accept={ACCEPTED_FILES} disabled={disabled || replacementFull}
          aria-label={english ? `Replace ${document.filename}` : `${document.filename} 교체`}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void perform("replace", file); }} />
        {action === "replace" ? (english ? "Replacing…" : "교체 중…") : (english ? "Replace file" : "파일 교체")}
      </label>
      <button type="button" disabled={disabled} onClick={() => void perform("remove")}
        aria-label={english ? `Remove ${document.filename}` : `${document.filename} 삭제`}>
        {action === "remove" ? (english ? "Removing…" : "삭제 중…") : (english ? "Remove" : "삭제")}
      </button>
    </div>
    {actionError && <p className="material-action-error" role="alert">{english ? "The change could not be confirmed. Check the material list and try again." : "변경 결과를 확인하지 못했어요. 자료 목록을 확인하고 다시 시도해 주세요."}</p>}
  </li>;
}

/** Completed uploads remain usable until their replacement has been saved. */
export default function MaterialList({ documents, locale, upload = null, busy = false, defaultOpen = false, onRemove, onReplace }: MaterialListProps) {
  const english = locale === "en";
  const [open, setOpen] = useState(defaultOpen);
  const replacementFull = documents.length >= MAX_DOCUMENTS;
  return <details className="lecture-material-list" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span>{english ? `Lecture materials · ${documents.length}` : `강의 자료 ${documents.length}개`}</span>
      {upload?.status === "pending" && <small role="status">{english ? "Reading…" : "읽는 중…"}</small>}
      {upload?.status === "failed" && <small>{english ? "Upload failed" : "업로드 실패"}</small>}
    </summary>
    <div className="material-list-content">
      {upload && <div className="material-upload-state" role={upload.status === "failed" ? "alert" : "status"}>
        <strong>{upload.filename}</strong>
        <span>{upload.status === "pending"
          ? (english ? "Reading the file. It will be ready for questions when processing finishes." : "파일을 읽고 있어요. 완료되면 질문에 활용할 수 있습니다.")
          : upload.error || (english ? "The file could not be read. Try uploading it again." : "파일을 읽지 못했어요. 다시 올려 주세요.")}</span>
        {upload.replacingId && <small>{english ? "The previous material stays available until the new file is ready." : "새 파일 읽기가 끝날 때까지 기존 자료는 유지됩니다."}</small>}
      </div>}
      {!documents.length && !upload && <p className="material-list-empty">{english ? "No materials added yet." : "아직 추가한 자료가 없어요."}</p>}
      {documents.length > 0 && <>
        <ul>{documents.map(document => <MaterialRow key={document.id} document={document} english={english}
          busy={busy || upload?.status === "pending"} replacementFull={replacementFull} onRemove={onRemove} onReplace={onReplace} />)}</ul>
        <p className="material-replacement-note">{replacementFull
          ? (english ? "All 20 material slots are occupied. Remove an unneeded material to make room for a safe replacement." : "자료 20개 한도에 도달했어요. 안전하게 교체할 여유 공간이 필요하므로 불필요한 자료를 먼저 삭제해 주세요.")
          : (english ? "A replacement is read first; the previous file is removed after the new material is ready." : "교체할 파일을 먼저 읽은 뒤, 준비가 끝나면 기존 자료를 삭제합니다.")}</p>
      </>}
    </div>
  </details>;
}
