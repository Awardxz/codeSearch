/** Small formatting helpers shared across screens. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Cosine similarity display. Embeddings are L2-normalized so the raw dot
 * product is already cosine similarity in [-1, 1]. This is NOT a percentage
 * match; it is shown as a raw similarity score.
 */
export function formatScore(score: number): string {
  return score.toFixed(3);
}

/** Reduce a path for display, keeping the file name visible. */
export function shortenPath(path: string, maxChars = 64): string {
  if (path.length <= maxChars) return path;
  const tail = path.slice(-(maxChars - 1));
  const cut = tail.indexOf("\\") >= 0 ? tail.indexOf("\\") : tail.indexOf("/");
  return "…" + (cut >= 0 ? tail.slice(cut) : tail);
}

/**
 * Compact count for dense readouts: 18412 -> "18.4k", 1428 -> "1,428".
 * Matches the design system's telemetry numerals, which stay tabular and small.
 */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}m`;
}

/**
 * The workspace root: the deepest directory every indexed file lives under.
 * Returns null when the files span unrelated roots, which the shell renders as
 * "no workspace" rather than forcing a misleading shared path.
 */
export function commonRootOf(paths: string[]): string | null {
  if (paths.length === 0) return null;

  const split = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    return slash > 0 ? normalized.slice(0, slash) : "";
  };

  let shared = split(paths[0]).split("/");
  for (const path of paths.slice(1)) {
    const segments = split(path).split("/");
    let index = 0;
    while (
      index < shared.length &&
      index < segments.length &&
      shared[index].toLowerCase() === segments[index].toLowerCase()
    ) {
      index++;
    }
    shared = shared.slice(0, index);
    if (shared.length === 0) return null;
  }
  return shared.join("/") || null;
}

