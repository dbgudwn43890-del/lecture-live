import { after, NextResponse } from "next/server";
import { hasVerifiedEmail } from "../../lib/verified-email";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { notePrompt, noteSchema, type LectureNote } from "../../lib/lecture-note";
import { isNoteLanguage } from "../../lib/note-language";
import { NoteInputError, noteClock, noteInputMessage, validateLectureNote, type NoteDocument, type NoteEvidence } from "../../lib/lecture-note-context";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";
import { createAdminClient } from "../../lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const SEGMENT_PAGE_SIZE = 1_000;
/** 하루 생성 한도. GET이 남은 횟수를 조회해 패널에 보여준다. */
const GENERATION_LIMIT = 10;
// 하루 10개. 시간당이 아니라 일 단위 — 수업 몰린 날도 10개면 충분하다.
const GENERATION_WINDOW_MS = 86_400_000;
const MAX_TRANSCRIPT_CHARACTERS = 300_000;
const MAX_MATERIAL_CHARACTERS = 80_000;
const MAX_QUESTION_CHARACTERS = 30_000;
const MAX_ANSWER_CHARACTERS = 120_000;
/** 다른 탭이 만든 generating 행이 이보다 오래됐으면 죽은 시도로 보고 이어받는다. */
const STALE_GENERATING_MS = 5 * 60_000;

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function context(request: Request): Promise<{ response: NextResponse } | { userId: string; supabase: Supabase; isEnglish: boolean }> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (authError || !hasVerifiedEmail(user)) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
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
  return NextResponse.json({
    note: note ?? null,
    remainingGenerations: await peekRemaining(current.userId),
    ...(note?.status === "failed" ? { error: generationFailureMessage(current.isEnglish) } : {}),
  });
}

