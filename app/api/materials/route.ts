import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { isUuid } from "../../lib/billing";
import { bootstrapTerms } from "../../lib/bootstrap-terms";
import { splitTerms } from "../../lib/glossary";
import { chunkPages, splitPages } from "../../lib/material-text";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MATERIAL_BYTES = 20_000_000;
const MAX_DOCUMENTS_PER_SESSION = 20;
// Long enough to read a slide without re-fetching, short enough that a copied
// URL stops working well before the lecture ends.
const SIGNED_URL_SECONDS = 900;

const MATERIAL_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
} as const;

function materialType(filename: string) {
  const extension = filename.toLowerCase().split(".").at(-1);
  return extension && extension in MATERIAL_TYPES
    ? { extension, contentType: MATERIAL_TYPES[extension as keyof typeof MATERIAL_TYPES] }
    : null;
}

function extractionPrompt(isPdf: boolean) {
  return [
  `이 ${isPdf ? "PDF" : "파일"}은 대학 강의 자료다. 처음부터 순서대로 내용을 텍스트로 옮겨라.`,
  `각 ${isPdf ? "페이지" : "문서의 페이지·슬라이드·시트 또는 섹션"}는 반드시 '## p.N' 머리글로 시작한다. N은 1부터 시작하는 순번이다.`,
  "수식은 읽어서 이해할 수 있는 말과 기호로 적는다. 표는 행 단위로 풀어 쓴다.",
  "그림·도표는 무엇을 보여 주는지 한두 문장으로 서술한다.",
  "장식, 페이지 번호, 머리말, 꼬리말은 생략한다. 없는 내용을 지어내지 않는다.",
  "마지막 줄에 '## TERMS' 머리글을 쓰고, 그 아래 한 줄에 이 자료의 전문용어·고유명사·약어를",
  "쉼표로 구분해 최대 40개 적는다. 받아쓰기가 틀리기 쉬운 말을 고른다. 일반 단어는 넣지 않는다.",
].join("\n");
}

