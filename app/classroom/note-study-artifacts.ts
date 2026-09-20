import { Lexer, walkTokens } from "marked";
import { splitLearningCheck, type LearningCheck } from "../lib/learning-check.ts";
import type { NoteAnswer } from "../lib/lecture-note.ts";
import { ANSWER_CHART_LANGUAGE, parseAnswerChart, type AnswerChartData } from "./answer-chart.ts";

type StudyArtifact = { type: "chart"; data: AnswerChartData } | ({ type: "check" } & LearningCheck);

/** Reuse explicit saved learning artifacts; never guess which prose is an example. */
export function noteStudyArtifacts(answers: NoteAnswer[]): StudyArtifact[] {
  const artifacts: StudyArtifact[] = [];
  const seen = new Set<string>();
  function add(artifact: StudyArtifact) {
    const key = JSON.stringify(artifact);
    if (!seen.has(key)) { seen.add(key); artifacts.push(artifact); }
  }
  for (const answer of answers) {
    const { body, check } = splitLearningCheck(answer.text);
    // A chart inside the check stays in its question/solution, in the original position.
    walkTokens(Lexer.lex(body), token => {
      if (token.type !== "code") return;
      const language = token.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (language && language !== ANSWER_CHART_LANGUAGE && language !== "json") return;
      const data = parseAnswerChart(token.text);
      if (data) add({ type: "chart", data });
    });
    if (check) add({ type: "check", ...check });
  }
  return artifacts;
}