/** 남은 생성 횟수. 조회 실패는 표시를 생략할 뿐 노트를 막지 않는다. */
async function peekRemaining(userId: string): Promise<number | null> {
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

function generationFailureMessage(isEnglish: boolean) {
  return isEnglish ? "Could not finish the note. Please try again." : "노트 작성을 마치지 못했습니다. 다시 시도해 주세요.";
}

async function releaseNoteLease(supabase: Supabase, sessionId: string, token: string) {
  try {
    const { error } = await supabase.rpc("release_generation_lease", {
      p_session_id: sessionId, p_kind: "note", p_token: token,
    });
    if (error) console.error("Note generation lease release failed", error.code);
  } catch {
    console.error("Note generation lease release failed");
  }
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const current = await context(request);
  if ("response" in current) return current.response;
  const { isEnglish, supabase, userId } = current;

  let body: { sessionId?: unknown; force?: unknown; language?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "요청을 확인해 주세요." }, { status: 400 });
  }
  if (!body || !isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  if (body.language !== undefined && !isNoteLanguage(body.language)) {
    return NextResponse.json({ error: isEnglish ? "Select a supported note language." : "노트 언어를 다시 선택해 주세요." }, { status: 400 });
  }
  const language = body.language ?? (isEnglish ? "en" : "ko");
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: isEnglish ? "Notes are not configured yet." : "노트 생성이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: generationFailureMessage(isEnglish) }, { status: 503 });
  const sessionId = body.sessionId;
  const token = crypto.randomUUID();
  const { data: claimed, error: leaseError } = await supabase.rpc("claim_generation_lease", {
    p_session_id: sessionId, p_kind: "note", p_token: token,
  });
  if (leaseError?.code === "42501") return NextResponse.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  if (leaseError) return NextResponse.json({ error: isEnglish ? "Please try again shortly." : "잠시 후 다시 시도해 주세요." }, { status: 503 });
  if (!claimed) {
    const { data: active, error } = await supabase.from("lecture_notes")
      .select("status,content,updated_at").eq("session_id", sessionId).maybeSingle();
    if (error) return NextResponse.json({ error: noteInputMessage("read", isEnglish) }, { status: 503 });
    if (active?.status === "generating" && Date.now() - Date.parse(active.updated_at) > STALE_GENERATING_MS) {
      // The runtime has ended, but its six-minute DB lease may have one minute
      // left. Do not turn a known expired job back into a generating indicator.
      return NextResponse.json({ note: { ...active, status: "failed" }, error: generationFailureMessage(isEnglish) }, {
        status: 409, headers: { "Retry-After": "60" },
      });
    }
    // There is a brief claim-to-row-write gap. Do not invent a start time:
    // the next GET will return the persisted job timestamp.
    return NextResponse.json({
      note: { status: "generating", content: active?.content ?? null, updated_at: active?.status === "generating" ? active.updated_at : null },
    }, { status: 202 });
  }

  let scheduled = false;
  let markUnscheduledFailed: (() => Promise<void>) | null = null;
  try {
    // RLS and the lease RPC both verify ownership. Notes require an ended lecture.
    const [{ data: session, error: sessionError }, { data: existing, error: existingError }] = await Promise.all([
      supabase.from("lecture_sessions").select("id,classroom_id,title,status").eq("id", sessionId).maybeSingle(),
      supabase.from("lecture_notes").select("id,status,content,updated_at").eq("session_id", sessionId).maybeSingle(),
    ]);
    if (sessionError || existingError) return NextResponse.json({ error: noteInputMessage("read", isEnglish) }, { status: 503 });
    if (!session) return NextResponse.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
    if (session.status !== "completed") {
      return NextResponse.json({ error: isEnglish ? "End the lecture first, then create the note." : "강의를 먼저 종료한 뒤 노트를 만들 수 있습니다." }, { status: 409 });
    }
    if (existing?.status === "ready" && body.force !== true) {
      return NextResponse.json({ note: { status: existing.status, content: existing.content, updated_at: existing.updated_at } });
    }
    if (existing?.status === "generating" && Date.now() - new Date(existing.updated_at).getTime() < STALE_GENERATING_MS) {
      return NextResponse.json({ note: { status: "generating", content: existing.content, updated_at: existing.updated_at } }, { status: 202 });
    }

    const startedAt = new Date().toISOString();
    const previousContent = existing?.content ?? null;
    const { error: claimError } = await admin.from("lecture_notes").upsert({
      session_id: sessionId,
      classroom_id: session.classroom_id,
      user_id: userId,
      status: "generating",
      content: previousContent,
      updated_at: startedAt,
    }, { onConflict: "session_id" });
    if (claimError) {
      console.error("Lecture note claim failed", claimError.code);
      return NextResponse.json({ error: isEnglish ? "Could not start the note." : "노트 생성을 시작하지 못했습니다." }, { status: 500 });
    }

    const markFailed = async () => {
      const { error } = await admin.from("lecture_notes")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("session_id", sessionId).eq("user_id", userId).eq("status", "generating").eq("updated_at", startedAt);
      if (error) console.error("Lecture note failure status save failed", error.code);
    };
    markUnscheduledFailed = markFailed;

    // Persist the start before input preparation, so another tab cannot mistake
    // a prior ready note for the result of the newly accepted generation.
    // Read the complete input before spending model quota.
    // Failed/oversized reads must never become plausible-looking partial notes.
    const evidence: NoteEvidence = { sources: new Map(), questions: new Set(), questionSources: new Map(), answers: new Map(), documents: [] };
    let transcript: string, questions: string, materialText: string;
    try {
      [transcript, questions, materialText] = await Promise.all([
        readTranscript(supabase, sessionId, evidence, isEnglish),
        readQuestions(supabase, sessionId, evidence, isEnglish),
        readMaterials(supabase, sessionId, evidence, isEnglish),
      ]);
    } catch (error) {
      const kind = error instanceof NoteInputError ? error.kind : "read";
      console.error("Lecture note input unavailable", kind);
      return NextResponse.json({ error: noteInputMessage(kind, isEnglish) }, { status: kind === "read" ? 503 : 413 });
    }
    if (!transcript) return NextResponse.json({ error: isEnglish ? "This lecture has no transcript to build a note from." : "노트를 만들 스크립트가 없는 수업입니다." }, { status: 422 });

    const rateLimit = await checkSharedRateLimit(`lecture-notes:${userId}`, GENERATION_LIMIT, GENERATION_WINDOW_MS);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: isEnglish ? "Too many note requests. Try again later." : "노트 생성 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const input = [
      `# ${isEnglish ? "Lecture" : "수업"}: ${session.title}`,
      `## ${isEnglish ? "Transcript" : "강의 스크립트"}\n${transcript}`,
      questions ? `## ${isEnglish ? "Actual questions and saved AI answers (conversation history, not lecture evidence; Q IDs go in questionIds only)" : "실제 질문과 저장된 AI 답변 (강의 근거가 아닌 대화 기록이며, Q ID는 questionIds에만 넣음)"}\n${questions}` : "",
      materialText ? `## ${isEnglish ? "Lecture materials (extracted text, not images)" : "강의 자료 (이미지가 아닌 추출 텍스트)"}\n${materialText}` : "",
    ].filter(Boolean).join("\n\n");
    const remainingGenerations = await peekRemaining(userId).catch(() => null);

    // Next/Vercel keeps after() alive after the HTTP response (including a tab
    // navigation). The DB row is the shared state; the browser only observes it.
    // Keep the lease until this callback completes, never until the 202 response.
    try {
      after(async () => {
        try {
          // Leave time for validation and DB writes inside the route's 300s cap.
          // A retry could double the old 240s timeout and leave a stuck job row.
          const timeout = Math.min(240_000, maxDuration * 1_000 - (Date.now() - requestStartedAt) - 20_000);
          if (timeout <= 0) throw new Error("note preparation exceeded time budget");
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout, maxRetries: 0 });
          const response = await openai.responses.create({
            model: "gpt-5.6-luna",
            max_output_tokens: 24_000,
            store: false,
            instructions: notePrompt(language),
            input,
            text: { format: { type: "json_schema", name: "lecture_note", strict: true, schema: noteSchema(language) as unknown as Record<string, unknown> } },
          });
          if (response.status !== "completed") throw new Error("incomplete note response");
          const note: LectureNote = { ...validateLectureNote(JSON.parse(response.output_text ?? ""), evidence), language };
          const { error: saveError } = await admin.from("lecture_notes")
            .update({ status: "ready", content: note, model: "gpt-5.6-luna", updated_at: new Date().toISOString() })
            .eq("session_id", sessionId).eq("user_id", userId).eq("status", "generating").eq("updated_at", startedAt);
          if (saveError) {
            console.error("Lecture note save failed", saveError.code);
            throw new Error("note save failed");
          }
          await saveConcepts(supabase, userId, session.classroom_id, sessionId, note);
        } catch (error) {
          console.error("Lecture note generation failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
          // Updating status never clears the previous validated content.
          try { await markFailed(); } catch { console.error("Lecture note failure status save failed"); }
        } finally {
          await releaseNoteLease(supabase, sessionId, token);
        }
      });
      scheduled = true;
    } catch {
      return NextResponse.json({ error: generationFailureMessage(isEnglish) }, { status: 503 });
    }
    return NextResponse.json({
      note: { status: "generating", content: previousContent, updated_at: startedAt },
      remainingGenerations,
    }, { status: 202 });
  } finally {
    if (!scheduled) {
      try { await markUnscheduledFailed?.(); } catch { console.error("Lecture note failure status save failed"); }
      await releaseNoteLease(supabase, sessionId, token);
    }
  }
}

