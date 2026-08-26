const MODEL = "@cf/openai/whisper-large-v3-turbo";

type CloudflareResult = {
  text?: unknown;
  transcription_info?: { language?: unknown };
};

type CloudflareResponse = {
  success?: boolean;
  result?: CloudflareResult;
};

export function isWhisperConfigured() {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

export async function transcribeWithWhisper(
  audioBuffer: ArrayBuffer,
  options: { language: "ko" | "en"; prompt?: string; timeoutMs?: number },
): Promise<{ text: string; language: string } | { error: string; status: number }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return { error: "Cloudflare Workers AI is not configured.", status: 503 };

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio: Buffer.from(audioBuffer).toString("base64"),
          task: "transcribe",
          language: options.language,
          vad_filter: true,
          condition_on_previous_text: true,
          ...(options.prompt ? { initial_prompt: options.prompt } : {}),
        }),
        cache: "no-store",
        signal: abortController.signal,
      },
    );

    if (!response.ok) return { error: `Cloudflare transcription failed (${response.status}).`, status: 502 };

    const data = await response.json() as CloudflareResponse;
    if (data.success === false || !data.result) return { error: "No transcription result.", status: 502 };

    return {
      text: typeof data.result.text === "string" ? data.result.text.trim() : "",
      language: typeof data.result.transcription_info?.language === "string" ? data.result.transcription_info.language : options.language,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { error: "Transcription timed out.", status: 504 };
    return { error: "Could not reach the transcription server.", status: 502 };
  } finally {
    clearTimeout(timeout);
  }
}
