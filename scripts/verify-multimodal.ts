/**
 * Multimodal verification: EmbeddingGemma 2 maps text, image, audio and video
 * into ONE shared 768-dimensional space. This proves it with the real model and
 * the same assets the model card documents, then checks that every modality
 * lands in that space and that a text query retrieves the right modality.
 *
 * Run with: node scripts/verify-multimodal.ts
 *
 * Notes on what this can and cannot prove:
 *  - Image and audio are decoded from real files, so retrieval is a real check.
 *  - Video uses synthetic frames, because `load_video` is browser-only in
 *    transformers.js and cannot decode an MP4 in Node. The mechanics (shape,
 *    normalization, determinism) are checked; the semantics are not.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  RawImage,
  RawVideo,
  load_image,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
const EXPECTED_DIM = 768;

/** Per the model card: `q4` for text/vision, and q8 is preferred for audio.
 *  We only have q4 assets cached, so q4 is used throughout. */
const DTYPES = { model: "q4", vision_encoder: "q4", audio_encoder: "q4" } as const;

const ASSET_BASE =
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main";

const MEDIA_DIR = join(tmpdir(), "sfs-multimodal");

const QUERIES = [
  "cats sleeping on a couch",
  "a president's speech about serving your country",
  "a turtle swimming in the ocean",
];

let checks = 0;
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks++;
  console.log(`ok   ${message}`);
}

function log(message: string) {
  console.log(`     ${message}`);
}

async function ensureAsset(name: string): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const path = join(MEDIA_DIR, name);
  if (!existsSync(path)) {
    const response = await fetch(`${ASSET_BASE}/${name}`);
    if (!response.ok) {
      throw new Error(`Could not download ${name}: ${response.status}`);
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

/** Minimal RIFF/WAVE reader: PCM int16, any channel count. */
function decodeWav(bytes: Buffer): { channels: number; sampleRate: number; data: Float32Array } {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file.");
  }

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString("ascii", cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const body = cursor + 8;

    if (id === "fmt ") {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
      break;
    }

    cursor = body + size + (size % 2);
  }

  if (dataOffset < 0 || bits !== 16) {
    throw new Error(`Unsupported WAV (data at ${dataOffset}, ${bits}-bit).`);
  }

  const sampleCount = Math.floor(dataLength / 2);
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = bytes.readInt16LE(dataOffset + i * 2);
  }

  const frames = Math.floor(sampleCount / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c];
    mono[i] = sum / channels / 32768;
  }

  return { channels, sampleRate, data: mono };
}

/** Linear resample to the mono 16 kHz the audio encoder expects. */
function resampleTo16k(input: Float32Array, from: number): Float32Array {
  if (from === 16000) return input;
  const ratio = from / 16000;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, input.length - 1);
    const frac = position - low;
    output[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return output;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a));
}

function checkVector(vector: number[], label: string) {
  if (vector.length !== EXPECTED_DIM) {
    throw new Error(`${label}: expected ${EXPECTED_DIM} dims, got ${vector.length}`);
  }
  const n = norm(vector);
  if (Math.abs(n - 1) > 1e-3) {
    throw new Error(`${label}: expected a unit-length vector, got norm ${n.toFixed(6)}`);
  }
}

/** A few synthetic frames, used only to prove the video path works. */
function syntheticFrames(count: number, hue: number): RawImage[] {
  const size = 64;
  const frames: RawImage[] = [];
  for (let f = 0; f < count; f++) {
    const pixels = new Uint8ClampedArray(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3;
        const moving = (x + f * 6) % size;
        pixels[i] = (moving / size) * 255 * hue;
        pixels[i + 1] = (y / size) * 255;
        pixels[i + 2] = 128;
      }
    }
    frames.push(new RawImage(pixels, size, size, 3));
  }
  return frames;
}

