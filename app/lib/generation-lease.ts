import type { createClient } from "./supabase/server";

/** Database lease shared across tabs and server instances; expires after maxDuration. */
export async function withGenerationLease(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  kind: "note" | "summary",
  isEnglish: boolean,
  generate: () => Promise<Response>,
): Promise<Response> {
  const token = crypto.randomUUID();
  const { data, error } = await supabase.rpc("claim_generation_lease", {
    p_session_id: sessionId, p_kind: kind, p_token: token,
  });
  if (error?.code === "42501") return Response.json({ error: isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  if (error) return Response.json({ error: isEnglish ? "Please try again shortly." : "잠시 후 다시 시도해 주세요." }, { status: 503 });
  if (!data) return Response.json(kind === "note"
    ? { note: { status: "generating", content: null, updated_at: new Date().toISOString() } }
    : { ok: true, skipped: "generating" }, { status: 202 });
  try {
    return await generate();
  } finally {
    // The token prevents an old request from releasing a newer request's lease.
    const { error: releaseError } = await supabase.rpc("release_generation_lease", {
      p_session_id: sessionId, p_kind: kind, p_token: token,
    });
    if (releaseError) console.error("Generation lease release failed", releaseError.code);
  }
}
