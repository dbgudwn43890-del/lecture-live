import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { hasVerifiedEmail } from "../../lib/verified-email";

import { AudioVerificationError, verifyAudio } from "../../lib/verified-audio";
import { enqueueStorageDeletion, drainStorageDeletions } from "../../lib/storage-cleanup";

import { isUuid } from "../../lib/billing";
import { deepgramLanguage } from "../../lib/deepgram";
import { isSpeechLanguage } from "../../lib/speech-languages";
import { parseGlossary } from "../../lib/glossary";
import {
  callbackToken,
  prerecordedUrl,
} from "../../lib/lecture-audio";
import { getAudioUploadAvailability } from "../../lib/lecture-audio-availability";
import { handleDirectAudioUpload } from "../../lib/lecture-audio-direct";
import { hasRecordingConsents } from "../../lib/consent";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

// Long enough for Deepgram to fetch a 1GB file, short enough that a leaked URL
// is useless by the time anyone finds it.
const SIGNED_URL_SECONDS = 3_600;

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "webm", "mp4"]);

function unavailableMessage(isEnglish: boolean) {
  return isEnglish
    ? "Recording uploads are currently unavailable on our service. You can still record a live lecture."
    : "현재 서비스에서 녹음 파일 업로드를 사용할 수 없습니다. 실시간 강의 기록은 사용할 수 있어요.";
}

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (authError || !hasVerifiedEmail(user)) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  const rateLimit = await checkSharedRateLimit(`lecture-audio:${user.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  // uploads rows are read-only for the authenticated role (20260902010000);
  // every write in this route goes through the service key.
  const admin = createAdminClient();
  return { userId: user.id, supabase, admin, isEnglish };
}

async function sweepExpired(supabase: Awaited<ReturnType<typeof createClient>>, admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string) {
  const { data: expired } = await supabase.from("uploads").select("id,object_key")
    .is("deleted_at", null).lt("delete_at", new Date().toISOString()).limit(20);
  for (const upload of expired ?? []) {
    if (upload.object_key) await enqueueStorageDeletion(admin, { bucket: "lecture-audio", objectKey: upload.object_key, userId, reason: "upload_expired" });
    await admin.from("uploads").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("id", upload.id);
  }
  await drainStorageDeletions(admin, { limit: 20, userId });
}

/** UPL-03. What the progress panel polls while Deepgram works. */
export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  const availability = await getAudioUploadAvailability(Boolean(current.admin));
  if (current.admin) await sweepExpired(current.supabase, current.admin, current.userId);

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
  return NextResponse.json({ uploads: data ?? [], availability }, { headers: { "Cache-Control": "no-store" } });
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
  const { admin, isEnglish, supabase, userId } = current;
  const availability = await getAudioUploadAvailability(Boolean(admin));
  if (!admin || !availability.available) {
    return NextResponse.json({ error: unavailableMessage(isEnglish), code: "AUDIO_UPLOAD_UNAVAILABLE", availability }, { status: 503 });
  }

  // Uploads are recordings too: the same legal gate as live lectures
  // (ACC-02/03), enforced here rather than only in the dialog.
  if (!(await hasRecordingConsents(supabase))) {
    return NextResponse.json({
      error: isEnglish ? "Transcription requires the age and recording agreements." : "녹음 파일을 변환하려면 만 14세 확인과 녹음 고지에 동의해야 합니다.",
    }, { status: 403 });
  }

  if (request.headers.get("content-type")?.includes("application/json")) {
    return handleDirectAudioUpload(request, { admin, supabase, userId, isEnglish }, availability);
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  const callbackBase = process.env.SITE_URL!;

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
  const requestedLanguage = formData.get("language");
  if (requestedLanguage != null && requestedLanguage !== "default" && !isSpeechLanguage(requestedLanguage)) {
    return NextResponse.json({
      error: isEnglish ? "Choose a supported transcription language." : "지원하는 받아쓰기 언어를 선택해 주세요.",
    }, { status: 400 });
  }
  const raw = deepgramLanguage(requestedLanguage, isEnglish ? "en" : "ko");
  // 업로드는 지원받는 Deepgram 배치로 간다. Deepgram의 multi는 한국어를
  // 지원하지 않으므로 혼용(실시간 Soniox 전용) 선택은 여기서 ko로 내린다.
  const language = raw === "multi" ? "ko" : raw;
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: isEnglish ? "Choose an audio file." : "녹음 파일을 선택해 주세요." }, { status: 400 });
  }
  if (file.size > availability.maxFileBytes) {
    const limit = "200MB";
    return NextResponse.json({
      error: isEnglish ? `Upload a file of ${limit} or less.` : `${limit} 이하의 파일을 올려 주세요.`,
      code: "AUDIO_UPLOAD_TOO_LARGE", maxFileBytes: availability.maxFileBytes,
    }, { status: 413 });
  }
  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return NextResponse.json({
      error: isEnglish ? "Supported formats are MP3, M4A, WAV, WebM, and MP4." : "MP3, M4A, WAV, WebM, MP4 파일만 변환할 수 있습니다.",
    }, { status: 400 });
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

  // Reject empty wallets before spending CPU decoding an untrusted recording.
  const { data: creditStatus, error: creditStatusError } = await supabase.rpc("get_credit_status");
  const availableCredits = Number((Array.isArray(creditStatus) ? creditStatus[0] : creditStatus)?.credits ?? 0);
  if (creditStatusError || availableCredits < 1) return NextResponse.json({ error: creditStatusError
    ? (isEnglish ? "Could not check your credits." : "크레딧을 확인하지 못했습니다.")
    : (isEnglish ? "Add credits to transcribe this recording." : "녹음 파일을 변환하려면 크레딧을 추가해 주세요."), credits: availableCredits,
  }, { status: creditStatusError ? 503 : 402 });
  const verificationLimit = await checkSharedRateLimit(`audio-verification:${userId}`, 20, 86_400_000);
  if (!verificationLimit.allowed) return NextResponse.json({ error: isEnglish ? "Your daily upload limit has been reached. Try again tomorrow." : "오늘의 파일 업로드 한도에 도달했습니다. 내일 다시 시도해 주세요." }, { status: 429 });
  let verified: Awaited<ReturnType<typeof verifyAudio>>;
  try {
    verified = await verifyAudio(file);
  } catch (error) {
    const code = error instanceof AudioVerificationError ? error.code : "invalid";
    return NextResponse.json({ error: code === "too_long"
      ? (isEnglish ? "A lecture can be up to 3 hours long." : "한 수업은 최대 3시간까지 변환할 수 있습니다.")
      : code === "unavailable"
        ? (isEnglish ? "File transcription is temporarily unavailable. Try again shortly." : "파일 변환을 잠시 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        : (isEnglish ? "We couldn’t read this recording safely. Export it as MP3, M4A, WAV, WebM, or MP4 and try again." : "녹음 파일을 확인하지 못했습니다. MP3, M4A, WAV, WebM, MP4로 다시 저장해 올려 주세요."),
    }, { status: code === "unavailable" ? 503 : code === "too_long" || code === "too_large" ? 413 : 400 });
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

  const objectKey = `${userId}/${randomUUID()}.flac`;
  const { data: upload, error: uploadRowError } = await admin
    .from("uploads")
    .insert({
      session_id: session.id,
      user_id: userId,
      idempotency_key: idempotencyKey,
      object_key: objectKey,
      status: "uploading",
      filename: (file.name || `lecture.${extension}`).slice(0, 200),
      byte_size: verified.bytes.byteLength,
      duration_ms: verified.durationMs,
    })
    .select("id,session_id,status")
    .single();
  if (uploadRowError || !upload) {
    console.error("Upload row create failed", uploadRowError?.code);
    await supabase.from("lecture_sessions").delete().eq("id", session.id);
    return NextResponse.json({ error: isEnglish ? "Could not start this upload." : "업로드를 시작하지 못했습니다." }, { status: 500 });
  }

  const { data: reservation, error: reservationError } = await admin.rpc("reserve_audio_credits_service", {
    p_user_id: userId, p_upload_id: upload.id, p_duration_ms: verified.durationMs,
  });
  const reserved = (Array.isArray(reservation) ? reservation[0] : reservation) as { allowed?: boolean; credits?: number } | null;
  if (reservationError || !reserved?.allowed) {
    await admin.from("lecture_sessions").delete().eq("id", session.id);
    return NextResponse.json({ error: reservationError
      ? (isEnglish ? "Could not check your credits. Try again shortly." : "크레딧을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")
      : (isEnglish ? `This lecture needs ${Math.ceil(verified.durationMs / 60_000)} credits.` : `이 수업을 변환하려면 크레딧 ${Math.ceil(verified.durationMs / 60_000)}개가 필요합니다.`),
      credits: reserved?.credits ?? 0,
    }, { status: reservationError ? 503 : 402 });
  }

  const fail = async (code: string, message: string, status: number) => {
    // Only called when work definitely was not accepted by the provider.
    const { error: releaseError } = await admin.rpc("settle_audio_credits_service", { p_user_id: userId, p_upload_id: upload.id, p_charge: false });
    if (releaseError) console.error("Audio reservation release failed", releaseError.code);
    await enqueueStorageDeletion(admin, { bucket: "lecture-audio", objectKey, userId, reason: code });
    await admin.from("uploads").update({ status: "failed", error_code: code, updated_at: new Date().toISOString() }).eq("id", upload.id);
    await admin.from("lecture_sessions").delete().eq("id", session.id);
    await drainStorageDeletions(admin, { limit: 5, userId });
    return NextResponse.json({ error: message }, { status });
  };

  const { error: storageError } = await admin.storage
    .from("lecture-audio")
    .upload(objectKey, verified.bytes, { contentType: "audio/flac", upsert: false });
  if (storageError) {
    console.error("Audio upload failed", storageError.message);
    return fail("storage", isEnglish ? "Could not save this recording." : "녹음 파일을 저장하지 못했습니다.", 500);
  }

  const { data: signed, error: signError } = await admin.storage
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
  const { data: submitting, error: submitError } = await admin.rpc("submit_audio_reservation_service", { p_user_id: userId, p_upload_id: upload.id });
  if (submitError || !submitting) return fail("reservation", isEnglish ? "Could not prepare transcription." : "받아쓰기를 준비하지 못했습니다.", 503);
  // Persist processing before the request: a callback can arrive before fetch
  // returns, and must not be overwritten back to processing after completion.
  await admin.from("uploads").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", upload.id);
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
      if (response.status >= 400 && response.status < 500) return fail("provider", isEnglish ? "Could not start transcription." : "받아쓰기를 시작하지 못했습니다.", 502);
      throw new Error("PROVIDER_ACCEPTANCE_UNKNOWN");
    }
    const accepted = await response.json() as { request_id?: string };
    requestId = accepted.request_id ?? null;
  } catch (error) {
    console.error("Deepgram prerecorded submit threw", error instanceof Error ? error.name : "unknown");
    // Acceptance is unknown. Keep the reservation and callback tracking; a
    // timeout must never turn already-running work into free processing.
  }

  const { data: queued } = await admin
    .from("uploads")
    .update({ provider_request_id: requestId, updated_at: new Date().toISOString() })
    .eq("id", upload.id)
    .select("id,session_id,status,filename,byte_size,duration_ms,error_code,created_at")
    .maybeSingle();

  return NextResponse.json({ upload: queued ?? upload, session }, { status: 202 });
}
