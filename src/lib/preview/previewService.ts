import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "../../types";
import { embeddingClient } from "../embeddings/embeddingClient";
import { SAMPLE_DOCUMENTS } from "../indexing/sampleDocuments";
import { indexStore } from "../indexing/indexStore";

/**
 * Preview panel: show the real file contents with the matched lines highlighted.
 *
 * The whole file is re-read through the same Rust command used for indexing,
 * so the preview is always in sync with what is on disk (including edits made
 * since the file was indexed).
 */

export type PreviewSource = {
  path: string;
  name: string;
  sizeBytes: number;
  content: string;
  /** True for built-in sample documents, which have no file on disk. */
  isSample: boolean;
  modality: PreviewModality;
  /** Object URL for media files, or null for text. */
  mediaUrl: string | null;
};

export type PreviewModality = "text" | "image" | "audio" | "video";

/** Extension groups the preview can render directly in the webview. */
export function modalityForPath(path: string): PreviewModality {
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic", "svg", "ico"].includes(extension)) {
    return "image";
  }
  if (["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus"].includes(extension)) {
    return "audio";
  }
  if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v"].includes(extension)) {
    return "video";
  }
  return "text";
}

export type PreviewMatch = {
  chunkIndex: number;
  lineStart: number | null;
  lineEnd: number | null;
  score: number;
};

type NativeTextFile = {
  path: string;
  name: string;
  size_bytes: number;
  content: string;
};

/** Read the source for the preview panel: text, or a playable media URL. */
export async function loadPreviewSource(
  path: string,
): Promise<PreviewSource> {
  if (path.startsWith("sample://")) {
    const name = path.slice("sample://".length);
    const sample = SAMPLE_DOCUMENTS.find((doc) => doc.fileName === name);
    if (!sample) {
      throw new Error(`Sample document "${name}" is no longer available.`);
    }
    return {
      path,
      name: sample.fileName,
      sizeBytes: sample.content.length,
      content: sample.content,
      isSample: true,
      modality: "text",
      mediaUrl: null,
    };
  }

  const modality = modalityForPath(path);

  if (modality !== "text") {
    // Media has no text to show; the panel displays or plays it instead.
    return {
      path,
      name: fileNameOf(path),
      sizeBytes: 0,
      content: "",
      isSample: false,
      modality,
      mediaUrl: await createMediaUrl(path),
    };
  }

  const native = await invoke<NativeTextFile>("read_text_file", { path });
  return {
    path,
    name: native.name,
    sizeBytes: native.size_bytes,
    content: native.content,
    isSample: false,
    modality: "text",
    mediaUrl: null,
  };
}

const MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wma: "audio/x-ms-wma",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  m4v: "video/mp4",
};

/** Turn a file on disk into a URL the webview can render or play. */
async function createMediaUrl(path: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_media_bytes", { path });
  const extension = extensionOf(path);
  return URL.createObjectURL(
    new Blob([bytes], { type: MEDIA_MIME[extension] ?? "application/octet-stream" }),
  );
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * Rank every chunk of the indexed file against the query and return the
 * matching chunks in descending score order. Lets the preview step through
 * every place the query matched, not just the chunk shown in the hit.
 */
export async function rankPreviewMatches(args: {
  path: string;
  query: string | null;
  initialChunkIndex: number | null;
}): Promise<PreviewMatch[]> {
  const { path, query, initialChunkIndex } = args;
  const file = indexStore.getFile(path);

  const matches: PreviewMatch[] = [];

  if (file && file.chunks.length > 0 && query) {
    const queryVector = await embeddingClient.embedQuery(query);

    for (const chunk of file.chunks) {
      let score = 0;
      for (let i = 0; i < queryVector.length; i++) {
        score += queryVector[i] * chunk.embedding[i];
      }
      if (score > 0) {
        matches.push({
          chunkIndex: chunk.fileIndex,
          lineStart: chunk.lineStart ?? null,
          lineEnd: chunk.lineEnd ?? null,
          score,
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
  }

  // Guarantee the chunk the user clicked on is navigable even if it scored
  // zero (or the file is not in the index at all).
  if (
    initialChunkIndex !== null &&
    !matches.some((match) => match.chunkIndex === initialChunkIndex)
  ) {
    matches.unshift({
      chunkIndex: initialChunkIndex,
      lineStart: null,
      lineEnd: null,
      score: 0,
    });
  }

  return matches;
}

export function toPreviewError(error: unknown): AppError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as AppError;
  }
  if (error instanceof Error) {
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}
