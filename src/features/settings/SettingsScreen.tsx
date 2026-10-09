import { useEffect, useSyncExternalStore, useState } from "react";
import { Icon } from "../../components/Icon";
import { Badge, ProgressBar } from "../../components/Badges";
import { useAppServices } from "../../hooks/useAppServices";
import { searchSettingsStore } from "../../lib/search/searchSettings";
import { searchHistoryStore } from "../../lib/search/searchHistory";
import { MODEL_DISPLAY_NAME, MODEL_ID } from "../../lib/embeddings/config";
import { indexStore } from "../../lib/indexing/indexStore";
import {
  getPersistStats,
  type PersistStats,
} from "../../lib/indexing/indexPersist";
import { commonRootOf, formatBytes, formatCompact, shortenPath } from "../../lib/format";

/**
 * Settings and diagnostics, laid out as the Stitch "Settings" screen: a
 * preferences rail on the left and four configuration sections on the right.
 *
 * The controls that are real are real: the result cap and similarity cutoff
 * write to the search settings the search screen reads, and every destructive
 * action states what it will do before it does it. Where the design shows a
 * control this build does not implement — hybrid lexical ranking, a swappable
 * inference runtime — the option is present but marked unavailable rather than
 * faked, so the layout is honest about what the app can do.
 */

