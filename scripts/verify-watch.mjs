/**
 * Watcher filter verification: the frontend `isWatchablePath` gate must agree
 * with the Rust scanner's rules, or the watcher will either embed files the
 * scanner would reject or ignore files it would index.
 *
 * The contract, mirrored from src-tauri/src/scanner.rs:
 * - pruned directory names (node_modules, .git, target, …) match anywhere in
 *   the path, case-insensitively;
 * - hidden *files* are skipped, but files inside hidden *directories* are kept;
 * - only formats the extractor registry supports are auto-indexed.
 *
 * Run with: node scripts/verify-watch.mjs
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
  const { isWatchablePath, normalizeWatchPath } = await server.ssrLoadModule(
    "/src/lib/watch/watchService.ts",
  );

  // Ordinary source files are watchable.
  check("ts file", isWatchablePath("C:/proj/src/app.ts"), true);
  check("rust file", isWatchablePath("/home/u/proj/main.rs"), true);
  check("markdown", isWatchablePath("/home/u/proj/README.md"), true);
  check("sql", isWatchablePath("/home/u/proj/schema.sql"), true);

  // Pruned directories match anywhere, case-insensitively.
  check("node_modules", isWatchablePath("C:/proj/node_modules/pkg/index.js"), false);
  check(".git", isWatchablePath("C:/proj/.git/config"), false);
  check("target", isWatchablePath("/home/u/proj/target/debug/app"), false);
  check("uppercase pruned", isWatchablePath("C:/proj/NODE_MODULES/a.js"), false);
  check("dist", isWatchablePath("C:/proj/dist/bundle.js"), false);
  check("vscode", isWatchablePath("C:/proj/.vscode/settings.json"), false);

  // Hidden files are skipped; hidden directories are kept.
  check("hidden file", isWatchablePath("C:/proj/.env"), false);
  check(
    "file in hidden dir",
    isWatchablePath("C:/proj/.github/workflows/ci.yml"),
    true,
  );

  // Formats the pipeline cannot embed are not auto-indexed.
  check("no extension", isWatchablePath("C:/proj/Makefile"), false);
  check("binary", isWatchablePath("C:/proj/app.exe"), false);
  check("pdf (planned, no extractor)", isWatchablePath("C:/proj/doc.pdf"), false);
  check("png (bulk pipeline only)", isWatchablePath("C:/proj/shot.png"), false);
  check("empty path", isWatchablePath(""), false);
  check("directory", isWatchablePath("C:/proj/src"), false);

  // Normalization is what index matching compares.
  check(
    "normalizes separators and case",
    normalizeWatchPath("C:\\Proj\\Src\\App.TS"),
    "c:/proj/src/app.ts",
  );
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`WATCH VERIFICATION FAILED (${failures} failures)`);
  process.exitCode = 1;
} else {
  console.log("WATCH VERIFICATION PASSED");
}
