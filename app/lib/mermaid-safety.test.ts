import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNoteDiagram } from "./mermaid-safety.ts";

test("preserves plain flowcharts and mindmaps as inert quoted syntax", () => {
  for (const source of [
    'flowchart TD\nA["수요 증가"] --> B["가격 상승"]\nB -->|"다음"| C(("균형"))',
    'flowchart TD\nA{조건} -.-> B(결과);',
    'mindmap\n  root(("회귀 분석"))\n    학습\n      손실 함수\n    예측',
  ]) {
    const safe = safeNoteDiagram(source);
    assert.ok(safe, source);
    assert.equal(safeNoteDiagram(safe), safe, "canonical source must remain accepted at browser boundary");
  }
});

test("rejects network, configuration, styling and parser escape extensions before render", () => {
  for (const source of [
    'flowchart TD\nA@{ img: "https://diagram-audit.invalid/pixel.svg", label: "Image" }',
    'flowchart TD\nA@{ shape: image, img: "//diagram-audit.invalid/pixel.svg" }',
    'flowchart TD\n%%{init: {securityLevel: "loose"}}%%\nA --> B',
    '---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA --> B',
    'flowchart TD\nA["<img src=https://diagram-audit.invalid/a>"]',
    'flowchart TD\nA["&lt;img src=https://diagram-audit.invalid/a&gt;"]',
    'flowchart TD\nA["#60;img src=x#62;"]',
    'flowchart TD\nA["\\x3cimg src=x\\x3e"]',
    'flowchart TD\nA@\n{ img: "https://diagram-audit.invalid/a" }',
    'flowchart TD\nA@{ img: "ht" + "tps://diagram-audit.invalid/a" }',
    'flowchart TD\nA["https://diagram-audit.invalid/a"]',
    'flowchart TD\nA --> B\nclick A "https://diagram-audit.invalid/"',
    'flowchart TD\nA --> B\nstyle A fill:url(https://diagram-audit.invalid/a)',
    'flowchart TD\nA --> B\nclassDef image fill:red',
    'flowchart TD\nA["Safe"]:::external',
    'mindmap\n  Root\n    ::icon(fa fa-book)',
    'mindmap\n  Root\n    Child\n    :::external',
    'mindmap\n  Root\n    <iframe src="https://diagram-audit.invalid/a">',
    'flowchart TD\nA["data:image/svg+xml,test"]',
    'flowchart TD\nA["java\u200bscript:test"]',
  ]) assert.equal(safeNoteDiagram(source), null, source);
});

test("bounds diagrams and rejects malformed structures", () => {
  for (const source of ['', 'sequenceDiagram\nA->>B:hello', 'flowchart TD', 'flowchart TD\nA[missing', 'mindmap\nRoot\nSecondRoot', `flowchart TD\nA["${'a'.repeat(201)}"]`, `flowchart TD\n${'A --> B\n'.repeat(121)}`, 'flowchart TD\nA["x"]\u0000']) {
    assert.equal(safeNoteDiagram(source), null);
  }
});
