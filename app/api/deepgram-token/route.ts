import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { bootstrapTerms } from "../../lib/bootstrap-terms";
import { deepgramLanguage, listenUrl } from "../../lib/deepgram";
import { SONIOX_LISTEN_URL, sonioxStreamConfig } from "../../lib/soniox";
import { mergeKeyterms, parseGlossary } from "../../lib/glossary";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown; language?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
  }
  if (!isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }

  // Deepgram은 지원 프로그램이라 당장 원가 0, Soniox는 실비($0.12/hr)다.
  // 그래서 기본 "ko"는 Deepgram에 남고, 한·영 혼용을 고른 수업만 Soniox로
  // 간다 (문장 안 두 언어 동시 인식, CER 실측 0%: scripts/eval-stt.mts).
  let language = deepgramLanguage(body.language, "ko");
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
  // The grant is independent of our database. Mint it while the credit,
  // glossary and transcript preflight run instead of adding another network
  // round trip after them. An unused 30-second grant is never returned.
  const grant = useSoniox
    ? fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 60 }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
    : fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 30, scopes: ["listen"] }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
  const [{ data: statusData, error: statusError }, { data: sessionRow }, { data: spokenRows }, response] = await Promise.all([
    supabase.rpc("get_credit_status"),
    supabase
      .from("lecture_sessions")
      // material_documents hangs off both tables now: directly from this
      // session, and from the classroom it belongs to. Reading both in the one
      // embed keeps the session's own material first without a second trip.
      .select("classrooms(glossary, material_documents(keyterms)), material_documents(keyterms)")
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
    grant,
  ]);
  const creditStatus = Array.isArray(statusData) ? statusData[0] : statusData;
  if (statusError) {
    console.error("Credit preflight failed", statusError.code);
    return NextResponse.json({ error: isEnglish ? "Credits are not configured yet." : "크레딧 기능이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  if (Number(creditStatus?.credits ?? 0) < 1) {
    return NextResponse.json({
      error: isEnglish ? "You are out of credits. Choose a plan to start recording." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
    }, { status: 402 });
  }

  if (!response.ok) {
    console.error("STT token grant failed", useSoniox ? "soniox" : "deepgram", response.status);
    return NextResponse.json({ error: "음성 인식 연결을 준비하지 못했습니다." }, { status: 502 });
  }

  const data = (await response.json()) as { access_token?: string; api_key?: string };
  const accessToken = useSoniox ? data.api_key : data.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "음성 인식 토큰이 비어 있습니다." }, { status: 502 });
  }

  const { data: creditData, error: creditError } = await supabase.rpc("consume_lecture_credits", {
    p_session_id: body.sessionId,
    p_minute_index: 0,
  });
  if (creditError) {
    console.error("Initial credit consumption failed", creditError.code);
    return NextResponse.json({ error: isEnglish ? "Credits are not configured yet." : "크레딧 기능이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  const credit = Array.isArray(creditData) ? creditData[0] : creditData;
  if (!credit?.allowed) {
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

  if (useSoniox) {
    return NextResponse.json(
      {
        accessToken,
        credits: Number(credit.remaining_credits),
        // ponytail: 어휘 갱신 재접속은 Deepgram 경로에만 있다. Soniox context도
        // 접속 시점에만 붙지만, 예산이 10배라 부트스트랩 없이도 대부분 담긴다.
        // 용어 누락 신고가 쌓이면 같은 refreshInMs 경로를 여기에도 연다.
        refreshInMs: null,
        listenUrl: SONIOX_LISTEN_URL,
        // 첫 소켓 메시지로 보낼 설정. 파라미터 주인은 서버라는 원칙 유지.
        sonioxConfig: sonioxStreamConfig({ keyterms, sessionId: body.sessionId as string }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      accessToken,
      credits: Number(credit.remaining_credits),
      // 자료도 용어집도 없는 수업에만, 한 번. 그때쯤이면 무엇에 대한 수업인지
      // 스크립트에 드러나 있고, 남은 시간이 갱신값을 회수할 만큼 길다.
      refreshInMs: language === "default" || declared.length ? null : 600_000,
      listenUrl: listenUrl({
        language,
        keyterms,
        sessionId: body.sessionId,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
