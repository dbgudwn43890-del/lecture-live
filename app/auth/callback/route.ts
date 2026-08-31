import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { SIGNUP_CONSENT_TYPES, CONSENT_VERSION } from "../../lib/consent";
import { createClient } from "../../lib/supabase/server";
import { getSafeAuthNext } from "../../lib/auth-redirect";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const requestedNext = request.nextUrl.searchParams.get("next");
  const nextPath = getSafeAuthNext(requestedNext);
  const supabase = await createClient();

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
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

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.search = "";
  redirectUrl.pathname = result.error
    ? nextPath.startsWith("/en/") ? "/en/login" : "/login"
    : nextPath;
  if (result.error) redirectUrl.searchParams.set("error", "callback");

  return NextResponse.redirect(redirectUrl);
}
