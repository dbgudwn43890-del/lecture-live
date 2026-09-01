import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isUuid } from "../../lib/billing";
import { deepgramLanguage } from "../../lib/deepgram";
import { parseGlossary } from "../../lib/glossary";
import {
  callbackToken,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_MS,
  prerecordedUrl,
} from "../../lib/lecture-audio";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

// Long enough for Deepgram to fetch a 1GB file, short enough that a leaked URL
// is useless by the time anyone finds it.
const SIGNED_URL_SECONDS = 3_600;

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "webm", "mp4"]);

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  const rateLimit = await checkSharedRateLimit(`lecture-audio:${user.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { userId: user.id, supabase, isEnglish };
}

/**
 * UPL-06. Anything past its deadline that still has an object loses it. This
 * runs on the polling path rather than a scheduled job: an upload is always
 * being watched by the client that made it, so the sweep gets called far more
 * often than a cron would, with no extra infrastructure.
 *
 * ponytail: piggybacked on polling. Move to a scheduled function if uploads
 * ever outlive the sessions that watch them.
 */
async function sweepExpired(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: expired } = await supabase
    .from("uploads")
    .select("id,object_key")
    .is("deleted_at", null)
    .lt("delete_at", new Date().toISOString())
    .limit(20);
  for (const upload of expired ?? []) {
    if (upload.object_key) await supabase.storage.from("lecture-audio").remove([upload.object_key]);
    await supabase
      .from("uploads")
      .update({ status: "deleted", object_key: null, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", upload.id);
  }
}

/** UPL-03. What the progress panel polls while Deepgram works. */
export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  await sweepExpired(current.supabase);

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const query = current.supabase
    .from("uploads")
    .select("id,session_id,status,filename,byte_size,duration_ms,error_code,created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data, error } = isUuid(sessionId) ? await query.eq("session_id", sessionId) : await query;
  if (error) {
    console.error("Upload list failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not check your uploads." : "업로드 상태를 확인하지 못했습니다." }, { status: 500 });
  }
  return NextResponse.json({ uploads: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * UPL-01. Takes the file, parks it in a private bucket, and hands Deepgram a
 * signed URL to fetch it from. The transcript arrives later on the callback
 * route, so this returns as soon as the job is accepted (UPL-03) rather than
 * holding a request open for the length of the lecture.
 */
export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  const { isEnglish, supabase, userId } = current;

  const apiKey = process.env.DEEPGRAM_API_KEY;
  const callbackBase = process.env.SITE_URL;
  if (!apiKey || !callbackBase || !process.env.LECTURE_AUDIO_CALLBACK_SECRET) {
    return NextResponse.json({ error: isEnglish ? "File transcription is not configured yet." : "녹음 파일 변환이 아직 설정되지 않았습니다." }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid upload." : "올바른 업로드 요청이 아닙니다." }, { status: 400 });
  }

  const file = formData.get("file");
  const title = String(formData.get("title") ?? "").trim().slice(0, 80);
  const classroomId = formData.get("classroomId");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  const raw = deepgramLanguage(formData.get("language"), "ko");
  // 업로드는 지원받는 Deepgram 배치로 간다. Deepgram의 multi는 한국어를
  // 지원하지 않으므로 혼용(실시간 Soniox 전용) 선택은 여기서 ko로 내린다.
  const language = raw === "multi" ? "ko" : raw;
  // The browser reads this off an <audio> element before uploading. It decides
  // whether to accept the job at all; the charge below uses Deepgram's own
  // measurement, so a client lying here cannot buy a cheaper transcription.
  const claimedDurationMs = Number(formData.get("durationMs") ?? 0);

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: isEnglish ? "Choose an audio file." : "녹음 파일을 선택해 주세요." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: isEnglish ? "Upload a file of 1GB or less." : "1GB 이하의 파일을 올려 주세요." }, { status: 413 });
  }
  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return NextResponse.json({
      error: isEnglish ? "Supported formats are MP3, M4A, WAV, WebM, and MP4." : "MP3, M4A, WAV, WebM, MP4 파일만 변환할 수 있습니다.",
    }, { status: 400 });
  }
  if (Number.isFinite(claimedDurationMs) && claimedDurationMs > MAX_AUDIO_MS) {
    return NextResponse.json({
      error: isEnglish ? "A lecture can be up to 3 hours long." : "한 수업은 최대 3시간까지 변환할 수 있습니다.",
    }, { status: 413 });
  }
  if (!title) {
    return NextResponse.json({ error: isEnglish ? "Name this lecture." : "수업 제목을 입력해 주세요." }, { status: 400 });
  }
  if (!idempotencyKey || idempotencyKey.length > 100) {
    return NextResponse.json({ error: isEnglish ? "Invalid upload." : "올바른 업로드 요청이 아닙니다." }, { status: 400 });
  }

  // UPL-04. The same request arriving twice — a retry, a double click, a flaky
  // connection — finds the job it already created instead of transcribing and
  // billing the same lecture again.
  const { data: existing } = await supabase
    .from("uploads")
    .select("id,session_id,status")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ upload: existing, duplicate: true });
  }

  // Transcribing a 3-hour file costs real money before a single credit is
  // charged, so an account with nothing left is turned away at the door. The
  // actual charge happens on the callback, against Deepgram's measured length.
  const { data: creditStatus } = await supabase.rpc("get_credit_status");
  const credits = Number((Array.isArray(creditStatus) ? creditStatus[0] : creditStatus)?.credits ?? 0);
  if (credits <= 0) {
    return NextResponse.json({
      error: isEnglish ? "You are out of credits. Choose a plan to continue." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
      credits,
    }, { status: 402 });
  }

  const room = isUuid(classroomId) ? classroomId : null;
  if (room) {
    const { data: classroom } = await supabase.from("classrooms").select("id").eq("id", room).maybeSingle();
    if (!classroom) return NextResponse.json({ error: isEnglish ? "Classroom not found." : "강의실을 찾지 못했습니다." }, { status: 404 });
  }

  // The session is created up front and left in 'recording' so the callback can
  // charge it through the same RPC a live lecture uses — that function refuses
  // any other status. It becomes 'completed' when the transcript lands.
  const { data: session, error: sessionError } = await supabase
    .from("lecture_sessions")
    .insert({ classroom_id: room, user_id: userId, title })
    .select("id,classroom_id,title,status,started_at,ended_at,duration_seconds")
    .single();
  if (sessionError || !session) {
    console.error("Upload session create failed", sessionError?.code);
    return NextResponse.json({ error: isEnglish ? "Could not create the lecture record." : "수업 기록을 만들지 못했습니다." }, { status: 500 });
  }

  const objectKey = `${userId}/${randomUUID()}.${extension}`;
  const { data: upload, error: uploadRowError } = await supabase
    .from("uploads")
    .insert({
      session_id: session.id,
      user_id: userId,
      idempotency_key: idempotencyKey,
      object_key: objectKey,
      status: "uploading",
      filename: (file.name || `lecture.${extension}`).slice(0, 200),
      byte_size: file.size,
      duration_ms: Number.isFinite(claimedDurationMs) && claimedDurationMs > 0 ? Math.round(claimedDurationMs) : null,
    })
    .select("id,session_id,status")
    .single();
  if (uploadRowError || !upload) {
    console.error("Upload row create failed", uploadRowError?.code);
    await supabase.from("lecture_sessions").delete().eq("id", session.id);
    return NextResponse.json({ error: isEnglish ? "Could not start this upload." : "업로드를 시작하지 못했습니다." }, { status: 500 });
  }

  const fail = async (code: string, message: string, status: number) => {
    await supabase.storage.from("lecture-audio").remove([objectKey]);
    await supabase.from("uploads").update({ status: "failed", error_code: code, updated_at: new Date().toISOString() }).eq("id", upload.id);
    // The lecture never existed as far as the learner is concerned: no
    // transcript, no charge. Leaving an empty session in the sidebar would be
    // a row they have to clean up themselves.
    await supabase.from("lecture_sessions").delete().eq("id", session.id);
    return NextResponse.json({ error: message }, { status });
  };

  const { error: storageError } = await supabase.storage
    .from("lecture-audio")
    .upload(objectKey, new Uint8Array(await file.arrayBuffer()), { contentType: file.type || "application/octet-stream", upsert: false });
  if (storageError) {
    console.error("Audio upload failed", storageError.message);
    return fail("storage", isEnglish ? "Could not save this recording." : "녹음 파일을 저장하지 못했습니다.", 500);
  }

  const { data: signed, error: signError } = await supabase.storage
    .from("lecture-audio")
    .createSignedUrl(objectKey, SIGNED_URL_SECONDS);
  if (signError || !signed) {
    console.error("Audio sign failed", signError?.message ?? "unknown");
    return fail("sign", isEnglish ? "Could not prepare this recording." : "녹음 파일을 준비하지 못했습니다.", 500);
  }

  // The glossary the classroom has taught itself feeds the recognizer the same
  // way it does on a live lecture.
  const { data: classroomRow } = room
    ? await supabase.from("classrooms").select("glossary").eq("id", room).maybeSingle()
    : { data: null };

  const callbackUrl = `${callbackBase.replace(/\/$/, "")}/api/lecture-audio/callback?uploadId=${upload.id}&token=${callbackToken(upload.id)}`;
  let requestId: string | null = null;
  try {
    const response = await fetch(prerecordedUrl({
      language,
      keyterms: parseGlossary(classroomRow?.glossary),
      callbackUrl,
      sessionId: session.id,
    }), {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: signed.signedUrl }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error("Deepgram prerecorded submit failed", response.status);
      return fail("provider", isEnglish ? "Could not start transcription." : "받아쓰기를 시작하지 못했습니다.", 502);
    }
    const accepted = await response.json() as { request_id?: string };
    requestId = accepted.request_id ?? null;
  } catch (error) {
    console.error("Deepgram prerecorded submit threw", error instanceof Error ? error.name : "unknown");
    return fail("provider", isEnglish ? "Could not start transcription." : "받아쓰기를 시작하지 못했습니다.", 502);
  }

  const { data: queued } = await supabase
    .from("uploads")
    .update({ status: "processing", provider_request_id: requestId, updated_at: new Date().toISOString() })
    .eq("id", upload.id)
    .select("id,session_id,status,filename,byte_size,duration_ms,error_code,created_at")
    .maybeSingle();

  return NextResponse.json({ upload: queued ?? upload, session }, { status: 202 });
}
