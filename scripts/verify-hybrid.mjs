/**
 * Hybrid search verification: BM25 lexical scoring plus vector/lexical fusion.
 *
 * Pure ranking behavior (tokenizer, BM25 ordering, length normalization, IDF,
 * incremental add/remove) is asserted against the real `Bm25Index`, and fusion
 * is proven end to end through the real `indexStore` + `searchIndex` with only
 * the embedding worker stubbed: an exact rare term ("zapqx") must lose on
 * vectors alone and win under the hybrid strategy.
 *
 * Run with: node scripts/verify-hybrid.mjs
 */

import { createServer } from "vite";

const STUB_ID = 'hybrid-test-stubs';

const stubPlugin = {
  name: "hybrid-verify-stubs",
  enforce: "pre",
  resolveId(id) {
    if (id.includes("/embeddings/embeddingClient")) return STUB_ID;
    return null;
  },
  load(id) {
    if (id !== STUB_ID) return null;
    return `
      // Deterministic 4-d vectors. The query is [1,0,0,0], so the dot product
      // is exactly the first component the test assigns each chunk.
      export const embeddingClient = {
        getStatus: () => ({
          phase: "ready", backend: "wasm", dimension: 4,
          downloadProgress: null, downloadFile: null, error: null, modalities: null,
        }),
        async embedDocuments(texts, titles, onProgress) {
          const vectors = texts.map(() => new Float32Array(4));
          onProgress?.(texts.length, texts.length);
          return vectors;
        },
        async embedQuery() {
          const v = new Float32Array(4);
          v[0] = 1;
          return v;
        },
        cancelAllJobs() {},
        async ensureLoaded() { return { backend: "wasm", dimension: 4 }; },
        subscribe() { return () => {}; },
        reinitialize() {},
      };
    `;
  },
};

const server = await createServer({
  plugins: [stubPlugin],
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "warn",
});

let failures = 0;

