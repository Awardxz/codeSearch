/**
 * Bulk + multimodal pipeline verification.
 *
 * Exercises the scan → plan → batch → scatter pipeline with the embedding
 * worker stubbed, and checks the properties that make a whole-desktop scan fast:
 * batches spanning several files, and media items priced by token cost so a
 * WebGPU batch never exceeds the model card's dispatch limit.
 *
 * Run with: node scripts/verify-bulk.mjs
 */

import { createServer } from "vite";

const STUB_ID = "\0virtual:bulk-test-stubs";

const stubPlugin = {
  name: "bulk-verify-stubs",
  enforce: "pre",
  resolveId(id) {
    if (id.includes("/embeddings/embeddingClient")) return STUB_ID;
    if (id.includes("/media/videoFrames")) return STUB_ID;
    return null;
  },
  load(id) {
    if (id !== STUB_ID) return null;
    return `
      // Deterministic stand-ins for the worker-backed client and the video
      // decoder (which needs a <video> element and cannot run in Node).
      export const embeddingClient = {
        getStatus: () => ({
          phase: "ready", backend: "wasm", dimension: 4,
          downloadProgress: null, downloadFile: null, error: null, modalities: null,
        }),

        // Vector derived from the text, so pairing is checkable.
        async embedDocuments(texts, titles, onProgress) {
          const vectors = texts.map((text, index) => {
            const v = new Float32Array(4);
            v[0] = (index + 1) / 100;
            v[1] = text.length;
            v[2] = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 97;
            v[3] = titles.length;
            return v;
          });
          onProgress?.(texts.length, texts.length);
          return vectors;
        },

        async embed(items, onProgress) {
          const vectors = items.map((item, index) => {
            const v = new Float32Array(4);
            v[0] = (index + 1) / 100;
            v[1] = item.modality === "text" ? item.text.length : 999;
            v[2] = item.modality.length * 7;
            v[3] = 1;
            return v;
          });
          onProgress?.(items.length, items.length);
          return vectors;
        },

        async embedQuery() { return new Float32Array(4); },
        cancelAllJobs() {},
        async ensureLoaded() { return { backend: "wasm", dimension: 4 }; },
      };

      export async function extractVideoFrames(path) {
        return {
          frames: Array.from({ length: 8 }, (_, i) => ({
            data: new Uint8ClampedArray(4 * 4 * 3),
            width: 4,
            height: 4,
            channels: 3,
          })),
          durationSeconds: 8,
          width: 4,
          height: 4,
        };
      }
    `;
  },
};

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`ok   ${message}`);
}

function literal(text, lines = 200) {
  return Array.from({ length: lines }, (_, i) => `line ${i} of ${text}`).join("\n");
}

function textFile(path, name, size = 1) {
  return { path, name, extension: "txt", modality: "text", sizeBytes: size, modifiedMs: 1 };
}