async function extractPdfPages(bytes: Uint8Array) {
  // PDF.js transfers its input buffer to a worker and may detach it. Keep the
  // upload bytes intact; the same bytes are stored after extraction succeeds.
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const pageCount = Math.min(pdf.numPages, 500);
  const pages = [] as { page: number; text: string }[];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => "str" in item ? item.str : "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push({ page: pageNumber, text });
  }
  return { pageCount, pages };
}

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  const rateLimit = await checkSharedRateLimit(`materials:${user.id}`, 30, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { userId: user.id, supabase, isEnglish };
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const params = new URL(request.url).searchParams;

  // One document, opened for reading. The bucket is private, so the viewer in
  // the workspace can only load a page through a short-lived signed URL.
  const documentId = params.get("documentId");
  if (documentId !== null) {
    if (!isUuid(documentId)) {
      return NextResponse.json({ error: current.isEnglish ? "Check the material." : "자료 정보를 확인해 주세요." }, { status: 400 });
    }
    const { data: document } = await current.supabase
      .from("material_documents")
      .select("id,filename,page_count,storage_path")
      .eq("id", documentId)
      .maybeSingle();
    if (!document?.storage_path) {
      return NextResponse.json(
        { error: current.isEnglish ? "The original file for this material was not kept." : "이 자료의 원본 파일은 보관되어 있지 않습니다." },
        { status: 404 },
      );
    }
    const { data: signed, error: signError } = await current.supabase.storage
      .from("materials")
      .createSignedUrl(document.storage_path, SIGNED_URL_SECONDS);
    if (signError || !signed) {
      console.error("Material sign failed", signError?.message ?? "unknown");
      return NextResponse.json({ error: current.isEnglish ? "Could not open this material." : "이 자료를 열지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({
      url: signed.signedUrl,
      expiresInSeconds: SIGNED_URL_SECONDS,
      filename: document.filename,
      pageCount: document.page_count,
    });
  }

  const sessionId = params.get("sessionId");
  if (!isUuid(sessionId)) {
    return NextResponse.json({ error: current.isEnglish ? "Check the lecture." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  const query = current.supabase
    .from("material_documents")
    .select("id,classroom_id,session_id,filename,page_count,created_at,storage_path")
    .order("created_at", { ascending: false });

  const { data, error } = await query.eq("session_id", sessionId);
  if (error) {
    console.error("Material list failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not load lecture materials." : "강의 자료를 불러오지 못했습니다." }, { status: 500 });
  }
  return NextResponse.json({ documents: data ?? [] });
}

export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  const { isEnglish, supabase, userId } = current;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: isEnglish ? "Material indexing is not configured yet." : "강의 자료 색인이 아직 설정되지 않았습니다." }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid upload." : "올바른 업로드 요청이 아닙니다." }, { status: 400 });
  }

  const rawSessionId = formData.get("sessionId");
  const sessionId = isUuid(rawSessionId) ? rawSessionId : null;
  const file = formData.get("file");
  if (!sessionId) {
    return NextResponse.json({ error: isEnglish ? "Open a lecture first." : "수업을 먼저 열어 주세요." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_MATERIAL_BYTES) {
    return NextResponse.json({ error: isEnglish ? "Upload a supported file of 20MB or less." : "지원하는 형식의 20MB 이하 자료를 올려 주세요." }, { status: 400 });
  }
  const type = materialType(file.name);
  if (!type) {
    return NextResponse.json({ error: isEnglish ? "Supported: PDF, Word, PowerPoint, text, CSV, and Excel files." : "PDF, Word, PowerPoint, 텍스트, CSV, 엑셀 파일을 올릴 수 있습니다." }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // A PDF must be a PDF even when its filename says so. Other accepted office
  // files are passed by extension, which selects OpenAI's file parser.
  if (type.extension === "pdf" && String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    return NextResponse.json({ error: isEnglish ? "This file is not a valid PDF." : "올바른 PDF 파일이 아닙니다." }, { status: 400 });
  }

  // RLS scopes both reads to this user, so a foreign session id comes back empty.
  const [{ data: session }, { count }] = await Promise.all([
    supabase.from("lecture_sessions").select("id,classroom_id").eq("id", sessionId).maybeSingle(),
    supabase.from("material_documents").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
  ]);
  if (!session) {
    return NextResponse.json({ error: isEnglish ? "Could not find that lecture." : "해당 수업을 찾지 못했습니다." }, { status: 404 });
  }
  if ((count ?? 0) >= MAX_DOCUMENTS_PER_SESSION) {
    return NextResponse.json({
      error: isEnglish
        ? `A lecture holds up to ${MAX_DOCUMENTS_PER_SESSION} materials. Remove one first.`
        : `수업당 자료는 ${MAX_DOCUMENTS_PER_SESSION}개까지입니다. 먼저 하나를 삭제해 주세요.`,
    }, { status: 409 });
  }

  const filename = (file.name || `material.${type.extension}`).slice(0, 200);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 240_000, maxRetries: 1 });

  // A document ingestion pipeline must know how many source pages it read.
  // PDF.js gives native text page-by-page; model output cannot prove coverage.
  let pages: { page: number; text: string }[];
  let pageCount: number;
  let keyterms: string[];
  if (type.extension === "pdf") {
    try {
      const extracted = await extractPdfPages(bytes);
      pages = extracted.pages;
      pageCount = extracted.pageCount;
      keyterms = bootstrapTerms(pages.map((page) => page.text).join(" "), [], 40);
    } catch (error) {
      console.error(
        "PDF text extraction failed",
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      );
      return NextResponse.json({ error: isEnglish ? "Could not read this PDF." : "이 PDF를 읽지 못했습니다." }, { status: 422 });
    }
  } else {
    let markdown: string;
    try {
      const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        max_output_tokens: 16_000,
        store: false,
        input: [{
          role: "user",
          content: [
            { type: "input_file", filename, file_data: `data:${type.contentType};base64,${Buffer.from(bytes).toString("base64")}` },
            { type: "input_text", text: extractionPrompt(false) },
          ],
        }],
      });
      markdown = response.output_text ?? "";
    } catch (error) {
      console.error("Material extraction failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
      return NextResponse.json({ error: isEnglish ? "Could not read this material." : "이 자료를 읽지 못했습니다." }, { status: 502 });
    }
    pages = splitPages(markdown);
    pageCount = pages.at(-1)?.page ?? pages.length;
    keyterms = splitTerms(markdown);
  }
  const chunks = chunkPages(pages);
  if (!chunks.length) {
    return NextResponse.json({ error: isEnglish ? "This PDF has no selectable text. Upload a text-based PDF for now." : "이 PDF에는 선택 가능한 텍스트가 없습니다. 현재는 텍스트 기반 PDF를 올려 주세요." }, { status: 422 });
  }

  let embeddings;
  try {
    const created = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((chunk) => chunk.text),
    });
    // The API echoes an index per row; trusting array order would file one
    // page's text under another page's vector.
    embeddings = [...created.data].sort((a, b) => a.index - b.index);
  } catch (error) {
    console.error("Material embedding failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
    return NextResponse.json({ error: isEnglish ? "Could not index this material." : "이 자료를 색인하지 못했습니다." }, { status: 502 });
  }

  // Uploaded only after extraction and embedding succeed, so a file the pipeline
  // could not read never lingers in the bucket. The first folder is the owner's
  // id, which is what the bucket policy checks.
  const storagePath = `${userId}/${randomUUID()}.${type.extension}`;
  const { error: uploadError } = await supabase.storage
    .from("materials")
    .upload(storagePath, bytes, { contentType: type.contentType, upsert: false });
  if (uploadError) {
    console.error("Material upload failed", uploadError.message);
    return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
  }

  const { data: document, error: documentError } = await supabase
    .from("material_documents")
    .insert({
      classroom_id: session.classroom_id,
      session_id: session.id,
      user_id: userId,
      filename,
      page_count: pageCount,
      keyterms: keyterms.join(", "),
      storage_path: storagePath,
    })
    .select("id,classroom_id,session_id,filename,page_count,created_at,storage_path")
    .single();
  if (documentError || !document) {
    console.error("Material document save failed", documentError?.code);
    await supabase.storage.from("materials").remove([storagePath]);
    return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
  }

  const { error: chunkError } = await supabase.from("material_chunks").insert(chunks.map((chunk, index) => ({
    document_id: document.id,
    classroom_id: session.classroom_id,
    user_id: userId,
    start_page: chunk.startPage,
    end_page: chunk.endPage,
    text: chunk.text,
    embedding: embeddings[index].embedding,
  })));
  if (chunkError) {
    // A document row with no chunks would list as indexed and never match, so
    // remove it rather than leaving a material that silently does nothing.
    console.error("Material chunk save failed", chunkError.code);
    await supabase.from("material_documents").delete().eq("id", document.id);
    await supabase.storage.from("materials").remove([storagePath]);
    return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ document }, { status: 201 });
}

export async function DELETE(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const documentId = new URL(request.url).searchParams.get("documentId");
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: current.isEnglish ? "Check the material." : "자료 정보를 확인해 주세요." }, { status: 400 });
  }

  // Read the path before the row goes: once it is deleted there is nothing left
  // pointing at the object, and it would sit in the bucket being billed forever.
  const { data: document } = await current.supabase
    .from("material_documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();

  const { error } = await current.supabase.from("material_documents").delete().eq("id", documentId);
  if (error) {
    console.error("Material delete failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not delete this material." : "이 자료를 삭제하지 못했습니다." }, { status: 500 });
  }
  if (document?.storage_path) {
    const { error: removeError } = await current.supabase.storage.from("materials").remove([document.storage_path]);
    // The row is already gone, so the material is deleted as far as the learner
    // is concerned. Log the orphan rather than failing a successful delete.
    if (removeError) console.error("Material file remove failed", removeError.message);
  }
  return NextResponse.json({ ok: true });
}
