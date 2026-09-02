import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getOAuthFallbackNext, localePathFor } from "./app/lib/auth-redirect";

// Matches a path against a route prefix on segment boundaries, so a future
// /authors or /loginhelp cannot inherit /auth's or /login's public status.
function isUnder(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// v2: 이름을 바꿔 예전 쿠키를 무효화한다. 예전 "site-locale"에는 IP 오추측이
// en으로 굳어 있어, 한국어 브라우저가 계속 영어 강의실로 열렸다. 이제 쿠키는
// 언어 토글(?lang=)로 직접 고른 선택만 담는다.
const LOCALE_COOKIE = "site-locale-choice";
const LOCALE_COOKIE_OPTIONS = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" } as const;

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // The language toggle appends ?lang=. Remember the choice in a cookie and
  // strip the param, so a Korean speaker abroad is not sent back to /en by the
  // IP guess on their very next navigation.
  const requestedLocale = request.nextUrl.searchParams.get("lang");
  if (requestedLocale === "ko" || requestedLocale === "en") {
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete("lang");
    const redirect = NextResponse.redirect(cleanUrl);
    redirect.cookies.set(LOCALE_COOKIE, requestedLocale, LOCALE_COOKIE_OPTIONS);
    return redirect;
  }

  const chosenLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const country = request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
  // 직접 고른 선택 > 브라우저 언어 > IP 국가. IP만 믿으면 VPN·해외 라우팅된
  // 통신사·헤더 없는 환경의 한국어 사용자가 영어 강의실로 들어간다.
  const acceptsKorean = (request.headers.get("accept-language") ?? "").toLowerCase().includes("ko");
  const prefersEnglish = chosenLocale
    ? chosenLocale === "en"
    : Boolean(country && country !== "KR" && country !== "XX" && !acceptsKorean);
  const usesEnglishHomepage = path === "/" && prefersEnglish;
  const oauthFallbackNext = getOAuthFallbackNext(
    path,
    country,
    request.nextUrl.searchParams.has("code"),
    prefersEnglish,
  );

  // Supabase falls back to the Site URL when an OAuth redirect URL is not allow-listed.
  // Recover the PKCE code instead of leaving the user signed out on the landing page.
  if (oauthFallbackNext) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = "/auth/callback";
    callbackUrl.searchParams.set("next", oauthFallbackNext);
    return NextResponse.redirect(callbackUrl);
  }

  // 추측은 저장하지 않는다. 예전에는 첫 요청의 IP 추측을 쿠키에 굳혔는데,
  // 그 추측이 틀리면(en) 한국어 브라우저가 영원히 영어로 열렸다. 브라우저
  // Accept-Language 기반 재계산은 요청마다 안정적이라 저장할 이유가 없다.

  // Both directions: into /en when English is preferred, back out of it when
  // Korean is. Only the first was enforced, so the language switch could set
  // the cookie and leave the visitor sitting on the English page.
  const localeTarget = localePathFor(path, prefersEnglish);
  if (localeTarget) {
    const localeUrl = request.nextUrl.clone();
    localeUrl.pathname = localeTarget;
    return NextResponse.redirect(localeUrl);
  }

  const requestHeaders = new Headers(request.headers);
  const explicitlyEnglish = request.headers.get("x-site-locale") === "en";
  requestHeaders.set("x-site-locale", explicitlyEnglish || usesEnglishHomepage || path === "/en" || path.startsWith("/en/") ? "en" : "ko");
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  // /auth routes (signout, OAuth callback) manage their own Supabase session
  // lifecycle. Refreshing the session here races their cookie writes — e.g.
  // signOut() clears cookies while this client's getClaims() call can
  // reissue a still-valid session cookie for the same response.
  //
  // /api routes each authenticate themselves, so the session refresh below is
  // pure overhead on them — and they are the hot path: during a recording that
  // is a transcription upload every few seconds plus a segment write per line.
  // They still need the locale header set above.
  if (isUnder(path, "/auth") || isUnder(path, "/api")) return response;

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
    "/login", "/api", "/privacy", "/terms",
    "/en/login", "/en/privacy", "/en/terms",
  ].some((prefix) => isUnder(path, prefix));

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
