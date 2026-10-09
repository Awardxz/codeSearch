/**
 * Embedding worker: owns the EmbeddingGemma 2 model and all inference.
 *
 * Running inference off the main thread keeps the UI responsive during model
 * download, initialization, and batched embedding. The main thread talks to
 * this worker exclusively through `embeddingClient.ts`.
 *
 * The model is multimodal: text, images, audio and video all project into one
 * shared 768-dimensional space, so a text query can retrieve a photo and vice
 * versa. Encoders are loaded selectively — a text-only session never downloads
 * the 104 MB vision or 180 MB audio weights.
 */

import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  RawImage,
  RawVideo,
  read_audio,
  load_video,
  env,
} from "@huggingface/transformers";
import {
  DTYPE_BY_BACKEND,
  MODEL_ID,
  buildDocumentText,
  buildQueryText,
} from "./config";
import type { AppError, InferenceBackend } from "../../types";
import { toAppError } from "../../types";

// Model assets come from the Hugging Face Hub on first use and are then served
// from the browser Cache API; never look for a bundled /models copy.
env.allowLocalModels = false;

// --- Worker protocol -------------------------------------------------------

/** Which encoders to load. Unused encoders are neither downloaded nor held. */
export type Modalities = {
  text: boolean;
  vision: boolean;
  audio: boolean;
};

/** Messages the main thread can send. */
export type WorkerRequest =
  | { kind: "load"; modalities: Modalities }
  | { kind: "cancel"; jobId: number }
  | { kind: "embed"; jobId: number; items: EmbedItem[] };

/**
 * A media input. All media items are identified by a path and a title;
 * `frames` and `durationSeconds` only apply to video.
 */
export type EmbedMediaItem = {
  modality: "image" | "audio" | "video";
  path: string;
  title: string;
  /** Video frames decoded on the main thread (`<video>` needs a DOM), or null
   *  to let the worker decode them with `load_video`. */
  frames?: SerializedFrame[] | null;
  durationSeconds?: number;
};

export type EmbedItem =
  | {
      modality: "text";
      mode: "documents" | "query";
      /** Raw text; the worker applies the task instruction prefix. */
      text: string;
      title: string;
    }
  | EmbedMediaItem;

/** A video frame as plain data, so it can cross `postMessage`. */
export type SerializedFrame = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 3;
};

/** Messages the worker sends back. */
export type WorkerEvent =
  | {
      kind: "load-progress";
      file: string | null;
      progress: number;
      loaded: number;
      total: number;
    }
  | {
      kind: "load-result";
      backend: InferenceBackend;
      dimension: number;
      modalities: Modalities;
    }
  | { kind: "embed-progress"; jobId: number; done: number; total: number }
  | {
      kind: "embed-result";
      jobId: number;
      embeddings: number[][];
      dimension: number;
    }
  | { kind: "job-error"; jobId: number; error: AppError }
  | { kind: "job-cancelled"; jobId: number };

