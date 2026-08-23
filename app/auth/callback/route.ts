import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

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

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.search = "";
  redirectUrl.pathname = result.error
    ? nextPath.startsWith("/en/") ? "/en/login" : "/login"
    : nextPath;
  if (result.error) redirectUrl.searchParams.set("error", "callback");

  return NextResponse.redirect(redirectUrl);
}
