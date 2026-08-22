import { NextResponse } from "next/server";

import { createClient } from "../../lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const next = new URL(request.url).searchParams.get("next");
  return NextResponse.redirect(new URL(next === "/en/login" ? "/en/login" : "/login", request.url), { status: 303 });
}
