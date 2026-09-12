// New accounts receive a card-free starter grant. Existing grants are never reset.
import { STARTER_CREDITS, STARTER_DAYS } from "./plans";
import { hasVerifiedEmail } from "./verified-email";
export const FREE_PILOT = false;
export const FREE_PILOT_CREDITS = STARTER_CREDITS;

/**
 * 그랜트가 하나도 없는 새 계정에 무료 크레딧을 심는다. 웹훅과 같은
 * (source_type, source_id) 멱등 upsert라 새로고침·동시 요청에도 한 번만
 * 들어간다. ko/en 강의실 페이지가 함께 쓴다 — en 쪽에만 빠져 있어서
 * 영어로 첫 진입한 새 계정이 0크레딧으로 시작하던 버그의 재발 방지.
 */
export async function ensureFreePilotGrant(userId: string): Promise<boolean> {
  const { createAdminClient } = await import("./supabase/admin");
  const admin = createAdminClient();
  if (!admin) return false;
  // This service-role write bypasses RLS. Recheck the authoritative Auth user
  // before a first grant so a pending signup can never receive starter credits.
  // This runs only when the classroom found no existing grant.
  try {
    const { data: { user }, error } = await admin.auth.admin.getUserById(userId);
    if (error || !hasVerifiedEmail(user) || user.id !== userId) return false;
  } catch {
    return false;
  }
  const now = Date.now();
  const { error } = await admin.from("credit_grants").upsert({
    user_id: userId,
    source_type: "trial",
    source_id: userId,
    plan_code: "trial",
    granted_credits: FREE_PILOT_CREDITS,
    remaining_credits: FREE_PILOT_CREDITS,
    starts_at: new Date(now).toISOString(),
    expires_at: new Date(now + STARTER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  }, { onConflict: "source_type,source_id", ignoreDuplicates: true });
  if (error) console.error("Free pilot grant failed", error.code);
  return !error;
}
