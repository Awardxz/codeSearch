/**
 * Built-in sample corpus for the embedding smoke test and the first-run
 * experience. Each document has a distinct subject so a handful of natural
 * language queries can be checked for correct top-1 retrieval:
 *
 *   "How do I optimize VRAM usage?"              -> gpu-memory-notes.txt
 *   "authentication with JWT tokens"             -> jwt-auth-explainer.txt
 *   "code that implements binary search"         -> binary-search.txt
 *   "comparing database systems"                 -> database-comparison.txt
 *   "how to make tomato sauce"                   -> pasta-recipe.txt
 */

export type SampleDocument = {
  fileName: string;
  content: string;
};

export const SAMPLE_DOCUMENTS: SampleDocument[] = [
  {
    fileName: "gpu-memory-notes.txt",
    content: `GPU Memory Notes

Training and inference workloads are bounded by VRAM. When a CUDA
operation reports out-of-memory, the allocator could not find a
contiguous block.

Strategies that reduced VRAM usage in practice:

1. Gradient checkpointing trades compute for memory by recomputing
   activations during the backward pass.
2. Mixed precision (fp16 or bf16) halves activation memory.
3. Optimizer state offloading moves Adam moments to system RAM.
4. Reduce batch size and use gradient accumulation to keep the same
   effective batch.

For local inference of embedding models, quantized weights such as
Q4 reduce the weights to roughly a quarter of the fp16 size, which
allows larger models to fit on a 12 GB graphics card.`,
  },
  {
    fileName: "jwt-auth-explainer.txt",
    content: `JWT Authentication Explained

A JSON Web Token is a signed, self-contained credential used for
stateless authentication. The server issues a token after the user
logs in; the client sends it with every request in the
Authorization header.

Structure: a JWT has three base64url sections - header, payload,
and signature. The signature is computed with a secret (HMAC) or a
private key (RS256, ES256).

Important properties:

- Tokens are signed, not encrypted. Anyone can read the payload.
- Never store secrets such as passwords inside the payload.
- Short expiry times plus refresh tokens limit the damage of leaks.
- Always validate the signature and the issuer before trusting
  any claim.

For our REST API, access tokens expire after 15 minutes and the
refresh token is stored in an httpOnly cookie.`,
  },
  {
    fileName: "binary-search.txt",
    content: `Binary search finds a target in a sorted array in O(log n) time
by repeatedly halving the search interval.

Implementation used in the algorithms assignment:

function binarySearch(arr, target) {
  let low = 0;
  let high = arr.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

Common mistakes: integer overflow in midpoint calculation, using
the array length instead of length - 1, and infinite loops when
the interval is not updated correctly.

Preconditions matter: binary search requires sorted input.`,
  },
  {
    fileName: "database-comparison.txt",
    content: `Comparing Database Systems

PostgreSQL vs MongoDB vs SQLite - notes from evaluating storage
for the semester project.

PostgreSQL: relational, strong consistency, rich SQL, extensions
such as pgvector for similarity search. Best when the schema is
stable and relations matter.

MongoDB: document store, flexible schema, horizontal scaling via
sharding. Good for rapidly changing document shapes.

SQLite: embedded, zero configuration, single file, excellent for
local-first applications and desktop tools. Not designed for
concurrent writers over a network, but ideal when one process owns
the data.

Decision: use SQLite for the desktop index, because all data is
local, the access pattern is read-heavy, and there is no server.`,
  },
  {
    fileName: "pasta-recipe.txt",
    content: `Simple Tomato Pasta

Ingredients:
- 200 g spaghetti
- 400 g canned tomatoes
- 2 cloves garlic
- olive oil, basil, salt

Steps:
1. Boil salted water and cook the spaghetti until al dente.
2. Gently heat sliced garlic in olive oil until fragrant.
3. Add the tomatoes, crush them, and simmer for 15 minutes.
4. Toss the pasta with the sauce and finish with fresh basil.

The sauce tastes better the next day. Store it in the fridge for
up to three days.`,
  },
  {
    fileName: "rust-error-handling.txt",
    content: `Error Handling in Rust

Rust models failure with the Result<T, E> enum instead of
exceptions. Functions that can fail return Result, and callers
must handle both variants explicitly.

Idioms that keep code readable:

- The ? operator propagates errors upward with early return.
- thiserror derives clean error enums for libraries.
- anyhow provides a boxed error type with context for binaries.
- Matching on error kinds lets callers recover from specific
  failures, such as retrying a temporary file lock.

Panics are for programmer bugs, not for expected failures such as
a missing file on disk.`,
  },
];
