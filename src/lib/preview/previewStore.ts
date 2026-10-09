import type { FileKind } from "../../types";

/**
 * Preview panel state. A tiny external store (not React state) so any screen
 * can open the preview, and so it can be rendered above the whole shell.
 *
 * NOTE: the readers are plain closures over `state` rather than methods of a
 * class — `useSyncExternalStore` calls getSnapshot with no receiver, so a
 * `this`-dependent method would lose it.
 */

export type PreviewRequest = {
  path: string;
  name: string;
  kind: FileKind;
  /** The search query, used to rank this file's chunks inside the preview. */
  query: string | null;
  /** Chunk to jump to initially (the one that produced the search hit). */
  initialChunkIndex: number | null;
};

export type PreviewState = {
  request: PreviewRequest | null;
};

const EMPTY: PreviewState = { request: null };

let state: PreviewState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

export const previewStore = {
  getSnapshot: (): PreviewState => state,

  getServerSnapshot: (): PreviewState => EMPTY,

  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  open(request: PreviewRequest) {
    // Reset before setting the new request so the panel reloads even when the
    // same path is opened twice in a row.
    state = EMPTY;
    emit();
    state = { request };
    emit();
  },

  close() {
    if (state.request === null) return;
    state = EMPTY;
    emit();
  },
};
