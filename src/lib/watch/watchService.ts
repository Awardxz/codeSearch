import type { FileKind } from "../../types";
import { indexStore } from "../indexing/indexStore";
import { isSupported } from "../extractors/registry";

/**
 * Filesystem watch service: continuous index sync for watched roots.
 *
 * The Rust side (`watch_start`) reports raw create/modify/remove events and
 * this service decides what they mean. The OS is chatty — one save is several
 * modify events — so events coalesce per path over a short window before
 * anything is re-indexed. Removes win over modifies for the same path.
 *
 * Scope, stated plainly:
 * - Only files the single-file pipeline can embed are auto-indexed (the text
 *   and code formats in the extractor registry). Media and planned formats
 *   need a full rescan, because only the bulk pipeline embeds them.
 * - Removes apply to anything in the index, whatever its kind.
 * - Pruned directories (`node_modules`, `.git`, …) and hidden files are
 *   ignored, mirroring the Rust scanner's rules.
 *
 * Everything Tauri is guarded: outside the desktop runtime the service stays
 * off and the app behaves exactly as before.
 */

export type WatchEventKind = "create" | "modify" | "remove" | "other";

export type WatchState = {
  watching: boolean;
  roots: string[];
  /** Coalesced changes waiting for the flush timer. */
  pending: number;
};

const ROOTS_STORAGE_KEY = "code-search:watched-roots";

/** Coalescing window: one save arrives as several modify events. */
const FLUSH_DELAY_MS = 1500;
/** Re-check delay while an indexing run is in flight. */
const BUSY_RETRY_MS = 5000;
const MAX_BUSY_RETRIES = 12;
/** Pending paths cap: beyond it a full refresh is cheaper and safer. */
const MAX_PENDING = 500;

/**
 * Directory names the Rust scanner never walks into (scanner.rs
 * `SKIPPED_DIRECTORIES`), lowercased — pruning is case-insensitive.
 */
const PRUNED_DIR_NAMES: ReadonlySet<string> = new Set(
  [
    ".git", ".hg", ".svn", ".bzr", "_darcs",
    "node_modules", "bower_components", "jspm_packages", "vendor", "target",
    "build", "dist", "out", "debug", "release", "obj", ".gradle", ".m2",
    ".nuget", ".cargo", ".rustup", ".npm", ".yarn", ".pnpm-store",
    "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".next", ".nuxt", ".svelte-kit", ".parcel-cache", ".turbo",
    ".idea", ".vscode", ".vs", ".settings", ".fleet", ".cache",
    "appdata", "application data", "library", "$recycle.bin",
    "system volume information", "windows", "programdata", "program files",
    "program files (x86)", "programs", "recovery", "perflogs", ".trash",
    ".trash-1000", "lost+found",
  ].map((name) => name.toLowerCase()),
);

/** Kinds the single-file pipeline (`indexPaths`) can embed. */
const REINDEXABLE_KINDS: ReadonlySet<FileKind> = new Set([
  "text",
  "code",
  "markdown",
  "data",
  "document",
]);

/** Normalize for comparing event paths with stored index paths. */
export function normalizeWatchPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * True when a create/modify event deserves action. Removes are handled
 * separately — anything in the index can leave it, whatever its kind.
 */
export function isWatchablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((part) => part.length > 0);
  if (segments.length === 0) return false;

  const base = segments[segments.length - 1];
  // Hidden files are skipped by the scanner; files inside hidden *directories*
  // are kept, so only the basename is tested.
  if (base.startsWith(".")) return false;
  if (segments.slice(0, -1).some((part) => PRUNED_DIR_NAMES.has(part.toLowerCase()))) {
    return false;
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return isSupported(base);
}

type PendingKind = "modify" | "remove";

type PendingEntry = {
  /** Original event path, casing intact — what the store opens and displays. */
  original: string;
  action: PendingKind;
};

let state: WatchState = { watching: false, roots: loadRoots(), pending: 0 };
const listeners = new Set<() => void>();
/** Keyed by normalized path for matching; values keep the original path. */
const pending = new Map<string, PendingEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let busyRetries = 0;
let needsRescan = false;
let listenAttached = false;