/**
 * 노트가 뽑은 개념 카드를 질문 컨텍스트용으로 굳힌다. 재생성이면 그 세션의
 * 이전 카드를 대체한다. 실패해도 노트는 이미 저장됐다 — 다음 재생성이 채운다.
 */
async function saveConcepts(supabase: Supabase, userId: string, classroomId: string | null, sessionId: string, note: LectureNote) {
  const concepts = (note.concepts ?? [])
    .filter((concept) => concept.name.trim() && concept.definition.trim())
    .slice(0, 20);
  try {
    await supabase.from("lecture_concepts").delete().eq("session_id", sessionId);
    if (!concepts.length) return;
    const seen = new Set<string>();
    const rows = concepts.filter((concept) => {
      const key = concept.name.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((concept) => {
      const spoken = concept.sources?.find(source => source.startMs !== undefined);
      return {
        user_id: userId,
        classroom_id: classroomId,
        session_id: sessionId,
        name: concept.name.trim().slice(0, 120),
        definition: concept.definition.trim().slice(0, 1000),
        evidence_ms: spoken?.startMs ?? null,
        related: concept.related.map((name) => name.trim()).filter(Boolean).slice(0, 8),
      };
    });
    const { error } = await supabase.from("lecture_concepts").insert(rows);
    if (error) console.error("Concept save failed", error.code);
  } catch (caught) {
    console.error("Concept save failed", caught instanceof Error ? caught.message : caught);
  }
}

/** PostgREST가 1000행에서 자른다. 분 단위 타임스탬프를 붙여 흐름을 보존한다. */
async function readTranscript(supabase: Supabase, sessionId: string, evidence: NoteEvidence, english: boolean) {
  const lines: string[] = [];
  let total = 0;
  for (let offset = 0; ; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transcript_segments")
      .select("start_ms,text")
      .eq("session_id", sessionId)
      .order("start_ms", { ascending: true })
      .order("client_id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) {
      console.error("Note segment read failed", error.code);
      throw new NoteInputError("read");
    }
    const page = data ?? [];
    for (const row of page) {
      if (!Number.isFinite(row.start_ms) || row.start_ms < 0 || typeof row.text !== "string") throw new NoteInputError("read");
      if (!row.text.trim()) continue;
      const id = `T${lines.length + 1}`;
      const clock = noteClock(row.start_ms);
      const line = `[${id} | ${clock}] ${row.text}`;
      total += line.length + 1;
      if (total > MAX_TRANSCRIPT_CHARACTERS) throw new NoteInputError("transcript");
      evidence.sources.set(id, { id, label: `${english ? "Lecture" : "강의"} ${clock}`, startMs: row.start_ms });
      lines.push(line);
    }
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  return lines.join("\n");
}

async function readQuestions(supabase: Supabase, sessionId: string, evidence: NoteEvidence, english: boolean) {
  const groups = new Map<string, string[]>();
  let total = 0;
  let answerTotal = 0;
  for (let offset = 0; ; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase.from("lecture_questions")
      .select("id,question,question_at_ms,answer")
      .eq("session_id", sessionId).order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) throw new NoteInputError("read");
    const page = data ?? [];
    for (const row of page) {
      if (typeof row.question !== "string" || !Number.isFinite(row.question_at_ms) || row.question_at_ms < 0) throw new NoteInputError("read");
      const question = row.question.trim();
      if (!question) continue;
      const clock = noteClock(row.question_at_ms);
      if (!groups.has(question)) {
        groups.set(question, []);
        const id = `Q${groups.size}`;
        total += question.length + id.length + 8;
        evidence.questions.add(question);
        evidence.questionSources.set(question, { id, label: `${english ? "My question" : "내 질문"} ${clock}`, startMs: row.question_at_ms });
      }
      if (!groups.get(question)!.includes(clock)) {
        groups.get(question)!.push(clock);
        total += clock.length + 2;
      }
      if (row.answer !== undefined && row.answer !== null && typeof row.answer !== "string") throw new NoteInputError("read");
      if (typeof row.answer === "string" && row.answer.trim()) {
        if (typeof row.id !== "string" || !row.id) throw new NoteInputError("read");
        const questionId = evidence.questionSources.get(question)!.id;
        const answers = evidence.answers!.get(questionId) ?? [];
        // Preserve each turn, including a different answer to an identical question.
        answers.push({ id: row.id, questionId, text: row.answer });
        evidence.answers!.set(questionId, answers);
        answerTotal += row.answer.length;
        if (answerTotal > MAX_ANSWER_CHARACTERS) throw new NoteInputError("questions");
      }
      if (total > MAX_QUESTION_CHARACTERS) throw new NoteInputError("questions");
    }
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  return [...groups].map(([question, clocks]) => {
    const id = evidence.questionSources.get(question)!.id;
    const answers = evidence.answers!.get(id) ?? [];
    const history = answers.map(answer => `${english ? "Saved AI answer (replayed verbatim in the note)" : "저장된 AI 답변 (노트에 원문 그대로 표시)"}:\n${answer.text}`).join("\n\n");
    return `[${id} | ${clocks.join(", ")}] ${question}${history ? `\n${history}` : ""}`;
  }).join("\n\n");
}

async function readMaterials(supabase: Supabase, sessionId: string, evidence: NoteEvidence, english: boolean) {
  const documents: NoteDocument[] = [];
  for (let offset = 0; ; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase.from("material_documents").select("id,filename,page_count,storage_path")
      .eq("session_id", sessionId).order("id", { ascending: true }).range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) throw new NoteInputError("read");
    const page = (data ?? []) as NoteDocument[];
    documents.push(...page);
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  evidence.documents = documents;

  const parts: string[] = [];
  let total = 0;
  for (const [documentIndex, document] of documents.entries()) {
    const heading = `### ${document.filename} (${document.storage_path ? (english ? "preview available" : "미리보기 가능") : (english ? "text only" : "텍스트 전용")})`;
    total += heading.length + 1;
    if (total > MAX_MATERIAL_CHARACTERS) throw new NoteInputError("materials");
    parts.push(heading);
    let hasChunks = false;
    for (let offset = 0; ; offset += SEGMENT_PAGE_SIZE) {
      const { data, error } = await supabase.from("material_chunks").select("start_page,end_page,text")
        .eq("document_id", document.id).order("start_page", { ascending: true }).order("id", { ascending: true })
        .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
      if (error) throw new NoteInputError("read");
      const chunks = data ?? [];
      for (const chunk of chunks) {
        hasChunks = true;
        if (typeof chunk.text !== "string" || !Number.isInteger(chunk.start_page) || !Number.isInteger(chunk.end_page) || chunk.start_page < 1 || chunk.end_page < chunk.start_page || chunk.end_page > (document.page_count ?? 500)) throw new NoteInputError("read");
        const ids: string[] = [];
        for (let page = chunk.start_page; page <= chunk.end_page; page++) {
          const id = `M${documentIndex + 1}P${page}`;
          ids.push(id);
          evidence.sources.set(id, { id, label: `${document.filename} · p.${page}`, documentId: document.id, page });
        }
        const line = `[${ids.join(", ")}] (p.${chunk.start_page}${chunk.end_page !== chunk.start_page ? `-${chunk.end_page}` : ""}) ${chunk.text}`;
        total += line.length + 1;
        if (total > MAX_MATERIAL_CHARACTERS) throw new NoteInputError("materials");
        parts.push(line);
      }
      if (chunks.length < SEGMENT_PAGE_SIZE) break;
    }
    if (!hasChunks) throw new NoteInputError("read");
  }
  return parts.join("\n");
}
