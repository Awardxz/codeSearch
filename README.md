# codeSearch

A local, private semantic search over your files, built with Tauri v2, React 19,
TypeScript and EmbeddingGemma 2. Nothing is uploaded: the model runs locally in
the app's webview, and file contents never leave the machine.

## What it does

- **Pick a folder, index it.** Choose a project (or any folder) in the OS picker
  and it is walked, read, chunked and embedded. The app never enumerates your
  machine on its own — roots are always explicitly chosen.
- **Search by meaning.** Type what you are looking for in plain language; results
  are ranked by semantic similarity, not keyword matching.
- **Multimodal, in one vector space.** EmbeddingGemma 2 maps text, code, images,
  audio and video into a single shared 768-dimensional space, so a text query can
  find a photo or a recording.
- **Preview with the match in context.** Open a result to see the real file with
  the matching lines highlighted and scrolled into view. Images, audio and video
  play inline.
- **Incremental.** Files already indexed and unchanged are skipped, so re-scanning
  after changing a few files only embeds what is new.

## Pruning

The walk never enters `node_modules`, `.git`, `target`, `dist`, `.venv`,
`.idea`, `.vscode`, caches, or OS and application folders — those account for
most of a developer's file count and none of it is worth indexing. Hidden
*directories* such as `.github` are kept, because CI and tool config is
legitimately searchable; hidden *files* such as `.env` are skipped.

## Getting started

```bash
npm install
npm run tauri dev
```

The first run downloads the model weights from the Hugging Face Hub (~470 MB at
q4 for all three encoders, of which a session only downloads what it needs) and
caches them. Later sessions run fully offline.

## Layout

```
src/
  features/          Screens: search, indexing, settings, preview
  hooks/             React context wiring the module-level services
  lib/
    embeddings/      Model config, worker protocol, client, token budgeting
    indexing/        Bulk pipeline: plan, batch, scatter back to files
    chunking/        Text normalization and boundary-aware chunking
    extractors/      File-kind registry
    media/           Video frame extraction (needs a DOM)
    preview/         File preview store and data loading
    scanning/        Folder scan and bulk read IPC
  types/             Shared application types
src-tauri/src/
  commands.rs        Validated file reads (text, bulk, media bytes)
  scanner.rs         Parallel folder walk with pruning
scripts/             Verification scripts (see below)
```

## Checks

```bash
npm run build                     # tsc && vite build
npm run test:rust                 # cargo test
npm run smoke:render              # render the whole app to a string
npm run verify:embeddings         # real model: retrieval quality
npm run verify:multimodal         # real model: image/audio/video in one space
npm run verify:preview            # preview data path and line-number contract
npm run verify:bulk               # scan -> chunk -> batch -> scatter
npm run verify:folder-scan        # end-to-end scan of a real project tree
```

`verify:folder-scan` builds a realistic project tree on disk and runs it through
the actual Rust scanner, so the pruning and classification rules are exercised
against real files rather than a reimplementation.
