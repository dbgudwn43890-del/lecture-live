import { NextResponse } from "next/server";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { NOTE_SCHEMA, notePrompt, type LectureNote } from "../../lib/lecture-note";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const SEGMENT_PAGE_SIZE = 1_000;
/** 시간당 생성 한도. GET이 남은 횟수를 조회해 패널에 보여준다. */
const GENERATION_LIMIT = 10;
// 하루 10개. 시간당이 아니라 일 단위 — 수업 몰린 날도 10개면 충분하다.
const GENERATION_WINDOW_MS = 86_400_000;
const MAX_TRANSCRIPT_CHARACTERS = 300_000;
const MAX_MATERIAL_CHARACTERS = 80_000;
/** 다른 탭이 만든 generating 행이 이보다 오래됐으면 죽은 시도로 보고 이어받는다. */
const STALE_GENERATING_MS = 5 * 60_000;

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  return { userId: user.id, supabase, isEnglish };
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!isUuid(sessionId)) {
    return NextResponse.json({ error: current.isEnglish ? "Check the lecture." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  const { data, error } = await current.supabase
    .from("lecture_notes")
    .select("status,content,updated_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    console.error("Lecture note read failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not load the note." : "노트를 불러오지 못했습니다." }, { status: 500 });
  }
  // 서버가 생성 중에 죽으면 행이 generating으로 굳는다. 5분 넘은 생성 중은
  // 실패로 보고해 클라이언트가 무한 스피너 대신 다시 시도 버튼을 띄우게 한다.
  const note = data && data.status === "generating"
    && Date.now() - new Date(data.updated_at).getTime() > STALE_GENERATING_MS
    ? { ...data, status: "failed" }
    : data;
  return NextResponse.json({ note: note ?? null, remainingGenerations: await peekRemaining(current.userId) });
}

/** 남은 생성 횟수. 조회 실패는 표시를 생략할 뿐 노트를 막지 않는다. */
async function peekRemaining(userId: string): Promise<number | null> {
  const { createAdminClient } = await import("../../lib/supabase/admin");
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.rpc("peek_rate_limit", {
    p_key: `lecture-notes:${userId}`,
    p_limit: GENERATION_LIMIT,
    p_window_seconds: GENERATION_WINDOW_MS / 1_000,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? Number(row.remaining) : null;
}

export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  const { isEnglish, supabase, userId } = current;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: isEnglish ? "Notes are not configured yet." : "노트 생성이 아직 설정되지 않았습니다." }, { status: 503 });
  }

  let body: { sessionId?: unknown; force?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "요청을 확인해 주세요." }, { status: 400 });
  }
  if (!isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  const sessionId = body.sessionId;

  // RLS가 소유자로 좁힌다. 노트는 끝난 강의에서만 만든다.
  const [{ data: session }, { data: existing }] = await Promise.all([
    supabase.from("lecture_sessions").select("id,classroom_id,title,status").eq("id", sessionId).maybeSingle(),
    supabase.from("lecture_notes").select("id,status,content,updated_at").eq("session_id", sessionId).maybeSingle(),
  ]);
  if (!session) {
    return NextResponse.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  }
  if (session.status !== "completed") {
    return NextResponse.json({ error: isEnglish ? "End the lecture first, then create the note." : "강의를 먼저 종료한 뒤 노트를 만들 수 있습니다." }, { status: 409 });
  }
  if (existing?.status === "ready" && body.force !== true) {
    return NextResponse.json({ note: { status: existing.status, content: existing.content, updated_at: existing.updated_at } });
  }
  if (existing?.status === "generating" && Date.now() - new Date(existing.updated_at).getTime() < STALE_GENERATING_MS) {
    return NextResponse.json({ note: { status: "generating", content: null, updated_at: existing.updated_at } }, { status: 202 });
  }

  // 쿼터는 실제로 생성에 들어갈 때만 소모한다. 위의 숏서킷(이미 완성·생성 중)
  // 앞에서 소모하면 노트를 다시 여는 것만으로 하루 10회가 줄었다.
  const rateLimit = await checkSharedRateLimit(`lecture-notes:${userId}`, GENERATION_LIMIT, GENERATION_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: isEnglish ? "Too many note requests. Try again later." : "노트 생성 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  // 자리를 먼저 잡는다. 유일 인덱스(session_id) 덕에 두 탭이 동시에 눌러도 행은 하나다.
  const { error: claimError } = await supabase.from("lecture_notes").upsert({
    session_id: sessionId,
    classroom_id: session.classroom_id,
    user_id: userId,
    status: "generating",
    updated_at: new Date().toISOString(),
  }, { onConflict: "session_id" });
  if (claimError) {
    console.error("Lecture note claim failed", claimError.code);
    return NextResponse.json({ error: isEnglish ? "Could not start the note." : "노트 생성을 시작하지 못했습니다." }, { status: 500 });
  }

  const [transcript, questions, materials] = await Promise.all([
    readTranscript(supabase, sessionId),
    readQuestions(supabase, sessionId),
    readMaterials(supabase, sessionId),
  ]);
  if (!transcript) {
    await supabase.from("lecture_notes").delete().eq("session_id", sessionId);
    return NextResponse.json({ error: isEnglish ? "This lecture has no transcript to build a note from." : "노트를 만들 스크립트가 없는 수업입니다." }, { status: 422 });
  }

  const input = [
    `# ${isEnglish ? "Lecture" : "수업"}: ${session.title}`,
    `## ${isEnglish ? "Transcript" : "강의 스크립트"}\n${transcript}`,
    questions ? `## ${isEnglish ? "Student questions during the lecture" : "수업 중 학생의 질문과 답변"}\n${questions}` : "",
    materials.text ? `## ${isEnglish ? "Lecture materials (with page numbers)" : "강의 자료 (페이지 번호 포함)"}\n${materials.text}` : "",
  ].filter(Boolean).join("\n\n");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 240_000, maxRetries: 1 });
  let note: LectureNote;
  try {
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      max_output_tokens: 24_000,
      store: false,
      instructions: notePrompt(isEnglish),
      input,
      text: { format: { type: "json_schema", name: "lecture_note", strict: true, schema: NOTE_SCHEMA as unknown as Record<string, unknown> } },
    });
    note = JSON.parse(response.output_text ?? "") as LectureNote;
    if (!note.sections?.length) throw new Error("empty note");
    linkMaterialBlocks(note, materials.documents);
  } catch (error) {
    console.error("Lecture note generation failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
    await supabase.from("lecture_notes").update({ status: "failed", updated_at: new Date().toISOString() }).eq("session_id", sessionId);
    return NextResponse.json({ error: isEnglish ? "Could not create the note. Try again." : "노트를 만들지 못했습니다. 다시 시도해 주세요." }, { status: 502 });
  }

  const updatedAt = new Date().toISOString();
  const { error: saveError } = await supabase
    .from("lecture_notes")
    .update({ status: "ready", content: note, model: "gpt-5.6-luna", updated_at: updatedAt })
    .eq("session_id", sessionId);
  if (saveError) {
    console.error("Lecture note save failed", saveError.code);
    return NextResponse.json({ error: isEnglish ? "Could not save the note." : "노트를 저장하지 못했습니다." }, { status: 500 });
  }
  return NextResponse.json({ note: { status: "ready", content: note, updated_at: updatedAt } }, { status: 201 });
}

