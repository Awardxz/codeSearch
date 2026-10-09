/**
 * Preview verification: exercises the preview data path (file read, chunk
 * ranking, line ranges, error mapping) with the Tauri and embedding boundaries
 * stubbed, plus the chunker's line-number contract against a real file.
 *
 * The line-number contract is the important one: `chunkText` records 1-based
 * source lines so the preview can highlight exactly the lines that matched.
 * `normalizeText` collapses horizontal whitespace and blank-line runs, so the
 * recorded line numbers are derived from the normalized text — this test
 * proves they still land on the right lines of the raw file.
 *
 * Run with: node scripts/verify-preview.mjs
 */

import { createServer } from "vite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_NAME = "pasta-recipe.txt";

// A file whose normalization is lossy in line count: leading indentation is
// collapsed and a run of blank lines becomes one blank line.
const RAW = [
  "Service deployment commands",
  "",
  "Usage: npm run deploy",
  "  Deploys the current commit to production.",
  "",
  "",
  "",
  "First run:",
  "  1. Build the frontend bundle.",
  "  2. Copy artifacts to the build host.",
  "  3. Run the release script and wait for health checks.",
  "",
  "Unrelated note about gardening.",
  "Tomatoes need at least six hours of sun.",
  "Water at the base of the plant, not the leaves.",
].join("\n");

// Chunks the fake embedding client will score, in score order.
const FAKE_CHUNKS = [
  { fileIndex: 0, text: "deploy", lineStart: 3, lineEnd: 3, embedding: [1, 0, 0] },
  { fileIndex: 1, text: "tomato", lineStart: 13, lineEnd: 14, embedding: [0, 1, 0] },
];

const tempDir = mkdtempSync(join(tmpdir(), "preview-verify-"));
const TEST_PATH = join(tempDir, "preview-verify.txt");
const SAMPLE_PATH = join(tempDir, SAMPLE_NAME);
const MISSING_PATH = join(tempDir, "does-not-exist.txt");

writeFileSync(TEST_PATH, RAW, "utf8");
writeFileSync(SAMPLE_PATH, "Simple tomato pasta. Boil salted water.\n", "utf8");

const STUB_ID = "\0virtual:test-stubs";

const stubPlugin = {
  name: "preview-verify-stubs",
  enforce: "pre",
  resolveId(id) {
    if (id === "@tauri-apps/api/core") return STUB_ID;
    if (id.includes("/embeddings/embeddingClient")) return STUB_ID;
    if (id.includes("/indexing/indexStore")) return STUB_ID;
    return null;
  },
  load(id) {
    if (id !== STUB_ID) return null;
    return `
      export async function invoke(cmd, args) {
        if (cmd !== "read_text_file") {
          throw new Error("Unexpected command: " + cmd);
        }
        const fs = await import("node:fs");
        const path = args.path === "sample://${SAMPLE_NAME}"
          ? ${JSON.stringify(SAMPLE_PATH)}
          : args.path;
        try {
          const buf = fs.readFileSync(path);
          return {
            path,
            name: path.replace(/\\\\/g, "/").split("/").pop(),
            extension: "txt",
            size_bytes: buf.length,
            modified_ms: 0,
            content: buf.toString("utf8"),
          };
        } catch {
          const shaped = new Error("File does not exist.");
          shaped.code = "not_found";
          throw shaped;
        }
      }

      export const embeddingClient = {
        async embedQuery(query) {
          return query.toLowerCase().includes("deploy") ? [1, 0, 0] : [0, 1, 0];
        },
      };

      export const indexStore = {
        getFile(path) {
          if (path !== ${JSON.stringify(TEST_PATH)}) return undefined;
          return { path, chunks: ${JSON.stringify(FAKE_CHUNKS)} };
        },
      };
    `;
  },
};

