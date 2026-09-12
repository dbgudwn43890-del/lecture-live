import { createHash } from "node:crypto";
import OpenAI from "openai";

import { canUseLiveAssist } from "../../lib/live-assist-access";
import { loadLiveAssistMaterialContext } from "../../lib/live-assist-context";
import {
  LIVE_ASSIST_MAX_BODY_BYTES, LiveAssistDecisionParser,
  liveAssistInput, liveAssistInstructions, parseLiveAssistRequest, type LiveAssistEvent,
} from "../../lib/live-assist";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const headers = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > LIVE_ASSIST_MAX_BODY_BYTES) throw new RangeError("Body too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIVE_ASSIST_MAX_BODY_BYTES) throw new RangeError("Body too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const requestStarted = performance.now();
  let english = request.headers.get("x-site-locale") === "en";
  const errorResponse = (status: number, korean: string, englishText: string, retryAfter?: number) => new Response(
    `${JSON.stringify({ error: english ? englishText : korean })}\n`,
    { status, headers: { ...headers, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
  );
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return errorResponse(401, "로그인이 필요합니다.", "Sign-in is required.");
    if (!canUseLiveAssist(user)) return errorResponse(403, "실시간 보조 기능을 사용할 수 없는 계정입니다.", "Live assistance is not available for this account.");

    let raw: unknown;
    try { raw = await readBody(request); } catch (error) {
      if (request.signal.aborted) return errorResponse(499, "요청이 취소됐습니다.", "The request was cancelled.");
      return error instanceof RangeError
        ? errorResponse(413, "요청 내용이 너무 깁니다.", "The request is too large.")
        : errorResponse(400, "요청 형식이 올바르지 않습니다.", "The request is invalid.");
    }
    const body = parseLiveAssistRequest(raw);
    if (!body) return errorResponse(400, "실시간 강의 요청 형식이 올바르지 않습니다.", "The live lecture request is invalid.");
    english = body.locale === "en";

    const apiKey = process.env.OPENAI_API_KEY;
    const admin = createAdminClient();
    if (!apiKey || !admin) return errorResponse(503, "실시간 보조 기능을 사용할 수 없습니다.", "Live assistance is unavailable.");

    const [{ data: session, error: sessionError }, { data: relay, error: relayError }] = await Promise.all([
      supabase.from("lecture_sessions").select("id,user_id,status,recorded_ms,recording_started_at,started_at")
        .eq("id", body.lectureSessionId).eq("user_id", user.id).maybeSingle(),
      admin.from("stt_relay_sessions").select("session_id,user_id,processed_bytes,authorized_bytes,connection_id,expires_at")
        .eq("session_id", body.lectureSessionId).eq("user_id", user.id).maybeSingle(),
    ]);
    if (sessionError || relayError) return errorResponse(503, "강의 상태를 확인하지 못했습니다.", "The lecture status could not be verified.");
    if (!session || session.user_id !== user.id) return errorResponse(404, "강의를 찾을 수 없습니다.", "The lecture was not found.");
    if (session.status !== "recording") return errorResponse(409, "기록 중인 강의에서 사용할 수 있습니다.", "Live assistance requires a recording lecture.");

    // The client cannot reuse an old prepaid minute to pass the credit gate.
    const recordingStarted = Date.parse(session.recording_started_at ?? session.started_at);
    if (!Number.isFinite(recordingStarted) || !Number.isSafeInteger(session.recorded_ms) || session.recorded_ms < 0) {
      return errorResponse(503, "강의 시간을 확인하지 못했습니다.", "The lecture time could not be verified.");
    }
    const recordedMs = session.recorded_ms + Math.max(0, Date.now() - recordingStarted);
    if (recordedMs >= 10_800_000) return errorResponse(409, "강의 기록 시간이 끝났습니다.", "The lecture recording limit was reached.");
    // Relay billing follows accepted PCM, which can trail the wall clock
    // after setup/reconnection. Honor its current prepaid minute only while
    // a server-owned lease still has unconsumed audio allowance.
    const prepaidRelay = relay && relay.user_id === user.id && relay.session_id === session.id
      && typeof relay.connection_id === "string" && relay.connection_id.length > 0
      && Date.parse(relay.expires_at) > Date.now()
      && Number.isSafeInteger(relay.processed_bytes) && relay.processed_bytes >= 0
      && Number.isSafeInteger(relay.authorized_bytes) && relay.authorized_bytes > relay.processed_bytes
      && relay.authorized_bytes <= 345_600_000;
    const { data: canAsk, error: creditError } = await supabase.rpc("can_ask_with_credits", {
      p_session_id: session.id,
      p_minute_index: prepaidRelay ? Math.floor(relay.processed_bytes / 1_920_000) : Math.floor(recordedMs / 60_000),
    });
    if (creditError) return errorResponse(503, "크레딧을 확인하지 못했습니다.", "Credits could not be verified.");
    if (canAsk !== true) return errorResponse(402, "사용 가능한 크레딧이 없습니다.", "No credits are available.");

    const consumeLimit = async (key: string, limit: number, seconds: number) => {
      // This experimental platform-key endpoint fails closed if the shared
      // limiter is unavailable; an instance-local fallback cannot bound spend.
      const { data, error } = await admin.rpc("consume_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: seconds });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || typeof row?.allowed !== "boolean") return errorResponse(503, "요청 한도를 확인하지 못했습니다.", "The request limit could not be verified.");
      if (!row.allowed) {
        const retry = Number(row.retry_after_seconds);
        return errorResponse(429, "잠시 후 다시 시도해 주세요.", "Try again shortly.", Number.isFinite(retry) ? Math.max(1, Math.ceil(retry)) : seconds);
      }
      return null;
    };
    // Bound retrieval as well as model calls. Materials are fetched afresh so
    // an upload or deletion is reflected without waiting for a process cache.
    for (const [key, limit, seconds] of [
      [`live-assist-burst:${user.id}`, 8, 15],
      [`live-assist-hour:${user.id}`, 900, 3_600],
    ] as const) {
      const denied = await consumeLimit(key, limit, seconds);
      if (denied) return denied;
    }
    if (request.signal.aborted) return errorResponse(499, "요청이 취소됐습니다.", "The request was cancelled.");

    const materialContext = await loadLiveAssistMaterialContext(admin, {
      userId: user.id, sessionId: session.id, signal: request.signal,
      query: `${body.transcript.slice(-2_000)}\n${body.conversation.filter(message => message.role === "user").at(-1)?.content.slice(-1_000) ?? ""}`,
    });
    if (request.signal.aborted) return errorResponse(499, "요청이 취소됐습니다.", "The request was cancelled.");
    if (materialContext.status === "unavailable") return errorResponse(503,
      "강의 자료를 불러오지 못해 실시간 답변을 잠시 멈췄어요. 잠시 후 다시 시도해 주세요.",
      "Live assistance paused because the lecture materials could not be loaded. Please retry shortly.");
    // The same spoken question becomes useful after a resume/chat clarification
    // arrives. Previous AI answers are not a reason to bypass deduplication.
    const contextHash = createHash("sha256").update(JSON.stringify({
      transcript: body.transcript.normalize("NFKC").replace(/\s+/g, " ").trim(),
      conversation: body.conversation, materialContext,
    })).digest("hex");
    const duplicate = await consumeLimit(`live-assist-window:${user.id}:${session.id}:${contextHash}`, 1, 60);
    if (duplicate) return duplicate;

    const abort = new AbortController();
    const abortFromRequest = () => abort.abort();
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    if (request.signal.aborted) abort.abort();
    const encoder = new TextEncoder();
    let cancelled = false;
    const timeout = setTimeout(() => abort.abort(), 40_000);
    const cleanup = () => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromRequest);
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const started = performance.now();
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        let decision: "wait" | "answer" | null = null;
        let decisionMs: number | null = null;
        let firstTextMs: number | null = null;
        let failed = false;
        const send = (event: LiveAssistEvent | { done: true } | { error: string }) => {
          if ("decision" in event) {
            decision = event.decision;
            decisionMs ??= Math.round(performance.now() - started);
          }
          if ("delta" in event && event.delta.trim()) firstTextMs ??= Math.round(performance.now() - started);
          if ("error" in event) failed = true;
          if (cancelled || request.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          const openai = new OpenAI({ apiKey, timeout: 40_000, maxRetries: 0 });
          const events = await openai.beta.responses.create({
            model: "gpt-5.6-luna", reasoning: { effort: "low" }, text: { verbosity: "low" },
            max_output_tokens: 650, store: false, tools: [], tool_choice: "none",
            safety_identifier: createHash("sha256").update(user.id).digest("hex"),
            instructions: liveAssistInstructions(body.locale), input: liveAssistInput(body, materialContext), stream: true,
          }, { signal: abort.signal });
          const parser = new LiveAssistDecisionParser();
          let completed = false;
          for await (const event of events) {
            abort.signal.throwIfAborted();
            if (event.type === "response.output_text.delta") {
              for (const output of parser.push(event.delta)) send(output);
            } else if (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") {
              const tokens = event.response?.usage;
              if (tokens) usage = { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens };
              if (event.type !== "response.completed") throw new Error("Provider response failed");
              completed = true;
            } else if (event.type === "error") throw new Error("Provider response failed");
          }
          abort.signal.throwIfAborted();
          if (!completed) throw new Error("Provider response did not complete");
          for (const output of parser.finish()) send(output);
          send({ done: true });
        } catch {
          abort.abort();
          send({ error: english ? "Live assistance could not finish. Try again with the next passage." : "실시간 답변을 마치지 못했어요. 다음 발화에서 다시 시도해 주세요." });
        } finally {
          cleanup();
          // Separate a deliberate WAIT from slow generation without logging speech or answers.
          console.info("Live assist usage", {
            inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
            decision, decisionMs, firstTextMs, preflightMs: Math.round(started - requestStarted),
            latencyMs: Math.round(performance.now() - started), failed, cancelled: cancelled || request.signal.aborted,
          });
          if (!cancelled) controller.close();
        }
      },
      cancel() { cancelled = true; abort.abort(); cleanup(); },
    });
    return new Response(stream, { headers });
  } catch {
    return errorResponse(503, "실시간 보조 기능을 사용할 수 없습니다.", "Live assistance is unavailable.");
  }
}
