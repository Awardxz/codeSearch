import { invoke } from "@tauri-apps/api/core";
import type { BulkFile } from "../indexing/bulkPlanner";

/**
 * Folder scanning: walk the folders the user picks and read the text files in
 * bulk.
 *
 * Everything expensive happens natively. The webview only ever sees the list of
 * files that survived pruning, which is what keeps a large project scan from
 * sending hundreds of thousands of rejected paths across the bridge.
 *
 * The app never enumerates the user's machine on its own: roots are chosen in
 * the OS folder picker, so the frontend has no way to wander outside what was
 * explicitly selected.
 */

export type ScanKind = "text" | "image" | "audio" | "video";

export type ScanFile = {
  path: string;
  name: string;
  extension: string;
  kind: ScanKind;
  size_bytes: number;
  modified_ms: number | null;
};

export type ScanSkipped = {
  unsupported_extension: number;
  binary: number;
  too_large: number;
  hidden: number;
  error: number;
  duplicates: number;
};

export type ScanResult = {
  files: ScanFile[];
  skipped: ScanSkipped;
  directories_visited: number;
  elapsed_ms: number;
};

type BulkReadResponse = {
  path: string;
  name: string;
  size_bytes: number;
  modified_ms: number | null;
  content: string;
  code: string;
  message: string;
};

/** A folder's label for display: its last path segment, or the whole path. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Walk the chosen roots. Runs natively, in parallel. */
export async function scanFolders(paths: string[]): Promise<ScanResult> {
  return invoke<ScanResult>("scan_folders", { paths });
}

/**
 * Read many text files in one call, in parallel. Returns exactly one entry per
 * requested path, in the same order, with failures flagged rather than dropped —
 * a file that could not be read must show up as a failure, not silently
 * degrade to a name-only entry that looks indexed.
 */
export async function readTextFilesBulk(
  paths: string[],
): Promise<RawFileReadView[]> {
  const results = await invoke<BulkReadResponse[]>("read_text_files_bulk", {
    paths,
  });

  const byPath = new Map(results.map((result) => [result.path, result]));

  return paths.map((path, index) => {
    const result = byPath.get(path);
    if (!result || typeof result.content !== "string") {
      const fallback = results[index];
      return {
        path,
        name: fallback?.name ?? path,
        sizeBytes: fallback?.size_bytes ?? 0,
        modifiedMs: fallback?.modified_ms ?? null,
        ok: false,
        content: "",
        error: fallback?.message ?? "The file could not be read.",
      };
    }
    return {
      path: result.path,
      name: result.name,
      sizeBytes: result.size_bytes,
      modifiedMs: result.modified_ms,
      ok: true,
      content: result.content,
      error: null,
    };
  });
}

type RawFileReadView = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number | null;
  ok: boolean;
  content: string;
  error: string | null;
};

/** Convert a scan result into the pipeline's file records. */
export function toBulkFiles(files: ScanFile[]): BulkFile[] {
  return files.map((file) => ({
    path: file.path,
    name: file.name,
    extension: file.extension,
    modality: file.kind,
    sizeBytes: file.size_bytes,
    modifiedMs: file.modified_ms,
  }));
}

/**
 * Read in chunks of this many paths. A scan can produce tens of thousands of
 * files; one giant read would block the webview for minutes at a time and move
 * a huge amount of text over the bridge in a single payload.
 */
export const READ_BATCH_SIZE = 150;

export function chunkedPaths(paths: string[], size = READ_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    batches.push(paths.slice(i, i + size));
  }
  return batches;
}
