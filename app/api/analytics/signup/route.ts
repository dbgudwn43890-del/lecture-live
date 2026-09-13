import { NextRequest, NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import {
  SIGNUP_ANALYTICS_CONSENT_COOKIE,
  allowsSignupAnalytics,
  claimSignupAnalytics,
  isSameOriginAnalyticsRequest,
  isSignupAnalyticsEnabled,
} from "../../../lib/signup-analytics";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  if (!isSameOriginAnalyticsRequest(request)) {
    return NextResponse.json({ eligible: false }, { status: 403, headers: privateHeaders });
  }
  if (!isSignupAnalyticsEnabled(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID)
      || !allowsSignupAnalytics(request.cookies.get(SIGNUP_ANALYTICS_CONSENT_COOKIE)?.value)) {
    return NextResponse.json({ eligible: false }, { headers: privateHeaders });
  }

  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ eligible: false }, { headers: privateHeaders });
    // SQL uses auth.uid(), never a supplied user_id or the callback query string.
    return NextResponse.json(await claimSignupAnalytics(supabase), { headers: privateHeaders });
  } catch {
    // Never fabricate a conversion or disclose database/user details on failure.
    return NextResponse.json({ eligible: false }, { status: 503, headers: privateHeaders });
  }
}
