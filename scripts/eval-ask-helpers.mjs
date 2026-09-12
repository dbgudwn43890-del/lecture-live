// Read through the final frame: fetch() resolving only measures response headers,
// not answer completion. The callback measures the first actual text delta.
export async function readNdjsonAnswer(response, onFirstText = () => {}) {
  if (!response.body) return { error: "no response body" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let firstTextSeen = false;

  const readLine = (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch {
      result = { error: "invalid NDJSON frame" };
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      result = { error: "invalid NDJSON frame" };
      return;
    }
    if (!firstTextSeen && typeof frame.delta === "string" && frame.delta.length) {
      firstTextSeen = true;
      onFirstText();
    }
    if (frame.error) result = { error: frame.error };
    if (frame.done && !result?.error) result = frame.done;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) readLine(line);
      if (done) break;
    }
    readLine(buffer);
    return result ?? { error: "no done frame" };
  } finally {
    reader.releaseLock();
  }
}

// Existing Luna token estimate; this excludes web search and is not an invoice.
export function estimateTokenCost(usage) {
  if (!usage) return 0;
  const count = (value) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const cached = count(usage.cachedInputTokens);
  const written = count(usage.cacheWriteTokens);
  const uncached = Math.max(0, count(usage.inputTokens) - cached - written);
  return (uncached * 0.2 + cached * 0.02 + written * 0.25 + count(usage.outputTokens) * 1.2) / 1_000_000;
}