interface WorkerScope {
  postMessage(message: WorkerEvent): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

// --- Model state -----------------------------------------------------------

/** Loosely-typed handles to the transformers.js model and processor. */
type Processor = {
  (
    text: string[] | null,
    images?: unknown,
    audio?: unknown,
    videos?: unknown,
  ): Promise<unknown>;
  image_processor?: { max_soft_tokens: number };
};
type Model = {
  (inputs: unknown): Promise<{ sentence_embedding?: Tensor; [key: string]: unknown }>;
  dispose?: () => void;
};
type Tensor = {
  dims: number[];
  tolist(): number[][];
};

let processor: Processor | null = null;
let model: Model | null = null;
let activeBackend: InferenceBackend | null = null;
/** Encoders currently loaded; checked before accepting media inputs. */
const loadedModalities: Modalities = { text: true, vision: false, audio: false };
let embeddingDimension: number | null = null;
let loadPromise: Promise<{
  backend: InferenceBackend;
  dimension: number;
  modalities: Modalities;
}> | null = null;

const cancelledJobs = new Set<number>();

// --- Modality token costs ---------------------------------------------------
//
// From the model card. All modalities share one 8,192-token context and, on
// WebGPU, each batch must stay under roughly 2,700 tokens or some ONNX Runtime
// kernels exceed a GPU dispatch limit. Costs live in ./tokenBudget so the
// planner here and the bulk indexer cannot disagree.

import { planItemBatches } from "./tokenBudget";

// --- Backend detection and loading -----------------------------------------

type MinimalWebGPU = {
  requestAdapter(): Promise<unknown>;
};

async function detectBackend(): Promise<InferenceBackend> {
  try {
    const gpu = (navigator as { gpu?: MinimalWebGPU }).gpu;
    if (!gpu) return "wasm";
    const adapter = await gpu.requestAdapter();
    if (!adapter) return "wasm";
    return "webgpu";
  } catch {
    return "wasm";
  }
}

async function loadWith(
  backend: InferenceBackend,
  modalities: Modalities,
): Promise<void> {
  // Selective encoder loading: dropping a config stops the weights from being
  // downloaded or allocated, which is the documented way to cut the footprint
  // from 740M parameters down to what the workload actually needs.
  const loaded = await AutoConfig.from_pretrained(MODEL_ID);
  const config: Record<string, unknown> = { ...loaded };
  if (!modalities.vision) config.vision_config = null;
  if (!modalities.audio) config.audio_config = null;

  processor = (await AutoProcessor.from_pretrained(
    MODEL_ID,
  )) as unknown as Processor;
  model = (await AutoModel.from_pretrained(MODEL_ID, {
    device: backend,
    dtype: DTYPE_BY_BACKEND[backend],
    config,
  } as unknown as Parameters<typeof AutoModel.from_pretrained>[1])) as unknown as Model;
}

async function loadModel(modalities: Modalities): Promise<{
  backend: InferenceBackend;
  dimension: number;
  modalities: Modalities;
}> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const preferred = await detectBackend();
    // WebGPU fails over to wasm; a failed wasm attempt is final.
    const attemptOrder: InferenceBackend[] =
      preferred === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];

    let lastError: unknown = null;

    for (const backend of attemptOrder) {
      try {
        await loadWith(backend, modalities);

        // Authoritative probe: run a tiny text inference to validate the
        // backend and capture the real output shape before any indexing work.
        const probeInputs = await processor!(["probe"]);
        const probe = await model!(probeInputs);
        const vector = probe.sentence_embedding ?? (probe as unknown as Tensor);
        if (!vector.dims || vector.dims.length !== 2) {
          throw new Error(
            `Unexpected pooled output shape [${vector.dims?.join(", ")}]; expected [batch, dimension].`,
          );
        }

        // Record the loaded encoders so a media input reaches the model only
        // when its encoder is resident, and is rejected clearly when it is not.
        loadedModalities.vision = modalities.vision;
        loadedModalities.audio = modalities.audio;
        embeddingDimension = vector.dims[1];
        activeBackend = backend;
        return { backend, dimension: embeddingDimension, modalities };
      } catch (error) {
        lastError = error;
        processor = null;
        model = null;
        activeBackend = null;
        loadedModalities.vision = false;
        loadedModalities.audio = false;
        embeddingDimension = null;
      }
    }

    loadPromise = null;
    throw lastError ?? new Error("Model initialization failed.");
  })();

  return loadPromise;
}

// --- Media decoding ---------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
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

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function mimeFor(path: string): string {
  return MIME_BY_EXTENSION[extensionOf(path)] ?? "application/octet-stream";
}

/** Read a media file's bytes through the Rust command. */
async function readMediaBlob(path: string): Promise<Blob> {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<ArrayBuffer>("read_media_bytes", { path });
  return new Blob([bytes], { type: mimeFor(path) });
}

/** Decode an image file into the RawImage the vision encoder expects. */
async function loadRawImage(path: string): Promise<RawImage> {
  const blob = await readMediaBlob(path);
  return RawImage.fromBlob(blob);
}

