import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EmbeddingStatus, IndexingProgress, IndexedFile } from "../types";
import { embeddingClient } from "../lib/embeddings/embeddingClient";
import { indexStore, type IndexSnapshot } from "../lib/indexing/indexStore";
import {
  restorePersistedIndex,
  type RestoreResult,
} from "../lib/indexing/indexPersist";
import { getStoredRoots, startWatching } from "../lib/watch/watchService";
import type { BulkProgress } from "../lib/indexing/bulkPlanner";

/**
 * Single React context wiring the two module-level services (embedding
 * worker client and index store) into component state via
 * useSyncExternalStore. Services live outside React so they survive
 * re-mounts and screen switches.
 */

type AppServices = {
  embeddingStatus: EmbeddingStatus;
  index: IndexSnapshot;
  files: IndexedFile[];
  progress: IndexingProgress;
  bulk: BulkProgress;
  bulkRunning: boolean;
  readyFileCount: number;
  /** Outcome of the persisted-snapshot restore that runs once at launch. */
  indexRestore: IndexRestoreStatus;
  ensureModelLoaded: () => void;
  reinitializeModel: () => void;
};

export type IndexRestoreStatus = {
  phase: "idle" | "restoring" | "ready" | "empty" | "discarded";
  /** Files brought back from disk (0 unless phase is "ready"). */
  files: number;
  /** Why a snapshot was discarded, for the Settings readout. */
  reason: string | null;
};

const AppServicesContext = createContext<AppServices | null>(null);

function useEmbeddingStatus(): EmbeddingStatus {
  return useSyncExternalStore(
    (listener) => embeddingClient.subscribe(listener),
    embeddingClient.getStatus,
    embeddingClient.getStatus,
  );
}

function useIndexSnapshot(): IndexSnapshot {
  return useSyncExternalStore(
    indexStore.subscribe,
    indexStore.getSnapshot,
    indexStore.getSnapshot,
  );
}

export function AppServicesProvider({ children }: { children: ReactNode }) {
  const embeddingStatus = useEmbeddingStatus();
  const index = useIndexSnapshot();
  const [indexRestore, setIndexRestore] = useState<IndexRestoreStatus>({
    phase: "idle",
    files: 0,
    reason: null,
  });

  useEffect(() => {
    // Warm the model on first mount so search is instant later. Failure is
    // surfaced through the status, not thrown.
    void embeddingClient.ensureLoaded().catch(() => undefined);

    // Bring back the persisted snapshot (no model needed — the vectors are
    // already embedded). Runs once; later mutations persist incrementally.
    setIndexRestore({ phase: "restoring", files: 0, reason: null });
    void restorePersistedIndex((files) =>
      indexStore.addIndexedFiles(files, { persist: false }),
    )
      .then((result: RestoreResult) => {
        if (result.status === "ready") {
          setIndexRestore({ phase: "ready", files: result.files, reason: null });
          // Re-arm the watcher on folders the user chose in a previous
          // session. Watching is passive; the restored index makes it
          // meaningful immediately.
          const roots = getStoredRoots();
          if (roots.length > 0) void startWatching(roots);
        } else if (result.status === "discarded") {
          setIndexRestore({ phase: "discarded", files: 0, reason: result.reason });
        } else {
          setIndexRestore({ phase: "empty", files: 0, reason: null });
        }
      })
      .catch(() => {
        setIndexRestore({ phase: "empty", files: 0, reason: null });
      });
  }, []);

  const value = useMemo<AppServices>(() => {
    const readyFileCount = index.files.filter((f) => f.status === "ready").length;
    return {
      embeddingStatus,
      index,
      files: index.files,
      progress: index.progress,
      bulk: index.bulk,
      bulkRunning: indexStore.isBulkRunning(),
      readyFileCount,
      indexRestore,
      ensureModelLoaded: () => {
        void embeddingClient.ensureLoaded().catch(() => undefined);
      },
      reinitializeModel: () => {
        embeddingClient.reinitialize();
        void embeddingClient.ensureLoaded().catch(() => undefined);
      },
    };
  }, [embeddingStatus, index, indexRestore]);

  return (
    <AppServicesContext.Provider value={value}>
      {children}
    </AppServicesContext.Provider>
  );
}

export function useAppServices(): AppServices {
  const context = useContext(AppServicesContext);
  if (!context) {
    throw new Error("useAppServices must be used inside AppServicesProvider.");
  }
  return context;
}
