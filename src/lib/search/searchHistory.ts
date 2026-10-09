/**
 * Recent search history, session-scoped in storage but restored across runs.
 *
 * The Search screen's empty state shows recent searches, which means the app
 * has to actually record them. Entries are the query text plus the number of
 * files it returned and when it ran, so the list is informative rather than a
 * decoration duplicate of the input field.
 */

export type SearchHistoryEntry = {
  query: string;
  matches: number;
  ranAt: number;
};

const STORAGE_KEY = "code-search:search-history";
const MAX_ENTRIES = 12;

let entries: SearchHistoryEntry[] = load();
const listeners = new Set<() => void>();

function load(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is SearchHistoryEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as SearchHistoryEntry).query === "string",
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore: history degrades to session-only.
  }
}

function emit() {
  for (const listener of [...listeners]) listener();
}

export const searchHistoryStore = {
  getSnapshot: (): SearchHistoryEntry[] => entries,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Record a completed search, moving an identical query back to the top. */
  record(query: string, matches: number) {
    const trimmed = query.trim();
    if (!trimmed) return;
    entries = [
      { query: trimmed, matches, ranAt: Date.now() },
      ...entries.filter(
        (entry) => entry.query.toLowerCase() !== trimmed.toLowerCase(),
      ),
    ].slice(0, MAX_ENTRIES);
    persist();
    emit();
  },

  clear() {
    entries = [];
    persist();
    emit();
  },
};

/** "12m ago" / "3h ago" / "6d ago" — the design's recent-search timestamp. */
export function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