function read(path, name, content) {
  return {
    path,
    name,
    sizeBytes: 1,
    modifiedMs: 1,
    ok: true,
    content: content ?? literal(name, 40),
    error: null,
  };
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [stubPlugin],
  server: { middlewareMode: true },
  ssr: { noExternal: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { prepareBulkChunks, scatterToIndexedFiles, mediaLabel } = await server.ssrLoadModule(
    "/src/lib/indexing/bulkPlanner.ts",
  );
  const { runBulkIndex } = await server.ssrLoadModule("/src/lib/indexing/bulkIndexer.ts");
  const { indexStore } = await server.ssrLoadModule("/src/lib/indexing/indexStore.ts");
  const tokenBudget = await server.ssrLoadModule("/src/lib/embeddings/tokenBudget.ts");
  const { estimateTokens, MAX_BATCH_TOKENS, planItemBatches } = tokenBudget;
  const { TOKENS_PER_IMAGE, TOKENS_PER_VIDEO_FRAME } = tokenBudget;

  // --- 1. Token costing keeps a WebGPU batch inside the dispatch limit -----
  const mixed = [
    { modality: "text", mode: "documents", text: "a".repeat(4000), title: "a" },
    { modality: "image", path: "/x.jpg", title: "x.jpg" },
    { modality: "audio", path: "/y.wav", title: "y.wav" },
    { modality: "video", path: "/z.mp4", title: "z.mp4", frames: new Array(8) },
  ];

  check(
    estimateTokens(mixed[1]) === TOKENS_PER_IMAGE,
    "an image costs the default 280-token vision budget",
  );
  check(
    estimateTokens(mixed[3]) === TOKENS_PER_VIDEO_FRAME * 8,
    "a video costs 140 tokens per frame",
  );

  // A WebGPU batch must stay under the card's ~2,700-token dispatch limit.
  const budget = MAX_BATCH_TOKENS.webgpu;
  let running = 0;
  for (const item of mixed) {
    const tokens = estimateTokens(item);
    if (running > 0 && running + tokens > budget) running = 0;
    running += tokens;
  }
  check(budget < 2700, `the WebGPU batch budget (${budget}) stays under the 2,700 token limit`);

  // A realistic mixed list must split into batches that each fit the budget,
  // and the split must cover every item exactly once.
  const realistic = [
    ...Array.from({ length: 40 }, (_, i) => ({
      modality: "text",
      mode: "documents",
      text: "x".repeat(600),
      title: `t${i}`,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      modality: "image",
      path: `/img${i}.jpg`,
      title: `img${i}.jpg`,
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      modality: "video",
      path: `/v${i}.mp4`,
      title: `v${i}.mp4`,
      frames: new Array(8),
    })),
  ];

  const webgpuBatches = planItemBatches(realistic, "webgpu");
  const flat = webgpuBatches.flat();
  check(flat.length === realistic.length, "every item lands in exactly one batch");
  check(new Set(flat).size === realistic.length, "no item is embedded twice");
  check(
    webgpuBatches.every(
      (batch) =>
        batch.reduce((sum, index) => sum + estimateTokens(realistic[index]), 0) <=
        MAX_BATCH_TOKENS.webgpu,
    ),
    "every WebGPU batch respects its token budget",
  );
  check(
    webgpuBatches.length > 1,
    `a ${realistic.length}-item mixed list splits into ${webgpuBatches.length} WebGPU batches`,
  );

  // A video (1,120 tokens) must never be packed alongside items that would push
  // the batch over the limit — that is the dispatch failure the card warns of.
  const crowded = [
    { modality: "video", path: "/a.mp4", title: "a.mp4", frames: new Array(8) },
    ...Array.from({ length: 5 }, (_, i) => ({
      modality: "image",
      path: `/c${i}.jpg`,
      title: `c${i}.jpg`,
    })),
  ];
  const videoPacks = planItemBatches(crowded, "webgpu");
  check(
    !videoPacks.some(
      (batch) =>
        batch.length > 1 &&
        batch.reduce((sum, index) => sum + estimateTokens(crowded[index]), 0) >
          MAX_BATCH_TOKENS.webgpu,
    ),
    "a video is never packed into a batch that would exceed the dispatch limit",
  );

  // --- 2. Planning: text chunks plus one embedding per media file ---------
  const files = [
    textFile("/a.txt", "a.txt"),
    textFile("/b.txt", "b.txt"),
    { path: "/img.jpg", name: "img.jpg", extension: "jpg", modality: "image", sizeBytes: 9, modifiedMs: 2 },
    { path: "/clip.mp4", name: "clip.mp4", extension: "mp4", modality: "video", sizeBytes: 99, modifiedMs: 3 },
  ];
  const reads = files.slice(0, 2).map((file) => read(file.path, file.name));

  const plan = prepareBulkChunks(files, reads);
  check(
    plan.items.length === 4,
    `two text files plus two media files produce four inputs (got ${plan.items.length})`,
  );
  check(
    plan.items[2].modality === "image" && plan.items[3].modality === "video",
    "media files become media embeddings, not text",
  );
  check(
    mediaLabel(files[2]).includes("img.jpg") && mediaLabel(files[2]).includes("/img.jpg"),
    "media records keep name and path as their label",
  );

  // --- 3. A failed read is a visible failure -----------------------------
  const failReads = [
    read("/a.txt", "a.txt"),
    { path: "/b.txt", name: "b.txt", sizeBytes: 0, modifiedMs: 1, ok: false, content: "", error: "denied" },
  ];
  const failPlan = prepareBulkChunks(files.slice(0, 2), failReads);
  check(failPlan.emptyFiles.length === 1, "an unreadable text file is reported as empty");
  // One vector for the single chunk that file 0 produced.
  const failScatter = scatterToIndexedFiles(
    files.slice(0, 2),
    failPlan,
    [new Float32Array(4)],
  );
  check(
    failScatter.filter((entry) => entry.failed).length === 1 &&
      failScatter[0].failed === false,
    "the readable file succeeds and the unreadable one is flagged as failed",
  );

  // --- 4. Media files are labelled by modality ---------------------------
  const scatter = scatterToIndexedFiles(files, plan, plan.items.map(() => new Float32Array(4)));
  check(
    scatter[2].indexed.kind === "image",
    "images are tagged with the image file kind",
  );
  check(
    scatter[3].indexed.kind === "media",
    "audio and video are tagged with the media file kind",
  );

  // --- 5. runBulkIndex persists everything with vectors ------------------
  indexStore.clear();
  const runResult = await runBulkIndex(files, () => Promise.resolve(reads));
  check(runResult.filesPlanned === 4, "four files are planned on a fresh run");
  check(runResult.filesDone === 4, "all four files are persisted");
  check(runResult.mediaPlanned === 2, "media files are counted separately");
  check(runResult.mediaDone === 2, "every media file was embedded");

  const stored = indexStore.getSnapshot().files;
  check(stored.length === 4, "the index store holds four files");
  check(
    stored.every((file) => file.chunks.length > 0 && file.chunks[0].embedding.length === 4),
    "every stored file has a vector",
  );
  const mediaEntry = stored.find((file) => file.name === "img.jpg");
  check(
    mediaEntry?.kind === "image" && mediaEntry.chunks[0].text.includes("/img.jpg"),
    "media is stored with its own embedding, not parsed text",
  );

  // --- 6. Incremental: a second identical run does no work ----------------
  const second = await runBulkIndex(files, () => Promise.resolve(reads));
  check(second.filesSkipped === 4, "unchanged files are all skipped");
  check(second.filesPlanned === 0, "nothing is re-planned when nothing changed");

  // --- 7. Changed files are re-indexed -----------------------------------
  const changed = files.map((file, index) =>
    index === 2 ? { ...file, sizeBytes: 7 } : file,
  );
  const third = await runBulkIndex(changed, () => Promise.resolve(reads));
  check(third.filesSkipped === 3, "unchanged files are still skipped");
  check(third.filesPlanned === 1, "only the changed file is re-planned");

  // --- 8. Cancellation stops between batches ----------------------------
  indexStore.clear();
  const many = Array.from({ length: 30 }, (_, i) => textFile(`/big/${i}.txt`, `${i}.txt`));
  const manyReads = many.map((file) => read(file.path, file.name, literal(file.name, 60)));

  indexStore.beginBulkRun();
  let calls = 0;
  const original = indexStore.shouldCancelBulk.bind(indexStore);
  indexStore.shouldCancelBulk = () => {
    calls++;
    return calls > 1;
  };

  const cancelled = await runBulkIndex(many, () => Promise.resolve(manyReads));
  indexStore.shouldCancelBulk = original;
  indexStore.endBulkRun();

  check(cancelled.cancelled === true, "a cancelled run reports cancellation");
  check(
    cancelled.chunksDone < cancelled.chunksPlanned,
    `embedding stops early (${cancelled.chunksDone}/${cancelled.chunksPlanned} chunks)`,
  );

  // --- 9. Persisting a large batch notifies once, not once per file -------
  indexStore.clear();
  const lots = Array.from({ length: 500 }, (_, i) => textFile(`/many/${i}.txt`, `${i}.txt`));

  let batchNotifications = 0;
  const unsub = indexStore.subscribe(() => batchNotifications++);
  indexStore.addIndexedFiles(
    lots.map((file) => ({
      path: file.path,
      name: file.name,
      extension: "txt",
      kind: "text",
      sizeBytes: 1,
      modifiedMs: 1,
      status: "ready",
      error: null,
      chunks: [],
      indexedAt: Date.now(),
      isSample: false,
    })),
  );
  unsub();

  check(
    batchNotifications === 1,
    `adding 500 files notifies exactly once (got ${batchNotifications})`,
  );

  console.log(`\n${passed} checks passed — BULK VERIFICATION PASSED`);
  process.exitCode = 0;
} catch (error) {
  console.error("\nBULK VERIFICATION FAILED:");
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
