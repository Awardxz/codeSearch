import type { InferenceBackend } from "../../types";
import {
  BATCH_CHAR_BUDGET_WASM,
  BATCH_CHAR_BUDGET_WEBGPU,
  MAX_BATCH_ITEMS,
} from "../embeddings/config";

/**
 * Group flat chunk lengths into embedding batches.
 *
 * Re-exported from `config.planBatches` so both the single-file worker path and
 * the bulk path share one definition of what "a batch" is — they must agree or
 * the bulk pipeline will send batches the model card says are too large.
 */
export function plannedBatches(
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

export { BATCH_CHAR_BUDGET_WASM, BATCH_CHAR_BUDGET_WEBGPU, MAX_BATCH_ITEMS };
