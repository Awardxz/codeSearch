import { invoke } from "@tauri-apps/api/core";
import type { ChunkRecord, IndexedFile } from "../../types";
import {
  EXPECTED_EMBEDDING_DIM,
  MODEL_ID,
} from "../embeddings/config";

/**
 * Persistence for the index: SQLite on the Rust side, in-memory store on this
 * side.
 *
 * Search needs every vector resident, so the whole snapshot loads at startup
 * and the store stays the source of truth while running. Writes go the other
 * way in small batches: a file's chunks plus its metadata per upsert, chained
 * through a single promise tail so concurrent indexing runs cannot interleave
 * a write with a remove or clear.
 *
 * Every `invoke` is guarded. Outside the Tauri runtime (browser dev, SSR
 * tests) the calls reject and persistence quietly degrades to a no-op — the
 * app works exactly as before, just without surviving restarts.
 */

/** Files per upsert call. A file's vectors dominate the payload; 25 keeps each
 *  invoke around a megabyte for typical chunk counts. */
const UPSERT_BATCH_SIZE = 25;

type PersistedChunkWire = {
  text: string;
  lineStart: number | null;
  lineEnd: number | null;
  embeddingB64: string;
};

type PersistedFileWire = {
  path: string;
  name: string;
  extension: string;
  kind: string;
  sizeBytes: number;
  modifiedMs: number | null;
  indexedAt: number;
  chunks: PersistedChunkWire[];
};

type PersistedSnapshotWire = {
  modelId: string | null;
  embeddingDim: number | null;
  files: PersistedFileWire[];
};

export type PersistStats = {
  path: string;
  files: number;
  chunks: number;
  bytes: number;
};

export type RestoreResult =
  | { status: "ready"; files: number }
  | { status: "empty" }
  | { status: "discarded"; reason: string };

/**
 * Float32Array to base64 of little-endian f32 bytes. All targets this app
 * ships on (x86-64, ARM64) are little-endian, and the Rust side decodes with
 * `f32::from_le_bytes` — documented here so a future big-endian port knows
 * this is the assumption to revisit.
 */
export function float32ToBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error("Stored embedding is not a whole number of f32 values.");
  }
  return new Float32Array(bytes.buffer);
}

let tail: Promise<void> = Promise.resolve();

function chain(task: () => Promise<void>): void {
  tail = tail.then(task).catch((error) => {
    console.warn("Index persistence failed; continuing in memory.", error);
  });
}

/** Queue an upsert of freshly indexed files. Samples never persist: they
 *  have no backing file and re-embed in seconds. */
export function schedulePersist(files: IndexedFile[]): void {
  const persistable = files.filter(
    (file) =>
      file.status === "ready" && !file.isSample && file.chunks.length > 0,
  );
  if (persistable.length === 0) return;
  chain(async () => {
    for (let start = 0; start < persistable.length; start += UPSERT_BATCH_SIZE) {
      const batch = persistable.slice(start, start + UPSERT_BATCH_SIZE);
      await invoke("persist_index_upsert", {
        modelId: MODEL_ID,
        embeddingDim: EXPECTED_EMBEDDING_DIM,
        files: batch.map(toWire),
      });
    }
  });
}

/** Queue removal of paths that left the index. Chained behind pending writes
 *  so a file cannot be re-inserted by a write that was already queued. */
export function scheduleRemove(paths: string[]): void {
  if (paths.length === 0) return;
  chain(async () => {
    await invoke("persist_index_remove", { paths });
  });
}

/** Queue a full wipe. Runs after everything queued before it. */
export function scheduleClear(): void {
  chain(async () => {
    await invoke("persist_index_clear", {});
  });
}

function toWire(file: IndexedFile): PersistedFileWire {
  return {
    path: file.path,
    name: file.name,
    extension: file.extension,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    modifiedMs: file.modifiedMs,
    indexedAt: file.indexedAt ?? Date.now(),
    chunks: file.chunks.map((chunk) => ({
      text: chunk.text,
      lineStart: chunk.lineStart ?? null,
      lineEnd: chunk.lineEnd ?? null,
      embeddingB64: float32ToBase64(chunk.embedding),
    })),
  };
}

function fromWire(file: PersistedFileWire): IndexedFile {
  const chunks: ChunkRecord[] = file.chunks.map((chunk, index) => ({
    fileIndex: index,
    text: chunk.text,
    lineStart: chunk.lineStart ?? undefined,
    lineEnd: chunk.lineEnd ?? undefined,
    embedding: base64ToFloat32(chunk.embeddingB64),
  }));
  return {
    path: file.path,
    name: file.name,
    extension: file.extension,
    kind: (file.kind ?? "unsupported") as IndexedFile["kind"],
    sizeBytes: file.sizeBytes,
    modifiedMs: file.modifiedMs,
    status: "ready",
    error: null,
    chunks,
    indexedAt: file.indexedAt,
    isSample: false,
  };
}

/**
 * Load the persisted snapshot and hand it to the store. A snapshot from a
 * different model or dimension is discarded (and wiped) rather than searched
 * with wrong vectors — embeddings are meaningless across models.
 */
export async function restorePersistedIndex(
  addFiles: (files: IndexedFile[]) => void,
): Promise<RestoreResult> {
  let snapshot: PersistedSnapshotWire;
  try {
    snapshot = await invoke<PersistedSnapshotWire>("persist_index_load", {});
  } catch {
    return { status: "empty" };
  }

  if (snapshot.files.length === 0) return { status: "empty" };

  if (
    snapshot.modelId !== MODEL_ID ||
    snapshot.embeddingDim !== EXPECTED_EMBEDDING_DIM
  ) {
    try {
      await invoke("persist_index_clear", {});
    } catch {
      // Best effort: the next upsert replaces the stale snapshot anyway.
    }
    return {
      status: "discarded",
      reason: `Snapshot was embedded with ${snapshot.modelId ?? "an unknown model"} and was discarded.`,
    };
  }

  try {
    addFiles(snapshot.files.map(fromWire));
  } catch (error) {
    return {
      status: "discarded",
      reason:
        error instanceof Error
          ? `Stored vectors could not be decoded: ${error.message}`
          : "Stored vectors could not be decoded.",
    };
  }
  return { status: "ready", files: snapshot.files.length };
}

/** Row counts and on-disk size for the Settings storage readout. Null outside
 *  the Tauri runtime or when the database cannot be read. */
export async function getPersistStats(): Promise<PersistStats | null> {
  try {
    return await invoke<PersistStats>("persist_index_stats", {});
  } catch {
    return null;
  }
}
