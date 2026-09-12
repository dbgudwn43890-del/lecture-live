import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { hasRecordingConsents } from "../../lib/consent";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { bootstrapTerms } from "../../lib/bootstrap-terms";
import { deepgramLanguage, listenUrl } from "../../lib/deepgram";
import { isSpeechLanguage } from "../../lib/speech-languages";
import { SONIOX_LISTEN_URL, sonioxStreamConfig } from "../../lib/soniox";
import { mergeKeyterms, parseGlossary } from "../../lib/glossary";
import { createClient } from "../../lib/supabase/server";
import { createAdminClient } from "../../lib/supabase/admin";
import { newRelayTicket, relayTicketHash, relayListenUrl } from "../../lib/stt-relay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown; language?: unknown; transport?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }
  if (body.language != null && body.language !== "default" && !isSpeechLanguage(body.language)) {
    return NextResponse.json({
      error: isEnglish ? "Choose a supported transcription language." : "지원하는 받아쓰기 언어를 선택해 주세요.",
    }, { status: 400 });
  }
  if (body.transport !== "pcm16") {
    return NextResponse.json({ error: isEnglish ? "Refresh this page to reconnect recording." : "페이지를 새로고침한 뒤 녹음을 다시 시작해 주세요." }, { status: 409 });
  }

  // 지원 크레딧이 남아 있는 동안 Deepgram 사용료를 상계할 수 있다.
  // 단일 언어는 Deepgram, 한·영 혼용은 Soniox로 간다. Soniox는 토큰 과금이며
  // 약 $0.12/h는 참고치다. 실시간 강의 품질은 별도 평가가 필요하다.
  let language = deepgramLanguage(body.language, isEnglish ? "en" : "ko");
  const useSoniox = language === "multi" && Boolean(process.env.SONIOX_API_KEY);
  // Deepgram의 multi 모델은 한국어를 지원하지 않는다. Soniox 키가 없으면
  // 혼용 선택을 한국어 중심으로 낮춰서 영어 전용 소켓이 열리는 걸 막는다.
  if (language === "multi" && !useSoniox) language = "ko";

  const apiKey = useSoniox ? process.env.SONIOX_API_KEY : process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "음성 인식 API 키가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  // The in-process limiter this used to call is a per-instance Map, so the
  // real ceiling on a token-minting route was 10/min times however many
  // serverless instances answered. Every other paid route already shares a
  // counter in Postgres.
  const rateLimit = await checkSharedRateLimit(`deepgram-token:${userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const supabase = await createClient();

  // The consent dialog only gates the UI; this is the enforcement (ACC-02/03).
  if (!(await hasRecordingConsents(supabase))) {
    return NextResponse.json({
      error: isEnglish ? "Recording requires the age and recording agreements." : "녹음을 시작하려면 만 14세 확인과 녹음 고지에 동의해야 합니다.",
    }, { status: 403 });
  }

  const admin = createAdminClient();
  const relayUrl = relayListenUrl();
  // Issuing an opaque DB ticket does not use the relay's callback secret.
  // That secret belongs to the Worker and its /api/stt/relay destination,
  // which may be production even when this issuer runs on localhost.
  if (!admin || !relayUrl) {
    const missingKeys = !admin
      ? ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter(key => !process.env[key])
      : [];
    if (!relayUrl) missingKeys.push("STT_RELAY_URL");
    console.error("Recording configuration unavailable", missingKeys);
    return NextResponse.json({
      code: "RECORDING_NOT_CONFIGURED", retryable: false,
      error: isEnglish ? "The recording connection settings need to be checked." : "녹음 연결 설정을 확인해야 합니다.",
    }, { status: 503 });
  }
  const [{ data: statusData, error: statusError }, { data: sessionRow }, { data: spokenRows }] = await Promise.all([
    supabase.rpc("get_credit_status"),
    supabase
      .from("lecture_sessions")
      // material_documents hangs off both tables now: directly from this
      // session, and from the classroom it belongs to. Reading both in the one
      // embed keeps the session's own material first without a second trip.
      .select("id,status,classrooms(glossary, material_documents!material_documents_classroom_id_fkey(keyterms)), material_documents!material_documents_session_id_fkey(keyterms)")
      .eq("id", body.sessionId)
      .maybeSingle(),
    // 재연결이거나 어휘 갱신이면 이 수업의 앞부분이 이미 쌓여 있다. 첫 연결이면
    // 빈 배열이 오고 부트스트랩은 그냥 아무것도 더하지 않는다.
    supabase
      .from("transcript_segments")
      .select("text")
      .eq("session_id", body.sessionId)
      .order("start_ms", { ascending: true })
      .limit(600),
  ]);
  const creditStatus = Array.isArray(statusData) ? statusData[0] : statusData;
  if (statusError) {
    console.error("Credit preflight failed", statusError.code);
    return NextResponse.json({ error: isEnglish ? "Credits are not configured yet." : "크레딧 기능이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  if (!sessionRow || sessionRow.status !== "recording") {
    return NextResponse.json({ error: isEnglish ? "This lecture is not recording." : "기록 중인 수업을 확인해 주세요." }, { status: 409 });
  }
  // Fail before minting a ticket that the relay cannot open. Only another
  // lecture blocks this preflight; same-session reconnects keep their path.
  // The database's atomic lease check still handles simultaneous starts.
  const { data: activeOtherSession, error: activeSessionError } = await admin.from("stt_relay_sessions")
    .select("session_id").eq("user_id", userId).neq("session_id", body.sessionId)
    .not("connection_id", "is", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle();
  if (activeSessionError) {
    return NextResponse.json({ error: isEnglish
      ? "Could not check your recording connection. Please try again shortly."
      : "녹음 연결 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 503 });
  }
  if (activeOtherSession) {
    return NextResponse.json({
      code: "RECORDING_ALREADY_ACTIVE", retryable: false,
      error: isEnglish
        ? "Recording is already active in another tab or device. Pause or end that recording, then try again."
        : "다른 탭이나 기기에서 녹음 중입니다. 해당 녹음을 일시정지하거나 종료한 뒤 다시 시작해 주세요.",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  const { data: relayState, error: relayStateError } = await admin.from("stt_relay_sessions")
    .select("processed_bytes,authorized_bytes,connection_id").eq("session_id", body.sessionId).eq("user_id", userId).maybeSingle();
  if (relayStateError) return NextResponse.json({ error: "Recording unavailable" }, { status: 503 });
  const reusablePrepaid = relayState && !relayState.connection_id && Number(relayState.authorized_bytes) > Number(relayState.processed_bytes);
  if (Number(creditStatus?.credits ?? 0) < 1 && !reusablePrepaid) {
    return NextResponse.json({
      error: isEnglish ? "You are out of credits. Choose a plan to start recording." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
    }, { status: 402 });
  }

  // 자료에서 뽑은 용어가 손으로 넣은 용어집을 이어받는다. 학생이 아무것도 입력하지
  // 않아도 업로드한 슬라이드가 그 과목의 어휘집 노릇을 한다 (PRD 36.3.1).
  const row = sessionRow as {
    classrooms?: { glossary?: string; material_documents?: Array<{ keyterms?: string }> } | null;
    material_documents?: Array<{ keyterms?: string }>;
  } | null;
  const classroom = row?.classrooms;
  // 이 수업에 붙은 자료가 있으면 그것만 오늘의 어휘집이다. 한 학기치 PDF에서 뽑은
  // 용어를 모두 밀어 넣으면 400자 예산이 지난주 어휘로 차서, 정작 오늘 나올 말이
  // 잘린다. 붙은 자료가 없는 수업만 강의실 전체 자료로 물러난다.
  const sessionMaterial = row?.material_documents ?? [];
  const material = sessionMaterial.length ? sessionMaterial : classroom?.material_documents ?? [];
  const declared = mergeKeyterms(
    parseGlossary(classroom?.glossary),
    material.flatMap((document) => parseGlossary(document.keyterms)),
  );
  // 자료도 용어집도 없는 수업은 여기서만 어휘를 얻는다. 남은 예산에만 들어가므로
  // 손으로 넣은 용어와 슬라이드 용어를 밀어내지 않는다.
  const spoken = (spokenRows ?? []).map((row) => String((row as { text?: unknown }).text ?? "")).join(" ");
  const keyterms = mergeKeyterms(declared, bootstrapTerms(spoken, declared));

  const accessToken = newRelayTicket();
  const configuration = useSoniox
    ? { provider: "soniox", listenUrl: SONIOX_LISTEN_URL,
        sonioxConfig: { ...sonioxStreamConfig({ keyterms, sessionId: body.sessionId }), audio_format: "pcm_s16le", sample_rate: 16_000, num_channels: 1 } }
    : { provider: "deepgram", listenUrl: listenUrl({ language, keyterms, sessionId: body.sessionId, pcm: true }) };
  const { error: ticketError } = await admin.from("stt_relay_tickets").insert({
    token_hash: relayTicketHash(accessToken), user_id: userId, session_id: body.sessionId, configuration,
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  });
  if (ticketError) return NextResponse.json({ error: "Recording unavailable" }, { status: 503 });
  return NextResponse.json({
    accessToken, listenUrl: relayUrl, relay: true, provider: configuration.provider,
    credits: Number(creditStatus?.credits ?? 0),
    refreshInMs: useSoniox || language === "default" || declared.length ? null : 600_000,
  }, { headers: { "Cache-Control": "no-store" } });
}
