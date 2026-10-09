/**
 * Safe text normalization applied after extraction and before chunking.
 *
 * Goals: make extracted text comparable and embeddable without destroying
 * information. We never collapse newlines entirely because paragraph
 * boundaries drive chunking, and we remove only obvious noise.
 *
 * IMPORTANT: every transformation below must be LINE-PRESERVING. The number of
 * newlines in the output has to equal the number in the input, because the
 * chunker derives each chunk's 1-based `lineStart` / `lineEnd` from the line
 * numbering of this text and the preview panel uses those ranges to highlight
 * lines in the original file. Deduplicating blank lines or trimming the ends
 * would shift every subsequent line number by however many lines were removed,
 * and the preview would silently highlight the wrong place.
 */
export function normalizeText(input: string): string {
  return (
    input
      // Normalize line endings (one newline in, one newline out).
      .replace(/\r\n?/g, "\n")
      // Remove BOM and zero-width characters.
      .replace(/^\uFEFF/, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      // Normalize NBSP and other unusual spaces to plain spaces.
      .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      // Collapse runs of horizontal whitespace.
      .replace(/[ \t]+/g, " ")
      // Trim trailing spaces on each line.
      .replace(/[ \t]+(?=\n)/g, "")
      // NOTE: deliberately NOT collapsing blank-line runs and NOT trimming the
      // whole string — both would remove lines and shift line numbers.
  );
}