/** PostgREST가 1000행에서 자른다. 분 단위 타임스탬프를 붙여 흐름을 보존한다. */
async function readTranscript(supabase: Supabase, sessionId: string) {
  const lines: string[] = [];
  let total = 0;
  for (let offset = 0; offset < 5_000; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transcript_segments")
      .select("start_ms,text")
      .eq("session_id", sessionId)
      .order("start_ms", { ascending: true })
      .order("client_id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) {
      console.error("Note segment read failed", error.code);
      break;
    }
    const page = data ?? [];
    for (const row of page) {
      const minutes = Math.floor(row.start_ms / 60_000);
      const line = `[${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}] ${row.text}`;
      total += line.length;
      if (total > MAX_TRANSCRIPT_CHARACTERS) return lines.join("\n");
      lines.push(line);
    }
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  return lines.join("\n");
}

async function readQuestions(supabase: Supabase, sessionId: string) {
  const { data, error } = await supabase
    .from("lecture_questions")
    .select("question,answer")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.error("Note question read failed", error.code);
    return "";
  }
  return (data ?? [])
    .map((row) => `Q: ${row.question}\nA: ${String(row.answer).slice(0, 2_000)}`)
    .join("\n\n");
}

type NoteDocument = { id: string; filename: string; page_count: number | null; storage_path: string | null };

async function readMaterials(supabase: Supabase, sessionId: string) {
  const { data, error } = await supabase
    .from("material_documents")
    .select("id,filename,page_count,storage_path")
    .eq("session_id", sessionId);
  const documents = (error ? [] : data ?? []) as NoteDocument[];
  if (!documents.length) return { text: "", documents };

  const parts: string[] = [];
  let total = 0;
  for (const document of documents) {
    const { data: chunks } = await supabase
      .from("material_chunks")
      .select("start_page,end_page,text")
      .eq("document_id", document.id)
      .order("start_page", { ascending: true });
    if (!chunks?.length) continue;
    parts.push(`### ${document.filename}`);
    for (const chunk of chunks) {
      const text = `(p.${chunk.start_page}${chunk.end_page !== chunk.start_page ? `-${chunk.end_page}` : ""}) ${chunk.text}`;
      total += text.length;
      if (total > MAX_MATERIAL_CHARACTERS) return { text: parts.join("\n"), documents };
      parts.push(text);
    }
  }
  return { text: parts.join("\n"), documents };
}

/**
 * 모델이 낸 material 블록을 실제 문서에 연결한다. 파일명이 안 맞거나 페이지가
 * 범위 밖이거나 원본이 보관되지 않은 자료면 블록을 버린다 — 틀린 이미지를
 * 자신 있게 싣는 것보다 안 싣는 편이 낫다.
 */
function linkMaterialBlocks(note: LectureNote, documents: NoteDocument[]) {
  const byName = new Map(documents.map((document) => [document.filename.trim().toLowerCase(), document]));
  for (const section of note.sections) {
    section.blocks = section.blocks.filter((block) => {
      if (block.type !== "material") return true;
      const document = byName.get(block.label.trim().toLowerCase());
      if (!document?.storage_path) return false;
      if (!Number.isInteger(block.page) || block.page < 1) return false;
      if (document.page_count && block.page > document.page_count) return false;
      block.documentId = document.id;
      return true;
    });
  }
}
