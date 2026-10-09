import type { IndexedFile } from "../../types";
import { indexStore } from "../indexing/indexStore";
import {
  prepareBulkChunks,
  scatterToIndexedFiles,
  type BulkFile,
  type BulkTextReader,
} from "./bulkPlanner";
import { embeddingClient } from "../embeddings/embeddingClient";
import { extractVideoFrames } from "../media/videoFrames";
import type { EmbedItem } from "../embeddings/embedding.worker";

/**
 * Bulk indexing pipeline for whole-folder scans.
 *
 * Separate from `indexStore.indexPaths` because a scan is bounded by embedding
 * throughput, not by disk or IPC. Indexing file-by-file wastes the model's
 * capacity: the text batch budget is 6,500 characters, which holds several
 * files' chunks. So the plan is laid out first, embedded in maximal batches,
 * then scattered back to the files.
 */

/** Inputs per `embed` call. Small enough for live progress, large enough that
 *  the worker can pack each call to its token budget. */
const EMBED_SLICE = 24;

export type BulkRunResult = {
  filesFound: number;
  filesPlanned: number;
  filesDone: number;
  filesSkipped: number;
  filesFailed: number;
  chunksPlanned: number;
  chunksDone: number;
  mediaPlanned: number;
  mediaDone: number;
  cancelled: boolean;
  elapsedMs: number;
};

type ResolvedItem = { kind: "item"; item: EmbedItem; planIndex: number };
type ResolvedFailure = {
  kind: "failed";
  planIndex: number;
  path: string;
  reason: string;
};
type Resolved = ResolvedItem | ResolvedFailure;

