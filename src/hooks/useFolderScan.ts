import { useCallback, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  folderLabel,
  scanFolders,
  toBulkFiles,
  type ScanResult,
} from "../lib/scanning/scanService";
import { runBulkIndex } from "../lib/indexing/bulkIndexer";
import { indexStore } from "../lib/indexing/indexStore";
import type { BulkFile } from "../lib/indexing/bulkPlanner";
import { readTextFilesBulk } from "../lib/scanning/scanService";
import type { RawFileRead } from "../lib/indexing/bulkPlanner";
import { startWatching } from "../lib/watch/watchService";

/**
 * Drives a folder scan end to end: pick a folder, walk it, read and index it.
 *
 * The expensive stages are native (walk, read); the embedding stage is batched
 * maximally across files. Progress is published through the index store so the
 * shell's status readout stays in sync.
 *
 * Only one folder is scanned at a time, and it is always chosen by the user in
 * the OS picker — the app never enumerates the machine on its own.
 */

export type ScanStage =
  | "idle"
  | "picking"
  | "scanning"
  | "reading"
  | "embedding"
  | "done"
  | "cancelled"
  | "error";

export type ScanState = {
  stage: ScanStage;
  /** The folder currently being scanned, if any. */
  folder: string | null;
  /** Most recent scan of that folder. */
  scan: ScanResult | null;
  textFiles: number;
  mediaFiles: number;
  mediaBreakdown: { images: number; audio: number; video: number };
  error: string | null;
};

const INITIAL: ScanState = {
  stage: "idle",
  folder: null,
  scan: null,
  textFiles: 0,
  mediaFiles: 0,
  mediaBreakdown: { images: 0, audio: 0, video: 0 },
  error: null,
};

export function useFolderScan() {
  const [state, setState] = useState<ScanState>(INITIAL);
  const [lastResult, setLastResult] = useState<{
    chunks: number;
    media: number;
    skipped: number;
    elapsedMs: number;
  } | null>(null);
  const busyRef = useRef(false);

  /** Open the OS folder picker and scan what was chosen. */
  const pickAndScan = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    setState((current) => ({ ...current, stage: "picking", error: null }));

    try {
      const picked = await openFolderDialog({
        directory: true,
        multiple: false,
        title: "Choose a project folder to index",
      });

      if (!picked || typeof picked !== "string") {
        setState((current) => ({ ...current, stage: "idle" }));
        return;
      }

      setState((current) => ({ ...current, stage: "scanning", folder: picked }));

      const scan = await scanFolders([picked]);

      const media = scan.files.filter((file) => file.kind !== "text");
      const text = scan.files.length - media.length;

      setState((current) => ({
        ...current,
        stage: "idle",
        folder: picked,
        scan,
        textFiles: text,
        mediaFiles: media.length,
        mediaBreakdown: {
          images: scan.files.filter((f) => f.kind === "image").length,
          audio: scan.files.filter((f) => f.kind === "audio").length,
          video: scan.files.filter((f) => f.kind === "video").length,
        },
        error: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        stage: "error",
        folder: null,
        scan: null,
        textFiles: 0,
        mediaFiles: 0,
        mediaBreakdown: { images: 0, audio: 0, video: 0 },
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Index everything the last scan found. */
  const indexScanned = useCallback(async () => {
    const scan = state.scan;
    const folder = state.folder;
    if (!scan || scan.files.length === 0) return;
    if (busyRef.current) return;

    busyRef.current = true;
    indexStore.beginBulkRun();
    setState((current) => ({ ...current, stage: "reading", error: null }));

    try {
      const files: BulkFile[] = toBulkFiles(scan.files);

      // Read in bounded batches so bridge payloads stay small and progress can
      // be reported between them.
      const textPaths = files
        .filter((file) => file.modality === "text")
        .map((file) => file.path);

      const reads: RawFileRead[] = [];
      for (let i = 0; i < textPaths.length; i += 150) {
        if (indexStore.shouldCancelBulk()) break;
        const slice = textPaths.slice(i, i + 150);
        const results = await readTextFilesBulk(slice);
        reads.push(...results);
        indexStore.publishBulkProgress({
          phase: "reading",
          filesFound: files.length,
          filesPlanned: files.length,
          chunksDone: 0,
          chunksPlanned: 0,
          inFlight: slice.length,
          currentFile: slice[slice.length - 1] ?? null,
          elapsedMs: 0,
        });
      }

      if (indexStore.shouldCancelBulk()) {
        indexStore.endBulkRun();
        setState((current) => ({ ...current, stage: "cancelled" }));
        return;
      }

      setState((current) => ({ ...current, stage: "embedding" }));
      const result = await runBulkIndex(
        files,
        () => Promise.resolve(reads),
      );

      setLastResult({
        chunks: result.chunksPlanned,
        media: result.mediaPlanned,
        skipped: result.filesSkipped,
        elapsedMs: result.elapsedMs,
      });
      setState((current) => ({ ...current, stage: "done" }));

      // Keep the index live: watch the folder that was just indexed so saves
      // re-index themselves. Watching is passive until files change.
      if (folder) void startWatching([folder]);
    } catch (error) {
      setState((current) => ({
        ...current,
        stage: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      indexStore.endBulkRun();
      busyRef.current = false;
    }
  }, [state.scan, state.folder]);

  const cancel = useCallback(() => {
    indexStore.cancelBulk();
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
    setLastResult(null);
  }, []);

  return {
    ...state,
    lastResult,
    folderLabel: state.folder ? folderLabel(state.folder) : null,
    pickAndScan,
    indexScanned,
    cancel,
    reset,
  };
}
