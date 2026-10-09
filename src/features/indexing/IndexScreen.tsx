import { useMemo } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "../../components/Icon";
import { useAppServices } from "../../hooks/useAppServices";
import { useFolderScan } from "../../hooks/useFolderScan";
import { Badge, FileKindBadge, ProgressBar, StatusBadge } from "../../components/Badges";
import { indexStore } from "../../lib/indexing/indexStore";
import { SAMPLE_DOCUMENTS } from "../../lib/indexing/sampleDocuments";
import { FILE_PICKER_EXTENSIONS, TEXT_EXTENSION_KINDS } from "../../lib/extractors/registry";
import { commonRootOf, formatBytes, formatCompact } from "../../lib/format";
import { MODEL_DISPLAY_NAME } from "../../lib/embeddings/config";

/** The index is capped in the UI: tens of thousands of rows would stall it. */
const MAX_LISTED_FILES = 300;

/**
 * Index screen, laid out as the Stitch "Index" screen: an editorial header, the
 * active repository card, the four telemetry cards, the pipeline panel, the
 * exclusion / format split, and the incremental log table.
 *
 * Nothing here is decorative. The repository card reflects the folder that was
 * actually scanned, the telemetry cards are counted from the live index, the
 * pipeline stages describe the stages this app really runs (discover → extract
 * → chunk → embed → index), and the log rows are the files that were really
 * indexed.
 */

