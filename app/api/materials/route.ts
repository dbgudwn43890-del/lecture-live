import { NextResponse } from "next/server";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { chunkPages, splitPages } from "../../lib/material-text";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PDF_BYTES = 20_000_000;
const MAX_DOCUMENTS_PER_CLASSROOM = 20;

const EXTRACTION_PROMPT = [
  "이 PDF는 대학 강의 자료다. 페이지 순서대로 내용을 텍스트로 옮겨라.",
  "각 페이지는 반드시 '## p.N' 머리글로 시작한다. N은 1부터 시작하는 페이지 번호다.",
  "수식은 읽어서 이해할 수 있는 말과 기호로 적는다. 표는 행 단위로 풀어 쓴다.",
  "그림·도표는 무엇을 보여 주는지 한두 문장으로 서술한다.",
  "장식, 페이지 번호, 머리말, 꼬리말은 생략한다. 없는 내용을 지어내지 않는다.",
].join("\n");

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

  const classroomId = new URL(request.url).searchParams.get("classroomId");
  const query = current.supabase
    .from("material_documents")
    .select("id,classroom_id,filename,page_count,created_at")
    .order("created_at", { ascending: false });

  const { data, error } = isUuid(classroomId) ? await query.eq("classroom_id", classroomId) : await query;
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

  const classroomId = formData.get("classroomId");
  const file = formData.get("file");
  if (!isUuid(classroomId)) {
    return NextResponse.json({ error: isEnglish ? "Choose a classroom first." : "강의실을 먼저 선택해 주세요." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: isEnglish ? "Upload a PDF of 20MB or less." : "20MB 이하의 PDF를 올려 주세요." }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Trust the bytes, not the name or the browser-supplied type.
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    return NextResponse.json({ error: isEnglish ? "Only PDF files can be indexed." : "PDF 파일만 색인할 수 있습니다." }, { status: 400 });
  }

  // Ownership check and the per-classroom ceiling in one read. RLS already
  // scopes both tables to this user, so a foreign classroom id comes back empty.
  const [{ data: classroom }, { count }] = await Promise.all([
    supabase.from("classrooms").select("id").eq("id", classroomId).maybeSingle(),
    supabase.from("material_documents").select("id", { count: "exact", head: true }).eq("classroom_id", classroomId),
  ]);
  if (!classroom) {
    return NextResponse.json({ error: isEnglish ? "Could not find that classroom." : "해당 강의실을 찾지 못했습니다." }, { status: 404 });
  }
  if ((count ?? 0) >= MAX_DOCUMENTS_PER_CLASSROOM) {
    return NextResponse.json({
      error: isEnglish
        ? `A classroom holds up to ${MAX_DOCUMENTS_PER_CLASSROOM} materials. Remove one first.`
        : `강의실당 자료는 ${MAX_DOCUMENTS_PER_CLASSROOM}개까지입니다. 먼저 하나를 삭제해 주세요.`,
    }, { status: 409 });
  }

  const filename = (file.name || "material.pdf").slice(0, 200);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 240_000, maxRetries: 1 });

  // Slides carry their meaning in formulas, tables, and diagrams, which plain
  // text extraction drops. The model reads the pages as pages and writes them
  // back as text, so the vision step happens once at upload instead of on
  // every question (PRD 36.3.2).
  let markdown: string;
  try {
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      max_output_tokens: 16_000,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_file", filename, file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` },
          { type: "input_text", text: EXTRACTION_PROMPT },
        ],
      }],
    });
    markdown = response.output_text ?? "";
  } catch (error) {
    console.error("Material extraction failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
    return NextResponse.json({ error: isEnglish ? "Could not read this PDF." : "이 PDF를 읽지 못했습니다." }, { status: 502 });
  }

  const pages = splitPages(markdown);
  const chunks = chunkPages(pages);
  if (!chunks.length) {
    return NextResponse.json({ error: isEnglish ? "No readable text was found in this PDF." : "이 PDF에서 읽을 수 있는 내용을 찾지 못했습니다." }, { status: 422 });
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

  const { data: document, error: documentError } = await supabase
    .from("material_documents")
    .insert({
      classroom_id: classroomId,
      user_id: userId,
      filename,
      page_count: Math.min(500, pages.at(-1)?.page ?? pages.length),
    })
    .select("id,classroom_id,filename,page_count,created_at")
    .single();
  if (documentError || !document) {
    console.error("Material document save failed", documentError?.code);
    return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
  }

  const { error: chunkError } = await supabase.from("material_chunks").insert(chunks.map((chunk, index) => ({
    document_id: document.id,
    classroom_id: classroomId,
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
    return NextResponse.json({ error: isEnglish ? "Could not save this material." : "이 자료를 저장하지 못했습니다." }, { status: 500 });
  }

  // The upload itself is never stored: only the extracted text and its vectors
  // remain (PRD 20.3, 36.3.2).
  return NextResponse.json({ document }, { status: 201 });
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
  return NextResponse.json({ ok: true });
}
