import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { isUuid } from "./billing.ts";
import { deepgramLanguage, type DeepgramLanguage } from "./deepgram.ts";
import { isSpeechLanguage } from "./speech-languages.ts";
import { parseGlossary } from "./glossary.ts";
import { callbackToken, prerecordedUrl } from "./lecture-audio.ts";
import { MAX_AUDIO_UPLOAD_BYTES, type AudioUploadTransfer } from "./lecture-audio-transfer.ts";
import { AudioVerificationError, verifyAudioStream } from "./verified-audio.ts";
import { enqueueStorageDeletion, drainStorageDeletions } from "./storage-cleanup.ts";
import type { AudioUploadAvailability } from "./lecture-audio-availability.ts";

type Context = { admin: SupabaseClient; supabase: SupabaseClient; userId: string; isEnglish: boolean };
type Upload = {
  id: string; session_id: string; user_id: string; status: string; object_key: string | null;
  filename: string; byte_size: number; source_byte_size: number; duration_ms: number | null;
  transcription_language: DeepgramLanguage; error_code: string | null; created_at: string; delete_at: string;
};
type Session = { id: string; classroom_id: string | null; title: string; status: string; started_at: string; ended_at: string | null; duration_seconds: number };

const fields = "id,session_id,user_id,status,object_key,filename,byte_size,source_byte_size,duration_ms,transcription_language,error_code,created_at,delete_at";
const sessionFields = "id,classroom_id,title,status,started_at,ended_at,duration_seconds";
const contentTypes: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", mp4: "video/mp4" };

function visibleUpload(upload: Upload) {
  return { id: upload.id, session_id: upload.session_id, status: upload.status, filename: upload.filename,
    byte_size: upload.byte_size, duration_ms: upload.duration_ms, error_code: upload.error_code, created_at: upload.created_at };
}
function visibleSession(session: Session) {
  return { id: session.id, classroom_id: session.classroom_id, title: session.title, status: session.status,
    started_at: session.started_at, ended_at: session.ended_at, duration_seconds: session.duration_seconds };
}
function failure(current: Context, code: string, ko: string, en: string, status = 400) {
  return NextResponse.json({ code, error: current.isEnglish ? en : ko }, { status });
}
function invalid(current: Context) { return failure(current, "INVALID_AUDIO_UPLOAD", "올바른 업로드 요청이 아닙니다.", "Invalid upload."); }

async function checkCredits(current: Context) {
  const { data, error } = await current.supabase.rpc("get_credit_status");
  if (error) return failure(current, "AUDIO_CREDITS_UNAVAILABLE", "크레딧을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", "Could not check your credits. Try again shortly.", 503);
  const credits = Number((Array.isArray(data) ? data[0] : data)?.credits ?? 0);
  if (credits < 1) return failure(current, "AUDIO_CREDITS_REQUIRED", "녹음 파일을 변환하려면 크레딧을 추가해 주세요.", "Add credits to transcribe this recording.", 402);
  return null;
}

/** Only application-allocated object IDs cross this boundary, never a caller's URL or path. */
export async function handleDirectAudioUpload(request: Request, current: Context, availability: AudioUploadAvailability) {
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 8_192) return invalid(current);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid(current);
    body = parsed;
  } catch { return invalid(current); }
  if (body.action === "prepare") return prepare(body, current, availability);
  if (body.action === "complete" && isUuid(body.uploadId)) return complete(body.uploadId, current);
  return invalid(current);
}

