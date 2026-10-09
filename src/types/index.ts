/**
 * Shared application types. These types cross module boundaries
 * (services <-> React) and must stay serialization-friendly where they
 * cross the native boundary.
 */

/** Error codes shared between the Rust layer and the frontend. */
export type AppErrorCode =
  | "not_found"
  | "access_denied"
  | "unsupported_format"
  | "too_large"
  | "extraction_failed"
  | "model_unavailable"
  | "gpu_unavailable"
  | "database_error"
  | "cancelled"
  | "unknown";

export type AppError = {
  code: AppErrorCode;
  message: string;
};

export function appError(code: AppErrorCode, message: string): AppError {
  return { code, message };
}

export function toAppError(error: unknown): AppError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as AppErrorCode, message: candidate.message };
    }
  }
  if (error instanceof Error && error.message) {
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}

/** A chunk of extracted content with its location inside the source file. */
export type TextChunk = {
  /** 0-based order within the file. */
  index: number;
  text: string;
  /** 1-based inclusive line range when the extractor can determine it. */
  lineStart?: number;
  lineEnd?: number;
};

/** File classification used for filters, icons, and extractor dispatch. */
export type FileKind =
  | "text"
  | "code"
  | "markdown"
  | "data"
  | "document"
  | "pdf"
  | "docx"
  | "image"
  | "media"
  | "unsupported";

export type IndexedFileStatus =
  | "queued"
  | "extracting"
  | "embedding"
  | "ready"
  | "failed";

export type IndexedFile = {
  path: string;
  name: string;
  extension: string;
  kind: FileKind;
  sizeBytes: number;
  modifiedMs: number | null;
  status: IndexedFileStatus;
  error: AppError | null;
  chunks: ChunkRecord[];
  indexedAt: number | null;
  /** Built-in sample corpus entries have no backing file to open. */
  isSample: boolean;
};

/** A chunk with its embedding, stored in the in-memory index (Phase 6 moves this to SQLite). */
export type ChunkRecord = {
  fileIndex: number;
  text: string;
  lineStart?: number;
  lineEnd?: number;
  embedding: Float32Array;
};

import type { Modalities } from "../lib/embeddings/embedding.worker";

/** Inference backend currently in use by the embedding worker. */
export type InferenceBackend = "webgpu" | "wasm";

export type ModelLoadPhase = "idle" | "loading" | "ready" | "error";

export type EmbeddingStatus = {
  phase: ModelLoadPhase;
  backend: InferenceBackend | null;
  dimension: number | null;
  /** 0..100 while downloading model assets, null otherwise. */
  downloadProgress: number | null;
  downloadFile: string | null;
  error: AppError | null;
  /** Encoders currently loaded; drives the Settings readout. */
  modalities: Modalities | null;
};

export type IndexingPhase =
  | "idle"
  | "scanning"
  | "extracting"
  | "embedding"
  | "completed"
  | "cancelled"
  | "failed";

export type IndexingProgress = {
  phase: IndexingPhase;
  filesTotal: number;
  filesDone: number;
  chunksDone: number;
  chunksTotal: number;
  currentFile: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: AppError | null;
};

export type SearchRequest = {
  query: string;
  limit: number;
  /** Filter by file kind, e.g. only code or only markdown. */
  kinds?: FileKind[];
  /** Cosine similarity cutoff; matches below it are discarded. */
  minScore?: number;
};

export type SearchHit = {
  path: string;
  name: string;
  extension: string;
  kind: FileKind;
  score: number;
  /** Best-matching chunk snippet. */
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
  chunkIndex: number;
  /** How many additional chunks from this file scored above zero. */
  otherMatches: number;
  indexedAt: number | null;
};

export type SearchResponse = {
  query: string;
  hits: SearchHit[];
  /** Total chunk-level comparisons performed (diagnostics). */
  chunksSearched: number;
  durationMs: number;
};