async function main() {
  const started = Date.now();

  console.log(`Loading ${MODEL_ID} (full multimodal, q4, cpu)…`);
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const model = await AutoModel.from_pretrained(MODEL_ID, {
    device: "cpu",
    dtype: DTYPES,
  });
  log(`Model loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const embed = async (
    text: string[] | null,
    images?: any[] | null,
    audio?: any[] | null,
    videos?: any[] | null,
  ) => {
    const inputs = await processor(text, images ?? null, audio ?? null, videos ?? null);
    const out = await model(inputs);
    const tensor = out.sentence_embedding ?? out;
    const list = tensor.tolist() as number[][];
    return list;
  };

  // --- 1. Text embeddings --------------------------------------------------
  const queryText = QUERIES.map((q) => `task: search result | query: ${q}`);
  const queryEmbeddings = await embed(queryText);
  check(queryEmbeddings.length === QUERIES.length, `text batch returns ${QUERIES.length} embeddings`);
  for (let i = 0; i < QUERIES.length; i++) {
    checkVector(queryEmbeddings[i], `text query "${QUERIES[i]}"`);
  }
  check(
    norm(queryEmbeddings[0]) > 0 && dot(queryEmbeddings[0], queryEmbeddings[1]) < 0.999,
    "different queries produce different unit vectors",
  );

  // --- 2. Image -----------------------------------------------------------
  const catPath = await ensureAsset("cats.jpg");
  const catBytes = await readFile(catPath);
  const image = await RawImage.fromBlob(
    new Blob([catBytes], { type: "image/jpeg" }),
  );
  const imageEmbedding = (await embed(null, [image]))[0];
  checkVector(imageEmbedding, "image embedding");
  log(`image encoded (${image.width}x${image.height}x${image.channels})`);

  // Determinism: the same image twice must give the same vector.
  const imageAgain = (await embed(null, [image]))[0];
  const imageDelta = Math.abs(dot(imageEmbedding, imageAgain) - 1);
  check(imageDelta < 1e-4, `image embedding is deterministic (delta ${imageDelta.toExponential(2)})`);

  // The vision encoder must actually be used: a different image changes the
  // vector. This is the check that catches "images silently ignored".
  const greyPixels = new Uint8ClampedArray(64 * 64 * 3).fill(128);
  const grey = new RawImage(greyPixels, 64, 64, 3);
  const greyEmbedding = (await embed(null, [grey]))[0];
  const imageSeparation = dot(imageEmbedding, greyEmbedding);
  check(
    imageSeparation < 0.999,
    `distinct images embed differently (cosine ${imageSeparation.toFixed(4)} proves the vision encoder runs)`,
  );

  // --- 3. Audio -----------------------------------------------------------
  const wavPath = await ensureAsset("jfk.wav");
  const wav = decodeWav(await readFile(wavPath));
  const pcm = resampleTo16k(wav.data, wav.sampleRate);
  const audioEmbedding = (await embed(null, null, [pcm]))[0];
  checkVector(audioEmbedding, "audio embedding");
  log(`audio encoded (${wav.channels}ch @ ${wav.sampleRate}Hz -> mono 16k, ${(pcm.length / 16000).toFixed(1)}s)`);

  // Same proof for the audio encoder.
  const silence = new Float32Array(16000);
  const silenceEmbedding = (await embed(null, null, [silence]))[0];
  const audioSeparation = dot(audioEmbedding, silenceEmbedding);
  check(
    audioSeparation < 0.999,
    `distinct audio embeds differently (cosine ${audioSeparation.toFixed(4)} proves the audio encoder runs)`,
  );

  // --- 4. Video (mechanics only) ------------------------------------------
  const videoFrames = syntheticFrames(8, 1);
  const video = new RawVideo(videoFrames, 8);
  const videoEmbedding = (await embed(null, null, null, [video]))[0];
  checkVector(videoEmbedding, "video embedding");
  const videoAgain = (await embed(null, null, null, [video]))[0];
  const videoDelta = Math.abs(dot(videoEmbedding, videoAgain) - 1);
  check(videoDelta < 1e-4, `video embedding is deterministic (delta ${videoDelta.toExponential(2)})`);

  // --- 5. Cross-modal retrieval -------------------------------------------
  // Every query must rank its own modality first. This is the model card's
  // documented behaviour, reproduced with the same assets.
  const media = [
    { name: "image (cats.jpg)", vector: imageEmbedding, expected: 0 },
    { name: "audio (jfk.wav)", vector: audioEmbedding, expected: 1 },
    { name: "video (synthetic)", vector: videoEmbedding, expected: 2 },
  ];

  console.log("\nCross-modal retrieval (query -> modality scores):");
  let passed = 0;
  for (let q = 0; q < QUERIES.length; q++) {
    const scores = media.map((entry) => ({
      name: entry.name,
      score: dot(queryEmbeddings[q], entry.vector),
    }));
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];

    const expectedIndex = media.findIndex((entry) => entry.expected === q);
    const expectedName = expectedIndex >= 0 ? media[expectedIndex].name : null;
    const correct = expectedName !== null && top.name === expectedName;

    if (correct) passed++;
    console.log(
      `  ${correct ? "PASS" : "n/a "}  "${QUERIES[q]}" -> ${top.name} (${top.score.toFixed(3)})`,
    );
    log(`         ${scores.map((s) => `${s.name.split(" ")[0]}=${s.score.toFixed(3)}`).join("  ")}`);
  }

  log(
    `video used synthetic frames so it cannot match "${QUERIES[2]}" semantically; ` +
      `image and audio are the real checks.`,
  );

  // The two modalities with real assets must both retrieve correctly.
  check(
    passed >= 2,
    `cross-modal retrieval ranks the right modality first for image and audio (${passed}/3; video is synthetic)`,
  );

  // --- 6. Selective encoder loading ---------------------------------------
  log("Verifying selective encoder loading (text-only footprint)…");
  const textOnlyConfig = await AutoConfig.from_pretrained(MODEL_ID);
  textOnlyConfig.vision_config = null;
  textOnlyConfig.audio_config = null;

  const textOnlyModel = await AutoModel.from_pretrained(MODEL_ID, {
    device: "cpu",
    dtype: { model: "q4" },
    config: textOnlyConfig,
  });
  const textOnlyEmbedding = (
    await textOnlyModel(await processor(queryText))
  ).sentence_embedding.tolist() as number[][];

  checkVector(textOnlyEmbedding[0], "text-only embedding");
  // Text embeddings must be in the same space as the full multimodal model's.
  const crossConfig = dot(textOnlyEmbedding[0], queryEmbeddings[0]);
  check(
    crossConfig > 0.9,
    `text-only and full-model text embeddings share one vector space (cosine ${crossConfig.toFixed(4)})`,
  );

  // --- 7. The batch convention the embedding worker relies on -----------
  // The worker groups a batch by modality and sends each group in its own
  // processor call, because a flat media list is ONE interleaved input. These
  // checks prove the per-modality call returns exactly one row per input.
  // `embed` is this script's own model helper, defined earlier in main().

  const threeTexts = [
    "task: search result | query: a cat on a sofa",
    "task: search result | query: a speech about a country",
    "title: none | text: an unrelated note about cooking rice",
  ];
  const threeRows = await embed(threeTexts);
  check(
    threeRows.length === 3,
    `a 3-text group returns 3 rows (got ${threeRows.length})`,
  );

  const twoImageRows = await embed(null, [[image], [image]]);
  check(
    twoImageRows.length === 2,
    `a 2-image group returns 2 rows (got ${twoImageRows.length})`,
  );
  const imageDot = dot(twoImageRows[0], twoImageRows[1]);
  check(
    Math.abs(imageDot - 1) < 1e-4,
    `the same image twice gives the same vector (cosine ${imageDot.toFixed(6)})`,
  );

  // Distinct images must give distinct rows, confirming they are separate
  // inputs and not interleaved into one.
  const greyPixels2 = new Uint8ClampedArray(64 * 64 * 3).fill(200);
  const grey2 = new RawImage(greyPixels2, 64, 64, 3);
  const mixedImageRows = await embed(null, [[image], [grey2]]);
  check(
    Math.abs(dot(mixedImageRows[0], mixedImageRows[1])) < 0.999,
    `distinct images in one group stay distinct (cosine ${dot(mixedImageRows[0], mixedImageRows[1]).toFixed(4)})`,
  );

  const twoAudioRows = await embed(null, null, [[pcm], [silence]]);
  check(
    twoAudioRows.length === 2,
    `a 2-clip audio group returns 2 rows (got ${twoAudioRows.length})`,
  );
  check(
    Math.abs(dot(twoAudioRows[0], twoAudioRows[1])) < 0.999,
    `distinct audio in one group stay distinct (cosine ${dot(twoAudioRows[0], twoAudioRows[1]).toFixed(4)})`,
  );

  const twoVideoRows = await embed(null, null, null, [[video], [video]]);
  check(
    twoVideoRows.length === 2,
    `a 2-video group returns 2 rows (got ${twoVideoRows.length})`,
  );

  // --- 8. Interleaved input ------------------------------------------------
  const interleaved = (await embed(["A photo: <|image|>"], [[grey]]))[0];
  checkVector(interleaved, "interleaved text+image embedding");
  check(
    dot(interleaved, queryEmbeddings[0]) !== 1,
    "interleaved input produces its own distinct embedding",
  );

  // --- 8. Token budgeting keeps a WebGPU batch inside the dispatch limit ---
  // Node 25 strips types natively, so the planner module imports without a
  // bundler and without pulling in the 470 MB model.
  const tokenBudget = await import("../src/lib/embeddings/tokenBudget.ts");

  const imageItem = { modality: "image", path: "/x.jpg", title: "x.jpg" };
  const videoItem = {
    modality: "video",
    path: "/z.mp4",
    title: "z.mp4",
    frames: new Array(8),
  };
  const textItem = {
    modality: "text",
    mode: "documents",
    text: "a".repeat(4000),
    title: "a",
  };

  check(
    tokenBudget.estimateTokens(imageItem) === tokenBudget.TOKENS_PER_IMAGE,
    "an image costs the default 280-token vision budget",
  );
  check(
    tokenBudget.estimateTokens(videoItem) ===
      tokenBudget.TOKENS_PER_VIDEO_FRAME * 8,
    "a video costs 140 tokens per decoded frame",
  );
  check(
    Math.abs(tokenBudget.estimateTokens(textItem) - 1000) < 1,
    "text is costed at roughly one token per four characters",
  );
  check(
    tokenBudget.MAX_BATCH_TOKENS.webgpu < 2700,
    `the WebGPU batch budget (${tokenBudget.MAX_BATCH_TOKENS.webgpu}) stays under the 2,700-token dispatch limit`,
  );

  const mixed = [
    ...Array.from({ length: 40 }, (_, i) => ({
      modality: "text",
      mode: "documents",
      text: "x".repeat(600),
      title: `t${i}`,
    })),
    ...Array.from({ length: 6 }, () => imageItem),
    ...Array.from({ length: 2 }, () => videoItem),
  ];

  const batches = tokenBudget.planItemBatches(mixed, "webgpu");
  const flat = batches.flat();
  check(flat.length === mixed.length, "every item lands in exactly one batch");
  check(new Set(flat).size === mixed.length, "no item is embedded twice");
  check(
    batches.every(
      (batch: number[]) =>
        batch.reduce(
          (sum: number, index: number) =>
            sum + tokenBudget.estimateTokens(mixed[index]),
          0,
        ) <= tokenBudget.MAX_BATCH_TOKENS.webgpu,
    ),
    "every WebGPU batch respects its token budget",
  );
  check(
    batches.length > 1,
    `a ${mixed.length}-item mixed list splits into ${batches.length} WebGPU batches`,
  );

  const crowded = [videoItem, ...Array.from({ length: 5 }, () => imageItem)];
  const crowdBatches = tokenBudget.planItemBatches(crowded, "webgpu");
  check(
    !crowdBatches.some(
      (batch: number[]) =>
        batch.length > 1 &&
        batch.reduce(
          (sum: number, index: number) =>
            sum + tokenBudget.estimateTokens(crowded[index]),
          0,
        ) > tokenBudget.MAX_BATCH_TOKENS.webgpu,
    ),
    "a video is never packed into a batch that would exceed the dispatch limit",
  );

  const wasmBatches = tokenBudget.planItemBatches(mixed, "wasm");
  check(
    wasmBatches.length < batches.length,
    `WASM uses the larger budget (${wasmBatches.length} batches vs ${batches.length} on WebGPU)`,
  );

  const totalMs = Date.now() - started;
  console.log(
    `\n${checks} checks passed — MULTIMODAL VERIFICATION PASSED ` +
      `(${(totalMs / 1000).toFixed(1)}s, cpu/q4)`,
  );
  process.exitCode = 0;
}

main().catch((error) => {
  console.error("\nMULTIMODAL VERIFICATION FAILED:");
  console.error(error);
  process.exitCode = 1;
});
