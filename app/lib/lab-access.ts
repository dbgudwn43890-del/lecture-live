/**
 * /stt-lab is an internal transcription-tuning tool that spends the Deepgram
 * Workers AI quota. Signing in is not enough to reach it: in production the
 * user id must be listed in STT_LAB_USER_IDS.
 */
export function canUseSttLab(userId: string | null) {
  if (!userId) return false;
  // Local dev only. A Vercel preview deployment is also NODE_ENV=development
  // in some configs, and it runs on the real provider keys — the allowlist
  // applies to anything deployed.
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) return true;

  const allowed = (process.env.STT_LAB_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return allowed.includes(userId);
}
