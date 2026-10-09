import type { TextChunk } from "../../types";

/**
 * Boundary-aware text chunker.
 *
 * Splits on blank-line paragraph boundaries first (aggregating small
 * paragraphs), then falls back to sentence and finally hard character
 * boundaries. Chunks overlap by whole lines so that no sentence is lost
 * across a cut, and every chunk records its 1-based source line range so
 * results can point back to a location in the file.
 *
 * The default size is tuned for the embedding model's 8,192-token context:
 * 1,600 characters is roughly 400-550 tokens for prose and code.
 */
export type ChunkerOptions = {
  maxChars?: number;
  overlapChars?: number;
};

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_OVERLAP_CHARS = 220;

export function chunkText(
  input: string,
  options: ChunkerOptions = {},
): TextChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  if (overlapChars >= maxChars) {
    throw new Error("Chunk overlap must be smaller than the chunk size.");
  }

  const text = input;
  if (!text) return [];

  const lineStarts = computeLineStarts(text);

  const chunks: TextChunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + maxChars, text.length);

    if (end < text.length) {
      end = findBoundary(text, cursor, end, maxChars);
    }

    const raw = text.slice(cursor, end);
    const trimmed = raw.trim();

    if (trimmed) {
      const lineStart = lineIndexFor(lineStarts, cursor) + 1;
      const lineEnd = lineIndexFor(lineStarts, Math.max(cursor, end - 1)) + 1;
      chunks.push({
        index: chunks.length,
        text: trimmed,
        lineStart,
        lineEnd,
      });
    }

    if (end >= text.length) break;

    // Move the cursor back by the overlap, but always make progress.
    const nextCursor = Math.max(end - overlapChars, cursor + 1);
    cursor = alignToLineStart(text, nextCursor);
  }

  return chunks;
}

/**
 * Prefer cutting at the last paragraph break, then sentence end, then any
 * whitespace, within the window [cursor + 65% of maxChars, end].
 */
function findBoundary(
  text: string,
  cursor: number,
  end: number,
  maxChars: number,
): number {
  const minimum = cursor + Math.floor(maxChars * 0.65);

  const paragraph = text.lastIndexOf("\n\n", end);
  const sentence = Math.max(
    text.lastIndexOf(". ", end),
    text.lastIndexOf(".\n", end),
    text.lastIndexOf("。", end),
  );
  const space = text.lastIndexOf(" ", end);
  const newline = text.lastIndexOf("\n", end);

  for (const candidate of [paragraph + 2, sentence + 1, newline + 1, space]) {
    if (candidate > minimum && candidate <= end) {
      return candidate;
    }
  }

  // Hard cut inside a long token (minified code, long URLs).
  return end;
}

/** Snap an overlap cursor forward to the start of the next line so chunks never begin mid-line. */
function alignToLineStart(text: string, position: number): number {
  if (position <= 0) return 0;
  const newline = text.indexOf("\n", position - 1);
  if (newline === -1) return position;
  return newline + 1;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Binary search for the line index containing a character offset. */
function lineIndexFor(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
