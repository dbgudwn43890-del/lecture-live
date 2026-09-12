import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "../../../lib/supabase/admin";
import { runStorageCleanup } from "../../../lib/storage-cleanup";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Cleanup unavailable" }, { status: 503 });
  try {
    const { error: reservationError } = await admin.rpc("sweep_audio_credit_reservations_service");
    if (reservationError) throw new Error("Audio reservation cleanup failed");
    return NextResponse.json(await runStorageCleanup(admin), { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Scheduled storage cleanup failed");
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}