/** Decode an audio file to mono 16 kHz PCM, as the audio encoder expects. */
async function loadAudio(path: string): Promise<Float32Array> {
  const blob = await readMediaBlob(path);
  const url = URL.createObjectURL(blob);
  try {
    return await read_audio(url, 16000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- Embedding --------------------------------------------------------------

/**
 * Embed a batch, returning one vector per input in input order.
 *
 * Each modality gets its own processor call on purpose. The processor treats a
 * flat image list as ONE interleaved input, so a batch mixing text and media
 * cannot be sent in a single call without losing track of which output row
 * belongs to which file. The model card's own examples always pass one modality
 * range at a time, so this mirrors that.
 */
async function embedBatch(items: EmbedItem[]): Promise<Float32Array[]> {
  if (!model || !processor) {
    throw new Error("Model is not loaded.");
  }

  for (const item of items) {
    if (item.modality === "image" || item.modality === "video") {
      if (!loadedModalities.vision) {
        throw new Error(
          "The vision encoder is not loaded, so images and video cannot be embedded.",
        );
      }
    }
    if (item.modality === "audio" && !loadedModalities.audio) {
      throw new Error(
        "The audio encoder is not loaded, so audio cannot be embedded.",
      );
    }
  }

  const results: Float32Array[] = new Array(items.length);

  // Group input indices by modality, preserving order within each group.
  const byModality = new Map<string, number[]>();
  items.forEach((item, index) => {
    const group = byModality.get(item.modality) ?? [];
    group.push(index);
    byModality.set(item.modality, group);
  });

  const textSlots = byModality.get("text") ?? [];
  const imageSlots = byModality.get("image") ?? [];
  const audioSlots = byModality.get("audio") ?? [];
  const videoSlots = byModality.get("video") ?? [];

  // --- Text: a flat string array yields one row per input. ---
  if (textSlots.length > 0) {
    const texts = textSlots.map((slot) => {
      const item = items[slot];
      if (item.modality !== "text") return "";
      return item.mode === "query"
        ? buildQueryText(item.text)
        : buildDocumentText(item.title, item.text);
    });
    assignRows(results, textSlots, await runModel(texts, null, null, null));
  }

  // --- Images: one single-image list per input. ---
  if (imageSlots.length > 0) {
    const images: RawImage[] = [];
    for (const slot of imageSlots) {
      const item = items[slot];
      if (item.modality === "image") images.push(await loadRawImage(item.path));
    }
    assignRows(
      results,
      imageSlots,
      await runModel(null, images.map((image) => [image]), null, null),
    );
  }

  // --- Audio: one clip per input, mono 16 kHz. ---
  if (audioSlots.length > 0) {
    const clips: Float32Array[] = [];
    for (const slot of audioSlots) {
      const item = items[slot];
      if (item.modality === "audio") clips.push(await loadAudio(item.path));
    }
    assignRows(
      results,
      audioSlots,
      await runModel(null, null, clips.map((clip) => [clip]), null),
    );
  }

  // --- Video: one frame list per input. ---
  if (videoSlots.length > 0) {
    const videos: RawVideo[] = [];
    for (const slot of videoSlots) {
      const item = items[slot];
      if (item.modality !== "video") continue;
      videos.push(
        item.frames && item.frames.length > 0
          ? new RawVideo(
              item.frames.map(
                (frame) =>
                  new RawImage(frame.data, frame.width, frame.height, frame.channels),
              ),
              item.frames.length,
            )
          : await loadVideoFrames(item.path),
      );
    }
    assignRows(
      results,
      videoSlots,
      await runModel(null, null, null, videos.map((video) => [video])),
    );
  }

  return results;
}

/** Run the model on one set of inputs and return its rows. */
async function runModel(
  texts: string[] | null,
  images: unknown,
  audios: unknown,
  videos: unknown,
): Promise<number[][]> {
  if (!model || !processor) {
    throw new Error("Model is not loaded.");
  }

  const inputs = await processor(texts, images, audios, videos);
  const output = await model(inputs);
  const tensor = output.sentence_embedding ?? (output as unknown as Tensor);

  const dims = tensor.dims;
  if (!dims || dims.length !== 2) {
    throw new Error(
      `Unexpected pooled output shape [${dims?.join(", ")}]; expected [batch, dimension].`,
    );
  }
  const dimension = dims[1];
  if (embeddingDimension === null) {
    embeddingDimension = dimension;
  } else if (embeddingDimension !== dimension) {
    throw new Error(
      `Embedding dimension changed mid-run (${embeddingDimension} -> ${dimension}); refusing to mix incompatible vectors.`,
    );
  }

  return tensor.tolist();
}

/** Copy the rows for one modality back into their input slots. */
function assignRows(
  results: Float32Array[],
  slots: number[],
  rows: number[][],
): void {
  if (rows.length !== slots.length) {
    throw new Error(
      `Model returned ${rows.length} embeddings for ${slots.length} inputs of the same modality.`,
    );
  }
  slots.forEach((slot, position) => {
    results[slot] = new Float32Array(rows[position]);
  });
}

/** Fallback for video when the main thread did not extract frames. */
async function loadVideoFrames(path: string): Promise<RawVideo> {
  const blob = await readMediaBlob(path);
  const url = URL.createObjectURL(blob);
  try {
    return await load_video(url, { fps: 1, num_frames: 16 });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleEmbed(request: Extract<WorkerRequest, { kind: "embed" }>) {
  const { jobId, items } = request;

  if (!model || !processor) {
    throw new Error("Model is not loaded.");
  }

  cancelledJobs.delete(jobId);

  const backend = activeBackend ?? "wasm";
  const batches = planItemBatches(items, backend);

  const results: Float32Array[] = new Array(items.length);
  let done = 0;

  for (const batch of batches) {
    if (cancelledJobs.has(jobId)) {
      scope.postMessage({ kind: "job-cancelled", jobId });
      return;
    }

    const batchItems = batch.map((index) => items[index]);
    const vectors = await embedBatch(batchItems);

    batch.forEach((itemIndex, position) => {
      results[itemIndex] = vectors[position];
    });

    done += batch.length;
    scope.postMessage({ kind: "embed-progress", jobId, done, total: items.length });
  }

  scope.postMessage({
    kind: "embed-result",
    jobId,
    embeddings: results.map((vector) => Array.from(vector)),
    dimension: embeddingDimension ?? 0,
  });
}

// --- Message loop ----------------------------------------------------------

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind === "cancel") {
    cancelledJobs.add(request.jobId);
    return;
  }

  if (request.kind === "load") {
    try {
      const { backend, dimension, modalities } = await loadModel(request.modalities);
      scope.postMessage({
        kind: "load-result",
        backend,
        dimension,
        modalities,
      });
    } catch (error) {
      scope.postMessage({
        kind: "job-error",
        jobId: -1,
        error: toAppError(error),
      });
    }
    return;
  }

  if (request.kind === "embed") {
    try {
      await handleEmbed(request);
    } catch (error) {
      cancelledJobs.delete(request.jobId);
      scope.postMessage({
        kind: "job-error",
        jobId: request.jobId,
        error: toAppError(error),
      });
    }
  }
};
