import type { FileKind } from "../../types";

/**
 * File-type registry: maps extensions to kinds and drives the file dialog
 * filter, dispatch in the indexing pipeline, and the Rust read allowlist
 * (which is the actual security boundary — this list is for presentation
 * and planning).
 */

export const TEXT_EXTENSION_KINDS: Readonly<Record<string, FileKind>> = {
  // Markdown / prose
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  txt: "text",
  log: "text",
  rtf: "text",

  // Data / config
  csv: "data",
  tsv: "data",
  json: "data",
  jsonl: "data",
  ndjson: "data",
  yaml: "data",
  yml: "data",
  xml: "data",
  toml: "data",
  ini: "data",
  cfg: "data",
  conf: "data",
  env: "data",
  properties: "data",
  sql: "data",
  graphql: "data",
  gql: "data",
  proto: "data",

  // Markup / styles
  html: "code",
  htm: "code",
  css: "code",
  scss: "code",
  sass: "code",
  less: "code",
  vue: "code",
  svelte: "code",
  astro: "code",

  // Source code
  js: "code",
  mjs: "code",
  cjs: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  py: "code",
  pyi: "code",
  rs: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cc: "code",
  cxx: "code",
  hpp: "code",
  hh: "code",
  cs: "code",
  go: "code",
  php: "code",
  rb: "code",
  r: "code",
  swift: "code",
  kt: "code",
  kts: "code",
  scala: "code",
  dart: "code",
  lua: "code",
  pl: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  ps1: "code",
  psm1: "code",
  bat: "code",
  cmd: "code",
  gradle: "code",
  makefile: "code",
  dockerfile: "code",
  gitignore: "code",
};

/**
 * Kinds the app can extract today. Document, PDF, and image extraction are
 * planned for later phases; they are listed so filters can show them as
 * "planned" rather than silently ignoring them.
 */
export const SUPPORTED_EXTENSION_SET = new Set(Object.keys(TEXT_EXTENSION_KINDS));

/** Extensions with a planned extraction path in a later phase. */
export const PLANNED_EXTENSIONS: Readonly<Record<string, FileKind>> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  xlsx: "document",
  pptx: "document",
  odt: "document",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  bmp: "image",
  gif: "image",
};

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export function classifyFile(fileName: string): FileKind {
  const ext = extensionOf(fileName);
  return TEXT_EXTENSION_KINDS[ext] ?? "unsupported";
}

export function isSupported(fileName: string): boolean {
  return SUPPORTED_EXTENSION_SET.has(extensionOf(fileName));
}

/** File dialog filter for the "add files" picker. */
export const FILE_PICKER_EXTENSIONS = Object.keys(TEXT_EXTENSION_KINDS).map(
  (ext) => `.${ext}`,
);
