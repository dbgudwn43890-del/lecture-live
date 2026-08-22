export type TranscriptPart = {
  startMs: number;
  endMs: number;
  text: string;
};

export function chunkTranscript(parts: TranscriptPart[], maxCharacters = 1_800) {
  const chunks: TranscriptPart[] = [];
  let current: TranscriptPart | null = null;

  for (const part of parts) {
    const text = part.text.trim();
    if (!text) continue;
    if (!current || current.text.length + text.length + 1 > maxCharacters) {
      if (current) chunks.push(current);
      current = { ...part, text };
    } else {
      current.text += `\n${text}`;
      current.endMs = part.endMs;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