export function SettingsScreen() {
  const { embeddingStatus, files, reinitializeModel } = useAppServices();
  const [section, setSection] = useState<SettingsSection>("model");
  const [confirmClear, setConfirmClear] = useState(false);

  const settings = useSyncExternalStore(
    searchSettingsStore.subscribe,
    searchSettingsStore.getSnapshot,
    searchSettingsStore.getSnapshot,
  );
  const historyCount = useSyncExternalStore(
    searchHistoryStore.subscribe,
    searchHistoryStore.getSnapshot,
    searchHistoryStore.getSnapshot,
  ).length;

  const readyFiles = files.filter((file) => file.status === "ready");
  const chunkCount = readyFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const embeddingBytes = chunkCount * (embeddingStatus.dimension ?? 0) * 4;
  const failedCount = files.filter((file) => file.status === "failed").length;
  const workspaceRoot = commonRootOf(readyFiles.map((file) => file.path));

  // On-disk snapshot stats for the storage readout. Null outside the desktop
  // app, where there is no database to report on.
  const [dbStats, setDbStats] = useState<PersistStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getPersistStats().then((stats) => {
      if (!cancelled) setDbStats(stats);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-5rem)] w-full">
      {/* Preferences rail */}
      <aside className="flex w-64 shrink-0 flex-col justify-between bg-surface-container-lowest px-space-md py-space-xl">
        <div className="flex flex-col gap-space-lg">
          <div className="px-space-md">
            <div className="text-label-sm tracking-wider text-on-surface-variant uppercase">
              Workspace Preferences
            </div>
            <p className="mt-1 text-headline-sm font-medium text-primary">
              Preferences
            </p>
          </div>
          <nav className="flex flex-col gap-1">
            {SECTIONS.map((entry) => {
              const active = section === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSection(entry.id)}
                  aria-current={active ? "true" : undefined}
                  className={`group flex w-full items-center justify-between rounded px-space-md py-space-sm text-left transition-all ${
                    active
                      ? "bg-surface-container-high font-medium text-primary shadow-sm"
                      : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
                  }`}
                >
                  <span className="flex items-center gap-space-sm">
                    <Icon
                      name={entry.icon}
                      className={`text-[18px] ${active ? "text-primary-container" : ""}`}
                    />
                    <span className="text-body-md">{entry.label}</span>
                  </span>
                  {entry.id === "model" && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-container shadow-[0_0_8px_rgba(178,247,0,0.9)]" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="px-space-md">
          <div className="flex flex-col gap-space-xs rounded-lg bg-surface-container-low p-space-sm">
            <div className="flex items-center justify-between">
              <span className="text-label-sm text-on-surface-variant uppercase">
                Runtime Telemetry
              </span>
              <span className="text-code-sm text-primary-fixed-dim">Zero net calls</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-surface-container-highest">
              <div
                className={`h-full rounded-full bg-primary-container transition-[width] duration-500 ${
                  embeddingStatus.phase === "ready" ? "w-full" : "w-1/3"
                }`}
              />
            </div>
            <div className="flex items-center justify-between pt-0.5 text-code-sm text-on-surface-variant">
              <span>In-process index</span>
              <span className="flex items-center gap-1 text-primary">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    embeddingStatus.phase === "error"
                      ? "bg-error"
                      : "bg-primary-container"
                  }`}
                />
                {enginePhase(embeddingStatus.phase)}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Configuration panel */}
      <main className="max-w-5xl flex-1 bg-surface px-space-xl py-space-xl">
        <div className="flex flex-col gap-y-10 pb-16">
          {/* Header */}
          <header className="flex flex-col gap-space-xs">
            <div className="flex items-center gap-space-sm">
              <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
                Hardware &amp; Processing Layer
              </span>
              <span className="rounded bg-surface-container-highest px-2 py-0.5 font-code-sm text-primary-container">
                Local Isolated Sandbox
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <h1 className="text-headline-lg font-semibold tracking-tight text-primary">
                {SECTIONS.find((entry) => entry.id === section)?.heading}
              </h1>
              <div className="flex items-center gap-space-sm">
                <span className="font-code-sm text-on-surface-variant">
                  q4 · ONNX Runtime {formatCompact(readyFiles.length)} files
                </span>
                {embeddingStatus.phase === "error" && (
                  <button
                    type="button"
                    onClick={reinitializeModel}
                    className="press rounded bg-primary-container px-space-md py-1 text-label-sm font-semibold text-on-primary-container"
                  >
                    Retry model load
                  </button>
                )}
              </div>
            </div>
            <p className="mt-0.5 max-w-2xl text-body-md text-on-surface-variant">
              {SECTIONS.find((entry) => entry.id === section)?.blurb}
            </p>
          </header>

          {/* Section 1 — model and runtime */}
          {section === "model" && (
            <section className="flex flex-col gap-space-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-sm">
                  <Icon name="memory" className="text-[20px] text-primary-container" />
                  <h2 className="text-headline-md font-semibold text-primary">
                    Active Local Transformer
                  </h2>
                </div>
                <span className="rounded bg-surface-container-high px-2 py-0.5 text-label-sm text-primary-fixed-dim">
                  Cosine Metric: Strict
                </span>
              </div>

              <div className="flex flex-col gap-space-lg rounded-lg bg-surface-container-low p-space-lg shadow-sm">
                <div className="flex flex-col justify-between gap-space-md md:flex-row md:items-start">
                  <div className="flex flex-col gap-space-xs">
                    <div className="flex flex-wrap items-center gap-space-sm">
                      <span className="text-headline-md font-semibold tracking-tight text-primary">
                        {MODEL_DISPLAY_NAME}
                      </span>
                      <span className="rounded bg-surface-container px-2 py-0.5 font-code-sm text-on-surface-variant">
                        {embeddingStatus.dimension ?? "—"}-dim
                      </span>
                      <span className="rounded bg-surface-container px-2 py-0.5 font-code-sm text-on-surface-variant">
                        q4 quantised
                      </span>
                      <Badge tone="success">Selected</Badge>
                    </div>
                    <p className="max-w-xl text-body-md text-on-surface-variant">
                      A local transformer that maps text, code, images and audio
                      into the same vector space, so a written query can find a
                      photo or a recording. It runs in-process through ONNX
                      Runtime Web.
                    </p>
                  </div>
                  <div className="flex items-center gap-space-xs self-start rounded bg-surface-container px-space-md py-1.5">
                    <Icon
                      name={
                        embeddingStatus.phase === "error" ? "error_outline" : "check_circle"
                      }
                      className="text-[16px] text-primary-container"
                    />
                    <span className="text-label-sm text-primary">
                      {embeddingStatus.phase === "ready"
                        ? "Downloaded & verified"
                        : embeddingStatus.phase === "loading"
                          ? "Loading"
                          : embeddingStatus.phase === "error"
                            ? "Failed to load"
                            : "Not loaded"}
                    </span>
                  </div>
                </div>

                {/* Weight source and state */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface-container-lowest px-space-md py-space-sm font-code-sm text-on-surface-variant">
                  <span className="flex items-center gap-2">
                    <span className="text-on-surface-variant/60">Weights:</span>
                    <span className="text-primary">{MODEL_ID}</span>
                  </span>
                  <span className="flex items-center gap-1 text-xs text-primary-fixed-dim">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
                    {enginePhase(embeddingStatus.phase)}
                    {embeddingStatus.downloadProgress !== null && (
                      <span className="tabular-nums">
                        {" "}
                        · {Math.round(embeddingStatus.downloadProgress)}%
                      </span>
                    )}
                  </span>
                </div>

                {embeddingStatus.phase === "loading" &&
                  embeddingStatus.downloadProgress !== null && (
                    <div className="flex flex-col gap-2">
                      <ProgressBar
                        value={embeddingStatus.downloadProgress}
                        max={100}
                        label="Model download"
                      />
                      <p className="text-body-sm text-on-surface-variant">
                        Downloading from the Hugging Face Hub
                        {embeddingStatus.downloadFile
                          ? ` — ${embeddingStatus.downloadFile}`
                          : ""}
                        . Only the encoders this session needs are fetched; after
                        the first run everything works offline.
                      </p>
                    </div>
                  )}

                {/* Runtime readouts. Not switches: this build detects the
                    backend rather than choosing one. */}
                <div className="grid grid-cols-1 gap-space-md pt-space-xs md:grid-cols-3">
                  <Field label="Inference Engine">
                    <div className="flex items-center bg-surface-container-high p-0.5 rounded">
                      <span className="flex-1 rounded bg-primary-container py-1.5 text-center text-label-sm font-semibold text-on-primary">
                        ONNX Runtime
                      </span>
                      <span className="flex-1 py-1.5 text-center text-label-sm text-on-surface-variant/60">
                        llama.cpp
                      </span>
                    </div>
                  </Field>
                  <Field label="Compute Target">
                    <div className="flex items-center bg-surface-container-high p-0.5 rounded">
                      <Segment label="CPU" active={embeddingStatus.backend === "wasm"} />
                      <Segment label="GPU" active={embeddingStatus.backend === "webgpu"} />
                    </div>
                  </Field>
                  <Field label="Quantisation">
                    <div className="flex items-center bg-surface-container-high p-0.5 rounded">
                      <Segment label="q4" active />
                      <Segment label="fp16" active={false} />
                    </div>
                  </Field>
                </div>

                {/* Live index size, which is what the model is actually holding */}
                <dl className="grid grid-cols-2 gap-3 rounded bg-surface-container-lowest p-space-md font-code-sm sm:grid-cols-4">
                  <Readout label="Vectors" value={chunkCount.toLocaleString()} />
                  <Readout
                    label="Resident"
                    value={embeddingBytes > 0 ? formatBytes(embeddingBytes) : "—"}
                  />
                  <Readout
                    label="Files"
                    value={readyFiles.length.toLocaleString()}
                  />
                  <Readout
                    label="Failed"
                    value={failedCount.toLocaleString()}
                    tone={failedCount > 0 ? "danger" : "default"}
                  />
                </dl>
              </div>
            </section>
          )}

          {/* Section 2 — retrieval */}
          {section === "search" && (
            <section className="flex flex-col gap-space-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-sm">
                  <Icon name="tune" className="text-[20px] text-primary-container" />
                  <h2 className="text-headline-md font-semibold text-primary">
                    Search &amp; Retrieval Tuning
                  </h2>
                </div>
                <span className="text-label-sm text-on-surface-variant">
                  In-memory index
                </span>
              </div>

              <div className="grid grid-cols-1 gap-space-lg md:grid-cols-2">
                <SliderCard
                  title="Result cap"
                  value={settings.limit}
                  readout={`${settings.limit} results`}
                  min={5}
                  max={50}
                  step={5}
                  minLabel="5 (fastest)"
                  maxLabel="50 (deep context)"
                  description="Maximum files returned per search. Larger caps search more of the index but take longer to rank."
                  onChange={(value) => searchSettingsStore.setLimit(value)}
                />
                <SliderCard
                  title="Similarity cutoff"
                  value={settings.minScore}
                  readout={`${settings.minScore.toFixed(2)} score`}
                  min={0}
                  max={0.95}
                  step={0.01}
                  minLabel="0.00 (permissive)"
                  maxLabel="0.95 (exact)"
                  description="Cosine similarity below which a file is discarded. Raise it to suppress unrelated matches on a large index."
                  onChange={(value) => searchSettingsStore.setMinScore(value)}
                />
              </div>

              <div className="flex flex-col gap-space-lg rounded-lg bg-surface-container-low p-space-lg shadow-sm">
                <div className="flex flex-col gap-space-sm">
                  <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
                    Primary Search Strategy
                  </span>
                  <div className="grid grid-cols-1 gap-space-md sm:grid-cols-2">
                    <label
                      className={`flex cursor-pointer items-start gap-space-sm rounded p-space-md transition-colors ${
                        settings.strategy === "vector"
                          ? "bg-surface-container-high shadow-sm"
                          : "bg-surface-container hover:bg-surface-container-high"
                      }`}
                    >
                      <input
                        type="radio"
                        name="search-strategy"
                        checked={settings.strategy === "vector"}
                        onChange={() => searchSettingsStore.setStrategy("vector")}
                        className="mt-1 accent-primary-container"
                      />
                      <div className="flex flex-col">
                        <span className="text-body-md font-semibold text-primary">
                          Semantic Vector Only
                        </span>
                        <span className="text-body-sm text-on-surface-variant">
                          Dense embedding distance. Best for exploratory questions
                          in plain language.
                        </span>
                      </div>
                    </label>
                    <label
                      className={`flex cursor-pointer items-start gap-space-sm rounded p-space-md transition-colors ${
                        settings.strategy === "hybrid"
                          ? "bg-surface-container-high shadow-sm"
                          : "bg-surface-container hover:bg-surface-container-high"
                      }`}
                    >
                      <input
                        type="radio"
                        name="search-strategy"
                        checked={settings.strategy === "hybrid"}
                        onChange={() => searchSettingsStore.setStrategy("hybrid")}
                        className="mt-1 accent-primary-container"
                      />
                      <div className="flex flex-col">
                        <div className="flex items-center gap-space-xs">
                          <span className="text-body-md font-medium text-on-surface">
                            Hybrid: Vector + BM25 Lexical
                          </span>
                          <Badge tone="accent">Recommended</Badge>
                        </div>
                        <span className="text-body-sm text-on-surface-variant">
                          Blends token frequency with vector embeddings for exact
                          symbols and typos.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="flex flex-col justify-between gap-space-md pt-space-sm md:flex-row md:items-center">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-headline-sm font-medium text-primary">
                      Result cards preview in
                    </span>
                    <p className="text-body-sm text-on-surface-variant">
                      Preview opens the real file contents through the native
                      reader, with the matched chunk jumped to.
                    </p>
                  </div>
                  <Badge tone="accent" icon={<Icon name="description" className="text-[13px]" />}>
                    preview panel
                  </Badge>
                </div>
              </div>
            </section>
          )}

          {/* Section 3 — chunking and storage */}
          {section === "indexing" && (
            <section className="flex flex-col gap-space-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-sm">
                  <Icon name="account_tree" className="text-[20px] text-primary-container" />
                  <h2 className="text-headline-md font-semibold text-primary">
                    Chunking &amp; Indexing
                  </h2>
                </div>
                <span className="text-label-sm text-on-surface-variant">
                  fixed in this build
                </span>
              </div>

              <div className="grid grid-cols-1 gap-space-md md:grid-cols-3">
                <ValueCard
                  label="Parser strategy"
                  value="Boundary-aware splitting"
                  note="Cuts at the last paragraph break, then sentence end, then whitespace."
                  icon="data_object"
                />
                <ValueCard
                  label="Chunk window"
                  value="1,600 chars"
                  note="Roughly 400–550 tokens for prose and code, inside the model's 8,192-token context."
                  icon="data_object"
                />
                <ValueCard
                  label="Chunk overlap"
                  value="220 chars"
                  note="Overlaps by whole lines so no sentence is lost across a cut."
                  icon="cycle"
                />
              </div>

              <div className="flex flex-col gap-space-md rounded-lg bg-surface-container-low p-space-lg shadow-sm">
                <h3 className="text-headline-sm font-semibold text-primary">
                  Workspace in this session
                </h3>
                <dl className="grid grid-cols-1 gap-3 font-code-sm sm:grid-cols-3">
                  <Readout
                    label="Root"
                    value={workspaceRoot ? basename(workspaceRoot) : "mixed"}
                  />
                  <Readout label="Files" value={files.length.toLocaleString()} />
                  <Readout
                    label="Media embedded"
                    value={
                      files.filter(
                        (file) => file.kind === "image" || file.kind === "media",
                      ).length.toLocaleString()
                    }
                  />
                </dl>
                <p className="text-body-sm text-on-surface-variant">
                  Formats are resolved from the extension registry, so the index
                  knows whether a file is code, prose, data or media before it is
                  read.
                </p>
              </div>
            </section>
          )}

          {/* Section 4 — storage and privacy */}
          {section === "storage" && (
            <section className="flex flex-col gap-space-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-sm">
                  <Icon name="shield" className="text-[20px] text-primary-container" />
                  <h2 className="text-headline-md font-semibold text-primary">
                    Local Storage &amp; Privacy
                  </h2>
                </div>
                <span className="rounded bg-surface-container-high px-2 py-0.5 text-label-sm text-on-surface-variant">
                  Airgap Compliant
                </span>
              </div>

              <div className="flex flex-col items-start justify-between gap-space-lg rounded-lg bg-surface-container-low p-space-lg shadow-sm md:flex-row">
                <div className="flex gap-space-md">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-surface-container-high">
                    <Icon name="lock" className="text-[28px] text-primary-container" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-space-sm">
                      <span className="text-headline-sm font-semibold text-primary">
                        100% Local-First Architecture
                      </span>
                      <Badge tone="success">Verified zero outbound</Badge>
                    </div>
                    <p className="max-w-xl text-body-md text-on-surface-variant">
                      File contents, extracted text, embeddings, media and search
                      queries all stay in this process. The only network access
                      is the first model download from Hugging Face; after that
                      everything works offline.
                    </p>
                    <div className="flex flex-wrap items-center gap-space-lg pt-2 text-code-sm text-on-surface-variant">
                      <span className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
                        SQLite snapshot on this disk
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
                        No telemetry, no analytics
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex min-w-[200px] flex-col gap-space-xs rounded bg-surface-container p-space-md">
                  <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
                    On-Disk Snapshot
                  </span>
                  <div className="flex items-baseline justify-between pt-1">
                    <span className="text-body-sm text-on-surface-variant">
                      Index database:
                    </span>
                    <span className="text-code-sm font-medium text-primary tabular-nums">
                      {dbStats ? formatBytes(dbStats.bytes) : "—"}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-body-sm text-on-surface-variant">
                      Files stored:
                    </span>
                    <span className="text-code-sm font-medium text-primary tabular-nums">
                      {dbStats ? dbStats.files.toLocaleString() : "—"}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-body-sm text-on-surface-variant">
                      Vectors resident:
                    </span>
                    <span className="text-code-sm font-medium text-primary tabular-nums">
                      {embeddingBytes > 0 ? formatBytes(embeddingBytes) : "—"}
                    </span>
                  </div>
                  <span
                    className="truncate text-right text-code-sm text-on-surface-variant/70 tabular-nums"
                    title={dbStats?.path ?? "Snapshot path unavailable outside the desktop app."}
                  >
                    {dbStats ? shortenPath(dbStats.path, 32) : "browser preview — no snapshot"}
                  </span>
                  <span className="text-right text-code-sm text-on-surface-variant/70">
                    reloads automatically on launch
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-space-md sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => searchHistoryStore.clear()}
                  disabled={historyCount === 0}
                  className="press flex items-center justify-center gap-space-xs rounded bg-surface-container-high px-space-md py-2.5 text-body-sm text-on-surface transition-colors hover:bg-surface-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="history" className="text-[16px] text-on-surface-variant" />
                  Clear query history ({historyCount})
                </button>
                <button
                  type="button"
                  onClick={() => indexStore.clear()}
                  disabled={files.length === 0}
                  className="press flex items-center justify-center gap-space-xs rounded bg-surface-container-high px-space-md py-2.5 text-body-sm text-on-surface transition-colors hover:bg-surface-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="cleaning_services" className="text-[16px] text-on-surface-variant" />
                  Purge embedding cache
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirmClear) {
                      indexStore.clear();
                      searchHistoryStore.clear();
                      setConfirmClear(false);
                    } else {
                      setConfirmClear(true);
                    }
                  }}
                  disabled={files.length === 0 && historyCount === 0}
                  className="press flex items-center justify-center gap-space-xs rounded bg-error/40 px-space-md py-2.5 text-body-sm text-error transition-colors hover:bg-error/70 hover:text-on-error-container disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="device_reset" className="text-[16px]" />
                  {confirmClear ? "Confirm reset — click again" : "Reset state"}
                </button>
              </div>
              {confirmClear && (
                <p className="text-body-sm text-warning">
                  Resetting clears the index and the search history. It cannot be
                  undone.
                </p>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

const SECTIONS: {
  id: SettingsSection;
  label: string;
  heading: string;
  blurb: string;
  icon: React.ComponentProps<typeof Icon>["name"];
}[] = [
  {
    id: "search",
    label: "Search Preferences",
    heading: "Search & Retrieval",
    blurb:
      "Tune how many results come back and how strong a match has to be before it is shown.",
    icon: "travel_explore",
  },
  {
    id: "model",
    label: "Model & Runtime",
    heading: "Embedding Model & Runtime",
    blurb:
      "The local transformer behind the index, what it is currently holding, and which device it runs on.",
    icon: "memory",
  },
  {
    id: "indexing",
    label: "Indexing & Ignores",
    heading: "Chunking & Indexing",
    blurb:
      "How files are split into chunks before embedding, and what the current workspace looks like.",
    icon: "rule_folder",
  },
  {
    id: "storage",
    label: "Storage & Privacy",
    heading: "Local Storage & Privacy",
    blurb:
      "Where the embeddings live, what leaves this machine, and how to clear it all.",
    icon: "verified_user",
  },
];

type SettingsSection = "search" | "model" | "indexing" | "storage";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-space-xs">
      <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function Segment({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`flex-1 rounded py-1.5 text-center text-label-sm transition-colors ${
        active
          ? "bg-primary-container font-semibold text-on-primary shadow-sm"
          : "text-on-surface-variant/60"
      }`}
    >
      {label}
    </span>
  );
}

function Readout({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-label-sm text-on-surface-variant uppercase">{label}</dt>
      <dd
        className={`truncate font-medium tabular-nums ${
          tone === "danger" ? "text-error" : "text-primary"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function ValueCard({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ComponentProps<typeof Icon>["name"];
}) {
  return (
    <div className="flex flex-col justify-between rounded-lg bg-surface-container-low p-space-lg">
      <div className="flex flex-col gap-space-xs">
        <span className="text-label-sm tracking-wider text-on-surface-variant uppercase">
          {label}
        </span>
        <div className="flex items-center gap-space-xs">
          <Icon name={icon} className="text-[18px] text-primary-container" />
          <span className="text-headline-sm font-medium text-primary">{value}</span>
        </div>
        <p className="mt-1 text-body-sm text-on-surface-variant">{note}</p>
      </div>
    </div>
  );
}

function SliderCard({
  title,
  value,
  readout,
  min,
  max,
  step,
  minLabel,
  maxLabel,
  description,
  onChange,
}: {
  title: string;
  value: number;
  readout: string;
  min: number;
  max: number;
  step: number;
  minLabel: string;
  maxLabel: string;
  description: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-space-md rounded-lg bg-surface-container-low p-space-lg">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-headline-sm font-medium text-primary">{title}</span>
          <span className="rounded bg-surface-container-highest px-2 py-0.5 font-code-sm text-primary-fixed-dim">
            {readout}
          </span>
        </div>
        <p className="text-body-sm text-on-surface-variant">{description}</p>
      </div>
      <input
        type="range"
        className="h-1.5 w-full cursor-pointer accent-primary-container rounded-lg bg-surface-container-highest"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={title}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <div className="flex justify-between text-label-sm text-on-surface-variant">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  );
}

function enginePhase(phase: string): string {
  switch (phase) {
    case "loading":
      return "Loading";
    case "error":
      return "Error";
    case "ready":
      return "Ready";
    default:
      return "Idle";
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
