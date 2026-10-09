/**
 * Phase 2 verification: run the real EmbeddingGemma 2 ONNX model in Node
 * and verify dimensions, normalization, prompt formats, and retrieval
 * quality on a small labeled corpus.
 *
 * Run with:  node scripts/verify-embeddings.ts
 *
 * This exercises the same model id, dtype, and prompt formats as the app's
 * embedding worker (CPU execution provider in Node — the browser worker
 * uses wasm, which maps to the same CPU path; WebGPU is verified in the
 * app UI).
 */

import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
const EXPECTED_DIM = 768;

env.allowLocalModels = false;

// Distinct-subject corpus with the queries each document should win.
const CORPUS: { title: string; text: string; queries: string[] }[] = [
  {
    title: "gpu-memory-notes",
    text: `GPU memory notes. Training and inference workloads are bounded by VRAM. When a CUDA operation reports out-of-memory, the allocator could not find a contiguous block. Gradient checkpointing trades compute for memory. Mixed precision halves activation memory. Optimizer state offloading moves Adam moments to system RAM. Quantized weights such as Q4 reduce model size so larger models fit on a 12 GB graphics card.`,
    queries: [
      "How do I optimize VRAM usage?",
      "My graphics card runs out of video memory",
    ],
  },
  {
    title: "jwt-auth-explainer",
    text: `JWT authentication explained. A JSON Web Token is a signed, self-contained credential used for stateless authentication. The server issues a token after login; the client sends it in the Authorization header. Three base64url sections: header, payload, signature. Signed, not encrypted. Short expiry plus refresh tokens limit the damage of leaks.`,
    queries: [
      "Find the document that explains authentication using JWT",
      "how do tokens authenticate requests",
    ],
  },
  {
    title: "binary-search",
    text: `Binary search finds a target in a sorted array in O(log n) time by repeatedly halving the search interval. Implementation with low and high pointers and a midpoint. Common mistakes: integer overflow in midpoint calculation, wrong bounds, infinite loops. Requires sorted input.`,
    queries: [
      "Find the file that contains my implementation of a binary search algorithm",
      "searching sorted arrays efficiently",
    ],
  },
  {
    title: "database-comparison",
    text: `Comparing database systems. PostgreSQL: relational, strong consistency, rich SQL, pgvector extension. MongoDB: document store, flexible schema, horizontal scaling via sharding. SQLite: embedded, zero configuration, single file, ideal for local-first desktop tools with one owning process. Decision: SQLite for the desktop index.`,
    queries: [
      "Find the notes where I compared different database systems",
      "which embedded database for a local app",
    ],
  },
  {
    title: "pasta-recipe",
    text: `Simple tomato pasta. Ingredients: spaghetti, canned tomatoes, garlic, olive oil, basil. Boil salted water, cook until al dente, heat sliced garlic in olive oil, add tomatoes, simmer fifteen minutes, toss with basil. The sauce tastes better the next day.`,
    queries: ["how to make tomato sauce", "dinner recipe with spaghetti"],
  },
];

function dot(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: number[] | Float32Array): number {
  return Math.sqrt(dot(a, a));
}

async function main() {
  console.log(`Loading ${MODEL_ID} (dtype q4, device cpu)…`);
  const started = Date.now();
  const extractor: FeatureExtractionPipeline = await pipeline(
    "feature-extraction",
    MODEL_ID,
    { device: "cpu", dtype: "q4" },
  );
  console.log(`Model loaded in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

  // 1. Embed documents with the documented document format.
  const docInputs = CORPUS.map(
    (doc) => `title: ${doc.title} | text: ${doc.text}`,
  );
  const docOutput = await extractor(docInputs, {
    pooling: "mean",
    normalize: true,
  });
  const docVectors = docOutput.tolist() as number[][];

  // 2. Check dimensions and normalization.
  const dims = new Set(docVectors.map((v) => v.length));
  if (dims.size !== 1 || !dims.has(EXPECTED_DIM)) {
    throw new Error(`Unexpected dimensions: ${Array.from(dims).join(", ")}`);
  }
  const norms = docVectors.map(norm);
  const maxDeviation = Math.max(...norms.map((n) => Math.abs(n - 1)));
  console.log(
    `Dimension: ${EXPECTED_DIM}; L2 norms within ${maxDeviation.toExponential(2)} of 1.0.`,
  );
  if (maxDeviation > 1e-3) {
    throw new Error("Embeddings are not normalized as expected.");
  }

  // 3. Retrieval: every query must rank its own document first.
  let passed = 0;
  let total = 0;
  const failures: string[] = [];

  for (const doc of CORPUS) {
    const docIndex = CORPUS.indexOf(doc);
    for (const query of doc.queries) {
      total++;
      const queryOutput = await extractor(
        [`task: search result | query: ${query}`],
        { pooling: "mean", normalize: true },
      );
      const queryVector = (queryOutput.tolist() as number[][])[0];

      const ranked = docVectors
        .map((vector, index) => ({ title: CORPUS[index].title, score: dot(queryVector, vector) }))
        .sort((a, b) => b.score - a.score);

      const top = ranked[0];
      const ok = top.title === doc.title;
      if (ok) {
        passed++;
      } else {
        failures.push(
          `"${query}" -> expected ${doc.title}, got ${top.title} (${top.score.toFixed(3)} vs ${ranked.find((r) => r.title === doc.title)!.score.toFixed(3)})`,
        );
      }
      console.log(
        `${ok ? "PASS" : "FAIL"}  "${query}" -> ${top.title} (${top.score.toFixed(3)})`,
      );
    }
  }

  console.log(`\nTop-1 retrieval: ${passed}/${total} passed.`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const failure of failures) console.log(`  - ${failure}`);
  }

  // 4. Repeated inference must give the same vector (no state corruption).
  const repeatOutput = await extractor([docInputs[0]], {
    pooling: "mean",
    normalize: true,
  });
  const repeatVector = (repeatOutput.tolist() as number[][])[0];
  const repeatDelta = Math.abs(dot(repeatVector, docVectors[0]) - 1);
  console.log(`Repeat-inference cosine delta: ${repeatDelta.toExponential(2)}`);
  if (repeatDelta > 1e-3) {
    throw new Error("Repeated inference produced a different embedding.");
  }

  if (passed < total) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Verification failed:", error);
  process.exitCode = 1;
});
