import { invoke } from "@tauri-apps/api/core";
import type { AppError, TextChunk } from "../../types";
import { normalizeText } from "../chunking/textNormalizer";
import { chunkText } from "../chunking/chunker";
import { classifyFile, extensionOf } from "../extractors/registry";

/**
 * Extraction stage: turns a selected file path into normalized, chunked
 * text ready for embedding.
 *
 * Content is read through the Rust `read_text_file` command, which
 * validates the extension and enforces a size limit before anything is
 * copied into the webview. PDF/DOCX/image extraction arrives in later
 * phases through additional extractors.
 */

type NativeTextFile = {
  path: string;
  name: string;
  extension: string;
  size_bytes: number;
  modified_ms: number | null;
  content: string;
};

export type ExtractedFile = {
  path: string;
  name: string;
  extension: string;
  kind: ReturnType<typeof classifyFile>;
  sizeBytes: number;
  modifiedMs: number | null;
  chunks: TextChunk[];
};

export async function extractTextFile(path: string): Promise<ExtractedFile> {
  const native = await invoke<NativeTextFile>("read_text_file", { path });

  const normalized = normalizeText(native.content);
  const chunks = chunkText(normalized);

  return {
    path: native.path,
    name: native.name,
    extension: extensionOf(native.name),
    kind: classifyFile(native.name),
    sizeBytes: native.size_bytes,
    modifiedMs: native.modified_ms,
    chunks,
  };
}

export function toAppErrorFromNative(error: unknown): AppError {
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
    return { code: "extraction_failed", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}