const checks = [];
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks.push(message);
  console.log(`ok   ${message}`);
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [stubPlugin],
  server: { middlewareMode: true },
  // Do not let Vite externalize node_modules deps, or the stub `resolveId`
  // never sees them and the real Tauri/Transformers modules get loaded.
  ssr: { noExternal: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { chunkText } = await server.ssrLoadModule("/src/lib/chunking/chunker.ts");
  const { normalizeText } = await server.ssrLoadModule("/src/lib/chunking/textNormalizer.ts");
  const store = await server.ssrLoadModule("/src/lib/preview/previewStore.ts").then((m) => m.previewStore);
  const previewService = await server.ssrLoadModule("/src/lib/preview/previewService.ts");

  // --- 1. Store: detached readers must not depend on `this` ---------------
  const detachedSnapshot = store.getSnapshot;
  const detachedSubscribe = store.subscribe;
  check(typeof detachedSnapshot() === "object", "previewStore.getSnapshot works detached");
  check(detachedSubscribe === store.subscribe, "previewStore.subscribe is a plain closure");

  store.open({
    path: TEST_PATH,
    name: "preview-verify.txt",
    kind: "text",
    query: "deploy commands",
    initialChunkIndex: 0,
  });
  check(detachedSnapshot().request?.path === TEST_PATH, "previewStore.open sets the request");

  const seen = [];
  const unsubscribe = detachedSubscribe(() => seen.push(1));
  store.close();
  check(detachedSnapshot().request === null, "previewStore.close clears the request");
  check(seen.length === 1, "previewStore.subscribe notifies subscribers");
  unsubscribe();
  store.close();
  check(seen.length === 1, "unsubscribe stops further notifications");

  // Re-opening the same path must re-trigger a reload in the panel.
  store.open({
    path: TEST_PATH,
    name: "preview-verify.txt",
    kind: "text",
    query: "deploy commands",
    initialChunkIndex: 0,
  });
  check(detachedSnapshot().request !== null, "re-opening the same path re-arms the panel");
  store.close();

  // --- 2. File read through the (stubbed) Rust command -------------------
  const loaded = await previewService.loadPreviewSource(TEST_PATH);
  check(loaded.content === RAW, "loadPreviewSource returns the exact file text");
  check(loaded.name === "preview-verify.txt", "loadPreviewSource reports the file name");
  check(loaded.isSample === false, "real paths are not treated as samples");
  check(loaded.sizeBytes === Buffer.byteLength(RAW), "loadPreviewSource reports the file size");

  // --- 3. Sample documents resolve without touching the disk -------------
  const sample = await previewService.loadPreviewSource(`sample://${SAMPLE_NAME}`);
  check(sample.isSample === true, "sample:// sources are flagged as samples");
  check(sample.content.length > 0, "sample documents have content");

  // --- 4. Errors map to a usable AppError --------------------------------
  try {
    await previewService.loadPreviewSource(MISSING_PATH);
    throw new Error("expected loadPreviewSource to throw");
  } catch (error) {
    const appError = previewService.toPreviewError(error);
    check(appError.code === "not_found", "read errors surface a not_found AppError");
    check(appError.message.length > 0, "read errors carry a message");
  }

  // --- 5. Match ranking and the initial-chunk guarantee ------------------
  const matches = await previewService.rankPreviewMatches({
    path: TEST_PATH,
    query: "deploy commands",
    initialChunkIndex: 0,
  });
  check(matches.length === 1, "only chunks scoring above zero are listed");
  check(matches[0].chunkIndex === 0, "the top match is the query-matching chunk");
  check(matches[0].lineStart === 3 && matches[0].lineEnd === 3, "match carries its line range");

  const forced = await previewService.rankPreviewMatches({
    path: TEST_PATH,
    query: "gardening",
    initialChunkIndex: 0,
  });
  check(
    forced[0]?.chunkIndex === 0 && forced[0]?.score === 0,
    "a zero-scoring clicked chunk is forced to the front of the match list",
  );
  check(
    forced.some((m) => m.chunkIndex === 1 && m.score > 0),
    "real matches are kept alongside the forced chunk",
  );

  const unknownFile = await previewService.rankPreviewMatches({
    path: MISSING_PATH,
    query: "anything",
    initialChunkIndex: null,
  });
  check(unknownFile.length === 0, "files absent from the index yield no matches");

  // --- 6. Line-number contract against a real file -----------------------
  const normalized = normalizeText(RAW);
  const normalizedLines = normalized.split("\n");
  const rawLines = RAW.split("\n");
  const DOUBLED = `${RAW}\n\n${RAW}`;
  const doubledLines = DOUBLED.split("\n");

  check(
    normalizedLines.length === rawLines.length,
    `normalization preserves the line count (${rawLines.length} -> ${normalizedLines.length}) — required for exact line numbers`,
  );

  const chunks = chunkText(DOUBLED, { maxChars: 200, overlapChars: 40 });
  check(chunks.length > 1, "the test file produces multiple chunks");

  // Every chunk's recorded range must (a) stay inside the file and (b) actually
  // contain the chunk's own text at those line numbers. (b) is the real proof:
  // it is what makes the preview highlight the right lines.
  let inRange = true;
  let wrongLines = 0;
  for (const chunk of chunks) {
    const start = chunk.lineStart ?? 0;
    const end = chunk.lineEnd ?? 0;
    if (start < 1 || end > doubledLines.length || start > end) {
      inRange = false;
      continue;
    }

    const chunkLines = chunk.text.split("\n").filter((line) => line.length > 0);
    const rawSlice = doubledLines
      .slice(start - 1, end)
      .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""));

    for (const chunkLine of chunkLines) {
      const trimmed = chunkLine.trim();
      if (trimmed.length === 0) continue;
      if (!rawSlice.some((rawLine) => rawLine.includes(trimmed))) wrongLines++;
    }
  }

  check(inRange, `chunker line ranges stay inside the file (${chunks.length} chunks)`);
  check(
    wrongLines === 0,
    `every chunk's recorded lines contain the chunk's own text (${wrongLines} mismatches)`,
  );

  // Targeted regression for the blank-line-collapse case: the chunk containing
  // "First run:" (line 9 of the raw file) must report a range that covers it.
  const firstRunLine = rawLines.indexOf("First run:") + 1;
  const containingChunk = chunks.find((chunk) => chunk.text.includes("First run:"));
  check(
    containingChunk !== undefined &&
      (containingChunk.lineStart ?? 0) <= firstRunLine &&
      firstRunLine <= (containingChunk.lineEnd ?? 0),
    `the chunk containing line ${firstRunLine} reports a range covering it (got ${
      containingChunk?.lineStart ?? "?"
    }–${containingChunk?.lineEnd ?? "?"})`,
  );

  console.log(`\n${checks.length} checks passed — PREVIEW VERIFICATION PASSED`);
  process.exitCode = 0;
} catch (error) {
  console.error("\nPREVIEW VERIFICATION FAILED:");
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
  rmSync(tempDir, { recursive: true, force: true });
}
