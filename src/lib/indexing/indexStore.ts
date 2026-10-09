import type {
  ChunkRecord,
  IndexedFile,
  IndexingProgress,
} from "../../types";
import { embeddingClient } from "../embeddings/embeddingClient";
import { chunkText } from "../chunking/chunker";
import { normalizeText } from "../chunking/textNormalizer";
import { classifyFile, extensionOf } from "../extractors/registry";
import { extractTextFile, toAppErrorFromNative } from "./extractor";
import type { SampleDocument } from "./sampleDocuments";
import { EMPTY_BULK_PROGRESS, type BulkProgress } from "./bulkPlanner";

/**
 * In-memory index store and indexing pipeline (Phase 3).
 *
 * The index lives in application memory; persistence to SQLite arrives in
 * Phase 6. The store keeps a referentially-stable snapshot object so React
 * can subscribe with useSyncExternalStore.
 *
 * Indexing is incremental at the file level: files whose size and
 * modification time match the stored record are skipped on refresh.
 */

export type IndexSnapshot = {
  files: IndexedFile[];
  progress: IndexingProgress;
  bulk: BulkProgress;
};

type Listener = () => void;

function initialProgress(): IndexingProgress {
  return {
    phase: "idle",
    filesTotal: 0,
    filesDone: 0,
    chunksDone: 0,
    chunksTotal: 0,
    currentFile: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

class IndexStore {
  private files = new Map<string, IndexedFile>();
  private listeners = new Set<Listener>();
  private snapshot: IndexSnapshot = {
    files: [],
    progress: initialProgress(),
    bulk: EMPTY_BULK_PROGRESS,
  };

  private running = false;
  private cancelRequested = false;
  private bulkRunning = false;
  private bulkCancelRequested = false;

  getSnapshot = (): IndexSnapshot => {
    return this.snapshot;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    this.snapshot = {
      files: Array.from(this.files.values()),
      progress: { ...this.snapshot.progress },
      bulk: { ...this.snapshot.bulk },
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private updateFile(path: string, patch: Partial<IndexedFile>) {
    const existing = this.files.get(path);
    if (!existing) return;
    this.files.set(path, { ...existing, ...patch });
    this.emit();
  }

  private updateProgress(patch: Partial<IndexingProgress>) {
    this.snapshot = {
      ...this.snapshot,
      progress: { ...this.snapshot.progress, ...patch },
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getFile(path: string): IndexedFile | undefined {
    return this.files.get(path);
  }

  /** Index the given paths. Files already indexed and unchanged are skipped. */
  async indexPaths(paths: string[]): Promise<void> {
    if (this.running) return;
    if (paths.length === 0) return;

    this.running = true;
    this.cancelRequested = false;

    this.updateProgress({
      phase: "extracting",
      filesTotal: paths.length,
      filesDone: 0,
      chunksDone: 0,
      chunksTotal: 0,
      currentFile: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    });

    // Register placeholders so the UI can show queued files immediately.
    for (const path of paths) {
      if (!this.files.has(path)) {
        const name = fileNameOf(path);
        this.files.set(path, {
          path,
          name,
          extension: extensionOf(name),
          kind: classifyFile(name),
          sizeBytes: 0,
          modifiedMs: null,
          status: "queued",
          error: null,
          chunks: [],
          indexedAt: null,
          isSample: false,
        });
      }
    }
    this.emit();

    let cancelled = false;

    for (const path of paths) {
      if (this.cancelRequested) {
        cancelled = true;
        break;
      }

      try {
        this.updateFile(path, { status: "extracting" });
        this.updateProgress({ phase: "extracting", currentFile: path });

        const extracted = await extractTextFile(path);

        // Incremental skip: identical size + mtime and a ready status means
        // the content is presumed unchanged; do not re-embed.
        const existing = this.files.get(path);
        if (
          existing &&
          existing.status === "ready" &&
          existing.sizeBytes === extracted.sizeBytes &&
          existing.modifiedMs !== null &&
          existing.modifiedMs === extracted.modifiedMs
        ) {
          this.updateFile(path, {
            name: extracted.name,
            extension: extracted.extension,
            kind: extracted.kind,
            status: "ready",
            error: null,
          });
          this.updateProgress({ filesDone: this.snapshot.progress.filesDone + 1 });
          continue;
        }

        this.updateFile(path, {
          name: extracted.name,
          extension: extracted.extension,
          kind: extracted.kind,
          sizeBytes: extracted.sizeBytes,
          modifiedMs: extracted.modifiedMs,
          status: "embedding",
          error: null,
        });
        this.updateProgress({
          phase: "embedding",
          chunksTotal: this.snapshot.progress.chunksTotal + extracted.chunks.length,
        });

        const embeddings = await embeddingClient.embedDocuments(
          extracted.chunks.map((chunk) => chunk.text),
          extracted.chunks.map(() => fileNameWithoutExtension(extracted.name)),
          (chunksDone) => {
            this.updateProgress({
              chunksDone: this.snapshot.progress.chunksTotal - extracted.chunks.length + chunksDone,
            });
          },
        );

        const chunks: ChunkRecord[] = extracted.chunks.map((chunk, index) => ({
          fileIndex: chunk.index,
          text: chunk.text,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          embedding: embeddings[index],
        }));

        this.updateFile(path, {
          status: "ready",
          chunks,
          indexedAt: Date.now(),
        });
        this.updateProgress({ filesDone: this.snapshot.progress.filesDone + 1 });
      } catch (error) {
        const appError = toAppErrorFromNative(error);

        if (appError.code === "cancelled") {
          cancelled = true;
          this.updateFile(path, { status: "queued" });
          break;
        }

        this.updateFile(path, { status: "failed", error: appError, chunks: [] });
        this.updateProgress({ filesDone: this.snapshot.progress.filesDone + 1 });
      }
    }

    this.running = false;
    this.updateProgress({
      phase: cancelled ? "cancelled" : "completed",
      currentFile: null,
      finishedAt: Date.now(),
    });
  }

  /** Re-index everything currently in the store (unchanged files are skipped). */
  async refresh(): Promise<void> {
    if (this.running) return;
    await this.indexPaths(Array.from(this.files.keys()));
  }

  /**
   * Index the built-in sample corpus. Content is already in memory, so the
   * extraction step is skipped; chunking and embedding are identical to
   * regular files. Samples cannot be opened as real files.
   */
  async indexSampleDocuments(samples: SampleDocument[]): Promise<void> {
    if (this.running || samples.length === 0) return;

    this.running = true;
    this.cancelRequested = false;

    this.updateProgress({
      phase: "embedding",
      filesTotal: samples.length,
      filesDone: 0,
      chunksDone: 0,
      chunksTotal: 0,
      currentFile: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    });

    let cancelled = false;

    for (const sample of samples) {
      if (this.cancelRequested) {
        cancelled = true;
        break;
      }

      const path = `sample://${sample.fileName}`;

      try {
        const chunks = chunkText(normalizeText(sample.content));
        this.updateProgress({
          chunksTotal: this.snapshot.progress.chunksTotal + chunks.length,
        });

        const embeddings = await embeddingClient.embedDocuments(
          chunks.map((chunk) => chunk.text),
          chunks.map(() => sample.fileName.replace(/\.[^.]+$/, "")),
          (chunksDone) => {
            this.updateProgress({
              chunksDone:
                this.snapshot.progress.chunksTotal - chunks.length + chunksDone,
            });
          },
        );

        const records: ChunkRecord[] = chunks.map((chunk, index) => ({
          fileIndex: chunk.index,
          text: chunk.text,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          embedding: embeddings[index],
        }));

        this.files.set(path, {
          path,
          name: sample.fileName,
          extension: extensionOf(sample.fileName),
          kind: classifyFile(sample.fileName),
          sizeBytes: sample.content.length,
          modifiedMs: null,
          status: "ready",
          error: null,
          chunks: records,
          indexedAt: Date.now(),
          isSample: true,
        });
        this.emit();
        this.updateProgress({ filesDone: this.snapshot.progress.filesDone + 1 });
      } catch (error) {
        const appError = toAppErrorFromNative(error);
        if (appError.code === "cancelled") {
          cancelled = true;
          break;
        }
        this.files.set(path, {
          path,
          name: sample.fileName,
          extension: extensionOf(sample.fileName),
          kind: classifyFile(sample.fileName),
          sizeBytes: sample.content.length,
          modifiedMs: null,
          status: "failed",
          error: appError,
          chunks: [],
          indexedAt: null,
          isSample: true,
        });
        this.emit();
        this.updateProgress({ filesDone: this.snapshot.progress.filesDone + 1 });
      }
    }

    this.running = false;
    this.updateProgress({
      phase: cancelled ? "cancelled" : "completed",
      currentFile: null,
      finishedAt: Date.now(),
    });
  }

  /** Re-index one file even if it appears unchanged. */
  async reindexFile(path: string): Promise<void> {
    if (this.running) return;
    const existing = this.files.get(path);
    if (existing) {
      // Invalidate metadata so the incremental skip does not trigger.
      this.files.set(path, { ...existing, modifiedMs: null, status: "queued" });
      this.emit();
    }
    await this.indexPaths([path]);
  }

  removeFile(path: string) {
    this.files.delete(path);
    this.emit();
  }

  clear() {
    if (this.running) return;
    this.files.clear();
    this.emit();
  }

  cancel() {
    if (!this.running) return;
    this.cancelRequested = true;
    embeddingClient.cancelAllJobs();
    this.updateProgress({ phase: "cancelled", currentFile: null });
  }

  // --- Bulk (folder scan) API ----------------------------------------------

  /** True when a folder scan is running; used to disable conflicting actions. */
  isBulkRunning(): boolean {
    return this.bulkRunning;
  }

  shouldCancelBulk(): boolean {
    return this.bulkCancelRequested;
  }

  /** Publish a progress update from the bulk pipeline. */
  publishBulkProgress(patch: Partial<BulkProgress>) {
    this.snapshot = {
      ...this.snapshot,
      bulk: { ...this.snapshot.bulk, ...patch },
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Insert or replace fully indexed files produced by the bulk pipeline.
   *
   * Takes a batch deliberately: a scan can produce tens of thousands of files,
   * and notifying once per file rebuilds the snapshot array for each one, which
   * turns the final stage of a large scan into quadratic work.
   */
  addIndexedFiles(indexed: IndexedFile[]) {
    if (indexed.length === 0) return;
    for (const file of indexed) {
      this.files.set(file.path, file);
    }
    this.emit();
  }

  /** Record files that could not be indexed, in one notification. */
  recordIndexFailures(paths: string[], message: string) {
    if (paths.length === 0) return;
    for (const path of paths) {
      const existing = this.files.get(path);
      if (!existing) continue;
      this.files.set(path, {
        ...existing,
        status: "failed",
        error: { code: "extraction_failed", message },
      });
    }
    this.emit();
  }

  /** True when the indexed record matches the scanned metadata exactly. */
  isUnchanged(path: string, sizeBytes: number, modifiedMs: number | null): boolean {
    const existing = this.files.get(path);
    if (!existing || existing.status !== "ready") return false;
    if (existing.sizeBytes !== sizeBytes) return false;
    if (modifiedMs === null) return false;
    return existing.modifiedMs === modifiedMs;
  }

  beginBulkRun() {
    this.bulkRunning = true;
    this.bulkCancelRequested = false;
    this.publishBulkProgress({
      ...EMPTY_BULK_PROGRESS,
      phase: "reading",
      backend: embeddingClient.getStatus().backend,
    });
  }

  endBulkRun() {
    this.bulkRunning = false;
    this.bulkCancelRequested = false;
    // Notify: without this the panel stays mounted for one frame after the
    // final progress update, and the UI briefly shows a completed bar.
    this.publishBulkProgress({});
  }

  cancelBulk() {
    if (!this.bulkRunning) return;
    this.bulkCancelRequested = true;
    embeddingClient.cancelAllJobs();
    this.publishBulkProgress({
      phase: "cancelled",
      inFlight: 0,
      currentFile: null,
    });
  }
}

function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export const indexStore = new IndexStore();
