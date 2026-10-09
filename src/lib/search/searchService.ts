import type {
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "../../types";
import { embeddingClient } from "../embeddings/embeddingClient";
import { bm25Index, bm25KeyFor } from "./bm25";
import type { IndexSnapshot } from "../indexing/indexStore";

/**
 * Semantic search over the in-memory index.
 *
 * Query and document embeddings are L2-normalized by the model, so the dot
 * product is cosine similarity. Results are grouped by file: each file
 * appears once with its best chunk; additional chunks above zero similarity
 * are counted as corroborating matches.
 *
 * The hybrid strategy additionally scores every chunk with BM25 and fuses
 * the two with a fixed vector weight. The blend rescues exact symbols and
 * rare terms (`refreshTokenWithRetry`, error codes) that dense vectors
 * flatten — at the cost of one BM25 pass over the chunk texts per search.
 */

const SNIPPET_MAX_CHARS = 220;

/** Fusion weight for the vector side; the lexical side takes the rest. */
export const HYBRID_VECTOR_WEIGHT = 0.7;

export async function searchIndex(
  snapshot: IndexSnapshot,
  request: SearchRequest,
): Promise<SearchResponse> {
  const startedAt = performance.now();
  const query = request.query.trim();

  if (!query) {
    return {
      query,
      hits: [],
      chunksSearched: 0,
      durationMs: 0,
    };
  }

  const queryVector = await embeddingClient.embedQuery(query);
  const strategy = request.strategy ?? "vector";
  const lexical = strategy === "hybrid" ? bm25Index.score(query) : null;

  const readyFiles = snapshot.files.filter(
    (file) => file.status === "ready" && file.chunks.length > 0,
  );

  const kindFilter = request.kinds;
  const eligibleFiles =
    kindFilter && kindFilter.length > 0
      ? readyFiles.filter((file) => kindFilter.includes(file.kind))
      : readyFiles;

  let chunksSearched = 0;

  type Best = { hit: SearchHit; others: number };

  const bestByFile = new Map<string, Best>();

  for (const file of eligibleFiles) {
    let bestScore = -Infinity;
    let bestPosition = -1;
    let bestVector = 0;
    let bestLexical: number | null = null;
    let others = 0;

    for (let position = 0; position < file.chunks.length; position++) {
      const chunk = file.chunks[position];
      const vector = chunk.embedding;
      if (vector.length !== queryVector.length) {
        throw new Error(
          `Embedding dimension mismatch in ${file.name}: stored ${vector.length}, query ${queryVector.length}. The index may be from a different model; re-index the folder.`,
        );
      }

      let vectorScore = 0;
      for (let i = 0; i < queryVector.length; i++) {
        vectorScore += queryVector[i] * vector[i];
      }
      chunksSearched++;

      const lexicalScore = lexical?.get(bm25KeyFor(file.path, position)) ?? null;
      const score =
        strategy === "hybrid"
          ? HYBRID_VECTOR_WEIGHT * vectorScore +
            (1 - HYBRID_VECTOR_WEIGHT) * (lexicalScore ?? 0)
          : vectorScore;

      if (score > bestScore) {
        if (bestPosition >= 0 && bestScore > 0) {
          others++;
        }
        bestScore = score;
        bestPosition = position;
        bestVector = vectorScore;
        bestLexical = lexicalScore;
      } else if (score > 0) {
        others++;
      }
    }

    if (bestPosition < 0 || bestScore <= 0) continue;

    const chunk = file.chunks[bestPosition];
    if (!chunk) continue;

    bestByFile.set(file.path, {
      others,
      hit: {
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: file.kind,
        score: bestScore,
        vectorScore: bestVector,
        lexicalScore: bestLexical,
        snippet: makeSnippet(chunk.text),
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        chunkIndex: chunk.fileIndex,
        otherMatches: others,
        indexedAt: file.indexedAt,
      },
    });
  }

  const hits = Array.from(bestByFile.values())
    .map((best) => best.hit)
    .filter((hit) => hit.score >= (request.minScore ?? 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, request.limit));

  return {
    query,
    hits,
    chunksSearched,
    durationMs: performance.now() - startedAt,
  };
}

function makeSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SNIPPET_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SNIPPET_MAX_CHARS).trimEnd() + "…";
}