async function prepare(body: Record<string, unknown>, current: Context, availability: AudioUploadAvailability) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
  const originalFilename = typeof body.filename === "string" ? body.filename.trim() : "";
  const extension = (originalFilename.split(".").pop() ?? "").toLowerCase();
  const filename = originalFilename.length > 200 ? `${originalFilename.slice(0, 199 - extension.length)}.${extension}` : originalFilename;
  const byteSize = body.byteSize;
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const contentType = contentTypes[extension];
  if (!title || !filename || !contentType || !key || key.length > 100 || !Number.isSafeInteger(byteSize) || Number(byteSize) <= 0
    || (body.classroomId != null && !isUuid(body.classroomId))) return invalid(current);
  if (Number(byteSize) > MAX_AUDIO_UPLOAD_BYTES) return failure(current, "AUDIO_UPLOAD_TOO_LARGE", "200MB 이하의 녹음 파일을 올려 주세요.", "Upload a recording of 200MB or less.", 413);
  if (body.language != null && body.language !== "default" && !isSpeechLanguage(body.language)) return invalid(current);
  const raw = deepgramLanguage(body.language, current.isEnglish ? "en" : "ko");
  const language = raw === "multi" ? "ko" : raw;
  const { data: previous } = await current.supabase.from("uploads").select("id,status,delete_at")
    .eq("user_id", current.userId).eq("idempotency_key", key).maybeSingle();
  const activeRetry = previous && !["failed", "deleted"].includes(previous.status)
    && (previous.status !== "uploading" || new Date(previous.delete_at).getTime() > Date.now());
  // A prior verification may already have reserved the entire wallet. A retry
  // must still be able to finish that same upload without new storage budget.
  const creditError = activeRetry ? null : await checkCredits(current);
  if (creditError) return creditError;

  const { data, error } = await current.admin.rpc("prepare_audio_upload_service", {
    p_user_id: current.userId, p_classroom_id: body.classroomId ?? null, p_title: title, p_filename: filename,
    p_byte_size: byteSize, p_language: language, p_idempotency_key: key,
  });
  if (error || !data?.upload || !data.session) {
    if (error?.message === "AUDIO_UPLOAD_DAILY_LIMIT") return failure(current, "AUDIO_UPLOAD_DAILY_LIMIT", "오늘의 파일 업로드 한도에 도달했습니다. 내일 다시 시도해 주세요.", "Your daily upload limit has been reached. Try again tomorrow.", 429);
    if (error?.message === "AUDIO_UPLOAD_PENDING_LIMIT") return failure(current, "AUDIO_UPLOAD_PENDING_LIMIT", "먼저 업로드 중인 녹음 파일의 변환을 완료해 주세요.", "Wait for your pending recording uploads to finish.", 409);
    if (error?.message === "AUDIO_UPLOAD_CONFLICT") return failure(current, "AUDIO_UPLOAD_CONFLICT", "이 업로드는 다른 파일로 시작되었습니다. 파일을 다시 선택해 주세요.", "This upload was started with another file. Select the recording again.", 409);
    if (error?.message === "CLASSROOM_NOT_FOUND") return failure(current, "CLASSROOM_NOT_FOUND", "강의실을 찾지 못했습니다.", "Classroom not found.", 404);
    console.error("Audio transfer prepare failed", error?.code ?? "missing_result");
    return failure(current, "AUDIO_UPLOAD_PREPARE_FAILED", "업로드를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.", "Could not prepare this upload. Try again shortly.", 503);
  }
  const upload = data.upload as Upload;
  const session = data.session as Session;
  if (["processing", "queued", "completed"].includes(upload.status)) {
    return NextResponse.json({ upload: visibleUpload(upload), session: visibleSession(session), duplicate: true });
  }
  if (upload.status !== "uploading" || !upload.object_key || new Date(upload.delete_at).getTime() <= Date.now()) {
    return failure(current, "AUDIO_UPLOAD_EXPIRED", "이 업로드는 종료되었습니다. 파일을 다시 선택해 주세요.", "This upload has ended. Select the recording again.", 409);
  }
  // A retry after verification can go straight to complete without replacing
  // the immutable source or receiving a token for the canonical FLAC.
  if (upload.duration_ms && upload.object_key.endsWith(".flac")) {
    return NextResponse.json({ upload: visibleUpload(upload), session: visibleSession(session), readyToComplete: true, availability });
  }
  if (data.duplicate) {
    try {
      const { data: exists } = await current.admin.storage.from("lecture-audio").exists(upload.object_key);
      if (exists) return NextResponse.json({ upload: visibleUpload(upload), session: visibleSession(session), readyToComplete: true, availability });
    } catch {
      return failure(current, "AUDIO_UPLOAD_PREPARE_FAILED", "이전 파일 전송 상태를 확인하지 못했습니다. 다시 시도해 주세요.", "Could not check the previous transfer. Try again.", 503);
    }
  }
  const { data: signed, error: signError } = await current.admin.storage.from("lecture-audio").createSignedUploadUrl(upload.object_key, { upsert: false });
  if (signError || !signed) return failure(current, "AUDIO_UPLOAD_PREPARE_FAILED", "파일 전송을 준비하지 못했습니다. 다시 시도해 주세요.", "Could not prepare the file transfer. Try again.", 503);
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  if (/^[a-z0-9-]+\.supabase\.co$/i.test(endpoint.hostname)) endpoint.hostname = endpoint.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  // Scoped x-signature tokens use Supabase's signed TUS route. The ordinary
  // /resumable route requires a user JWT and does not authorize this token.
  // Keep /sign as the final segment so the returned Location stays signed.
  endpoint.pathname = "/storage/v1/upload/resumable/sign";
  endpoint.search = ""; endpoint.hash = "";
  const transfer: AudioUploadTransfer = { endpoint: endpoint.toString(), bucketName: "lecture-audio", objectName: upload.object_key, token: signed.token, contentType };
  return NextResponse.json({ upload: visibleUpload(upload), session: visibleSession(session), transfer, availability }, { headers: { "Cache-Control": "no-store" } });
}