function loadRoots(): string[] {
  try {
    const raw = localStorage.getItem(ROOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function storeRoots(roots: string[]) {
  try {
    localStorage.setItem(ROOTS_STORAGE_KEY, JSON.stringify(roots));
  } catch {
    // Ignore: watching still works for this session.
  }
}

function emit() {
  state = { ...state, pending: pending.size };
  for (const listener of [...listeners]) listener();
}

async function ensureListener(): Promise<void> {
  if (listenAttached) return;
  listenAttached = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ kind: WatchEventKind; paths: string[] }>(
      "index://fs-changed",
      (event) => {
        if (!state.watching) return;
        ingest(event.payload.kind, event.payload.paths ?? []);
      },
    );
  } catch {
    // Not in the Tauri runtime: no events will ever arrive.
  }
}

function ingest(kind: WatchEventKind, paths: string[]) {
  if (kind !== "create" && kind !== "modify" && kind !== "remove") return;

  for (const path of paths) {
    const key = normalizeWatchPath(path);
    if (kind === "remove") {
      pending.set(key, { original: path, action: "remove" });
    } else if (isWatchablePath(path)) {
      // A remove already queued for this path wins.
      if (!pending.has(key)) pending.set(key, { original: path, action: "modify" });
    }
    if (pending.size > MAX_PENDING) {
      pending.clear();
      needsRescan = true;
      break;
    }
  }

  emit();
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }
}

async function flush(): Promise<void> {
  if (pending.size === 0 && !needsRescan) return;

  if (indexStore.isRunning() || indexStore.isBulkRunning()) {
    if (busyRetries < MAX_BUSY_RETRIES) {
      busyRetries++;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, BUSY_RETRY_MS);
      return;
    }
    // An indexing run has held the store for a minute: drop the backlog
    // rather than growing it without bound. The next scan catches up.
    pending.clear();
    needsRescan = false;
    busyRetries = 0;
    emit();
    return;
  }
  busyRetries = 0;

  // Snapshot the backlog so events arriving mid-flush queue for the next one.
  const batch: [string, PendingEntry][] = [...pending.entries()];
  pending.clear();

  const byPath = new Map(
    indexStore.getSnapshot().files.map((file) => [normalizeWatchPath(file.path), file]),
  );

  const toReindex: string[] = [];
  const toAdd: string[] = [];
  for (const [key, entry] of batch) {
    const indexed = byPath.get(key);
    if (entry.action === "remove") {
      if (indexed) indexStore.removeFile(indexed.path);
      continue;
    }
    if (indexed) {
      // Only re-embed what the single-file pipeline can read. Anything else
      // (media, planned formats) keeps its vectors until a full rescan.
      if (REINDEXABLE_KINDS.has(indexed.kind)) toReindex.push(indexed.path);
      continue;
    }
    // A new file under a watched root the pipeline can read.
    toAdd.push(entry.original);
  }

  // Index sequentially through the existing entry points so progress,
  // cancellation and persistence behave exactly like a manual run.
  for (const path of toReindex) {
    await indexStore.reindexFile(path);
  }
  for (const path of toAdd) {
    await indexStore.indexPaths([path]);
  }

  if (needsRescan) {
    needsRescan = false;
    await indexStore.refresh();
  }
  emit();
}

export const watchStore = {
  getSnapshot: (): WatchState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Roots remembered across sessions (user-chosen folders only). */
export function getStoredRoots(): string[] {
  return [...state.roots];
}

/** Start (or re-target) watching. Returns the roots actually watched. Outside
 *  the Tauri runtime there is nothing to watch, so this resolves to []. */
export async function startWatching(roots: string[]): Promise<string[]> {
  await ensureListener();
  let watched: string[] = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    watched = await invoke<string[]>("watch_start", { paths: roots });
  } catch {
    return [];
  }
  const merged = [...new Set([...state.roots, ...watched])];
  state = { ...state, watching: true, roots: merged };
  storeRoots(merged);
  emit();
  return watched;
}

/** Pause watching, keeping the roots so resume needs no dialog. */
export async function stopWatching(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("watch_stop", {});
  } catch {
    // Backend already gone or not Tauri: state still updates.
  }
  state = { ...state, watching: false };
  emit();
}