function check(name, actual, expected) {
  const same =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-9
      : actual === expected;
  if (!same) {
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok ${name}`);
  }
}

function checkClose(name, actual, expected, tolerance = 1e-6) {
  if (Math.abs(actual - expected) > tolerance) {
    console.error(`FAIL ${name}: expected ~${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok ${name}`);
  }
}

function vec(first) {
  const v = new Float32Array(4);
  v[0] = first;
  return v;
}

function order(hits) {
  return hits.map((hit) => hit.name).join(",");
}

try {
  const { Bm25Index, tokenizeCode } = await server.ssrLoadModule(
    "/src/lib/search/bm25.ts",
  );

  // --- Tokenizer -----------------------------------------------------------
  check(
    "camelCase splits",
    tokenizeCode("refreshTokenWithRetry").join(","),
    "refresh,token,with,retry",
  );
  check(
    "pascal + acronym splits",
    tokenizeCode("parseHTTPResponse").join(","),
    "parse,http,response",
  );
  check(
    "digit boundaries split, digits kept",
    tokenizeCode("OAuth2Client").join(","),
    "auth,2,client",
  );
  check("single letters dropped", tokenizeCode("x = y").join(","), "");
  check("snake_case splits", tokenizeCode("max_retry_count").join(","), "max,retry,count");

  // --- BM25 ordering --------------------------------------------------------
  const bm25 = new Bm25Index();
  bm25.syncFile("d1", [{ text: "apple apple apple" }]);
  bm25.syncFile("d2", [{ text: "apple" }]);
  bm25.syncFile("d3", [{ text: "banana" }]);
  check("bm25 doc count", bm25.size, 3);

  const apple = bm25.score("apple");
  check("repeated term wins", [...apple.entries()].sort((a, b) => b[1] - a[1])[0][0].startsWith("d1"), true);
  check("max-normalized to 1", apple.get([...apple.keys()].find((k) => k.startsWith("d1"))), 1);
  check("non-matching doc absent", apple.has([...apple.keys()].find((k) => k.startsWith("d3")) ?? "d3"), false);

  // Length normalization: same tf, shorter doc wins.
  bm25.syncFile("d4", [{ text: `apple ${"filler ".repeat(100)}` }]);
  const normed = bm25.score("apple");
  const byKey = (prefix) => normed.get([...normed.keys()].find((k) => k.startsWith(prefix)));
  check("short doc outranks long doc at equal tf", byKey("d2") > byKey("d4"), true);

  // Removal and clearing.
  bm25.removeFile("d1");
  const afterRemove = bm25.score("apple");
  check("removed doc gone", [...afterRemove.keys()].some((k) => k.startsWith("d1")), false);
  check("remaining docs still score", afterRemove.size > 0, true);
  bm25.clear();
  check("clear empties", bm25.size, 0);
  check("empty query scores nothing", bm25.score("").size, 0);
  bm25.syncFile("solo", [{ text: "hello world" }]);
  check("unknown term scores nothing", bm25.score("zapqx").size, 0);

  // --- Fusion end to end ----------------------------------------------------
  const { indexStore } = await server.ssrLoadModule(
    "/src/lib/indexing/indexStore.ts",
  );
  const { searchIndex } = await server.ssrLoadModule(
    "/src/lib/search/searchService.ts",
  );

  const file = (path, name, text, first) => ({
    path,
    name,
    extension: "ts",
    kind: "code",
    sizeBytes: text.length,
    modifiedMs: 1,
    status: "ready",
    error: null,
    chunks: [{ fileIndex: 0, text, lineStart: 1, lineEnd: 2, embedding: vec(first) }],
    indexedAt: 1,
    isSample: false,
  });

  indexStore.addIndexedFiles([
    file("C:/proj/auth.ts", "auth.ts", "VECTOR_WIN alpha beta", 0.5),
    file("C:/proj/retry.ts", "retry.ts", "zapqx needle gamma", 0.1),
    file("C:/proj/notes.md", "notes.md", "unrelated prose about gardening", 0.05),
  ]);

  const snapshot = () => indexStore.getSnapshot();

  const vectorOnly = await searchIndex(snapshot(), {
    query: "zapqx",
    limit: 10,
    strategy: "vector",
  });
  check("vector order prefers cosine", order(vectorOnly.hits), "auth.ts,retry.ts,notes.md");
  check(
    "vector hits carry no lexical score",
    vectorOnly.hits.every((hit) => hit.lexicalScore === null),
    true,
  );

  const hybrid = await searchIndex(snapshot(), {
    query: "zapqx",
    limit: 10,
    strategy: "hybrid",
  });
  check("hybrid rescues the exact term", order(hybrid.hits), "retry.ts,auth.ts,notes.md");
  const winner = hybrid.hits[0];
  checkClose("hybrid winner fused", winner.score, 0.7 * 0.1 + 0.3 * 1.0);
  checkClose("hybrid winner lexical is max-normalized", winner.lexicalScore, 1.0);
  checkClose("hybrid winner vector preserved", winner.vectorScore, 0.1);
  checkClose("hybrid runner-up fused", hybrid.hits[1].score, 0.7 * 0.5);

  // Cutoff at 0.34 keeps the blend winner (0.37) and the vector
  // runner-up (0.35) while dropping the unrelated file (0.035).
  const cut = await searchIndex(snapshot(), {
    query: "zapqx",
    limit: 10,
    minScore: 0.34,
    strategy: "hybrid",
  });
  check("cutoff applies to the blend", order(cut.hits), "retry.ts,auth.ts");

  // Removing a file removes its lexical entries too.
  indexStore.removeFile("C:/proj/retry.ts");
  const afterDelete = await searchIndex(snapshot(), {
    query: "zapqx",
    limit: 10,
    strategy: "hybrid",
  });
  check("deleted file leaves hybrid results", order(afterDelete.hits), "auth.ts,notes.md");

  indexStore.clear();
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`HYBRID VERIFICATION FAILED (${failures} failures)`);
  process.exitCode = 1;
} else {
  console.log("HYBRID VERIFICATION PASSED");
}
