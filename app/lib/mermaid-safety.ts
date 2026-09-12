/**
 * Mermaid's strict mode still fetches image nodes while laying out the diagram.
 * Parse a deliberately small, inert subset before importing/rendering Mermaid.
 * Never add arbitrary Mermaid config, HTML, styling, links, or resource nodes here.
 */
export function safeNoteDiagram(source: string): string | null {
  if (typeof source !== "string" || source.length > 8_000) return null;
  if (/[\\%`&@\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u.test(source)) return null;
  const lines = source.trim().replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 120) return null;
  const kind = lines.shift()?.trim();
  if (kind !== "flowchart TD" && kind !== "mindmap") return null;
  const label = (value: string): string | null => {
    const cleaned = value.trim().replace(/^"([^"\n]*)"$/, "$1");
    if (!cleaned || cleaned.length > 200 || /["<>\[\]{}|;]/u.test(cleaned) || /(?:[a-z][a-z0-9+.-]*:\/|\/\/|\b(?:data|javascript|vbscript):)/iu.test(cleaned)) return null;
    return `"${cleaned}"`;
  };
  const shapes = [["((", "))"], ["[[", "]]"], ["([", "])"], ["[", "]"], ["(", ")"], ["{", "}"]] as const;
  const reserved = /^(?:click|style|class|classDef|linkStyle|subgraph|end|direction|flowchart|mindmap|graph|accTitle|accDescr)$/i;
  const readNode = (statement: string): { node: string; rest: string } | null => {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,63})/.exec(statement);
    if (!match || reserved.test(match[1])) return null;
    let rest = statement.slice(match[0].length).trimStart();
    for (const [open, close] of shapes) {
      if (!rest.startsWith(open)) continue;
      const end = rest.indexOf(close, open.length);
      if (end < 0) return null;
      const text = label(rest.slice(open.length, end));
      if (!text) return null;
      return { node: `${match[1]}${open}${text}${close}`, rest: rest.slice(end + close.length).trimStart() };
    }
    return { node: match[1], rest };
  };
  const result: string[] = [kind];
  let rootIndent: number | undefined;
  const indents: number[] = [];
  for (const original of lines) {
    const statement = original.trim();
    if (!statement) continue;
    if (kind === "mindmap") {
      // Re-emit all bare labels as quoted nodes; directives cannot be interpreted.
      const indent = original.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0;
      if (rootIndent === undefined) rootIndent = indent;
      else if (indent <= rootIndent) return null;
      while (indents.length && indent <= indents[indents.length - 1]) indents.pop();
      indents.push(indent);
      let node: string;
      if (/^[A-Za-z][A-Za-z0-9_]*\s*[\[({]/.test(statement)) {
        const parsed = readNode(statement);
        if (!parsed || parsed.rest) return null;
        node = parsed.node;
      } else {
        const text = label(statement);
        if (!text || /[:()]/.test(statement)) return null;
        node = `note_node_${result.length}[${text}]`;
      }
      result.push(`${"  ".repeat(indents.length)}${node}`);
      continue;
    }
    const first = readNode(statement.replace(/;$/, ""));
    if (!first) return null;
    let output = first.node;
    let rest = first.rest;
    while (rest) {
      const arrow = /^(-->|---|-\.->|==>)\s*/.exec(rest);
      if (!arrow) return null;
      rest = rest.slice(arrow[0].length);
      let edgeLabel = "";
      if (rest.startsWith("|")) {
        const end = rest.indexOf("|", 1);
        const text = end > 0 ? label(rest.slice(1, end)) : null;
        if (!text) return null;
        edgeLabel = `|${text}|`;
        rest = rest.slice(end + 1).trimStart();
      }
      const next = readNode(rest);
      if (!next) return null;
      output += ` ${arrow[1]}${edgeLabel} ${next.node}`;
      rest = next.rest;
    }
    result.push(output);
  }
  return result.length > 1 ? result.join("\n") : null;
}
