import { NextRequest, NextResponse } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import {
  finalizeSignupAnalytics, isSameOriginAnalyticsRequest,
  SIGNUP_ANALYTICS_CONSENT_COOKIE,
} from "../../../../lib/signup-analytics";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

/** Email-code confirmation does not pass through the OAuth callback. This
 * first-party endpoint finalizes the same DB marker, without sending GA data. */
export async function POST(request: NextRequest) {
  if (!isSameOriginAnalyticsRequest(request)) return NextResponse.json({ ok: false }, { status: 403, headers });
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ ok: false }, { status: 401, headers });
    const ok = await finalizeSignupAnalytics(
      supabase,
      request.cookies.get(SIGNUP_ANALYTICS_CONSENT_COOKIE)?.value,
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID,
    );
    return NextResponse.json({ ok }, { status: ok ? 200 : 503, headers });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
