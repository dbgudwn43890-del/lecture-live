"use client";

import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { AnswerMarkdown } from "./answer-markdown";
import { splitLearningCheck } from "../lib/learning-check";
import "katex/dist/katex.min.css";
import "./learning-answer.css";

function LearningAnswer({ text, pending = false, isEnglish = false }: { text: string; pending?: boolean; isEnglish?: boolean }) {
  const { body, check } = splitLearningCheck(text, pending);
  return <div className="learning-answer">
    {pending && !body.trim() ? <p className="answer-check-label">{isEnglish ? "Preparing your answer…" : "답변을 준비하고 있어요…"}</p> : <AnswerMarkdown text={body} pending={pending} isEnglish={isEnglish} />}
    {check && <section className="answer-check" aria-label={isEnglish ? "Check yourself" : "확인 질문"}>
      <span className="answer-check-label">{isEnglish ? "Check yourself" : "확인 질문"}</span>
      <AnswerMarkdown text={check.question} isEnglish={isEnglish} />
      <details>
        <summary>{isEnglish ? "Show answer" : "정답 보기"}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="answer-check-solution"><AnswerMarkdown text={check.answer} isEnglish={isEnglish} /></div>
      </details>
    </section>}
  </div>;
}

export default memo(LearningAnswer);
