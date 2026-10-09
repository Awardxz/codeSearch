import type {
  AppError,
  EmbeddingStatus,
  InferenceBackend,
} from "../../types";
import type { EmbedItem, Modalities, WorkerEvent, WorkerRequest } from "./embedding.worker";
import { EXPECTED_EMBEDDING_DIM } from "./config";

/**
 * Main-thread client for the embedding worker. All model loading and
 * inference happens in the worker; this class turns the message protocol
 * into promises with progress and cancellation support.
 *
 * A single worker instance is shared by the whole app so the model is
 * loaded exactly once.
 */

type PendingJob = {
  resolve: (value: void) => void;
  reject: (error: AppError) => void;
  onProgress?: (done: number, total: number) => void;
  collectEmbeddings?: boolean;
  embeddings?: number[][];
  dimension?: number;
};

type StatusListener = (status: EmbeddingStatus) => void;

function createWorker(): Worker {
  return new Worker(new URL("./embedding.worker.ts", import.meta.url), {
    type: "module",
    name: "embedding-worker",
  });
}

class EmbeddingClient {
  private worker: Worker | null = null;
  private nextJobId = 1;
  private pending = new Map<number, PendingJob>();
  private loadWaiters: Array<{
    resolve: (info: { backend: InferenceBackend; dimension: number }) => void;
    reject: (error: AppError) => void;
  }> = [];
  private listeners = new Set<StatusListener>();

  private status: EmbeddingStatus = {
    phase: "idle",
    backend: null,
    dimension: null,
    downloadProgress: null,
    downloadFile: null,
    error: null,
    modalities: null,
  };

  /** Arrow property: `useSyncExternalStore` calls getSnapshot without a receiver. */
  getStatus = (): EmbeddingStatus => {
    return this.status;
  };