async function complete(uploadId: string, current: Context) {
  const { admin, supabase, userId } = current;
  const { data: found } = await supabase.from("uploads").select(fields).eq("id", uploadId).eq("user_id", userId).maybeSingle();
  const upload = found as Upload | null;
  if (!upload || !upload.source_byte_size) return failure(current, "AUDIO_UPLOAD_NOT_FOUND", "업로드를 찾지 못했습니다.", "Upload not found.", 404);
  const { data: session } = await supabase.from("lecture_sessions").select(sessionFields).eq("id", upload.session_id).eq("user_id", userId).maybeSingle();
  if (!session) return failure(current, "AUDIO_UPLOAD_NOT_FOUND", "수업 기록을 찾지 못했습니다.", "Lecture record not found.", 404);
  if (["processing", "queued", "completed"].includes(upload.status)) return NextResponse.json({ upload: visibleUpload(upload), session, duplicate: true }, { status: 202 });
  if (upload.status !== "uploading" || !upload.object_key || new Date(upload.delete_at).getTime() <= Date.now()) return failure(current, "AUDIO_UPLOAD_EXPIRED", "이 업로드는 종료되었습니다. 파일을 다시 선택해 주세요.", "This upload has ended. Select the recording again.", 409);
  const token = randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc("claim_audio_verification_service", { p_user_id: userId, p_upload_id: upload.id, p_token: token });
  if (claimError) return failure(current, "AUDIO_UPLOAD_RETRY", "파일 확인을 준비하지 못했습니다. 다시 시도해 주세요.", "Could not prepare verification. Try again.", 503);
  if (!claimed) return NextResponse.json({ upload: visibleUpload(upload), session, pending: true }, { status: 202, headers: { "Retry-After": "5" } });
  const release = async () => { await admin.from("uploads").update({ verification_claimed_at: null, verification_token: null }).eq("id", upload.id).eq("verification_token", token); };
  const retry = async (code: string, ko: string, en: string, status = 503) => { await release(); return failure(current, code, ko, en, status); };
  const discard = async (code: string, ko: string, en: string, status: number, reserved = false) => {
    if (reserved) await admin.rpc("settle_audio_credits_service", { p_user_id: userId, p_upload_id: upload.id, p_charge: false });
    await admin.from("uploads").update({ status: "failed", error_code: code, verification_claimed_at: null, verification_token: null }).eq("id", upload.id).eq("user_id", userId);
    if (upload.object_key) await enqueueStorageDeletion(admin, { bucket: "lecture-audio", objectKey: upload.object_key, userId, reason: code });
    await drainStorageDeletions(admin, { limit: 5, userId });
    return failure(current, code, ko, en, status);
  };
  try {
    const { data: priorReservation } = await admin.from("audio_credit_reservations").select("status").eq("upload_id", upload.id).eq("user_id", userId).maybeSingle();
    if (priorReservation?.status === "submitted" || priorReservation?.status === "settled") {
      await admin.from("uploads").update({ status: "processing", verification_claimed_at: null, verification_token: null }).eq("id", upload.id).eq("verification_token", token);
      return NextResponse.json({ upload: { ...visibleUpload(upload), status: "processing" }, session, duplicate: true }, { status: 202 });
    }
    if (priorReservation?.status === "released") return discard("reservation", "이 변환 요청은 종료되었습니다. 파일을 다시 선택해 주세요.", "This transcription request has ended. Select the recording again.", 409);
    if (!upload.duration_ms || !upload.object_key.endsWith(".flac")) {
      const creditError = priorReservation?.status === "reserved" ? null : await checkCredits(current);
      if (creditError) { await release(); return creditError; }
      // The private path is read from this user's upload row. Neither a request
      // URL nor a browser-supplied duration can influence decoding or charging.
      const { data: source, error: sourceError } = await admin.storage.from("lecture-audio").createSignedUrl(upload.object_key, 120);
      if (sourceError || !source) return retry("AUDIO_UPLOAD_INCOMPLETE", "파일 전송이 완료되지 않았습니다. 파일을 다시 전송해 주세요.", "The file transfer is incomplete. Upload the file again.", 409);
      const response = await fetch(source.signedUrl, { signal: AbortSignal.timeout(90_000), redirect: "error" });
      if (!response.ok || !response.body) return retry("AUDIO_UPLOAD_INCOMPLETE", "파일 전송이 완료되지 않았습니다. 파일을 다시 전송해 주세요.", "The file transfer is incomplete. Upload the file again.", 409);
      let verified: Awaited<ReturnType<typeof verifyAudioStream>>;
      try { verified = await verifyAudioStream(response.body, Number(upload.source_byte_size)); }
      catch (error) {
        const code = error instanceof AudioVerificationError ? error.code : "unavailable";
        if (code === "busy" || code === "unavailable") return retry("AUDIO_UPLOAD_RETRY", "다른 녹음 파일을 확인 중이거나 변환 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", "The recording verifier is busy or unavailable. Try again shortly.");
        if (code === "too_long") return discard("too_long", "한 수업은 최대 3시간까지 변환할 수 있습니다.", "A lecture can be up to 3 hours long.", 413);
        if (code === "too_large") return discard("too_large", "녹음 파일의 크기 또는 변환 후 크기가 한도를 초과했습니다. 파일을 나누어 올려 주세요.", "The recording or its decoded audio exceeds the limit. Split it into smaller files.", 413);
        return discard("invalid", "녹음 파일을 읽지 못했습니다. MP3, M4A, WAV, WebM, MP4로 다시 저장해 올려 주세요.", "Could not read this recording. Export it as MP3, M4A, WAV, WebM, or MP4 and try again.", 400);
      }
      const { data: reservation, error: reserveError } = await admin.rpc("reserve_audio_credits_service", { p_user_id: userId, p_upload_id: upload.id, p_duration_ms: verified.durationMs });
      const reserved = Array.isArray(reservation) ? reservation[0] : reservation;
      if (reserveError) return retry("AUDIO_CREDITS_UNAVAILABLE", "크레딧을 확인하지 못했습니다. 다시 시도해 주세요.", "Could not check your credits. Try again.");
      if (!reserved?.allowed) return retry("AUDIO_CREDITS_REQUIRED", `이 수업을 변환하려면 크레딧 ${Math.ceil(verified.durationMs / 60_000)}개가 필요합니다. 충전 후 다시 시도해 주세요.`, `This recording needs ${Math.ceil(verified.durationMs / 60_000)} credits. Add credits and retry.`, 402);
      const canonicalKey = `${userId}/${upload.id}.flac`;
      const { error: storageError } = await admin.storage.from("lecture-audio").upload(canonicalKey, verified.bytes, { contentType: "audio/flac", upsert: true });
      if (storageError) return discard("storage", "변환한 녹음 파일을 저장하지 못했습니다. 파일을 다시 올려 주세요.", "Could not save the verified recording. Upload the file again.", 503, true);
      const { data: saved, error: saveError } = await admin.from("uploads").update({ object_key: canonicalKey, duration_ms: verified.durationMs, byte_size: verified.bytes.byteLength })
        .eq("id", upload.id).eq("verification_token", token).select("id").maybeSingle();
      if (saveError || !saved) {
        await enqueueStorageDeletion(admin, { bucket: "lecture-audio", objectKey: canonicalKey, userId, reason: "verification_save_failed" });
        return discard("storage", "파일 확인 결과를 저장하지 못했습니다. 파일을 다시 올려 주세요.", "Could not save verification results. Upload the file again.", 503, true);
      }
      upload.object_key = canonicalKey; upload.duration_ms = verified.durationMs; upload.byte_size = verified.bytes.byteLength;
      // Updating object_key transactionally queues deletion of the raw file.
      await drainStorageDeletions(admin, { limit: 5, userId });
    }
    const { data: signed, error: signError } = await admin.storage.from("lecture-audio").createSignedUrl(upload.object_key, 3_600);
    if (signError || !signed) return retry("AUDIO_UPLOAD_RETRY", "받아쓰기를 준비하지 못했습니다. 다시 시도해 주세요.", "Could not prepare transcription. Try again.");
    const { data: classroom } = session.classroom_id ? await supabase.from("classrooms").select("glossary").eq("id", session.classroom_id).maybeSingle() : { data: null };
    const { data: submitted, error: submitError } = await admin.rpc("submit_audio_reservation_service", { p_user_id: userId, p_upload_id: upload.id });
    if (submitError) return retry("AUDIO_UPLOAD_RETRY", "받아쓰기를 준비하지 못했습니다. 다시 시도해 주세요.", "Could not prepare transcription. Try again.");
    if (!submitted) {
      // A prior request may already have reached the provider. Never submit or
      // refund it again merely because that response was lost.
      await release();
      return NextResponse.json({ upload: { ...visibleUpload(upload), status: "processing" }, session, duplicate: true }, { status: 202 });
    }
    const { data: processing, error: processingError } = await admin.from("uploads").update({ status: "processing", verification_claimed_at: null, verification_token: null })
      .eq("id", upload.id).eq("verification_token", token).select("id").maybeSingle();
    if (processingError || !processing) {
      // We have not contacted the provider, so this failure can be refunded.
      return discard("tracking", "받아쓰기 상태를 저장하지 못했습니다. 파일을 다시 올려 주세요.", "Could not save transcription status. Upload the recording again.", 503, true);
    }
    const callbackUrl = new URL("/api/lecture-audio/callback", process.env.SITE_URL);
    callbackUrl.searchParams.set("uploadId", upload.id); callbackUrl.searchParams.set("token", callbackToken(upload.id));
    let requestId: string | null = null;
    try {
      const result = await fetch(prerecordedUrl({ language: upload.transcription_language, keyterms: parseGlossary(classroom?.glossary), callbackUrl: callbackUrl.toString(), sessionId: session.id }), {
        method: "POST", headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: signed.signedUrl }), signal: AbortSignal.timeout(30_000),
      });
      if (result.status >= 400 && result.status < 500) {
        await admin.rpc("settle_audio_credits_service", { p_user_id: userId, p_upload_id: upload.id, p_charge: false });
        await admin.from("uploads").update({ status: "failed", error_code: "provider" }).eq("id", upload.id);
        await enqueueStorageDeletion(admin, { bucket: "lecture-audio", objectKey: upload.object_key, userId, reason: "provider" });
        await drainStorageDeletions(admin, { limit: 5, userId });
        return failure(current, "AUDIO_PROVIDER_REJECTED", "받아쓰기를 시작하지 못했습니다. 파일을 다시 올려 주세요.", "Could not start transcription. Upload the recording again.", 502);
      }
      if (!result.ok) throw new Error("PROVIDER_ACCEPTANCE_UNKNOWN");
      const accepted = await result.json();
      requestId = typeof accepted?.request_id === "string" ? accepted.request_id : null;
    } catch { /* Unknown acceptance retains the reservation and callback tracking. */ }
    const { data: queued } = await admin.from("uploads").update({ provider_request_id: requestId }).eq("id", upload.id).select(fields).maybeSingle();
    return NextResponse.json({ upload: visibleUpload(queued ?? { ...upload, status: "processing" }), session }, { status: 202 });
  } catch {
    return retry("AUDIO_UPLOAD_RETRY", "녹음 파일 처리 중 서버 요청을 완료하지 못했습니다. 다시 시도해 주세요.", "A server request could not finish while processing this recording. Try again.");
  }
}
