import type { SupabaseClient } from "@supabase/supabase-js";

/** A service-only, atomic reservation covers retries as well as the first embedding. */
export async function reserveLectureIndex(admin: SupabaseClient, input: { sessionId: string; userId: string; characters: number }): Promise<string | null> {
  const { data, error } = await admin.rpc("reserve_lecture_index", {
    p_session_id: input.sessionId, p_user_id: input.userId, p_characters: input.characters,
  });
  if (error) {
    console.error("Lecture indexing reservation failed", error.code);
    return null;
  }
  return data?.allowed === true && typeof data.claim_token === "string" ? data.claim_token : null;
}

export async function finishLectureIndex(admin: SupabaseClient, sessionId: string, token: string, succeeded: boolean): Promise<boolean> {
  const { data, error } = await admin.rpc("finish_lecture_index", {
    p_session_id: sessionId, p_claim_token: token, p_succeeded: succeeded,
  });
  if (error) console.error("Lecture indexing completion failed", error.code);
  return !error && data === true;
}
