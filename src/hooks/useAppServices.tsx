import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EmbeddingStatus, IndexingProgress, IndexedFile } from "../types";
import { embeddingClient } from "../lib/embeddings/embeddingClient";
import { indexStore, type IndexSnapshot } from "../lib/indexing/indexStore";
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
  ensureModelLoaded: () => void;
  reinitializeModel: () => void;
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

  useEffect(() => {
    // Warm the model on first mount so search is instant later. Failure is
    // surfaced through the status, not thrown.
    void embeddingClient.ensureLoaded().catch(() => undefined);
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
      ensureModelLoaded: () => {
        void embeddingClient.ensureLoaded().catch(() => undefined);
      },
      reinitializeModel: () => {
        embeddingClient.reinitialize();
        void embeddingClient.ensureLoaded().catch(() => undefined);
      },
    };
  }, [embeddingStatus, index]);

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
