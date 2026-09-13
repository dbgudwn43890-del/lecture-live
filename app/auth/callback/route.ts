import { type NextRequest, NextResponse } from "next/server";

import { SIGNUP_CONSENT_TYPES, CONSENT_VERSION } from "../../lib/consent";
import { createClient } from "../../lib/supabase/server";
import { getSafeAuthNext } from "../../lib/auth-redirect";
import { finalizeSignupAnalytics, SIGNUP_ANALYTICS_CONSENT_COOKIE } from "../../lib/signup-analytics";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");
  const requestedNext = request.nextUrl.searchParams.get("next");
  const nextPath = getSafeAuthNext(requestedNext);
  // Recovery codes belong to the reset form. A generic callback must not turn
  // a password-reset link into an ordinary classroom sign-in.
  if (type === "recovery") {
    const resetUrl = new URL(nextPath.startsWith("/en/") ? "/en/login" : "/login", request.nextUrl.origin);
    resetUrl.searchParams.set("mode", "recovery");
    resetUrl.searchParams.set("error", "recovery_link");
    resetUrl.searchParams.set("next", nextPath);
    return NextResponse.redirect(resetUrl);
  }
  const supabase = await createClient();

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && (type === "signup" || type === "email")
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("Missing authentication token") };

  // ACC-02/ACC-03. The learner ticked both boxes on the signup form, but there
  // was no session yet to write them against — the account only becomes real
  // when the emailed link lands here. The version comes from the server, never
  // from the query string, so a hand-edited link cannot record consent to
  // wording that was never shown.
  if (!result.error && request.nextUrl.searchParams.get("consent") === "1") {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { error } = await supabase.from("consents").upsert(
        SIGNUP_CONSENT_TYPES.map((consentType) => ({ user_id: user.id, consent_type: consentType, document_version: CONSENT_VERSION })),
        { onConflict: "user_id,consent_type,document_version", ignoreDuplicates: true },
      );
      // The classroom asks again on its next load if this did not land, so a
      // failed write costs one extra dialog rather than an unrecorded consent.
      if (error) console.error("Signup consent save failed", error.code);
    }
  }

  if (!result.error) {
    // Only a database-created marker can become a signup conversion. This
    // callback also handles returning users, so OAuth success alone is not one.
    await finalizeSignupAnalytics(
      supabase,
      request.cookies.get(SIGNUP_ANALYTICS_CONSENT_COOKIE)?.value,
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID,
    );
  }

  // nextPath can include a lecture or plan query. Assigning it to pathname
  // encodes the question mark and sends the learner to a nonexistent page.
  const redirectUrl = new URL(nextPath, request.nextUrl.origin);
  if (result.error) {
    redirectUrl.pathname = nextPath.startsWith("/en/") ? "/en/login" : "/login";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("error", "callback");
    redirectUrl.searchParams.set("next", nextPath);
  }

  return NextResponse.redirect(redirectUrl);
}
