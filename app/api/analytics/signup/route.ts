import { NextRequest, NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import { createAdminClient } from "../../../lib/supabase/admin";
import { hasVerifiedEmail } from "../../../lib/verified-email";
import { ANALYTICS_CONSENT, analyticsEnabled } from "../../../lib/analytics-policy";

export async function POST(request: NextRequest) {
  const reply = (claimed = false) => NextResponse.json({ claimed }, { headers: { "Cache-Control": "no-store" } });
  try {
    if (!analyticsEnabled(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID)
      || request.headers.get("origin") !== request.nextUrl.origin
      || request.cookies.get(ANALYTICS_CONSENT)?.value !== "granted") return reply();
    const client = await createClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !hasVerifiedEmail(user)) return reply();
    const { data, error: claimsError } = await client.auth.getClaims();
    const session = data?.claims?.session_id;
    if (claimsError || data?.claims?.sub !== user.id || typeof session !== "string"
      || !/^[0-9a-f-]{36}$/i.test(session)) return reply();
    const admin = createAdminClient();
    if (!admin) return reply();
    const result = await admin.rpc("claim_analytics_signup_service", { p_user_id: user.id, p_session_id: session });
    return reply(!result.error && result.data === true);
  } catch {
    // No upstream response, identity, or auth token is logged or returned.
    return reply();
  }
}
