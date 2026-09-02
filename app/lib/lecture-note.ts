/**
 * 강의 노트의 저장 형태. 마크다운 대신 타입이 있는 블록 JSON을 쓴다.
 * 파서·새니타이저 없이 React가 그대로 그리고, 수식(KaTeX)과
 * 다이어그램(Mermaid)만 각자의 렌더러로 넘긴다.
 */
export type NoteBlock = {
  type: "paragraph" | "list" | "formula" | "diagram" | "callout" | "qa";
  /** paragraph·callout 본문, formula·diagram 캡션, qa 답변 */
  text: string;
  /** list 항목. 다른 타입에서는 빈 배열 */
  items: string[];
  /** formula: KaTeX 문법 수식. 다른 타입에서는 빈 문자열 */
  latex: string;
  /** diagram: Mermaid 소스. 다른 타입에서는 빈 문자열 */
  mermaid: string;
  /** callout 제목("시험 포인트" 등), qa 질문. 다른 타입에서는 빈 문자열 */
  label: string;
};

export type NoteSection = { heading: string; blocks: NoteBlock[] };
export type LectureNote = { title: string; summary: string; sections: NoteSection[] };

/** OpenAI structured output용. strict 모드라 모든 필드가 required다. */
export const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "sections"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "blocks"],
        properties: {
          heading: { type: "string" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "text", "items", "latex", "mermaid", "label"],
              properties: {
                type: { type: "string", enum: ["paragraph", "list", "formula", "diagram", "callout", "qa"] },
                text: { type: "string" },
                items: { type: "array", items: { type: "string" } },
                latex: { type: "string" },
                mermaid: { type: "string" },
                label: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function notePrompt(isEnglish: boolean) {
  return [
    isEnglish
      ? "You are writing a review note for a university student who just attended this lecture. Use ONLY the transcript, the student's Q&A, and the lecture materials below. Never invent content that was not covered."
      : "방금 이 강의를 들은 대학생을 위한 복습 노트를 작성한다. 아래 스크립트, 학생의 질문·답변, 강의 자료만 근거로 쓴다. 강의에서 다루지 않은 내용을 지어내지 않는다.",
    isEnglish
      ? "Structure: an overall summary, then sections following the lecture's actual flow. Inside sections use paragraphs, lists, callouts (label like 'Exam point' or 'Definition' for things the lecturer emphasized), formulas, diagrams, and qa blocks."
      : "구조: 전체 요약 후, 강의의 실제 흐름을 따르는 섹션들. 섹션 안에서는 문단, 목록, 콜아웃(강의자가 강조한 내용에 '시험 포인트'·'정의' 같은 label), 수식, 다이어그램, qa 블록을 쓴다.",
    isEnglish
      ? "Formulas: whenever the lecture or materials contain a formula, output it as a formula block with valid KaTeX in `latex` and a one-line caption in `text`."
      : "수식: 강의나 자료에 수식이 나오면 formula 블록으로 만들고 `latex`에 올바른 KaTeX 문법, `text`에 한 줄 설명을 쓴다.",
    isEnglish
      ? "Diagrams: where concepts relate (processes, hierarchies, comparisons), add 1-3 diagram blocks with valid Mermaid (flowchart TD or mindmap) in `mermaid`. Keep node labels short; wrap them in double quotes."
      : "다이어그램: 개념 사이의 관계(과정, 위계, 비교)가 있으면 diagram 블록을 1~3개 넣고 `mermaid`에 올바른 Mermaid(flowchart TD 또는 mindmap)를 쓴다. 노드 라벨은 짧게, 큰따옴표로 감싼다.",
    isEnglish
      ? "Q&A: summarize each question the student asked as a qa block (question in `label`, short answer in `text`) inside the section it belongs to — these mark what the student found hard."
      : "질문: 학생이 한 질문은 해당 섹션 안에 qa 블록으로 정리한다(`label`에 질문, `text`에 짧은 답). 학생이 어려워한 지점이므로 빠뜨리지 않는다.",
    isEnglish
      ? "When a lecture material page is the source, mention it in the text like (p.12). Unused fields must be empty strings or empty arrays. Write in English."
      : "강의 자료가 근거일 때는 본문에 (p.12)처럼 페이지를 적는다. 쓰지 않는 필드는 빈 문자열·빈 배열로 둔다. 한국어로 쓴다.",
  ].join("\n");
}
