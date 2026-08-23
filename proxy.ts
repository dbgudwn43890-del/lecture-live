import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getOAuthFallbackNext } from "./app/lib/auth-redirect";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const country = request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
  const prefersEnglish = Boolean(country && country !== "KR" && country !== "XX");
  const usesEnglishHomepage = path === "/" && prefersEnglish;
  const oauthFallbackNext = getOAuthFallbackNext(path, country, request.nextUrl.searchParams.has("code"));

  // Supabase falls back to the Site URL when an OAuth redirect URL is not allow-listed.
  // Recover the PKCE code instead of leaving the user signed out on the landing page.
  if (oauthFallbackNext) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = "/auth/callback";
    callbackUrl.searchParams.set("next", oauthFallbackNext);
    return NextResponse.redirect(callbackUrl);
  }

  const localizablePaths = ["/", "/preview", "/login", "/classroom", "/billing", "/privacy", "/terms"];
  if (
    prefersEnglish &&
    path !== "/" &&
    !path.startsWith("/en") &&
    localizablePaths.includes(path)
  ) {
    const englishUrl = request.nextUrl.clone();
    englishUrl.pathname = path === "/" ? "/en" : `/en${path}`;
    return NextResponse.redirect(englishUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-site-locale", usesEnglishHomepage || path === "/en" || path.startsWith("/en/") ? "en" : "ko");
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const isPublic = path === "/" || path === "/en" || [
    "/preview", "/login", "/auth", "/api", "/privacy", "/terms", "/stt-lab",
    "/en/preview", "/en/login", "/en/privacy", "/en/terms",
  ].some((prefix) => path.startsWith(prefix));

  if (!data?.claims && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = path.startsWith("/en/") ? "/en/login" : "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
