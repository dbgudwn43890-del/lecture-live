export type SttProvider = "deepgram" | "whisper";

// ponytail: env-only switch. Deepgram code stays wired for a later flip back — set STT_PROVIDER=deepgram to revert.
export function getSttProvider(): SttProvider {
  return process.env.STT_PROVIDER === "deepgram" ? "deepgram" : "whisper";
}