export function IndexScreen() {
  const { files, progress, embeddingStatus, bulkRunning } = useAppServices();
  const scan = useFolderScan();

  const readyFiles = files.filter((file) => file.status === "ready");
  const failedCount = files.filter((file) => file.status === "failed").length;
  const chunkCount = readyFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const embeddingBytes = chunkCount * (embeddingStatus.dimension ?? 0) * 4;
  const workspaceRoot = commonRootOf(readyFiles.map((file) => file.path));

  const medias = readyFiles.filter(
    (file) => file.kind === "image" || file.kind === "media",
  );
  const lastIndexedAt = useMemo(() => {
    const stamps = readyFiles
      .map((file) => file.indexedAt)
      .filter((stamp): stamp is number => stamp !== null);
    return stamps.length > 0 ? Math.max(...stamps) : null;
  }, [readyFiles]);

  /** Languages actually present in the index, which is what the grammar list shows. */
  const languagesPresent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of readyFiles) {
      if (!file.extension) continue;
      counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [readyFiles]);

  const formatsSupported = Object.keys(TEXT_EXTENSION_KINDS).length;

  const running =
    progress.phase === "extracting" || progress.phase === "embedding";
  const scanBusy =
    bulkRunning ||
    scan.stage === "picking" ||
    scan.stage === "scanning" ||
    scan.stage === "reading" ||
    scan.stage === "embedding";

  const scanReady =
    scan.scan !== null &&
    scan.scan.files.length > 0 &&
    !scanBusy &&
    scan.stage === "idle";

  async function addFiles() {
    try {
      const selection = await openFileDialog({
        multiple: true,
        title: "Choose files to index",
        filters: [
          {
            name: "Supported text and code files",
            extensions: FILE_PICKER_EXTENSIONS.map((ext) => ext.slice(1)),
          },
        ],
      });
      if (!selection || selection.length === 0) return;
      await indexStore.indexPaths(selection);
    } catch (error) {
      // The scan hook owns surface error copy for folder scans; file-dialog
      // failures are surfaced through the store's global error instead.
      console.error("File dialog failed", error);
    }
  }

  return (
    <div className="relative flex w-full flex-col gap-gutter px-gutter py-space-xl">
      {/* Editorial header */}
      <div className="flex flex-col justify-between gap-space-md pb-space-xs md:flex-row md:items-end">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-space-xs text-label-sm tracking-wider text-on-surface-variant uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
            <span>Local Repository Management</span>
            <span className="text-surface-container-highest">/</span>
            <span className="text-code-sm text-secondary">
              {workspaceRoot ? basename(workspaceRoot) : "no workspace"}
            </span>
          </div>
          <h1 className="text-headline-lg tracking-tight text-primary">
            Your files, understood.
          </h1>
          <p className="max-w-2xl text-body-md text-on-surface-variant">
            Scan, chunk, and embed locally with {MODEL_DISPLAY_NAME}. No external
            API calls, no telemetry — the index lives in this process.
          </p>
        </div>

        <div className="flex items-center gap-space-sm self-start rounded-lg bg-surface-container-low px-space-md py-space-xs">
          <div className="flex flex-col text-right font-code-sm">
            <span className="flex items-center justify-end gap-1 font-medium text-on-surface">
              <Icon name="speed" className="text-xs text-primary-fixed-dim" />
              {formatCompact(chunkCount)} chunks
            </span>
            <span className="text-[11px] text-on-surface-variant">
              {embeddingStatus.backend === "webgpu"
                ? "WebGPU · GPU"
                : embeddingStatus.backend === "wasm"
                  ? "WASM · CPU"
                  : "Detecting device…"}
            </span>
          </div>
          <div className="h-6 w-px bg-surface-container-highest" />
          <div
            className={`h-2.5 w-2.5 rounded-full ${
              embeddingStatus.phase === "ready"
                ? "animate-pulse bg-primary-container shadow-[0_0_10px_rgba(178,247,0,0.7)]"
                : embeddingStatus.phase === "error"
                  ? "bg-error"
                  : "animate-pulse bg-primary-container"
            }`}
          />
        </div>
      </div>

      {/* Repository showcase */}
      <div className="relative flex flex-col gap-space-md overflow-hidden rounded-xl bg-surface-container-low p-space-lg shadow-md">
        <div className="pointer-events-none absolute -top-20 -right-20 h-80 w-80 rounded-full bg-primary-container/5 blur-3xl" />
        <div className="flex flex-col justify-between gap-space-md lg:flex-row lg:items-center">
          <div className="flex items-start gap-space-md">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-primary-container">
              <Icon name="folder_managed" className="text-xl" />
            </div>
            <div className="flex min-w-0 flex-col">
              <div className="flex flex-wrap items-center gap-space-sm">
                <span className="truncate text-code-lg font-medium tracking-tight text-primary">
                  {workspaceRoot ?? "mixed workspace"}
                </span>
                {readyFiles.length > 0 && (
                  <span className="flex items-center gap-1 rounded bg-surface-container-highest px-space-xs py-0.5 text-code-sm text-secondary">
                    <Icon name="file_copy" className="text-[13px]" />
                    {readyFiles.length.toLocaleString()} files
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-space-md gap-y-1 text-body-sm text-on-surface-variant">
                <div className="flex items-center gap-1.5 text-primary-fixed-dim">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-container opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-container" />
                  </span>
                  <span className="font-medium text-on-surface">
                    {indexStateLabel(scan.stage, progress.phase, bulkRunning)}
                  </span>
                </div>
                <span className="text-surface-container-highest">•</span>
                <span>
                  Last index:{" "}
                  <span className="text-on-surface">{formatWhen(lastIndexedAt)}</span>
                </span>
                <span className="text-surface-container-highest">•</span>
                <span className="text-on-surface-variant">
                  {medias.length > 0
                    ? `${medias.length} media files embedded`
                    : "text and code only"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-space-xs">
            <button
              type="button"
              onClick={() => void scan.pickAndScan()}
              disabled={running || scanBusy}
              className="press flex items-center gap-1.5 rounded-lg bg-primary-container px-space-md py-1.5 text-label-md text-on-primary-container transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sync" className="text-[16px]" />
              {scan.stage === "picking"
                ? "Waiting for a folder"
                : scan.stage === "scanning"
                  ? "Scanning"
                  : running
                    ? "Indexing"
                    : "Index a folder"}
            </button>
            <button
              type="button"
              onClick={() => void addFiles()}
              disabled={running || scanBusy}
              className="press flex items-center gap-1.5 rounded-lg bg-surface-container-high px-space-md py-1.5 text-label-md text-on-surface transition-colors hover:bg-surface-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="add" className="text-[16px]" />
              Add files
            </button>
            <button
              type="button"
              onClick={() => void indexStore.indexSampleDocuments(SAMPLE_DOCUMENTS)}
              disabled={running || scanBusy}
              className="press flex items-center gap-1 px-space-sm py-1.5 rounded-lg bg-surface-container text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
              title="Load the built-in sample corpus"
            >
              <Icon name="data_object" className="text-[16px]" />
              Samples
            </button>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => indexStore.clear()}
                disabled={running || scanBusy}
                className="press flex items-center gap-1 px-space-sm py-1.5 rounded-lg bg-surface-container text-label-md text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="device_reset" className="text-[16px]" />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Errors, before the numbers, because they explain them */}
      {scan.stage === "error" && scan.error && (
        <p className="rounded-lg border border-error/30 bg-error/8 px-space-md py-2 text-body-md text-error">
          {scan.error}
        </p>
      )}

      {/* Telemetry */}
      <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Indexed Files"
          icon={<Icon name="file_copy" className="text-base text-secondary" />}
          value={readyFiles.length.toLocaleString()}
          note={failedCount > 0 ? `${failedCount.toLocaleString()} failed` : "0 failed"}
          noteTone={failedCount > 0 ? "danger" : "muted"}
        />
        <StatCard
          label="Semantic Chunks"
          icon={<Icon name="data_object" className="text-base text-primary-container" />}
          value={formatCompact(chunkCount)}
          note={
            readyFiles.length > 0
              ? `${Math.round(chunkCount / readyFiles.length)} chunks / file`
              : "—"
          }
        />
        <StatCard
          label="Vector Footprint"
          icon={<Icon name="database" className="text-base text-tertiary-fixed-dim" />}
          value={embeddingBytes > 0 ? formatBytes(embeddingBytes) : "—"}
          note={MODEL_DISPLAY_NAME}
        />
        <StatCard
          label="Indexing Latency"
          icon={<Icon name="timer" className="text-base text-primary-fixed-dim" />}
          value={
            progress.startedAt !== null && progress.finishedAt !== null
              ? `${Math.round((progress.finishedAt - progress.startedAt) / 1000)}s`
              : "—"
          }
          note={
            progress.chunksTotal > 0
              ? `${progress.chunksTotal.toLocaleString()} chunks queued`
              : "idle"
          }
        />
      </div>

      {/* Pipeline */}
      <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm">
        <div className="flex flex-col justify-between gap-space-sm pb-space-xs sm:flex-row sm:items-center">
          <div className="flex items-center gap-space-sm">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                running || bulkRunning
                  ? "animate-pulse bg-primary-container shadow-[0_0_8px_rgba(178,247,0,0.8)]"
                  : "bg-surface-container-highest"
              }`}
            />
            <div>
              <h2 className="text-headline-sm font-semibold text-primary">
                Local Pipeline
              </h2>
              <div className="flex items-center gap-1.5 font-code-sm text-on-surface-variant">
                <Icon name="visibility" className="text-[14px] text-secondary" />
                <span>
                  {running || bulkRunning
                    ? "Reading, chunking and embedding files now"
                    : "Standing by — index a folder to start the pipeline"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-space-xs text-label-md">
            <button
              type="button"
              onClick={() => void scan.indexScanned()}
              disabled={!scanReady}
              className="press flex items-center gap-1 rounded bg-surface-container-high px-space-md py-1 text-on-surface transition-colors hover:bg-surface-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="sync_alt" className="text-[15px]" />
              Index scanned files
            </button>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => indexStore.clear()}
                className="press flex items-center gap-1 rounded bg-surface-container px-space-md py-1 text-on-surface-variant transition-colors hover:text-error"
              >
                <Icon name="cycle" className="text-[15px]" />
                Rebuild index
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-space-xs rounded-lg bg-surface-container-lowest p-space-md">
          <div className="flex items-center justify-between text-label-sm">
            <span className="flex items-center gap-1.5 font-medium text-on-surface">
              <Icon name="check_circle" className="text-[14px] text-primary-container" />
              State: {indexStateLabel(scan.stage, progress.phase, bulkRunning)}
            </span>
            <span className="text-code-sm text-on-surface-variant tabular-nums">
              {progress.chunksDone.toLocaleString()} /{" "}
              {progress.chunksTotal.toLocaleString()} chunks ·{" "}
              {failedCount.toLocaleString()} failures
            </span>
          </div>
          <ProgressBar
            value={progress.chunksDone}
            max={Math.max(1, progress.chunksTotal)}
            label="Indexing progress"
          />
          <div className="grid grid-cols-1 gap-space-xs pt-space-xs sm:grid-cols-5">
            <Stage label="01 Discovery" note="Folder walk" detail="files found" files={files.length} />
            <Stage
              label="02 Extraction"
              note="Read and normalise"
              detail="files read"
              files={readyFiles.length}
            />
            <Stage
              label="03 Chunking"
              note="Boundary-aware split"
              detail="chunks cut"
              files={chunkCount}
            />
            <Stage
              label="04 Embedding"
              note={MODEL_DISPLAY_NAME}
              detail="vectors written"
              files={chunkCount}
            />
            <Stage
              label="05 Index"
              note="In-memory cosine"
              detail="searchable"
              files={readyFiles.length}
            />
          </div>
        </div>
      </section>

      {/* Live indexing progress, when something is running */}
      {(progress.phase !== "idle" || bulkRunning) && (
        <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="text-headline-sm text-on-surface">
              {phaseLabel(progress.phase)}
            </p>
            {running && (
              <button
                type="button"
                onClick={() => indexStore.cancel()}
                className="press rounded border border-line-strong px-3 py-1.5 text-label-sm text-on-surface hover:border-error hover:text-error"
              >
                Cancel
              </button>
            )}
          </div>
          <ProgressBar
            value={progress.filesDone}
            max={Math.max(1, progress.filesTotal)}
            label="File progress"
          />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-code-sm text-on-surface-variant">
            <span className="tabular-nums">
              Files {progress.filesDone.toLocaleString()} of{" "}
              {progress.filesTotal.toLocaleString()}
            </span>
            <span className="tabular-nums">
              Chunks {Math.min(progress.chunksDone, progress.chunksTotal).toLocaleString()}{" "}
              of {progress.chunksTotal.toLocaleString()}
            </span>
            {progress.currentFile && (
              <span className="truncate" title={progress.currentFile}>
                {progress.currentFile}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Scan preview */}
      {scan.scan !== null && (
        <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm">
          <div className="flex flex-col justify-between gap-space-sm sm:flex-row sm:items-center">
            <div className="flex flex-col gap-0.5">
              <h3 className="flex items-center gap-space-xs text-headline-sm font-semibold text-primary">
                <Icon name="folder_open" className="text-base text-secondary" />
                Scan preview
              </h3>
              <p className="text-code-sm text-on-surface-variant">
                {scan.scan.files.length.toLocaleString()} files in{" "}
                {scan.scan.directories_visited.toLocaleString()} folders ·{" "}
                {(scan.scan.elapsed_ms / 1000).toFixed(1)}s
              </p>
            </div>
            <button
              type="button"
              onClick={() => void scan.indexScanned()}
              disabled={!scanReady}
              className="press rounded-lg bg-primary-container px-space-md py-1.5 text-label-md text-on-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            >
              Index {scan.scan.files.length.toLocaleString()} files
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Text and code" value={scan.textFiles} />
            <MiniStat label="Images" value={scan.mediaBreakdown.images} />
            <MiniStat label="Audio" value={scan.mediaBreakdown.audio} />
            <MiniStat label="Video" value={scan.mediaBreakdown.video} />
          </div>
          <p className="text-body-sm text-on-surface-variant">
            {describeSkipped(scan.scan.skipped)} Dependency, cache and system
            folders are skipped before the walk reaches them.
          </p>
        </section>
      )}

      {/* Exclusions + formats */}
      <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
        <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm lg:col-span-7">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-space-xs">
              <Icon name="rule_folder" className="text-base text-on-surface-variant" />
              <h3 className="text-headline-sm font-semibold text-primary">
                What gets skipped
              </h3>
            </div>
            <Badge tone="accent" icon={<Icon name="verified" className="text-xs" />}>
              built-in pruning
            </Badge>
          </div>
          <p className="-mt-1 text-body-sm text-on-surface-variant">
            The Rust folder walk prunes dependency, cache and system folders
            before it reaches them, so they are never read, chunked or embedded.
          </p>
          <div className="flex flex-col gap-space-xs">
            <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
              Always pruned
            </span>
            <div className="flex flex-wrap gap-1.5">
              {PRUNED_FOLDERS.map((folder) => (
                <span
                  key={folder}
                  className="inline-flex items-center gap-1 rounded bg-surface-container px-2 py-1 text-code-sm text-on-surface"
                >
                  {folder}
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-space-sm pt-space-xs text-body-sm sm:grid-cols-2">
            <Badge tone="neutral">
              <Icon name="check" className="text-[12px] text-primary-fixed-dim" />
              {formatsSupported} text and code formats
            </Badge>
            <Badge tone="neutral">
              <Icon name="check" className="text-[12px] text-primary-fixed-dim" />
              images, audio and video embedded as media
            </Badge>
            <Badge tone="neutral">
              <Icon name="close" className="text-[12px] text-error" />
              binaries and files over 10 MB
            </Badge>
            <Badge tone="neutral">
              <Icon name="close" className="text-[12px] text-error" />
              hidden files and folders
            </Badge>
          </div>
        </section>

        <section className="flex flex-col justify-between gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm lg:col-span-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <h3 className="text-headline-sm font-semibold text-primary">
                Languages in this index
              </h3>
              <span className="text-code-sm text-secondary">extension registry</span>
            </div>
            <p className="text-body-sm text-on-surface-variant">
              Extensions present in the current index. {formatsSupported} formats
              are recognised in total.
            </p>
          </div>
          {languagesPresent.length === 0 ? (
            <div className="rounded bg-surface-container-lowest p-space-md text-center text-code-sm text-on-surface-variant/70">
              Nothing indexed yet.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 font-code-sm">
              {languagesPresent.map(([extension, count]) => (
                <span
                  key={extension}
                  className="flex items-center gap-1 rounded bg-surface-container-high px-2 py-1 text-primary"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
                  {extension}
                  <span className="text-on-surface-variant tabular-nums">{count}</span>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between rounded bg-surface-container-lowest p-space-sm text-code-sm text-on-surface-variant">
            <span>Chunker window</span>
            <span className="font-medium text-primary">1,600 chars / 220 overlap</span>
          </div>
        </section>
      </div>

      {/* The index itself */}
      <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-lg shadow-sm">
        <div className="flex items-center justify-between pb-space-xs">
          <div className="flex items-center gap-space-xs">
            <Icon name="account_tree" className="text-base text-primary-container" />
            <h3 className="text-headline-sm font-semibold text-primary">
              Indexed files
            </h3>
          </div>
          <div className="flex items-center gap-space-sm text-code-sm text-on-surface-variant">
            {failedCount > 0 && (
              <span className="text-error">{failedCount.toLocaleString()} failed</span>
            )}
            <span className="tabular-nums">{files.length.toLocaleString()} total</span>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-container-lowest p-space-lg text-center">
            <Icon name="folder_open" className="text-2xl text-primary-container" />
            <p className="text-headline-sm text-on-surface">Nothing indexed yet</p>
            <p className="max-w-sm text-body-sm text-on-surface-variant">
              Pick a project folder to index, add files by hand, or load the
              sample corpus. Everything is read, chunked and embedded locally —
              nothing leaves this machine.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-code-sm">
                <thead>
                  <tr className="border-b border-surface-container-highest text-on-surface-variant">
                    <th className="px-space-sm py-space-xs text-label-sm uppercase">File</th>
                    <th className="px-space-sm py-space-xs text-label-sm uppercase">Kind</th>
                    <th className="px-space-sm py-space-xs text-label-sm uppercase">Chunks</th>
                    <th className="px-space-sm py-space-xs text-label-sm uppercase">Size</th>
                    <th className="px-space-sm py-space-xs text-right text-label-sm uppercase">
                      State
                    </th>
                    <th className="px-space-sm py-space-xs text-right text-label-sm uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-highest/50 text-on-surface">
                  {(files.length > MAX_LISTED_FILES ? files.slice(0, MAX_LISTED_FILES) : files).map(
                    (file) => (
                      <tr
                        key={file.path}
                        className="transition-colors hover:bg-surface-container"
                      >
                        <td className="max-w-xs truncate px-space-sm py-2">
                          <span className="block truncate font-medium">{file.name}</span>
                          <span
                            className="block truncate text-[11px] text-on-surface-variant"
                            title={file.path}
                          >
                            {file.isSample ? "built-in sample document" : file.path}
                          </span>
                        </td>
                        <td className="px-space-sm py-2">
                          <FileKindBadge kind={file.kind} />
                        </td>
                        <td className="px-space-sm py-2 whitespace-nowrap tabular-nums">
                          {file.chunks.length.toLocaleString()}
                        </td>
                        <td className="px-space-sm py-2 whitespace-nowrap tabular-nums text-on-surface-variant">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="px-space-sm py-2 text-right whitespace-nowrap">
                          <StatusBadge status={file.status} />
                        </td>
                        <td className="px-space-sm py-2 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => void indexStore.reindexFile(file.path)}
                              disabled={running || scanBusy}
                              className="rounded px-2 py-1 text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
                            >
                              {file.status === "failed" ? "Retry" : "Re-index"}
                            </button>
                            <button
                              type="button"
                              onClick={() => indexStore.removeFile(file.path)}
                              disabled={running || scanBusy}
                              className="rounded px-2 py-1 text-label-sm text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            {files.length > MAX_LISTED_FILES && (
              <p className="text-code-sm text-on-surface-variant">
                Showing the first {MAX_LISTED_FILES.toLocaleString()} of{" "}
                {files.length.toLocaleString()} files.
              </p>
            )}
          </>
        )}
      </section>

      {/* Privacy footer */}
      <div className="flex flex-col items-center justify-between gap-space-xs border-t border-surface-container-highest/60 pt-space-xs text-code-sm text-on-surface-variant sm:flex-row">
        <div className="flex items-center gap-2">
          <Icon name="security" className="text-xs text-primary-fixed-dim" />
          <span>
            Zero telemetry. Embeddings are held in this process only and are
            released when the app closes.
          </span>
        </div>
        <div className="text-primary-fixed-dim font-medium">
          {MODEL_DISPLAY_NAME} · {embeddingStatus.dimension ?? "—"}-dim ·{" "}
          {embeddingStatus.backend === "webgpu" ? "WebGPU" : "WASM"}
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function Stage({
  label,
  note,
  detail,
  files,
}: {
  label: string;
  note: string;
  detail: string;
  files: number;
}) {
  return (
    <div className="flex flex-col gap-1 rounded bg-surface-container-low p-space-xs">
      <div className="flex items-center justify-between text-label-sm">
        <span className="font-medium text-primary">{label}</span>
        <span className="text-code-sm text-primary-container tabular-nums">
          {formatCompact(files)}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-container-highest">
        <div className="h-full w-full bg-primary-container" />
      </div>
      <span className="text-[11px] text-on-surface-variant">
        {note}
        <span className="ml-1 text-on-surface-variant/60">· {detail}</span>
      </span>
    </div>
  );
}

function StatCard({
  label,
  icon,
  value,
  note,
  noteTone = "muted",
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  note: string;
  noteTone?: "muted" | "danger";
}) {
  return (
    <div className="flex flex-col justify-between rounded-xl bg-surface-container-low p-space-md shadow-sm transition-colors hover:bg-surface-container">
      <div className="flex items-center justify-between text-on-surface-variant">
        <span className="text-label-sm tracking-wider uppercase">{label}</span>
        {icon}
      </div>
      <div className="my-space-xs flex items-baseline gap-space-xs">
        <span className="text-headline-lg font-semibold tracking-tight text-primary tabular-nums">
          {value}
        </span>
      </div>
      <div
        className={`text-code-sm ${noteTone === "danger" ? "text-error" : "text-on-surface-variant"}`}
      >
        {note}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-line bg-surface-container-lowest px-space-md py-2">
      <dt className="text-label-sm text-on-surface-variant uppercase">{label}</dt>
      <dd className="mt-0.5 text-headline-sm font-medium text-primary tabular-nums">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

/* ── Labels ───────────────────────────────────────────────────────────────── */

const PRUNED_FOLDERS = [
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  ".cache",
  "hidden entries",
];

function indexStateLabel(
  scanStage: string,
  phase: string,
  bulkRunning: boolean,
): string {
  if (bulkRunning) return "Index In Progress";
  if (scanStage === "scanning" || scanStage === "picking") return "Scanning Folder";
  if (scanStage === "done") return "Index Up-to-Date";
  if (phase === "extracting" || phase === "embedding") return "Index In Progress";
  if (phase === "completed") return "Index Up-to-Date";
  if (phase === "failed") return "Indexing Failed";
  if (phase === "cancelled") return "Indexing Cancelled";
  return "Idle";
}

function describeSkipped(skipped: {
  binary: number;
  hidden: number;
  too_large: number;
  unsupported_extension: number;
}): string {
  const parts = [
    skipped.binary > 0 && `${skipped.binary.toLocaleString()} binary`,
    skipped.hidden > 0 && `${skipped.hidden.toLocaleString()} hidden`,
    skipped.too_large > 0 && `${skipped.too_large.toLocaleString()} over 10 MB`,
    skipped.unsupported_extension > 0 &&
      `${skipped.unsupported_extension.toLocaleString()} unsupported`,
  ].filter((part): part is string => typeof part === "string");

  return parts.length === 0
    ? "Nothing was skipped."
    : `Skipped ${parts.join(", ")}.`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "extracting":
      return "Reading and chunking files";
    case "embedding":
      return "Embedding chunks";
    case "completed":
      return "Indexing finished";
    case "cancelled":
      return "Indexing cancelled";
    case "failed":
      return "Indexing failed";
    default:
      return "Working";
  }
}

function formatWhen(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
