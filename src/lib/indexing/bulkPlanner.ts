import type { ChunkRecord, FileKind, IndexedFile } from "../../types";
import { normalizeText } from "../chunking/textNormalizer";
import { chunkText } from "../chunking/chunker";
import { classifyFile } from "../extractors/registry";
import type { EmbedItem, EmbedMediaItem } from "../embeddings/embedding.worker";

/**
 * Types and planning stage of the bulk indexer (whole-folder scans).
 *
 * Everything is planned up front so a single embedding batch can hold inputs
 * from several files, which is what makes a whole-desktop scan fast.
 */

/** Which modality a file is embedded as. */
export type BulkModality = "text" | "image" | "audio" | "video";

/** A file discovered by a folder scan. */
export type BulkFile = {
  path: string;
  name: string;
  extension: string;
  modality: BulkModality;
  sizeBytes: number;
  modifiedMs: number | null;
};

/** A text file read by the Rust bulk command. `ok: false` means it failed. */
export type RawFileRead = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number | null;
  ok: boolean;
  content: string;
  error: string | null;
};

/** Reads many text paths at once; one entry per path, in the requested order. */
export type BulkTextReader = (paths: string[]) => Promise<RawFileRead[]>;

export type BulkProgress = {
  phase: "reading" | "embedding" | "done" | "cancelled" | "idle";
  filesFound: number;
  filesPlanned: number;
  filesSkipped: number;
  filesFailed: number;
  chunksPlanned: number;
  chunksDone: number;
  mediaPlanned: number;
  mediaDone: number;
  inFlight: number;
  currentFile: string | null;
  elapsedMs: number;
  /** Backend the embedding worker settled on, for the UI readout. */
  backend: string | null;
};

export const EMPTY_BULK_PROGRESS: BulkProgress = {
  phase: "idle",
  filesFound: 0,
  filesPlanned: 0,
  filesSkipped: 0,
  filesFailed: 0,
  chunksPlanned: 0,
  chunksDone: 0,
  mediaPlanned: 0,
  mediaDone: 0,
  inFlight: 0,
  currentFile: null,
  elapsedMs: 0,
  backend: null,
};

export type BulkPlan = {
  /** Flat embedding inputs in stable order. */
  items: EmbedItem[];
  /** File name for each input (used as the embedding document title). */
  titles: string[];
  /** Which pending file each input belongs to. */
  owners: number[];
  /** Input indices owned by each file, in order. */
  itemsPerFile: number[][];
  /** Files that produced no inputs at all, and are therefore failures. */
  emptyFiles: number[];
};

/**
 * Turn a scan result plus bulk reads into a flat embedding plan.
 *
 * Text files contribute one input per chunk. Media files contribute exactly one
 * input each, embedded through the vision or audio encoder — not by reading
 * text, which is what makes cross-modal search possible at all.
 */
export function prepareBulkChunks(
  pending: BulkFile[],
  reads: RawFileRead[],
): BulkPlan {
  const readsByPath = new Map(reads.map((read) => [read.path, read]));

  const items: EmbedItem[] = [];
  const titles: string[] = [];
  const owners: number[] = [];
  const itemsPerFile: number[][] = pending.map(() => []);
  const emptyFiles: number[] = [];

  for (let fileIndex = 0; fileIndex < pending.length; fileIndex++) {
    const file = pending[fileIndex];
    const local: number[] = [];

    if (file.modality === "text") {
      const read = readsByPath.get(file.path);
      if (read?.ok) {
        for (const chunk of chunkText(normalizeText(read.content))) {
          const globalIndex = items.length;
          items.push({
            modality: "text",
            mode: "documents",
            text: chunk.text,
            title: file.name,
          });
          titles.push(file.name);
          owners.push(fileIndex);
          local.push(globalIndex);
        }
      }
      // A text file whose read failed contributes nothing, so
      // `scatterToIndexedFiles` marks it as failed. Indexing just its name
      // would look like success while hiding that the contents were never read.
      if (local.length === 0) emptyFiles.push(fileIndex);
    } else {
      // One embedding per media file, from the media itself.
      const globalIndex = items.length;
      const media: EmbedMediaItem =
        file.modality === "image"
          ? { modality: "image", path: file.path, title: file.name }
          : file.modality === "audio"
            ? { modality: "audio", path: file.path, title: file.name }
            : { modality: "video", path: file.path, title: file.name, frames: null };
      items.push(media);
      titles.push(file.name);
      owners.push(fileIndex);
      local.push(globalIndex);
    }

    itemsPerFile[fileIndex] = local;
  }

  return { items, titles, owners, itemsPerFile, emptyFiles };
}

export type ScatterEntry = {
  file: BulkFile;
  indexed: IndexedFile;
  failed: boolean;
};

/** Pair each file with its vectors, flagging files whose inputs never landed. */
export function scatterToIndexedFiles(
  pending: BulkFile[],
  plan: BulkPlan,
  embeddings: Float32Array[],
): ScatterEntry[] {
  const entries: ScatterEntry[] = [];

  for (let fileIndex = 0; fileIndex < pending.length; fileIndex++) {
    const file = pending[fileIndex];
    const local = plan.itemsPerFile[fileIndex] ?? [];

    // A file with no vectors at all failed; partial filling cannot happen,
    // because embedding is all-or-nothing per input.
    const failed = local.length === 0 || local.every((index) => !embeddings[index]);

    const chunks: ChunkRecord[] = local
      .filter((index) => embeddings[index])
      .map((index) => ({
        fileIndex: 0,
        // Media has no line numbers, so the record keeps a descriptive label.
        text: mediaLabel(file),
        embedding: embeddings[index],
      }));

    entries.push({
      file,
      failed,
      indexed: {
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: modalityToKind(file.modality, file.name),
        sizeBytes: file.sizeBytes,
        modifiedMs: file.modifiedMs,
        status: "ready",
        error: null,
        chunks,
        indexedAt: Date.now(),
        isSample: false,
      },
    });
  }

  return entries;
}

/** Human-readable label stored as the chunk text for media files. */
export function mediaLabel(file: BulkFile): string {
  return `${file.name} ${file.path}`;
}

function modalityToKind(modality: BulkModality, name: string): FileKind {
  switch (modality) {
    case "image":
      return "image";
    case "audio":
    case "video":
      return "media";
    default:
      return classifyFile(name);
  }
}
