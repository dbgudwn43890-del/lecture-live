import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { hasVerifiedEmail } from "../../lib/verified-email";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { bootstrapTerms } from "../../lib/bootstrap-terms";
import { splitTerms } from "../../lib/glossary";
import { normalizeMaterialText, readTextMaterial, splitPages } from "../../lib/material-text";
import { boundedMaterialChunks } from "../../lib/material-ingestion-budget";
import { extractBoundedPdf } from "../../lib/material-ingestion-pdf";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";
import { createAdminClient } from "../../lib/supabase/admin";
import { drainStorageDeletions, enqueueStorageDeletion } from "../../lib/storage-cleanup";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MATERIAL_BYTES = 20_000_000;
const MAX_DOCUMENTS_PER_SESSION = 20;
// Long enough to read a page without re-fetching, short enough that a copied
// URL stops working soon.
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

async function context(request: Request): Promise<
  { response: NextResponse } | { userId: string; supabase: Awaited<ReturnType<typeof createClient>>; isEnglish: boolean }
> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (authError || !hasVerifiedEmail(user)) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
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

  // One document, opened for reading. The bucket is private, so the note
  // viewer can only load a page through a short-lived signed URL.
  const documentId = params.get("documentId");
  if (documentId !== null) {
    if (!isUuid(documentId)) {
      return NextResponse.json({ error: current.isEnglish ? "Check the material." : "자료 정보를 확인해 주세요." }, { status: 400 });
    }
    const preview = params.get("preview");
    if (preview !== null && preview !== "text") {
      return NextResponse.json({ error: current.isEnglish ? "Check the preview request." : "미리보기 요청을 확인해 주세요." }, { status: 400 });
    }
    const { data: document, error: documentError } = await current.supabase
      .from("material_documents")
      .select("id,filename,page_count,storage_path")
      .eq("id", documentId)
      .eq("user_id", current.userId)
      .maybeSingle();
    if (documentError) {
      console.error("Material read failed", documentError.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not load this material. Try again." : "자료를 불러오지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
    }
    if (!document) {
      return NextResponse.json({ error: current.isEnglish ? "Could not find this material." : "해당 자료를 찾지 못했습니다." }, { status: 404 });
    }
    if (preview === "text") {
      const { data: chunks, error } = await current.supabase.from("material_chunks")
        .select("text,start_page,end_page").eq("document_id", documentId).eq("user_id", current.userId)
        .order("start_page", { ascending: true }).order("id", { ascending: true }).limit(2);
      if (error) {
        console.error("Material preview failed", error.code);
        return NextResponse.json({ error: current.isEnglish ? "Could not load the extracted text. Try again." : "읽은 내용을 불러오지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
      }
      // A small plain-text excerpt, never a signed URL, storage path, vector,
      // or full material body. React renders it as text, not HTML/Markdown.
      const text = (chunks ?? []).map((chunk) => normalizeMaterialText(chunk.text)
        .replace(/^## p\.\d+\s*$/gmu, "").replace(/\s+/gu, " ").trim()).filter(Boolean).join(" ");
      const characters = Array.from(text);
      return NextResponse.json({
        id: document.id, filename: document.filename, pageCount: document.page_count,
        status: text ? "ready" : "empty", preview: characters.slice(0, 600).join(""),
        excerpt: true,
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
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
    .select("id,classroom_id,session_id,filename,page_count,created_at")
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

  // The per-minute limit alone allowed 43k platform-key LLM extractions a
  // day. No real learner uploads anywhere near this many materials.
  const dailyLimit = await checkSharedRateLimit(`materials-daily:${userId}`, 100, 86_400_000);
  if (!dailyLimit.allowed) {
    return NextResponse.json(
      { error: isEnglish ? "Daily material upload limit reached. Try again tomorrow." : "오늘 올릴 수 있는 강의 자료 수를 모두 사용했습니다. 내일 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(dailyLimit.retryAfterSeconds) } },
    );
  }

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

  // RLS scopes the lookup; the reservation independently checks ownership.
  const { data: session } = await supabase.from("lecture_sessions")
    .select("id,classroom_id").eq("id", sessionId).maybeSingle();
  if (!session) {
    return NextResponse.json({ error: isEnglish ? "Could not find that lecture." : "해당 수업을 찾지 못했습니다." }, { status: 404 });
  }
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: isEnglish ? "Material storage is unavailable." : "자료 저장을 사용할 수 없습니다." }, { status: 503 });

  const { data: reservation, error: reserveError } = await admin.rpc("reserve_material_upload", {
    p_session_id: sessionId, p_user_id: userId,
  });
  if (reserveError || !reservation || typeof reservation.allowed !== "boolean") {
    return NextResponse.json({ error: isEnglish ? "Material upload capacity could not be checked. Try again shortly." : "자료 업로드 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
  if (!reservation.allowed) {
    if (reservation.reason === "session_unavailable") {
      return NextResponse.json({ error: isEnglish ? "Could not find that lecture." : "해당 수업을 찾지 못했습니다." }, { status: 404 });
    }
    if (!["document_limit", "daily_budget", "busy"].includes(reservation.reason)) {
      return NextResponse.json({ error: isEnglish ? "Material upload capacity could not be checked. Try again shortly." : "자료 업로드 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
    }
    const full = reservation.reason === "document_limit";
    const daily = reservation.reason === "daily_budget";
    return NextResponse.json({ error: full
      ? (isEnglish ? `A lecture holds up to ${MAX_DOCUMENTS_PER_SESSION} materials, including uploads in progress. Remove one or wait for an upload to finish.` : `업로드 중인 자료를 포함해 수업당 ${MAX_DOCUMENTS_PER_SESSION}개까지 올릴 수 있습니다. 자료를 삭제하거나 업로드가 끝난 뒤 다시 시도해 주세요.`)
      : daily
        ? (isEnglish ? "Daily material upload limit reached. Try again tomorrow." : "오늘의 자료 업로드 한도에 도달했습니다. 내일 다시 시도해 주세요.")
        : (isEnglish ? "Another material upload is in progress. Try again shortly." : "다른 자료를 업로드하고 있습니다. 잠시 후 다시 시도해 주세요.") },
    { status: full ? 409 : 429 });
  }
  if (!isUuid(reservation.claim_token)) {
    return NextResponse.json({ error: isEnglish ? "Material upload capacity could not be checked. Try again shortly." : "자료 업로드 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
  const claimToken = reservation.claim_token;
  try {

    const filename = Array.from(normalizeMaterialText(file.name)).slice(0, 200).join("") || `material.${type.extension}`;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 240_000, maxRetries: 1 });

    // A document ingestion pipeline must know how many source pages it read.
    // PDF.js gives native text page-by-page; model output cannot prove coverage.
    let pages: { page: number; text: string }[];
    let pageCount: number;
    let keyterms: string[];
    if (type.extension === "pdf") {
      try {
        const extracted = await extractBoundedPdf(bytes, request.signal);
        pages = extracted.pages;
        pageCount = extracted.pageCount;
        keyterms = bootstrapTerms(pages.map((page) => page.text).join(" "), [], 40);
      } catch (error) {
        if (error instanceof Error && error.message === "PDF_PAGE_LIMIT") {
          return NextResponse.json({ error: isEnglish
            ? "Split PDFs longer than 500 pages into smaller files before uploading."
            : "500페이지가 넘는 PDF는 파일을 나누어 올려 주세요." }, { status: 422 });
        }
        const reason = error instanceof Error ? error.message : "unknown";
        if (reason === "PDF_RUNTIME_UNAVAILABLE") {
          return NextResponse.json({ error: isEnglish
            ? "PDF processing is temporarily unavailable. Please try again shortly."
            : "PDF 처리를 잠시 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
        }
        if (["MATERIAL_TEXT_LIMIT", "PDF_TIMEOUT", "PDF_RESOURCE_LIMIT"].includes(reason)) {
          return NextResponse.json({ error: isEnglish
            ? "This PDF exceeds the text or processing limit. Split it into smaller files and upload again."
            : "이 PDF의 텍스트 분량 또는 처리량이 한도를 넘었습니다. 파일을 나누어 다시 올려 주세요." }, { status: 422 });
        }
        if (reason === "PDF_BUSY") {
          return NextResponse.json({ error: isEnglish ? "PDF processing is busy. Try again shortly." : "PDF 처리 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, { status: 503, headers: { "Retry-After": "10" } });
        }
        console.error("PDF text extraction failed");
        return NextResponse.json({ error: isEnglish ? "Could not read this PDF." : "이 PDF를 읽지 못했습니다." }, { status: 422 });
      }
    } else if (["txt", "csv", "tsv"].includes(type.extension)) {
      try {
        pages = readTextMaterial(bytes);
        pageCount = pages.length;
        keyterms = bootstrapTerms(pages.map((page) => page.text).join(" "), [], 40);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "TEXT_TOO_LARGE";
        return NextResponse.json({ error: tooLarge
          ? (isEnglish ? "Split text materials into files of 500,000 characters or less." : "텍스트 자료를 50만 자 이하로 나누어 올려 주세요.")
          : (isEnglish ? "Save this text file as UTF-8 or UTF-16 and upload it again." : "텍스트 파일을 UTF-8 또는 UTF-16으로 저장한 뒤 다시 올려 주세요.") }, { status: 422 });
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
        markdown = normalizeMaterialText(response.output_text ?? "");
      } catch (error) {
        console.error("Material extraction failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
        return NextResponse.json({ error: isEnglish ? "Could not read this material." : "이 자료를 읽지 못했습니다." }, { status: 502 });
      }
      pages = splitPages(markdown);
      pageCount = pages.at(-1)?.page ?? pages.length;
      keyterms = splitTerms(markdown);
    }
    let budget: ReturnType<typeof boundedMaterialChunks>;
    try {
      budget = boundedMaterialChunks(pages);
    } catch {
      return NextResponse.json({ error: isEnglish
        ? "This material exceeds the text indexing limit. Split it into smaller files and upload again."
        : "이 자료의 텍스트가 색인 한도를 넘었습니다. 파일을 나누어 다시 올려 주세요." }, { status: 422 });
    }
    const { chunks, characters, tokenBound } = budget;
    if (!chunks.length) {
      return NextResponse.json({ error: type.extension === "pdf"
        ? (isEnglish ? "This PDF has no selectable text. Upload a text-based PDF for now." : "이 PDF에는 선택 가능한 텍스트가 없습니다. 현재는 텍스트 기반 PDF를 올려 주세요.")
        : (isEnglish ? "This material has no readable text." : "이 자료에서 읽을 수 있는 텍스트를 찾지 못했습니다.") }, { status: 422 });
    }

    const { data: charged, error: chargeError } = await admin.rpc("charge_material_upload", {
      p_claim_token: claimToken, p_user_id: userId, p_characters: characters,
      p_token_bound: tokenBound, p_chunks: chunks.length,
    });
    if (chargeError || !charged || charged.allowed !== true) {
      const exhausted = !chargeError && charged?.reason === "daily_budget";
      return NextResponse.json({ error: exhausted
        ? (isEnglish ? "Daily material indexing limit reached. Try again tomorrow." : "오늘의 자료 색인 한도에 도달했습니다. 내일 다시 시도해 주세요.")
        : (isEnglish ? "Material indexing capacity could not be checked. Try again shortly." : "자료 색인 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.") },
      { status: exhausted ? 429 : 503 });
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
      if (embeddings.length !== chunks.length || embeddings.some((row, index) =>
        row.index !== index || !Array.isArray(row.embedding) || !row.embedding.length ||
        row.embedding.some((value) => !Number.isFinite(value)))) {
        throw new Error("Incomplete material embeddings");
      }
    } catch (error) {
      console.error("Material embedding failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
      return NextResponse.json({ error: isEnglish ? "Could not index this material." : "이 자료를 색인하지 못했습니다." }, { status: 502 });
    }

    // 노트가 자료 페이지를 그림으로 실을 수 있게 PDF 원본만 비공개 버킷에 보관한다
    // (버킷 mime 제한도 PDF뿐이다). 색인·임베딩이 끝난 뒤에만 올려서 읽지 못한
    // 파일이 버킷에 남지 않는다. 보관 실패는 색인 자체를 무르지 않는다 — 노트에
    // 그림이 빠질 뿐, 검색과 답변은 그대로 동작한다.
    let storagePath: string | null = null;
    if (type.extension === "pdf") {
      const path = `${userId}/${randomUUID()}.pdf`;
      const { error: uploadError } = await admin.storage
        .from("materials")
        .upload(path, bytes, { contentType: type.contentType, upsert: false });
      if (uploadError) console.error("Material upload failed", uploadError.message);
      else storagePath = path;
    }

    const { data: document, error: documentError } = await admin
      .from("material_documents")
      .insert({
        id: claimToken,
        classroom_id: session.classroom_id,
        session_id: session.id,
        user_id: userId,
        filename,
        page_count: pageCount,
        // Term-length limits can cut a UTF-16 pair even after the page is clean.
        keyterms: normalizeMaterialText(keyterms.join(", ")),
        storage_path: storagePath,
      })
      .select("id,classroom_id,session_id,filename,page_count,created_at")
      .single();
    if (documentError || !document) {
      console.error("Material document save failed", documentError?.code);
      if (storagePath) {
        await enqueueStorageDeletion(admin, { bucket: "materials", objectKey: storagePath, userId, reason: "material_save_failed" });
        await drainStorageDeletions(admin, { userId }).catch(() => console.error("Material cleanup deferred"));
      }
      return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
    }

    const { error: chunkError } = await admin.from("material_chunks").insert(chunks.map((chunk, index) => ({
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
      if (storagePath) {
        await enqueueStorageDeletion(admin, { bucket: "materials", objectKey: storagePath, userId, reason: "material_save_failed" });
        await drainStorageDeletions(admin, { userId }).catch(() => console.error("Material cleanup deferred"));
      }
      return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
    }

    return NextResponse.json({ document }, { status: 201 });
  } finally {
    // Release every failed/aborted attempt; a successful insert consumes the
    // reservation atomically. The lease recovers slots if this process dies.
    await admin.rpc("finish_material_upload", { p_claim_token: claimToken, p_user_id: userId })
      .then(({ error }) => { if (error) console.error("Material reservation cleanup deferred"); },
        () => { console.error("Material reservation cleanup deferred"); });
  }
}

export async function DELETE(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const documentId = new URL(request.url).searchParams.get("documentId");
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: current.isEnglish ? "Check the material." : "자료 정보를 확인해 주세요." }, { status: 400 });
  }

  const { error } = await current.supabase.from("material_documents").delete().eq("id", documentId);
  if (error) {
    console.error("Material delete failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not delete this material." : "이 자료를 삭제하지 못했습니다." }, { status: 500 });
  }
  // The DB trigger preserves the path in the same transaction as the delete.
  // Immediate removal is best-effort; the scheduled worker retries failures.
  const admin = createAdminClient();
  if (admin) await drainStorageDeletions(admin, { userId: current.userId })
    .catch(() => console.error("Material cleanup deferred"));
  return NextResponse.json({ ok: true });
}
