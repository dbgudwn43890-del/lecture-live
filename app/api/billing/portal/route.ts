import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../../lib/auth";
import { paddleRequest } from "../../../lib/billing";
import { checkSharedRateLimit } from "../../../lib/rate-limit";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

type PortalSession = { urls: { general: { overview: string } } };

export async function POST(request: Request) {
  const isEnglish = request.headers.get("x-site-locale") === "en";
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  const rateLimit = await checkSharedRateLimit(`billing-portal:${userId}`, 10, 60_000);
  if (!rateLimit.allowed) return NextResponse.json({ error: isEnglish ? "Try again shortly." : "잠시 후 다시 시도해 주세요." }, { status: 429 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: isEnglish ? "Billing storage is not configured." : "결제 저장 기능이 설정되지 않았습니다." }, { status: 503 });
  const { data: account } = await admin.from("billing_accounts").select("paddle_customer_id").eq("user_id", userId).maybeSingle();
  if (!account?.paddle_customer_id) {
    return NextResponse.json({ error: isEnglish ? "No payment history was found." : "결제 내역이 없습니다." }, { status: 404 });
  }

  try {
    const portal = await paddleRequest<PortalSession>(`/customers/${account.paddle_customer_id}/portal-sessions`, { method: "POST", body: "{}" });
    return NextResponse.json({ url: portal.urls.general.overview }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Billing portal failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: isEnglish ? "Could not open billing settings." : "결제 관리 화면을 열지 못했습니다." }, { status: 503 });
  }
}
