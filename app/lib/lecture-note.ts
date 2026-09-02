/**
 * 강의 노트의 저장 형태. 마크다운 대신 타입이 있는 블록 JSON을 쓴다.
 * 파서·새니타이저 없이 React가 그대로 그리고, 수식(KaTeX)과
 * 다이어그램(Mermaid)만 각자의 렌더러로 넘긴다.
 */
export type NoteBlock = {
  type: "paragraph" | "list" | "formula" | "diagram" | "callout" | "qa" | "material";
  /** paragraph·callout 본문, formula·diagram·material 캡션, qa 답변 */
  text: string;
  /** list 항목. 다른 타입에서는 빈 배열 */
  items: string[];
  /** formula: KaTeX 문법 수식. 다른 타입에서는 빈 문자열 */
  latex: string;
  /** diagram: Mermaid 소스. 다른 타입에서는 빈 문자열 */
  mermaid: string;
  /** callout 제목("시험 포인트" 등), qa 질문, material 파일명. 다른 타입에서는 빈 문자열 */
  label: string;
  /** material: 자료 페이지 번호. 다른 타입에서는 0 */
  page: number;
  /** material: 서버가 파일명을 검증해 붙이는 문서 id. 모델은 채우지 않는다. */
  documentId?: string;
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
              required: ["type", "text", "items", "latex", "mermaid", "label", "page"],
              properties: {
                type: { type: "string", enum: ["paragraph", "list", "formula", "diagram", "callout", "qa", "material"] },
                text: { type: "string" },
                items: { type: "array", items: { type: "string" } },
                latex: { type: "string" },
                mermaid: { type: "string" },
                label: { type: "string" },
                page: { type: "integer" },
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
      ? "The transcript comes from speech recognition, so it contains mishearings. Read for meaning, not spelling: when a word contradicts its own context or the materials (a homophone, a broken term), silently use the word the lecturer clearly meant — especially when later sentences repeat the correct one. Only when you genuinely cannot tell, keep the transcript's word and add the alternative in parentheses. Never build a summary around a mishearing."
      : "스크립트는 음성 인식 결과라 잘못 받아쓴 단어가 섞여 있다. 표기가 아니라 의미로 읽어라: 문맥이나 강의 자료와 어긋나는 단어(동음이의어, 깨진 전문용어)는 강의자가 명백히 의도한 단어로 조용히 고쳐 쓴다 — 특히 뒤 문장들이 올바른 단어를 반복할 때는 앞의 오인식을 그 단어로 읽는다. 정말 판단이 안 될 때만 원문 표기를 쓰고 괄호로 다른 해석을 병기한다. 오인식된 단어를 중심에 두고 요약을 만들지 않는다.",
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
      ? "Material pages: when a material page holds an important figure, table, or formula the lecture discussed, add a material block — exact filename in `label`, page number in `page`, one line in `text` on why it matters. The page is shown as an image, so only pick pages with real visual content."
      : "자료 페이지: 강의에서 다룬 중요한 그림·표·수식이 실린 자료 페이지가 있으면 material 블록을 넣는다 — `label`에 정확한 파일명, `page`에 페이지 번호, `text`에 왜 중요한지 한 줄. 그 페이지가 이미지로 표시되므로 실제 시각 자료가 있는 페이지만 고른다.",
    isEnglish
      ? "When a lecture material page is the source, mention it in the text like (p.12). Unused fields must be empty strings, empty arrays, or 0. Write in English."
      : "강의 자료가 근거일 때는 본문에 (p.12)처럼 페이지를 적는다. 쓰지 않는 필드는 빈 문자열·빈 배열·0으로 둔다. 한국어로 쓴다.",
  ].join("\n");
}
