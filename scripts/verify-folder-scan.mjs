import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * End-to-end check of the pick-a-folder flow.
 *
 * Builds a realistic project tree on disk, scans it through the real Rust
 * scanner, and asserts what the UI would then show: which files are indexed,
 * how each modality is classified, and what was pruned.
 *
 * Run with: node scripts/verify-folder-scan.mjs
 *
 * The scanner is reached through `cargo run --example scan`, which calls the
 * exact code the app calls. Compiling it the first time takes a while; it is
 * cached afterwards.
 */

const CARGO_DIR = join(process.cwd(), "src-tauri");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`ok   ${message}`);
}

/** Run the scanner example and parse its JSON. */
function runScan(paths) {
  const stdout = execFileSync(
    "cargo",
    ["run", "-q", "-p", "semantic-file-search", "--example", "scan", "--", "scan", ...paths],
    { cwd: CARGO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function runRead(path) {
  const stdout = execFileSync(
    "cargo",
    ["run", "-q", "-p", "semantic-file-search", "--example", "scan", "--", "read", path],
    { cwd: CARGO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function runBytes(path) {
  const stdout = execFileSync(
    "cargo",
    ["run", "-q", "-p", "semantic-file-search", "--example", "scan", "--", "bytes", path],
    { cwd: CARGO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

const root = mkdtempSync(join(tmpdir(), "sfs-folder-scan-"));

function write(relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

try {
  // A realistic project: sources, docs, config, media, plus the
  // dependency and VCS trees a project folder always drags along.
  write("package.json", JSON.stringify({ name: "widget", version: "1.0.0" }, null, 2));
  write("README.md", "# Widget\n\nA widget that does widget things.\n");
  write("src/index.ts", "export function main() { return 1; }\n");
  write("src/lib/greeter.ts", "export function greet(name: string) {\n  return `hi ${name}`;\n}\n");
  write("docs/guide.md", "# Guide\n\nRun `npm start` to begin.\n");
  write(".github/workflows/ci.yml", "name: ci\non: push\n");
  write("tsconfig.json", '{ "strict": true }\n');
  write("notes.txt", "TODO: ship it.\n");
  write("assets/logo.png", "not-a-real-png");
  write("assets/screenshot.jpg", "not-a-real-jpeg");
  write("assets/clip.mp4", "not-a-real-video");
  write("assets/theme.mp3", "not-a-real-audio");
  // Binaries at a path that is NOT pruned, so they are actually classified.
  write("assets/app.exe", "MZ");
  write("assets/bundle.zip", "PK");
  write("assets/weird.qqq", "unknown");

  // Must be pruned.
  write("node_modules/left-pad/index.js", "module.exports = () => 1;");
  write("target/debug/app", "binary");
  write(".git/config", "[core]");
  write("dist/bundle.js", "bundle");
  write(".venv/lib/python3.11/site.py", "venv");
  write("dist/.hidden-notes.txt", "never reached");

  // Hidden file at the top level.
  write(".env", "SECRET=hunter2");

  const scanned = runScan([root]);
  check(scanned.files.length > 0, `the scan returned ${scanned.files.length} files`);

  const byName = new Map(scanned.files.map((f) => [f.name, f]));
  const has = (name) => byName.has(name);

  check(has("index.ts"), "a source file is indexed");
  check(has("greeter.ts"), "a nested source file is indexed");
  check(has("README.md"), "markdown is indexed");
  check(has("ci.yml"), "files inside .github are indexed (hidden dirs are not pruned)");
  check(has("package.json"), "json is indexed");
  check(has("notes.txt"), "plain text is indexed");

  check(!has("index.js"), "node_modules is pruned");
  check(!has("app"), "target is pruned");
  check(!has("config"), ".git is pruned");
  check(!has("bundle.js"), "dist is pruned");
  check(!has("site.py"), ".venv is pruned");
  check(!has(".env"), "a hidden file at the root is skipped");
  check(!has(".hidden-notes.txt"), "nothing under a pruned dir is reached");

  check(
    byName.get("logo.png")?.kind === "image" && byName.get("screenshot.jpg")?.kind === "image",
    "png and jpg are classified as images",
  );
  check(byName.get("clip.mp4")?.kind === "video", "mp4 is classified as video");
  check(byName.get("theme.mp3")?.kind === "audio", "mp3 is classified as audio");

  const kinds = new Set(scanned.files.map((f) => f.kind));
  check(
    ["text", "image", "audio", "video"].every((k) => kinds.has(k)),
    `all four modalities appear in the scan (${[...kinds].join(", ")})`,
  );

  check(scanned.elapsed_ms >= 0, "the scan reports a duration");
  check(scanned.directories_visited > 3, `${scanned.directories_visited} folders were walked`);
  check(
    scanned.skipped.hidden >= 1,
    `hidden entries are counted (${scanned.skipped.hidden})`,
  );
  check(
    scanned.skipped.binary === 2,
    `binary extensions are counted as binary (${scanned.skipped.binary}: exe and zip)`,
  );
  check(
    scanned.skipped.unsupported_extension === 1,
    `an unknown extension is counted as unsupported (${scanned.skipped.unsupported_extension})`,
  );
  check(
    !has("app.exe") && !has("bundle.zip") && !has("weird.qqq"),
    "binaries and unknown extensions are not indexed",
  );
  // Pruning happens before classification, so a pruned tree never shows up in
  // the skip counts at all. Pinning that keeps the UI's numbers honest.
  check(
    scanned.skipped.binary === 2,
    "the pruned target/debug/app is not double-counted as binary",
  );

  // The results are sorted, so progress reporting and re-scans are stable.
  const paths = scanned.files.map((f) => f.path);
  const sorted = [...paths].sort();
  check(
    JSON.stringify(paths) === JSON.stringify(sorted),
    "results are sorted by path",
  );

  // Media must be readable as bytes — that is what the embedding worker uses.
  const bytes = runBytes(join(root, "assets", "logo.png"));
  check(bytes.includes("Raw"), "media bytes are readable through the Rust command");

  // And text is readable in bulk.
  const text = runRead(join(root, "src", "index.ts"));
  check(
    text.content.includes("export function main"),
    "a text file's contents are readable",
  );

  // A second scan of the same folder must return the identical set: the
  // incremental skip depends on stable ordering and metadata.
  const again = runScan([root]);
  check(
    JSON.stringify(again.files.map((f) => f.path)) === JSON.stringify(paths),
    "a re-scan of the same folder returns the same files",
  );

  // Two folders at once must both be walked.
  const second = mkdtempSync(join(tmpdir(), "sfs-folder-scan-b-"));
  write("placeholder.txt", "x");
  writeFileSync(join(second, "other.txt"), "other");
  try {
    const multi = runScan([root, second]);
    check(
      multi.files.some((f) => f.name === "other.txt") &&
        multi.files.some((f) => f.name === "index.ts"),
      "two folders can be scanned together",
    );
  } finally {
    rmSync(second, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed — FOLDER SCAN VERIFICATION PASSED`);
process.exitCode = 0;
