import { NextResponse } from "next/server";

import { CONSENT_TYPES, CONSENT_VERSION, isConsentType } from "../../lib/consent";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  const rateLimit = await checkSharedRateLimit(`consents:${user.id}`, 30, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { userId: user.id, supabase, isEnglish };
}

/** Which of the current version's consents this account has already given. */
export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const { data, error } = await current.supabase
    .from("consents")
    .select("consent_type")
    .eq("document_version", CONSENT_VERSION);
  if (error) {
    console.error("Consent read failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not check your agreements." : "동의 기록을 확인하지 못했습니다." }, { status: 500 });
  }

  const accepted = new Set((data ?? []).map((row) => row.consent_type));
  return NextResponse.json(
    {
      version: CONSENT_VERSION,
      accepted: [...accepted],
      // The one thing the caller actually branches on: may this account record?
      satisfied: CONSENT_TYPES.every((type) => accepted.has(type)),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Records agreement to the current wording. The version comes from the server,
 * never from the request: a client that could name its own version could file
 * today's tick against wording the learner never saw.
 */
export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { types?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const types = Array.isArray(body.types) ? [...new Set(body.types.filter(isConsentType))] : [];
  if (!types.length) {
    return NextResponse.json({ error: current.isEnglish ? "Check the agreements." : "동의 항목을 확인해 주세요." }, { status: 400 });
  }

  // ignoreDuplicates, because agreeing twice to the same wording is not an
  // error — a double-submit or a second tab should be a no-op, not a 500.
  const { error } = await current.supabase.from("consents").upsert(
    types.map((type) => ({ user_id: current.userId, consent_type: type, document_version: CONSENT_VERSION })),
    { onConflict: "user_id,consent_type,document_version", ignoreDuplicates: true },
  );
  if (error) {
    console.error("Consent save failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not save your agreement." : "동의 기록을 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ version: CONSENT_VERSION, accepted: types }, { status: 201 });
}
