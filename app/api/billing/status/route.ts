import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "../../../lib/auth";
import { checkSharedRateLimit } from "../../../lib/rate-limit";
import { createAdminClient } from "../../../lib/supabase/admin";

export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Sign-in required" }, { status: 401 });
  const limit = await checkSharedRateLimit(`billing-status:${userId}`, 60, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: "Try again shortly" }, { status: 429 });
  const id = new URL(request.url).searchParams.get("transaction");
  if (!id || !/^txn_[a-z0-9]+$/.test(id)) return NextResponse.json({ error: "Invalid transaction" }, { status: 400 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const { data, error } = await admin.from("billing_orders").select("completed_at").eq("transaction_id", id).eq("user_id", userId).maybeSingle();
  if (error) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ granted: Boolean(data.completed_at) }, { headers: { "Cache-Control": "no-store" } });
}
