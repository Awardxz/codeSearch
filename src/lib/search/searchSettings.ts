/**
 * Search settings: the retrieval controls the Settings screen exposes.
 *
 * A tiny external store (the same shape as previewStore) so the search screen
 * and the settings screen share one source of truth without prop drilling or a
 * re-render of the whole shell. Values persist to localStorage because they are
 * user preference, not derived state — the app must survive a restart with the
 * same retrieval behaviour.
 */

import type { SearchStrategy } from "../../types";

export type SearchSettings = {
  /** Maximum number of files returned per search. */
  limit: number;
  /**
   * Cosine similarity cutoff. Matches below it are discarded, which is what
   * keeps a long-tail index from surfacing unrelated files.
   */
  minScore: number;
  /** Retrieval strategy: pure vectors, or vectors fused with BM25. */
  strategy: SearchStrategy;
};

export const LIMIT_CHOICES = [10, 25, 50] as const;

export const MIN_SCORE_RANGE = { min: 0, max: 0.95, step: 0.01 } as const;

const DEFAULTS: SearchSettings = {
  limit: 25,
  minScore: 0.2,
  strategy: "vector",
};

const STORAGE_KEY = "code-search:search-settings";

function read(): SearchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SearchSettings>;
    return {
      limit: LIMIT_CHOICES.includes(parsed.limit as 10 | 25 | 50)
        ? (parsed.limit as number)
        : DEFAULTS.limit,
      minScore:
        typeof parsed.minScore === "number" &&
        parsed.minScore >= MIN_SCORE_RANGE.min &&
        parsed.minScore <= MIN_SCORE_RANGE.max
          ? parsed.minScore
          : DEFAULTS.minScore,
      strategy: parsed.strategy === "hybrid" ? "hybrid" : DEFAULTS.strategy,
    };
  } catch {
    return DEFAULTS;
  }
}

let state: SearchSettings = read();
const listeners = new Set<() => void>();

function commit(next: SearchSettings) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a disabled store: settings stay in memory for this run.
  }
  for (const listener of [...listeners]) listener();
}

export const searchSettingsStore = {
  getSnapshot: (): SearchSettings => state,
  getServerSnapshot: (): SearchSettings => ({ ...DEFAULTS }),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setLimit(limit: number) {
    commit({ ...state, limit });
  },
  setMinScore(minScore: number) {
    commit({ ...state, minScore });
  },
  setStrategy(strategy: SearchStrategy) {
    commit({ ...state, strategy });
  },
};
