import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { MAX_AUDIO_UPLOAD_BYTES } from "./lecture-audio-transfer.ts";

export type AudioUploadAvailability = {
  available: boolean;
  reason: "service_unavailable" | null;
  maxFileBytes: number;
};

/** Report service readiness without exposing provider or callback credentials. */
export async function getAudioUploadAvailability(adminConfigured: boolean): Promise<AudioUploadAvailability> {
  const maxFileBytes = MAX_AUDIO_UPLOAD_BYTES;
  let callbackConfigured = false;
  try {
    const site = new URL(process.env.SITE_URL ?? "");
    callbackConfigured = site.protocol === "https:"
      && !site.username && !site.password && !site.search && !site.hash
      && site.pathname === "/"
      && !["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  } catch { /* A missing or invalid callback address cannot receive results. */ }

  if (adminConfigured && process.env.DEEPGRAM_API_KEY?.trim()
    && process.env.LECTURE_AUDIO_CALLBACK_SECRET?.trim() && callbackConfigured) {
    try {
      await access(join(process.cwd(), ".ffmpeg", "ffmpeg"), constants.X_OK);
      return { available: true, reason: null, maxFileBytes };
    } catch { /* The decoder must be installed before accepting a file. */ }
  }
  return { available: false, reason: "service_unavailable", maxFileBytes };
}
