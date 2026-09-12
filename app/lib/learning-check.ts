export type LearningCheck = { question: string; answer: string };

/** A small optional convention on top of Markdown, not a second answer format. */
export function splitLearningCheck(text: string, pending = false): { body: string; check: LearningCheck | null } {
  let fence: { marker: string; size: number } | null = null;
  let questionStart = -1;
  let questionContent = -1;
  let answerStart = -1;
  let answerContent = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], size: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.size) fence = null;
    } else if (!fence) {
      if (questionStart < 0 && /^### (?:확인 질문|Check yourself)\s*$/i.test(line)) {
        questionStart = offset;
        questionContent = offset + line.length + 1;
      } else if (questionStart >= 0 && /^### (?:정답|Answer)\s*$/i.test(line)) {
        answerStart = offset;
        answerContent = offset + line.length + 1;
        break;
      }
    }
    offset += line.length + 1;
  }
  if (questionStart < 0) return { body: text, check: null };
  // Never flash the solution while tokens for a self-check are still arriving.
  if (pending) return { body: text.slice(0, questionStart).trimEnd(), check: null };
  const question = answerStart >= 0 ? text.slice(questionContent, answerStart).trim() : "";
  const answer = answerContent >= 0 ? text.slice(answerContent).trim() : "";
  // A model that omits the convention still gets an ordinary readable answer.
  if (!question || !answer) return { body: text, check: null };
  return { body: text.slice(0, questionStart).trimEnd(), check: { question, answer } };
}
