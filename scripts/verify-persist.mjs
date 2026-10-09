/**
 * Persistence codec verification: the Float32Array <-> base64 bridge between
 * the in-memory index and the SQLite snapshot must be byte-exact. A single
 * flipped bit in a vector silently corrupts every future search over the
 * restored index, so this proves the round trip on hostile inputs (zeros,
 * negatives, subnormals, infinities) plus the wire shape used for files.
 *
 * The Rust side mirrors this with `decode_embedding` unit tests in
 * src-tauri/src/persist.rs (`cargo test`). Together they pin both ends of
 * the IPC contract.
 *
 * Run with: node scripts/verify-persist.mjs
 */

import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "warn",
});

let failures = 0;

function check(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok ${name}`);
  }
}

try {
  const { float32ToBase64, base64ToFloat32 } = await server.ssrLoadModule(
    "/src/lib/indexing/indexPersist.ts",
  );

  // 1. A model-shaped vector round-trips byte-exactly.
  const dim = 768;
  const original = new Float32Array(dim);
  let seed = 0x12345678;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let i = 0; i < dim; i++) original[i] = rand() * 2 - 1;

  const b64 = float32ToBase64(original);
  check("768-dim base64 length", b64.length, 4096);
  const back = base64ToFloat32(b64);
  check("round-trip length", back.length, dim);
  check(
    "round-trip byte-exact",
    Buffer.from(back.buffer).equals(Buffer.from(original.buffer)),
    true,
  );

  // 2. Hostile values survive: zeros, negatives, subnormals, infinities, NaN.
  const hostile = new Float32Array([
    0, -0, -1.5, 1e-40, -1e-40, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, Number.NaN, 3.4028235e38, -3.4028235e38,
  ]);
  const hostileBack = base64ToFloat32(float32ToBase64(hostile));
  const hostileBytes = Buffer.from(hostile.buffer).equals(
    Buffer.from(hostileBack.buffer),
  );
  check("hostile values byte-exact", hostileBytes, true);

  // 3. Empty vector is legal (zero-chunk files never persist, but the codec
  //    must not throw on the boundary).
  check("empty vector length", base64ToFloat32(float32ToBase64(new Float32Array(0))).length, 0);

  // 4. Corrupt input throws instead of returning a wrong-length vector.
  let threw = false;
  try {
    base64ToFloat32("!!!not-base64!!!");
  } catch {
    threw = true;
  }
  check("corrupt base64 throws", threw, true);

  threw = false;
  try {
    // Valid base64, 3 bytes: not a whole number of f32.
    base64ToFloat32("abcd");
  } catch {
    threw = true;
  }
  check("non-f32 length throws", threw, true);
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`PERSIST CODEC VERIFICATION FAILED (${failures} failures)`);
  process.exitCode = 1;
} else {
  console.log("PERSIST CODEC VERIFICATION PASSED");
}
