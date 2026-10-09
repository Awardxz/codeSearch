import type {
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "../../types";
import { embeddingClient } from "../embeddings/embeddingClient";
import type { IndexSnapshot } from "../indexing/indexStore";

/**
 * Semantic search over the in-memory index.
 *
 * Query and document embeddings are L2-normalized by the model, so the dot
 * product is cosine similarity. Results are grouped by file: each file
 * appears once with its best chunk; additional chunks above zero similarity
 * are counted as corroborating matches.
 */

const SNIPPET_MAX_CHARS = 220;

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
    let bestChunkIndex = -1;
    let others = 0;

    for (const chunk of file.chunks) {
      const vector = chunk.embedding;
      if (vector.length !== queryVector.length) {
        throw new Error(
          `Embedding dimension mismatch in ${file.name}: stored ${vector.length}, query ${queryVector.length}. The index may be from a different model; re-index the folder.`,
        );
      }

      let score = 0;
      for (let i = 0; i < queryVector.length; i++) {
        score += queryVector[i] * vector[i];
      }
      chunksSearched++;

      if (score > bestScore) {
        if (bestChunkIndex >= 0 && bestScore > 0) {
          others++;
        }
        bestScore = score;
        bestChunkIndex = chunk.fileIndex;
      } else if (score > 0) {
        others++;
      }
    }

    if (bestChunkIndex < 0 || bestScore <= 0) continue;

    const chunk = file.chunks.find((c) => c.fileIndex === bestChunkIndex);
    if (!chunk) continue;

    bestByFile.set(file.path, {
      others,
      hit: {
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: file.kind,
        score: bestScore,
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
