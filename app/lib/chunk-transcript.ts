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

export function groupTranscriptParagraphs(parts: TranscriptPart[], maxCharacters = 280, maxParts = 3) {
  const paragraphs: TranscriptPart[] = [];
  let current: TranscriptPart | null = null;
  let partCount = 0;

  for (const part of parts) {
    const text = part.text.trim();
    if (!text) continue;
    if (!current || partCount >= maxParts || current.text.length + text.length + 1 > maxCharacters) {
      if (current) paragraphs.push(current);
      current = { ...part, text };
      partCount = 1;
    } else {
      current.text += ` ${text}`;
      current.endMs = part.endMs;
      partCount += 1;
    }
  }

  if (current) paragraphs.push(current);
  return paragraphs;
}

export function countTranscriptSentences(parts: TranscriptPart[]) {
  return parts.reduce((count, part) => {
    const text = part.text.trim();
    if (!text) return count;
    return count + Math.max(1, text.match(/[.!?…]+/g)?.length ?? 0);
  }, 0);
}
