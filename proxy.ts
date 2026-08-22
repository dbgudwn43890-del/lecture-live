import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const country = request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
  const localizablePaths = ["/", "/preview", "/login", "/classroom", "/privacy", "/terms"];
  if (
    country &&
    country !== "KR" &&
    country !== "XX" &&
    !path.startsWith("/en") &&
    localizablePaths.includes(path)
  ) {
    const englishUrl = request.nextUrl.clone();
    englishUrl.pathname = path === "/" ? "/en" : `/en${path}`;
    return NextResponse.redirect(englishUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-site-locale", path === "/en" || path.startsWith("/en/") ? "en" : "ko");
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
    "/preview", "/login", "/auth", "/api", "/privacy", "/terms",
    "/en/preview", "/en/login", "/en/privacy", "/en/terms",
  ].some((prefix) => path.startsWith(prefix));

  if (!data?.claims && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = path.startsWith("/en/") ? "/en/login" : "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