  /** Arrow property for the same reason as `getStatus`. */
  subscribe = (listener: StatusListener): (() => void) => {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setStatus(patch: Partial<EmbeddingStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) {
      listener(this.status);
    }
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = createWorker();
      this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
        this.handleWorkerEvent(event.data);
      };
      this.worker.onerror = (event) => {
        // Worker-level failure (script load, unhandled exception).
        this.setStatus({
          phase: "error",
          error: {
            code: "model_unavailable",
            message: `Embedding worker crashed: ${event.message || "unknown error"}`,
          },
        });
        for (const waiter of this.loadWaiters) {
          waiter.reject({
            code: "model_unavailable",
            message: "Embedding worker failed to start.",
          });
        }
        this.loadWaiters = [];
      };
    }
    return this.worker;
  }

  private handleWorkerEvent(event: WorkerEvent) {
    switch (event.kind) {
      case "load-progress": {
        this.setStatus({
          phase: "loading",
          downloadProgress: event.progress,
          downloadFile: event.file,
        });
        break;
      }

      case "load-result": {
        this.setStatus({
          phase: "ready",
          backend: event.backend,
          dimension: event.dimension,
          modalities: event.modalities,
          downloadProgress: null,
          downloadFile: null,
          error: null,
        });
        for (const waiter of this.loadWaiters) {
          waiter.resolve({
            backend: event.backend,
            dimension: event.dimension,
          });
        }
        this.loadWaiters = [];
        break;
      }

      case "embed-progress": {
        const job = this.pending.get(event.jobId);
        job?.onProgress?.(event.done, event.total);
        break;
      }

      case "embed-result": {
        const job = this.pending.get(event.jobId);
        if (job) {
          job.embeddings = event.embeddings;
          job.dimension = event.dimension;
          job.resolve();
          this.pending.delete(event.jobId);
        }
        break;
      }

      case "job-cancelled": {
        const job = this.pending.get(event.jobId);
        if (job) {
          job.reject({ code: "cancelled", message: "Embedding was cancelled." });
          this.pending.delete(event.jobId);
        }
        break;
      }

      case "job-error": {
        if (event.jobId === -1) {
          // Load failure.
          this.setStatus({
            phase: "error",
            downloadProgress: null,
            downloadFile: null,
            error: event.error,
          });
          for (const waiter of this.loadWaiters) {
            waiter.reject(event.error);
          }
          this.loadWaiters = [];
          return;
        }

        const job = this.pending.get(event.jobId);
        if (job) {
          job.reject(event.error);
          this.pending.delete(event.jobId);
        }
        break;
      }
    }
  }

  /**
   * Load the model if needed; resolves once inference is usable.
   *
   * `modalities` selects which encoders load. A session that has only ever
   * embedded text has not downloaded the vision or audio weights, so asking for
   * them later triggers a load with those encoders enabled.
   */
  async ensureLoaded(
    modalities: Modalities = { text: true, vision: false, audio: false },
  ): Promise<{ backend: InferenceBackend; dimension: number }> {
    const worker = this.ensureWorker();

    if (
      this.status.phase === "ready" &&
      this.status.backend &&
      this.status.dimension &&
      modalitiesSatisfied(this.status.modalities, modalities)
    ) {
      return {
        backend: this.status.backend,
        dimension: this.status.dimension,
      };
    }

    if (this.status.phase === "error") {
      // A previous attempt failed; allow a retry by reloading the worker.
      this.reinitialize();
    }

    return new Promise((resolve, reject) => {
      this.loadWaiters.push({ resolve, reject });
      this.setStatus({ phase: "loading", error: null, modalities });
      worker.postMessage({ kind: "load", modalities } satisfies WorkerRequest);
    });
  }

  /** Post an embed job and return its id. */
  private postJob(items: EmbedItem[]): number {
    const jobId = this.nextJobId++;
    const worker = this.ensureWorker();
    this.pending.set(jobId, {
      resolve: () => undefined,
      reject: () => undefined,
    });
    worker.postMessage({ kind: "embed", jobId, items } satisfies WorkerRequest);
    return jobId;
  }

  /**
   * Embed text and/or media through the model.
   *
   * `items` is a flat list; the worker batches it by token budget, so chunks
   * from many files (or a mixed text/media list) share single ONNX calls.
   * Resolves with one vector per input, in input order.
   */
  async embed(
    items: EmbedItem[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Float32Array[]> {
    if (items.length === 0) return [];

    await this.ensureLoaded(modalitiesFor(items));

    const jobId = this.postJob(items);
    this.pending.get(jobId)!.onProgress = onProgress;

    return this.awaitJob(jobId, items.length);
  }

  /** Embed document chunks. Convenience wrapper over `embed`. */
  async embedDocuments(
    texts: string[],
    titles: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    return this.embed(
      texts.map((text, index) => ({
        modality: "text" as const,
        mode: "documents" as const,
        text,
        title: titles[index] ?? "",
      })),
      onProgress,
    );
  }

  /** Embed a single search query with the query prompt format. */
  async embedQuery(query: string): Promise<Float32Array> {
    const vectors = await this.embed([
      { modality: "text", mode: "query", text: query, title: "" },
    ]);
    const vector = vectors[0];
    if (!vector) {
      throw { code: "model_unavailable", message: "Model returned no embedding." };
    }
    return vector;
  }

  /** Await an already-posted job and validate its shape. */
  private awaitJob(jobId: number, expected: number): Promise<Float32Array[]> {
    return new Promise<Float32Array[]>((resolve, reject) => {
      const job = this.pending.get(jobId);
      if (!job) {
        reject({ code: "cancelled", message: "The embedding job is no longer pending." });
        return;
      }
      job.resolve = () => {
        const vectors = (job.embeddings ?? []).map((list) => new Float32Array(list));
        const dimension = job.dimension ?? 0;

        if (vectors.length !== expected) {
          reject({
            code: "model_unavailable",
            message: `Model returned ${vectors.length} embeddings for ${expected} inputs.`,
          });
          return;
        }
        if (dimension !== EXPECTED_EMBEDDING_DIM) {
          reject({
            code: "model_unavailable",
            message: `Model returned ${dimension}-dimensional embeddings; expected ${EXPECTED_EMBEDDING_DIM}.`,
          });
          return;
        }
        resolve(vectors);
      };
    });
  }

  /** Cancel an in-flight embed job. Batches not yet started are skipped. */
  cancel(jobId: number) {
    this.worker?.postMessage({ kind: "cancel", jobId } satisfies WorkerRequest);
  }

  /** Cancel every pending embed job (used when indexing is cancelled). */
  cancelAllJobs() {
    for (const jobId of this.pending.keys()) {
      this.worker?.postMessage({ kind: "cancel", jobId } satisfies WorkerRequest);
    }
  }

  /** Tear down and recreate the worker (used for retry-after-error). */
  reinitialize() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    for (const waiter of this.loadWaiters) {
      waiter.reject({ code: "cancelled", message: "Model reinitialization was requested." });
    }
    this.loadWaiters = [];
    this.setStatus({
      phase: "idle",
      backend: null,
      dimension: null,
      modalities: null,
      downloadProgress: null,
      downloadFile: null,
      error: null,
    });
  }
}

export const embeddingClient = new EmbeddingClient();

/** Which encoders a set of items needs. */
function modalitiesFor(items: EmbedItem[]): Modalities {
  let vision = false;
  let audio = false;
  let text = false;
  for (const item of items) {
    if (item.modality === "text") text = true;
    if (item.modality === "image" || item.modality === "video") vision = true;
    if (item.modality === "audio") audio = true;
  }
  return { text: text || vision || audio, vision, audio };
}

/** True when the loaded session already covers everything requested. */
function modalitiesSatisfied(
  loaded: Modalities | null,
  requested: Modalities,
): boolean {
  if (!loaded) return false;
  if (requested.vision && !loaded.vision) return false;
  if (requested.audio && !loaded.audio) return false;
  if (requested.text && !loaded.text) return false;
  return true;
}
