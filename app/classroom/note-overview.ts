import { NOTE_KEY_POINT_MAX_LENGTH, NOTE_SUMMARY_MAX_LENGTH, type LectureNote } from "../lib/lecture-note";

/** Keep older prose intact without making it the first screen of the note. */
export function noteOverview(note: LectureNote) {
  const original = [...new Set((note.keyPoints ?? []).map(point => point.trim()).filter(Boolean))];
  const points: string[] = [];
  const details: string[] = [];
  for (const point of original) {
    if (points.length < 5 && point.length <= NOTE_KEY_POINT_MAX_LENGTH && !point.includes("\n")) points.push(point);
    else details.push(point);
  }
  const summary = note.summary.trim();
  const oneLine = summary.length <= NOTE_SUMMARY_MAX_LENGTH && !summary.includes("\n") ? summary : "";
  if (summary && !oneLine && !original.includes(summary)) details.unshift(summary);
  return {
    summary: oneLine,
    kind: points.length ? "keyPoints" as const : "topics" as const,
    points: points.length ? points : [...new Set(note.sections.map(section => section.heading.trim()).filter(Boolean))].slice(0, 5),
    details,
  };
}
