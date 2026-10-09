/**
 * BM25 lexical index over chunk texts (the "lexical" half of hybrid search).
 *
 * Dense vectors miss exact symbols (`refreshTokenWithRetry` scores no higher
 * than any vaguely auth-shaped prose), so the hybrid strategy blends cosine
 * similarity with classic BM25 term matching. This module is the entire
 * lexical side: a code-aware tokenizer, an incrementally updated inverted
 * index, and max-normalized scoring for fusion.
 *
 * Pure TypeScript with no dependencies, so the ranking behavior is fully
 * covered by `scripts/verify-hybrid.mjs`. The index is maintained by
 * `indexStore` alongside the vectors: every mutation that changes what is
 * indexed syncs the affected file here.
 */

/** BM25 constants. Standard values; retrieval is not sensitive to them. */
const K1 = 1.2;
const B = 0.75;

/** Key separator. NUL cannot appear in a filesystem path, so keys can never
 *  collide. Built with fromCharCode so no literal NUL byte lives in source. */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Code-aware tokenizer. Splits on non-alphanumerics, then on camelCase,
 * PascalCase and letter/digit boundaries, and lowercases — so
 * `refreshTokenWithRetry` matches queries containing "refresh", "token" or
 * "retry" as well as the full symbol. Single letters are noise in code
 * (`x`, `e`); pure numbers (versions, ports, status codes) are kept.
 */
export function tokenizeCode(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    const parts = token.split(
      /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/,
    );
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length < 2 && !/^[0-9]+$/.test(lower)) continue;
      out.push(lower);
    }
  }
  return out;
}

type DocStat = {
  /** Token count after tokenization (BM25 length normalization). */
  length: number;
  /** Term frequencies within this chunk. */
  terms: Map<string, number>;
};

/** Chunk identity for fusion: position within its file's chunk array. */
export function bm25KeyFor(path: string, chunkPosition: number): string {
  return path + KEY_SEPARATOR + String(chunkPosition);
}

export class Bm25Index {
  private docs = new Map<string, DocStat>();
  private docFreq = new Map<string, number>();
  private totalLength = 0;
  private files = new Map<string, Set<string>>();

  get size(): number {
    return this.docs.size;
  }

  /** Replace every chunk record for a file (re-index-safe by construction). */
  syncFile(path: string, chunks: { text: string }[]): void {
    this.removeFile(path);
    const keys = new Set<string>();
    for (let position = 0; position < chunks.length; position++) {
      const key = bm25KeyFor(path, position);
      const tokens = tokenizeCode(chunks[position].text);
      const terms = new Map<string, number>();
      for (const token of tokens) {
        terms.set(token, (terms.get(token) ?? 0) + 1);
      }
      this.docs.set(key, { length: tokens.length, terms });
      for (const term of terms.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
      this.totalLength += tokens.length;
      keys.add(key);
    }
    this.files.set(path, keys);
  }

  removeFile(path: string): void {
    const keys = this.files.get(path);
    if (!keys) return;
    for (const key of keys) {
      const stat = this.docs.get(key);
      if (!stat) continue;
      this.docs.delete(key);
      this.totalLength -= stat.length;
      for (const term of stat.terms.keys()) {
        const remaining = (this.docFreq.get(term) ?? 1) - 1;
        if (remaining <= 0) this.docFreq.delete(term);
        else this.docFreq.set(term, remaining);
      }
    }
    this.files.delete(path);
  }

  clear(): void {
    this.docs.clear();
    this.docFreq.clear();
    this.files.clear();
    this.totalLength = 0;
  }

  /**
   * Score every chunk against the query. Returned scores are max-normalized
   * to [0, 1] so fusion with cosine similarity (also roughly [0, 1]) needs
   * no further calibration. Empty when the query has no indexable terms.
   */
  score(query: string): Map<string, number> {
    const count = this.docs.size;
    if (count === 0) return new Map();
    const terms = tokenizeCode(query);
    if (terms.length === 0) return new Map();

    const avgdl = this.totalLength / count;
    const raw = new Map<string, number>();
    for (const term of new Set(terms)) {
      const df = this.docFreq.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      for (const [key, stat] of this.docs) {
        const tf = stat.terms.get(term);
        if (!tf) continue;
        const denom = tf + K1 * (1 - B + (B * stat.length) / avgdl);
        raw.set(key, (raw.get(key) ?? 0) + (idf * (tf * (K1 + 1))) / denom);
      }
    }

    let max = 0;
    for (const value of raw.values()) {
      if (value > max) max = value;
    }
    if (max <= 0) return new Map();
    for (const [key, value] of raw) {
      raw.set(key, value / max);
    }
    return raw;
  }
}

/** The live lexical index, maintained by `indexStore`. */
export const bm25Index = new Bm25Index();
