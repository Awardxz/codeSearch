import type { InferenceBackend } from "../../types";

/**
 * Model configuration, verified against the model card
 * (https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) and the
 * Transformers.js v4 API:
 *
 * - Text-search queries use the documented prompt:
 *     `task: search result | query: {content}`
 * - Documents use:
 *     `title: {title} | text: {content}`   (title: none when absent)
 * - Output is 768-dimensional, mean-pooled and L2-normalized, so the dot
 *   product of two embeddings is their cosine similarity.
 * - WebGPU constraint from the model card: keep each batch under ~2,700
 *   total tokens or some ONNX Runtime WebGPU kernels exceed a GPU dispatch
 *   limit. We enforce this with a per-batch character budget.
 */

export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";

/** Human-facing model name used throughout the UI and the design system. */
export const MODEL_DISPLAY_NAME = "EmbeddingGemma 2";

/** Expected dimension for this model; validated at runtime, not assumed. */
export const EXPECTED_EMBEDDING_DIM = 768;

/** Model quantization per backend. q4 is the card's recommended WebGPU dtype. */
export const DTYPE_BY_BACKEND: Record<InferenceBackend, "q4"> = {
  webgpu: "q4",
  wasm: "q4",
};

/**
 * Max total input characters per inference batch. Chunks average ~4 chars
 * per token, so 6,500 chars ≈ 1,600-2,200 tokens — safely under the ~2,700
 * token WebGPU dispatch limit even with worst-case tokenizers.
 */
export const BATCH_CHAR_BUDGET_WEBGPU = 6_500;
/** WASM has no GPU dispatch limit; larger batches amortize overhead. */
export const BATCH_CHAR_BUDGET_WASM = 16_000;
/** Hard cap on items per batch regardless of character budget. */
export const MAX_BATCH_ITEMS = 8;

export function buildQueryText(query: string): string {
  return `task: search result | query: ${query.trim()}`;
}

export function buildDocumentText(title: string, content: string): string {
  const safeTitle = title.trim() || "none";
  return `title: ${safeTitle} | text: ${content}`;
}

/** Group texts into inference batches under both budgets. */
export function planBatches(
  charLengths: number[],
  backend: InferenceBackend,
): number[][] {
  const budget =
    backend === "webgpu" ? BATCH_CHAR_BUDGET_WEBGPU : BATCH_CHAR_BUDGET_WASM;

  const batches: number[][] = [];
  let current: number[] = [];
  let currentChars = 0;

  charLengths.forEach((length, index) => {
    const wouldOverflow =
      current.length >= MAX_BATCH_ITEMS ||
      (current.length > 0 && currentChars + length > budget);

    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(index);
    currentChars += length;
  });

  if (current.length > 0) batches.push(current);
  return batches;
}
