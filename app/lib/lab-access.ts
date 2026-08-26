/**
 * /stt-lab is an internal transcription-tuning tool that spends the Cloudflare
 * Workers AI quota. Signing in is not enough to reach it: in production the
 * user id must be listed in STT_LAB_USER_IDS.
 */
export function canUseSttLab(userId: string | null) {
  if (!userId) return false;
  if (process.env.NODE_ENV !== "production") return true;

  const allowed = (process.env.STT_LAB_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return allowed.includes(userId);
}
