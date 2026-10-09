import type { EmbedItem } from "./embedding.worker";

/**
 * Token budgeting for embedding batches.
 *
 * Kept free of any dependency on `@huggingface/transformers` so the batch
 * planner and the embedding worker share one definition of costs, and so the
 * numbers can be verified in Node without loading a 470 MB model.
 */

/** Text is roughly one token per four characters. */
export const TOKENS_TEXT_PER_CHAR = 1 / 4;

/** One image consumes the model card's default 280-token vision budget. */
export const TOKENS_PER_IMAGE = 280;

/** Video is charged per frame at 140 tokens each, at 1 frame per second. */
export const TOKENS_PER_VIDEO_FRAME = 140;

/** Audio is charged per second, mono at 16 kHz. */
export const TOKENS_PER_AUDIO_SECOND = 25;

/**
 * Largest total token count allowed in one batch.
 *
 * The model card is explicit: on WebGPU, some ONNX Runtime kernels exceed a GPU
 * dispatch limit above roughly 2,700 tokens, counting text, image frames and
 * audio together. WASM has no such limit and is bounded by memory instead.
 */
export const MAX_BATCH_TOKENS = {
  webgpu: 2_600,
  wasm: 16_000,
} as const;

/** Assumed clip length for items whose duration is only known after decoding. */
const ASSUMED_AUDIO_SECONDS = 30;
/** Assumed frame count for video items whose frames are not yet decoded. */
const ASSUMED_VIDEO_FRAMES = 16;

/** Rough per-item token cost, used only for batch planning. */
export function estimateTokens(item: EmbedItem): number {
  switch (item.modality) {
    case "text":
      return item.text.length * TOKENS_TEXT_PER_CHAR;
    case "image":
      return TOKENS_PER_IMAGE;
    case "video":
      return (item.frames?.length ?? ASSUMED_VIDEO_FRAMES) * TOKENS_PER_VIDEO_FRAME;
    case "audio":
      return ASSUMED_AUDIO_SECONDS * TOKENS_PER_AUDIO_SECOND;
  }
}

/** Group flat item indices into batches under the backend's token budget. */
export function planItemBatches(
  items: EmbedItem[],
  backend: "webgpu" | "wasm",
): number[][] {
  const budget = MAX_BATCH_TOKENS[backend];

  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;

  items.forEach((item, index) => {
    const tokens = estimateTokens(item);
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(index);
    currentTokens += tokens;
  });

  if (current.length > 0) batches.push(current);
  return batches;
}
