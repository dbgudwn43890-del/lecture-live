import { NextResponse } from "next/server";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import {
  completedWindows,
  MAX_SUMMARY_CHARACTERS,
  segmentsInWindow,
  SUMMARY_PROMPT,
  SUMMARY_WINDOW_MS,
  type SummarySegment,
} from "../../lib/lecture-summary";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 한 요청이 채울 창의 수. 밀린 게 더 있으면 다음 호출이 이어 받는다. */
const MAX_WINDOWS_PER_CALL = 3;
/** 창 하나에 이만큼도 안 쌓였으면 요약해서 아낄 것이 없다. */
const MIN_WINDOW_CHARACTERS = 400;
const SEGMENT_PAGE_SIZE = 1_000;

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
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "요청을 확인해 주세요." }, { status: 400 });
  }
  if (!isUuid(body.sessionId)) {
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

  // RLS가 소유자로 좁힌다. 남의 수업 id는 여기서 빈 값으로 돌아온다.
  const [{ data: session }, { data: existingRows }] = await Promise.all([
    supabase.from("lecture_sessions").select("id,classroom_id").eq("id", sessionId).maybeSingle(),
    supabase.from("lecture_summaries").select("window_index").eq("session_id", sessionId),
  ]);
  if (!session) return NextResponse.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });

  const segments = await readSegments(supabase, sessionId);
  if (!segments.length) return NextResponse.json({ ok: true, written: 0 });

  const existing = (existingRows ?? []).map((row) => Number(row.window_index));
  const pending = completedWindows(segments.at(-1)!.endMs, existing).slice(0, MAX_WINDOWS_PER_CALL);
  if (!pending.length) return NextResponse.json({ ok: true, written: 0 });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
  const rows: Array<Record<string, unknown>> = [];

  for (const windowIndex of pending) {
    const inWindow = segmentsInWindow(segments, windowIndex);
    const sourceText = inWindow.map((segment) => segment.text).join("\n");
    // 조용했던 구간. 원문을 그대로 두는 편이 요약보다 짧고 정확하다.
    if (sourceText.length < MIN_WINDOW_CHARACTERS) continue;

    let text: string;
    try {
      const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        max_output_tokens: 2_000,
        store: false,
        instructions: SUMMARY_PROMPT,
        input: sourceText,
      });
      text = (response.output_text ?? "").trim().slice(0, MAX_SUMMARY_CHARACTERS);
    } catch (error) {
      // 이 구간은 다음 호출에서 다시 시도된다. 행을 안 쓰는 것이 곧 재시도다.
      console.error("Lecture summary failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
      break;
    }
    if (!text) continue;

    rows.push({
      session_id: sessionId,
      classroom_id: session.classroom_id,
      user_id: user.id,
      window_index: windowIndex,
      start_ms: windowIndex * SUMMARY_WINDOW_MS,
      end_ms: Math.min(10_800_000, (windowIndex + 1) * SUMMARY_WINDOW_MS),
      text,
      source_characters: sourceText.length,
    });
  }

  if (!rows.length) return NextResponse.json({ ok: true, written: 0 });

  // 두 탭이 같은 창을 동시에 밀면 유일 인덱스가 하나만 남긴다. 먼저 쓴 쪽이
  // 이기고, 진 쪽은 에러가 아니라 할 일이 없어진 것이다.
  const { error } = await supabase.from("lecture_summaries").upsert(rows, {
    onConflict: "session_id,window_index",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error("Lecture summary save failed", error.code);
    return NextResponse.json({ error: isEnglish ? "Could not save the summary." : "요약을 저장하지 못했습니다." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, written: rows.length });
}

/** PostgREST가 1000행에서 조용히 자른다. 3시간 수업은 그보다 문장이 많다. */
async function readSegments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
): Promise<SummarySegment[]> {
  const rows: SummarySegment[] = [];
  for (let offset = 0; offset < 5_000; offset += SEGMENT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transcript_segments")
      .select("start_ms,end_ms,text")
      .eq("session_id", sessionId)
      .order("start_ms", { ascending: true })
      .order("client_id", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (error) {
      console.error("Summary segment read failed", error.code);
      break;
    }
    const page = data ?? [];
    for (const row of page) rows.push({ startMs: row.start_ms, endMs: row.end_ms, text: row.text });
    if (page.length < SEGMENT_PAGE_SIZE) break;
  }
  return rows;
}
