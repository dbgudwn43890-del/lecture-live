import type { Summary } from "./lecture-summary";

export type LectureFlowSection = {
  windowIndex: number;
  startMs: number;
  endMs: number;
  title: string;
  keywords: string[];
  points: string[];
};

export type LectureFlowResponse = {
  sections: LectureFlowSection[];
  pending: { startMs: number; endMs: number } | null;
};

function compact(value: string, limit: number): string {
  const text = value.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

/** Present the existing model-written index, never a transcript fallback. */
export function summaryFlowSection(summary: Summary, locale: "ko" | "en" = "ko"): LectureFlowSection | null {
  if (!Number.isInteger(summary.windowIndex) || summary.windowIndex < 0 || summary.windowIndex > 17
    || !Number.isFinite(summary.startMs) || !Number.isFinite(summary.endMs)
    || summary.startMs < 0 || summary.endMs <= summary.startMs) return null;

  const values = { TOPICS: [] as string[], TERMS: [] as string[], POINTS: [] as string[] };
  const legacy: string[] = [];
  let current: keyof typeof values | null = null;
  for (const line of summary.text.split(/\r?\n/)) {
    const clean = line.replace(/\*\*|__/g, "").replace(/^\s*#{1,3}\s*/, "").trim();
    if (!clean || /^```/.test(clean)) continue;
    const heading = /^(TOPICS|TERMS|POINTS)\s*[:：]\s*(.*)$/i.exec(clean);
    if (heading) {
      current = heading[1].toUpperCase() as keyof typeof values;
      if (heading[2].trim()) values[current].push(heading[2].trim());
    } else if (current) {
      values[current].push(clean);
    } else {
      legacy.push(clean);
    }
  }

  const topics = unique(values.TOPICS.flatMap(line => line.split(/[,;，；]/)).map(value => compact(value, 64)), 2);
  const keywords = unique(values.TERMS.flatMap(line => line.split(/[,;，；]/)).map(value => compact(value, 36)), 5);
  const sourcePoints = values.POINTS.length ? values.POINTS : current ? [] : legacy;
  const points = unique(sourcePoints.map(line => compact(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""), 140)), 4);
  if (!topics.length && !keywords.length && !points.length) return null;

  return {
    windowIndex: summary.windowIndex,
    startMs: summary.startMs,
    endMs: summary.endMs,
    title: compact(topics.join(" · ") || keywords[0] || (locale === "en" ? "Key ideas" : "핵심 흐름"), 64),
    keywords,
    points,
  };
}

export function buildLectureFlow(summaries: Summary[], lastEndMs: number, locale: "ko" | "en" = "ko"): LectureFlowResponse {
  const sections = summaries
    .map(summary => summaryFlowSection(summary, locale))
    .filter((section): section is LectureFlowSection => section !== null)
    .sort((a, b) => a.startMs - b.startMs || a.windowIndex - b.windowIndex);
  const coveredThrough = sections.reduce((latest, section) => Math.max(latest, section.endMs), 0);
  const latestSpeech = Number.isFinite(lastEndMs) ? Math.max(0, lastEndMs) : 0;
  return { sections, pending: latestSpeech > coveredThrough ? { startMs: coveredThrough, endMs: latestSpeech } : null };
}
