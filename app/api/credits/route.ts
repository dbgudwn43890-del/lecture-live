import { NextResponse } from "next/server";

import { getCreditStatus } from "../../lib/credit-status";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

function message(request: Request, korean: string, english: string) {
  return request.headers.get("x-site-locale") === "en" ? english : korean;
}

async function current(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { response: NextResponse.json({ error: message(request, "로그인이 필요합니다.", "Sign-in is required.") }, { status: 401 }) };
  }
  // The workspace reads this after each lecture boundary and on load.
  const rateLimit = await checkSharedRateLimit(`credits:${user.id}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: message(request, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "Too many requests. Try again shortly.") },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { supabase };
}

export async function GET(request: Request) {
  const context = await current(request);
  if ("response" in context) return context.response;
  const status = await getCreditStatus(context.supabase);
  if ("error" in status) {
    console.error("Credit status failed", status.error);
    return NextResponse.json({ error: message(request, "크레딧 기능이 아직 설정되지 않았습니다.", "Credits are not configured yet.") }, { status: 503 });
  }
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
