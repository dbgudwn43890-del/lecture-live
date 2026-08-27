import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getOAuthFallbackNext, localePathFor } from "./app/lib/auth-redirect";

// Matches a path against a route prefix on segment boundaries, so a future
// /authors or /loginhelp cannot inherit /auth's or /login's public status.
function isUnder(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const LOCALE_COOKIE = "site-locale";
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
  const prefersEnglish = chosenLocale
    ? chosenLocale === "en"
    : Boolean(country && country !== "KR" && country !== "XX");
  const usesEnglishHomepage = path === "/" && prefersEnglish;
  const oauthFallbackNext = getOAuthFallbackNext(
    path,
    country,
    request.nextUrl.searchParams.has("code"),
    chosenLocale ? chosenLocale === "en" : undefined,
  );

  // Supabase falls back to the Site URL when an OAuth redirect URL is not allow-listed.
  // Recover the PKCE code instead of leaving the user signed out on the landing page.
  if (oauthFallbackNext) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = "/auth/callback";
    callbackUrl.searchParams.set("next", oauthFallbackNext);
    return NextResponse.redirect(callbackUrl);
  }

  // Whichever language this visitor gets, remember it. Without this the choice
  // was re-derived from the IP header on every request, so a Korean visitor
  // whose next request was geolocated elsewhere — a VPN, a mobile carrier
  // routed abroad, a missing header — landed in the English classroom after
  // reading the Korean landing page.
  const rememberLocale = <T extends NextResponse>(target: T) => {
    if (!chosenLocale) target.cookies.set(LOCALE_COOKIE, prefersEnglish ? "en" : "ko", LOCALE_COOKIE_OPTIONS);
    return target;
  };

  // Both directions: into /en when English is preferred, back out of it when
  // Korean is. Only the first was enforced, so the language switch could set
  // the cookie and leave the visitor sitting on the English page.
  const localeTarget = localePathFor(path, prefersEnglish);
  if (localeTarget) {
    const localeUrl = request.nextUrl.clone();
    localeUrl.pathname = localeTarget;
    return rememberLocale(NextResponse.redirect(localeUrl));
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
    return rememberLocale(NextResponse.redirect(loginUrl));
  }

  return rememberLocale(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
