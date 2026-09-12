import { NextResponse } from "next/server";
import { hasVerifiedEmail } from "../../lib/verified-email";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { withGenerationLease } from "../../lib/generation-lease";
import { buildLectureFlow } from "../../lib/lecture-flow";
import {
  pendingSummaryWindows,
  MAX_SUMMARY_CHARACTERS,
  MAX_WINDOW_INDEX,
  SUMMARY_PROMPT,
  SUMMARY_WINDOW_MS,
  type SummarySegment,
} from "../../lib/lecture-summary";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 한 요청이 채울 창의 수. 밀린 게 더 있으면 다음 호출이 이어 받는다. */
const MAX_WINDOWS_PER_CALL = 3;
const SEGMENT_PAGE_SIZE = 1_000;

/** A private, read-only view of summaries that have already been generated. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const isEnglish = request.headers.get("x-site-locale") === "en";
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !hasVerifiedEmail(user)) {
    return reply({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, 401);
  }
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!isUuid(sessionId)) {
    return reply({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, 400);
  }
  const { data: session, error: sessionError } = await supabase.from("lecture_sessions")
    .select("id").eq("id", sessionId).eq("user_id", user.id).maybeSingle();
  if (sessionError) return reply({ error: isEnglish ? "Could not load the lecture flow. Please try again." : "수업 흐름을 불러오지 못했습니다. 다시 시도해 주세요." }, 503);
  if (!session) return reply({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, 404);

  const [summaryResult, latestResult] = await Promise.all([
    supabase.from("lecture_summaries").select("window_index,start_ms,end_ms,text")
      .eq("session_id", sessionId).eq("user_id", user.id).order("window_index", { ascending: true }).limit(18),
    // Only the last timestamp is needed. Never read/send transcript text here.
    supabase.from("transcript_segments").select("end_ms")
      .eq("session_id", sessionId).eq("user_id", user.id).order("end_ms", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (summaryResult.error || latestResult.error) {
    return reply({ error: isEnglish ? "Could not load the lecture flow. Please try again." : "수업 흐름을 불러오지 못했습니다. 다시 시도해 주세요." }, 503);
  }
  return reply(buildLectureFlow((summaryResult.data ?? []).map(row => ({
    windowIndex: row.window_index, startMs: row.start_ms, endMs: row.end_ms, text: row.text,
  })), latestResult.data?.end_ms ?? 0, isEnglish ? "en" : "ko"));
}

/**
 * 끝난 구간을 하나씩 색인용 요약으로 접어 둔다. 질문할 때가 아니라 강의 중에,
 * 학습자를 기다리게 하지 않는 시점에 한 번만 돈다. 여기서 만든 요약을
 * /api/ask가 원문 대신 읽는다.
 *
 * 크레딧은 받지 않는다. 이건 학습자가 산 기능이 아니라 뒤에 오는 질문값을
 * 깎기 위해 우리가 미리 치르는 비용이다.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (authError || !hasVerifiedEmail(user)) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "요청을 확인해 주세요." }, { status: 400 });
  }
  if (!body || !isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  const sessionId = body.sessionId;

  // 클라이언트가 몇 분마다 부르는 자리다. 탭이 여러 개 열려 있어도 모델 호출이
  // 그만큼 늘지는 않게 막는다.
  const rateLimit = await checkSharedRateLimit(`lecture-summary:${user.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ ok: true, skipped: "rate-limited" }, { status: 202 });
  }
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ ok: true, skipped: "unconfigured" });

  return withGenerationLease(supabase, sessionId, "summary", isEnglish, async () => {

  // Explicit ownership remains required before any service-role operation.
  const [{ data: session, error: sessionError }, { data: existingRows, error: existingError }] = await Promise.all([
    supabase.from("lecture_sessions").select("id,classroom_id,status").eq("id", sessionId).eq("user_id", user.id).maybeSingle(),
    supabase.from("lecture_summaries").select("window_index").eq("session_id", sessionId).eq("user_id", user.id),
  ]);
  if (sessionError || existingError) return NextResponse.json({ error: "Could not load summary context." }, { status: 503 });
  if (!session) return NextResponse.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: isEnglish ? "Summary generation is temporarily unavailable." : "요약 생성을 잠시 사용할 수 없습니다." }, { status: 503 });
  const { data: generations, error: generationError } = await admin.from("lecture_summary_generations")
    .select("window_index,attempts,completed_at").eq("session_id", sessionId).eq("user_id", user.id);
  if (generationError) return NextResponse.json({ error: isEnglish ? "Could not check summary generation. Please try again." : "요약 생성 상태를 확인하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });

  let segments: SummarySegment[];
  try {
    segments = await readSegments(supabase, sessionId);
  } catch {
    return NextResponse.json({ error: isEnglish ? "Could not load summary context. Please try again." : "요약할 내용을 불러오지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
  }
  if (!segments.length) return NextResponse.json({ ok: true, written: 0 });

  const existing = [
    ...(existingRows ?? []).map((row) => Number(row.window_index)),
    ...(generations ?? []).filter(row => row.completed_at || row.attempts >= 2).map(row => Number(row.window_index)),
  ];
  const pending = pendingSummaryWindows(segments, existing, MAX_WINDOW_INDEX + 1, session.status === "completed");
  if (!pending.length) return NextResponse.json({ ok: true, written: 0 });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 0 });
  let written = 0;
  let requested = 0;
  let skipped: string | undefined;

  for (const { windowIndex, sourceText } of pending) {
    if (requested >= MAX_WINDOWS_PER_CALL) break;
    const token = crypto.randomUUID();
    const { data: claim, error: claimError } = await admin.rpc("claim_lecture_summary_generation", {
      p_user_id: user.id, p_session_id: sessionId, p_window_index: windowIndex, p_token: token,
      p_source_characters: sourceText.length,
      p_end_ms: Math.min(10_800_000, (windowIndex + 1) * SUMMARY_WINDOW_MS, segments.at(-1)!.endMs),
    });
    // Fail closed before a paid request if the durable budget is unavailable.
    if (claimError) return NextResponse.json({ error: isEnglish ? "Could not reserve summary generation. Please try again." : "요약 생성 요청을 저장하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
    if (claim !== "claimed") {
      skipped = ["completed", "generating", "attempt-limit", "daily-budget", "source-limit"].includes(claim) ? claim : "unavailable";
      if (skipped === "daily-budget" || skipped === "unavailable") break;
      continue;
    }

    requested += 1;
    let text: string;
    try {
      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        max_output_tokens: 2_000,
        store: false,
        instructions: SUMMARY_PROMPT,
        input: sourceText,
      });
      text = (response.output_text ?? "").trim().slice(0, MAX_SUMMARY_CHARACTERS);
    } catch (error) {
      // The durable attempt remains charged, including ambiguous upstream failures.
      console.error("Lecture summary failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
      break;
    }
    if (!text) continue;

    // Save and durable completion commit together, using the current parent
    // classroom in the database so a concurrent lecture move remains valid.
    const { data: saved, error } = await admin.rpc("complete_lecture_summary_generation", {
      p_user_id: user.id, p_session_id: sessionId, p_window_index: windowIndex, p_token: token, p_text: text,
    });
    if (error || !saved) {
      console.error("Lecture summary save failed", error?.code ?? "claim-expired");
      return NextResponse.json({ error: isEnglish ? "Could not save the summary." : "요약을 저장하지 못했습니다." }, { status: 500 });
    }
    written += 1;
  }
  return NextResponse.json({ ok: true, written, ...(skipped ? { skipped } : {}) });
  });
}

/** PostgREST가 1000행에서 조용히 자른다. 3시간 수업은 그보다 문장이 많다. */
async function readSegments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
): Promise<SummarySegment[]> {
  const rows: SummarySegment[] = [];
  for (let offset = 0; ; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transcript_segments")
      .select("start_ms,end_ms,text")
      .eq("session_id", sessionId)
      .order("start_ms", { ascending: true })
      .order("client_id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) {
      console.error("Summary segment read failed", error.code);
      throw new Error("Summary context could not be read completely");
    }
    const page = data ?? [];
    for (const row of page) rows.push({ startMs: row.start_ms, endMs: row.end_ms, text: row.text });
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  return rows;
}
