import { createContext, createElement, useContext, type ComponentProps, type ReactNode } from "react";
import { Streamdown, useIsCodeFenceIncomplete, type Components, type StreamdownProps } from "streamdown";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import { Lexer } from "marked";
import { ANSWER_CHART_LANGUAGE, AnswerChart, parseAnswerChart } from "./answer-chart.ts";

const AnswerPresentation = createContext({ pending: false, isEnglish: false });

const heading = ({ children }: ComponentProps<"h3"> | Record<string, unknown>) => createElement("h3", { className: "answer-section-title" }, children as ReactNode);
const components: Components = {
  h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
  strong: ({ children }) => createElement("strong", null, children),
  em: ({ children }) => createElement("em", null, children),
  // The existing source list is the only place for external navigation. No
  // model-generated images, tracking requests, custom HTML or embedded players.
  a: ({ children }) => createElement("span", null, children),
  img: () => null,
  table: ({ children }) => createElement("div", { className: "answer-table-scroll", tabIndex: 0 }, createElement("table", null, children)),
  pre: function AnswerCodeBlock({ children, node }) {
    const { pending, isEnglish } = useContext(AnswerPresentation);
    const incomplete = useIsCodeFenceIncomplete();
    const code = node?.children.find(child => child.type === "element" && child.tagName === "code");
    if (code?.type === "element") {
      const className: unknown = code.properties.className;
      const classes: unknown[] = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/) : [];
      const language = classes.find((value): value is string => typeof value === "string" && value.startsWith("language-"))?.slice(9).toLowerCase();
      const declaredChart = language === ANSWER_CHART_LANGUAGE;
      if (declaredChart || !language || language === "json") {
        const source = code.children.map(child => child.type === "text" ? child.value : "").join("");
        const data = parseAnswerChart(source);
        if (declaredChart || data) {
          return createElement(AnswerChart, { data: incomplete ? null : data, pending: pending && incomplete, isEnglish });
        }
        // A neutral JSON object is ambiguous until complete. Buffer it rather
        // than flashing chart internals or prematurely calling it a chart.
        // Closed ordinary JSON still follows the normal code path below.
        if (pending && incomplete && (source.trimStart().startsWith("{") || (language === "json" && !source.trim()))) return null;
      }
    }
    return createElement("pre", null, children);
  },
  code: ({ children, className }) => createElement("code", { className }, children),
};

const markdownOptions = {
  skipHtml: true,
  disallowedElements: ["img", "iframe", "video", "audio", "script", "style", "input", "button", "form"],
  components,
  plugins: { math, cjk },
  controls: false,
  linkSafety: { enabled: false },
  parseIncompleteMarkdown: true,
} satisfies Partial<StreamdownProps>;

/** Shared by the real answer view and server-rendering security/stream tests. */
export function AnswerMarkdown({ text, pending = false, isEnglish = false }: { text: string; pending?: boolean; isEnglish?: boolean }) {
  // Remend can complete **word, but a delta containing only ** has no word to
  // attach to yet. Hold that empty delimiter for the next token (never save it).
  let visible = text;
  if (pending && Lexer.lex(text).at(-1)?.type !== "code") {
    visible = text.replace(/(?:\*{1,3}|_{1,3})$/, "").replace(/(^|\s)(?:`{1,2}|#{1,6})$/, "$1");
  }
  if (pending && /^\s*\|/m.test(visible)) {
    // GFM cannot identify a table until its separator row arrives. Hold only
    // that undecided paragraph; the same parser leaves fenced code untouched.
    const tokens = Lexer.lex(visible);
    let offset = 0;
    for (const token of tokens) {
      if (token.type === "paragraph" && /^\s*\|/.test(token.raw)) {
        visible = visible.slice(0, offset);
        break;
      }
      offset += token.raw.length;
    }
  }
  return createElement(AnswerPresentation.Provider, { value: { pending, isEnglish } },
    createElement(Streamdown, { ...markdownOptions, isAnimating: pending, className: "answer-markdown" }, visible));
}
