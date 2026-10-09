/**
 * Minimal code presentation layer.
 *
 * The Stitch result cards show a syntax-tinted code block, so the match reads
 * like the file it came from rather than like prose. This is deliberately not a
 * parser — it tints the three token classes the design distinguishes (strings,
 * numbers, keywords) and leaves everything else as plain body text, so nothing
 * is ever visually misrepresented.
 */

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "def", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "final", "finally", "fn", "for", "from", "function", "go",
  "if", "impl", "import", "in", "instanceof", "interface", "let", "match", "mut",
  "new", "None", "null", "override", "private", "protected", "public", "pub",
  "raise", "return", "self", "static", "struct", "super", "switch", "this",
  "throw", "trait", "true", "try", "type", "typeof", "undefined", "use", "var",
  "void", "where", "while", "with", "yield",
]);

type Token = { text: string; role: "plain" | "keyword" | "string" | "number" | "comment" };

const TOKEN_PATTERN = new RegExp(
  [
    "(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)", // comments
    "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)", // strings
    "(\\b\\d+(?:\\.\\d+)*\\b)", // numbers
    "([A-Za-z_$][\\w$]*)", // words
  ].join("|"),
  "g",
);

/** Split one line into tinted tokens. Never throws; falls back to plain text. */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ text: line.slice(cursor, index), role: "plain" });
    }

    const [text, comment, string, number, word] = match;
    if (comment !== undefined) tokens.push({ text, role: "comment" });
    else if (string !== undefined) tokens.push({ text, role: "string" });
    else if (number !== undefined) tokens.push({ text, role: "number" });
    else if (KEYWORDS.has(word)) tokens.push({ text, role: "keyword" });
    else tokens.push({ text, role: "plain" });

    cursor = index + text.length;
  }

  if (cursor < line.length) {
    tokens.push({ text: line.slice(cursor), role: "plain" });
  }
  return tokens.length > 0 ? tokens : [{ text: line, role: "plain" }];
}

/** Map a token role to the design system's code colours. */
export function tokenClassName(role: Token["role"]): string {
  switch (role) {
    case "keyword":
      return "text-secondary";
    case "string":
      return "text-[#9cd900]";
    case "number":
      return "text-tertiary-fixed-dim";
    case "comment":
      return "text-on-surface-variant/60";
    default:
      return "";
  }
}