export async function runBulkIndex(
  files: BulkFile[],
  readText: BulkTextReader,
): Promise<BulkRunResult> {
  const startedAt = Date.now();

  // 1. Skip files that are already indexed and unchanged.
  const pending: BulkFile[] = [];
  let skipped = 0;

  for (const file of files) {
    if (indexStore.isUnchanged(file.path, file.sizeBytes, file.modifiedMs)) {
      skipped++;
      continue;
    }
    pending.push(file);
  }

  const mediaPlanned = pending.filter((file) => file.modality !== "text").length;

  // 2. Read text contents in bulk, then plan every input up front.
  const textPaths = pending
    .filter((file) => file.modality === "text")
    .map((file) => file.path);
  const reads = textPaths.length > 0 ? await readText(textPaths) : [];
  const plan = prepareBulkChunks(pending, reads);

  const chunksPlanned = plan.items.filter((item) => item.modality === "text").length;

  if (plan.items.length === 0) {
    finishRun(
      pending.length,
      skipped,
      plan.emptyFiles.length,
      chunksPlanned,
      mediaPlanned,
      0,
      startedAt,
    );
    return emptyResult(files, pending.length, skipped, plan.emptyFiles.length);
  }

  // 3. Resolve media inputs. Video frames are decoded on the main thread,
  //    because `<video>` does not exist inside a worker.
  const resolved = await resolveItems(plan.items);
  if (resolved === null) {
    finishRun(pending.length, skipped, 0, chunksPlanned, mediaPlanned, 0, startedAt);
    return { ...emptyResult(files, pending.length, skipped, 0), cancelled: true };
  }

  // 4. Embed in slices. Each slice is packed by the worker to its token budget,
  //    so text and media share single ONNX calls instead of one call each.
  const embeddings = new Array<Float32Array>(plan.items.length);
  let chunksDone = 0;
  let mediaDone = 0;

  const ready = resolved.filter(
    (entry): entry is ResolvedItem => entry.kind === "item",
  );

  for (let start = 0; start < ready.length; start += EMBED_SLICE) {
    if (indexStore.shouldCancelBulk()) {
      indexStore.publishBulkProgress({
        phase: "cancelled",
        filesFound: files.length,
        filesPlanned: pending.length,
        filesSkipped: skipped,
        chunksPlanned,
        mediaPlanned,
        chunksDone,
        mediaDone,
        inFlight: 0,
        currentFile: null,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        filesFound: files.length,
        filesPlanned: pending.length,
        filesDone: 0,
        filesSkipped: skipped,
        filesFailed: 0,
        chunksPlanned,
        chunksDone,
        mediaPlanned,
        mediaDone,
        cancelled: true,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const slice = ready.slice(start, start + EMBED_SLICE);
    const vectors = await embeddingClient.embed(
      slice.map((entry) => entry.item),
      (done, total) => {
        const progressed = slice.slice(0, done);
        indexStore.publishBulkProgress({
          phase: "embedding",
          filesFound: files.length,
          filesPlanned: pending.length,
          filesSkipped: skipped,
          chunksPlanned,
          mediaPlanned,
          chunksDone: chunksDone + progressed.filter((e) => e.item.modality === "text").length,
          mediaDone: mediaDone + progressed.filter((e) => e.item.modality !== "text").length,
          inFlight: total - done,
          currentFile: plan.titles[slice[Math.min(done, slice.length - 1)].planIndex] ?? null,
          elapsedMs: Date.now() - startedAt,
        });
      },
    );

    slice.forEach((entry, position) => {
      embeddings[entry.planIndex] = vectors[position];
      if (entry.item.modality === "text") chunksDone++;
      else mediaDone++;
    });

    indexStore.publishBulkProgress({
      phase: "embedding",
      filesFound: files.length,
      filesPlanned: pending.length,
      filesSkipped: skipped,
      chunksPlanned,
      mediaPlanned,
      chunksDone,
      mediaDone,
      inFlight: 0,
      currentFile: null,
      elapsedMs: Date.now() - startedAt,
    });
  }

  // 5. Scatter vectors back to files and persist. One notification for the
  //    whole batch, or a 50,000-file scan becomes quadratic.
  const stored: IndexedFile[] = [];
  const failures: string[] = [];

  for (const entry of scatterToIndexedFiles(pending, plan, embeddings)) {
    if (entry.failed) {
      failures.push(entry.file.path);
      continue;
    }
    stored.push(entry.indexed);
  }
  for (const entry of resolved) {
    if (entry.kind === "failed") failures.push(entry.path);
  }

  indexStore.addIndexedFiles(stored);
  indexStore.recordIndexFailures(
    failures,
    "This file could not be embedded.",
  );

  const filesFailed = failures.length;
  finishRun(pending.length, skipped, filesFailed, chunksPlanned, mediaPlanned, mediaDone, startedAt);

  return {
    filesFound: files.length,
    filesPlanned: pending.length,
    filesDone: pending.length - filesFailed,
    filesSkipped: skipped,
    filesFailed,
    chunksPlanned,
    chunksDone,
    mediaPlanned,
    mediaDone,
    cancelled: false,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Turn planned inputs into embeddable ones, decoding video frames on the way.
 *
 * Returns null when the run was cancelled mid-decode. A media file that cannot
 * be decoded is reported as a failure rather than silently dropping out.
 */
async function resolveItems(items: EmbedItem[]): Promise<Resolved[] | null> {
  const resolved: Resolved[] = [];

  for (let planIndex = 0; planIndex < items.length; planIndex++) {
    const item = items[planIndex];

    if (item.modality !== "video") {
      resolved.push({ kind: "item", item, planIndex });
      continue;
    }

    if (indexStore.shouldCancelBulk()) return null;

    try {
      const { frames, durationSeconds } = await extractVideoFrames(item.path);
      resolved.push({
        kind: "item",
        planIndex,
        item: {
          modality: "video",
          path: item.path,
          title: item.title,
          frames: frames as unknown as SerializedFrameLike[],
          durationSeconds,
        },
      });
    } catch (error) {
      resolved.push({
        kind: "failed",
        planIndex,
        path: item.path,
        reason: error instanceof Error ? error.message : "The video could not be decoded.",
      });
    }
  }

  return resolved;
}

type SerializedFrameLike = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 3;
};

function finishRun(
  filesPlanned: number,
  filesSkipped: number,
  filesFailed: number,
  chunksPlanned: number,
  mediaPlanned: number,
  mediaDone: number,
  startedAt: number,
) {
  indexStore.publishBulkProgress({
    phase: "done",
    filesFound: 0,
    filesPlanned,
    filesSkipped,
    filesFailed,
    chunksPlanned,
    chunksDone: chunksPlanned,
    mediaPlanned,
    mediaDone,
    inFlight: 0,
    currentFile: null,
    elapsedMs: Date.now() - startedAt,
  });
}

function emptyResult(
  files: BulkFile[],
  filesPlanned: number,
  filesSkipped: number,
  filesFailed: number,
): BulkRunResult {
  return {
    filesFound: files.length,
    filesPlanned,
    filesDone: Math.max(0, filesPlanned - filesFailed),
    filesSkipped,
    filesFailed,
    chunksPlanned: 0,
    chunksDone: 0,
    mediaPlanned: 0,
    mediaDone: 0,
    cancelled: false,
    elapsedMs: 0,
  };
}
