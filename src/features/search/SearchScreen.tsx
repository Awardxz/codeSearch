import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../../components/Icon";
import { useAppServices } from "../../hooks/useAppServices";
import { Badge } from "../../components/Badges";
import { searchIndex } from "../../lib/search/searchService";
import { searchSettingsStore } from "../../lib/search/searchSettings";
import {
  relativeTime,
  searchHistoryStore,
} from "../../lib/search/searchHistory";
import { registerSearchFocusTarget } from "./searchFocus";
import { KeyCap, SearchField } from "./SearchField";
import { ResultCard } from "./ResultCard";
import { commonRootOf, formatBytes, formatCompact } from "../../lib/format";
import { MODEL_DISPLAY_NAME } from "../../lib/embeddings/config";
import type { AppError, FileKind, SearchResponse } from "../../types";

/**
 * Search screen: one field, then document results.
 *
 * The screen has two states, both lifted straight from the Stitch design. With
 * nothing indexed or no query yet it is the "Search (Empty State)" screen — a
 * hero, the omni field, suggested intents and the index summary. Once a query
 * has run it becomes the "Search" screen — the same field in its panel shell,
 * a query metadata bar, then a stack of result cards.
 *
 * Every control is wired: the suggested intents run real searches, the filter
 * popovers scope them, ↑/↓ moves through the result stack and ↵ opens the
 * preview, and every completed search is recorded so the empty state has a
 * real history to show.
 */

const KIND_FILTERS: { id: FileKind; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "markdown", label: "Markdown" },
  { id: "text", label: "Text" },
  { id: "data", label: "Data" },
  { id: "document", label: "Documents" },
  { id: "image", label: "Images" },
  { id: "media", label: "Audio and video" },
];

/** Suggested intents — running any of these is a real semantic search. */
const SUGGESTED_INTENTS: string[] = [
  "Where do we refresh expired authentication tokens?",
  "Find the function that retries failed HTTP requests",
  "How are database connections initialized and pooled?",
  "Where do we validate user permissions or roles?",
  "Show how chunks are embedded and written to the index",
];

const RESULT_LIMITS = [10, 25, 50];

export function SearchScreen() {
  const { index, embeddingStatus } = useAppServices();
  const settings = useSyncExternalStore(
    searchSettingsStore.subscribe,
    searchSettingsStore.getSnapshot,
    searchSettingsStore.getServerSnapshot,
  );
  const history = searchHistoryStore.getSnapshot();

  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<FileKind[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [filterOpen, setFilterOpen] = useState<"kinds" | "limit" | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The shell's ⌘K needs to reach this input.
  useEffect(() => {
    registerSearchFocusTarget(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => registerSearchFocusTarget(null);
  }, []);

  const readyFiles = index.files.filter((file) => file.status === "ready");
  const chunkCount = readyFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const workspaceRoot = commonRootOf(readyFiles.map((file) => file.path));

  const modelBusy = embeddingStatus.phase === "loading";
  const modelError = embeddingStatus.phase === "error";
  const hasContent = searching || response !== null || error !== null;

  /* ── search ─────────────────────────────────────────────────────────── */

  async function runSearch(rawQuery: string) {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      setResponse(null);
      setError(null);
      setCursor(-1);
      return;
    }

    setSearching(true);
    setError(null);
    try {
      const result = await searchIndex(index, {
        query: trimmed,
        limit: settings.limit,
        kinds,
        minScore: settings.minScore,
        strategy: settings.strategy,
      });
      setResponse(result);
      setCursor(result.hits.length > 0 ? 0 : -1);
      searchHistoryStore.record(trimmed, result.hits.length);
    } catch (caught) {
      setError(
        caught && typeof caught === "object" && "code" in caught
          ? (caught as AppError)
          : { code: "unknown", message: String(caught) },
      );
      setResponse(null);
      setCursor(-1);
    } finally {
      setSearching(false);
    }
  }

  function clearAll() {
    setQuery("");
    setResponse(null);
    setError(null);
    setCursor(-1);
    inputRef.current?.focus();
  }

  function toggleKind(kind: FileKind) {
    setKinds((current) =>
      current.includes(kind)
        ? current.filter((item) => item !== kind)
        : [...current, kind],
    );
  }

  /* ── keyboard: ↑/↓ through the stack, ↵ to open, Esc to clear ────────── */

  useEffect(() => {
    if (!response || response.hits.length === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (inField && target !== inputRef.current) return;
        event.preventDefault();
        setCursor((current) => {
          const last = response.hits.length - 1;
          const next = event.key === "ArrowDown" ? current + 1 : current - 1;
          return Math.max(0, Math.min(last, next));
        });
        return;
      }

      if (event.key === "Enter" && cursor >= 0 && cursor < response.hits.length) {
        const card = listRef.current?.querySelectorAll<HTMLElement>(
          "[data-result-card]",
        )[cursor];
        card?.querySelector<HTMLButtonElement>("[data-preview-button]")?.click();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [response, cursor]);

  // Keep the keyboard cursor's card scrolled into view.
  useEffect(() => {
    if (cursor < 0) return;
    const card = listRef.current?.querySelectorAll<HTMLElement>("[data-result-card]")[
      cursor
    ];
    card?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const hits = response?.hits ?? [];
  const activeKindLabel =
    kinds.length === 0
      ? "all"
      : kinds.length === 1
        ? (KIND_FILTERS.find((filter) => filter.id === kinds[0])?.label ?? "1")
        : `${kinds.length} types`;

  if (!hasContent) {
    return (
      <EmptyState
        query={query}
        setQuery={setQuery}
        inputRef={inputRef}
        onSubmit={() => void runSearch(query)}
        onClear={clearAll}
        onSubmitQuery={(text) => {
          setQuery(text);
          void runSearch(text);
        }}
        busy={searching}
        disabled={modelBusy}
        modelError={modelError}
        error={error}
        readyFiles={readyFiles.length}
        chunkCount={chunkCount}
        dimension={embeddingStatus.dimension}
        engineReady={embeddingStatus.phase === "ready"}
        workspaceRoot={workspaceRoot}
        history={history}
        kinds={kinds}
        toggleKind={toggleKind}
      />
    );
  }

  return (
    <div className="relative w-full pb-16">
      <div className="mx-auto flex max-w-4xl flex-col gap-space-md px-gutter py-space-md">
        {/* Hero */}
        <div className="flex items-center gap-2 pt-2">
          <h1 className="text-headline-md font-medium tracking-tight text-primary">
            Find the code.
            <span className="text-body-md font-normal text-on-surface-variant">
              {" "}
              Search {formatCompact(chunkCount)} chunks across{" "}
              {workspaceRoot ? basename(workspaceRoot) : "your workspace"}
            </span>
          </h1>
          <span className="rounded border border-surface-container-highest/60 bg-surface-container-high px-1.5 py-0.5 text-label-sm text-on-surface-variant/80">
            {embeddingStatus.dimension ?? "—"}d dense
          </span>
        </div>

        <SearchField
          ref={inputRef}
          variant="panel"
          value={query}
          onChange={setQuery}
          onSubmit={() => void runSearch(query)}
          onClear={clearAll}
          busy={searching}
          disabled={modelBusy}
          modeLabel={
            settings.strategy === "hybrid"
              ? "Hybrid (Vector + Lexical)"
              : "Semantic (Vector)"
          }
          onToggleMode={() => {
            const next =
              settings.strategy === "hybrid" ? "vector" : "hybrid";
            searchSettingsStore.setStrategy(next);
            if (query.trim()) void runSearch(query);
          }}
          suggestions={SUGGESTED_INTENTS.slice(0, 3)}
          onSuggestion={(text) => {
            setQuery(text);
            void runSearch(text);
          }}
        />

        {/* Query metadata and refinement */}
        <div className="flex flex-wrap items-center justify-between gap-space-sm select-none">
          <div className="flex items-center gap-space-sm text-label-sm text-on-surface-variant">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
              <span className="text-code-sm font-medium text-primary tabular-nums">
                {hits.length} {hits.length === 1 ? "match" : "matches"}
              </span>
              {response && (
                <span className="text-on-surface-variant/60">
                  in {Math.round(response.durationMs)}ms
                </span>
              )}
            </div>
            <span className="text-surface-container-highest">•</span>
            <span className="flex items-center gap-1 text-code-sm text-on-surface-variant/80">
              <Icon name="sort" className="text-[13px]" />
              {settings.strategy === "hybrid"
                ? "Blended vector + lexical"
                : "Cosine similarity"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {/* File-kind filter */}
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setFilterOpen((open) => (open === "kinds" ? null : "kinds"))
                }
                aria-expanded={filterOpen === "kinds"}
                className="flex items-center gap-1 rounded border border-surface-container-highest/40 bg-surface-container-low px-2 py-0.5 text-code-sm text-on-surface transition-colors hover:bg-surface-container"
              >
                <span className="text-on-surface-variant/70">Lang:</span>
                {activeKindLabel}
                <Icon name="arrow_drop_down" className="text-[13px]" />
              </button>
              {filterOpen === "kinds" && (
                <div className="absolute right-0 z-30 mt-1 w-48 rounded-lg border border-line-strong bg-surface-container-low p-1 shadow-[0_16px_36px_-8px_rgba(0,0,0,0.7)]">
                  {KIND_FILTERS.map((filter) => (
                    <label
                      key={filter.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-code-sm text-on-surface hover:bg-surface-container-high"
                    >
                      <input
                        type="checkbox"
                        checked={kinds.includes(filter.id)}
                        onChange={() => toggleKind(filter.id)}
                        className="h-3.5 w-3.5 accent-primary-container"
                      />
                      {filter.label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Similarity threshold, edited in Settings */}
            <span
              className="flex items-center gap-1 rounded border border-surface-container-highest/40 bg-surface-container-low px-2 py-0.5 text-code-sm text-primary-fixed-dim"
              title="Cosine cutoff — change it in Settings › Search and retrieval"
            >
              <span className="text-on-surface-variant/70">Score:</span>
              &ge; {settings.minScore.toFixed(2)}
            </span>

            {/* Result limit */}
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setFilterOpen((open) => (open === "limit" ? null : "limit"))
                }
                aria-expanded={filterOpen === "limit"}
                className="flex items-center gap-1 rounded border border-surface-container-highest/40 bg-surface-container-low px-2 py-0.5 text-code-sm text-on-surface transition-colors hover:bg-surface-container"
              >
                <span className="text-on-surface-variant/70">Limit:</span>
                {settings.limit}
                <Icon name="arrow_drop_down" className="text-[13px]" />
              </button>
              {filterOpen === "limit" && (
                <div className="absolute right-0 z-30 mt-1 w-32 rounded-lg border border-line-strong bg-surface-container-low p-1 shadow-[0_16px_36px_-8px_rgba(0,0,0,0.7)]">
                  {RESULT_LIMITS.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      onClick={() => {
                        searchSettingsStore.setLimit(choice);
                        setFilterOpen(null);
                        if (query.trim()) void runSearch(query);
                      }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-code-sm hover:bg-surface-container-high ${
                        settings.limit === choice
                          ? "text-primary"
                          : "text-on-surface"
                      }`}
                    >
                      {choice}
                      {settings.limit === choice && (
                        <Icon name="check" className="text-[13px]" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Errors sit with the field, because they concern the query */}
        {modelError && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-space-md py-2 text-body-md text-error">
            The model failed to load: {embeddingStatus.error?.message}. Retry from
            Settings.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-space-md py-2 text-body-md text-error">
            {error.message}
          </div>
        )}

        {/* Results */}
        <div ref={listRef} className="flex flex-col gap-space-md">
          {searching && (
            <div className="flex items-center gap-3 py-10 text-body-md text-on-surface-variant">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse-soft absolute inline-flex h-full w-full rounded-full bg-primary-container" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-container" />
              </span>
              Embedding the query and ranking {readyFiles.length.toLocaleString()}{" "}
              files
            </div>
          )}

          {!searching && response && hits.length === 0 && (
            <div className="py-9">
              <p className="text-headline-sm text-on-surface">
                Nothing matched that description
              </p>
              <p className="mt-2 max-w-md text-body-md leading-relaxed text-on-surface-variant">
                No file scored above the {settings.minScore.toFixed(2)} similarity
                cutoff. Try different wording, clear the type filter, or index a
                folder with more files in it.
              </p>
              {kinds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setKinds([])}
                  className="press mt-4 rounded border border-line-strong bg-surface-container-high px-3 py-1.5 text-label-sm text-on-surface hover:bg-surface-bright"
                >
                  Clear type filter
                </button>
              )}
            </div>
          )}

          {!searching &&
            hits.map((hit, position) => (
              <div
                key={hit.path}
                data-result-card
                className={`rounded-lg transition-shadow ${
                  position === cursor ? "ring-1 ring-primary-container/60" : ""
                }`}
              >
                <ResultCard
                  hit={hit}
                  query={response?.query ?? ""}
                  isTop={position === 0}
                />
              </div>
            ))}
        </div>
      </div>

      <EngineStatusStrip
        readyFiles={readyFiles.length}
        chunkCount={chunkCount}
        embeddingBytes={
          chunkCount * (embeddingStatus.dimension ?? 0) * 4
        }
      />
    </div>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────────── */

function EmptyState({
  query,
  setQuery,
  inputRef,
  onSubmit,
  onClear,
  onSubmitQuery,
  busy,
  disabled,
  modelError,
  error,
  readyFiles,
  chunkCount,
  dimension,
  engineReady,
  workspaceRoot,
  history,
  kinds,
  toggleKind,
}: {
  query: string;
  setQuery: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onClear: () => void;
  onSubmitQuery: (query: string) => void;
  busy: boolean;
  disabled: boolean;
  modelError: boolean;
  error: AppError | null;
  readyFiles: number;
  chunkCount: number;
  /** Real embedding dimension, so the readout never guesses. */
  dimension: number | null;
  /** True when the embedding worker has finished loading. */
  engineReady: boolean;
  workspaceRoot: string | null;
  history: ReturnType<typeof searchHistoryStore.getSnapshot>;
  kinds: FileKind[];
  toggleKind: (kind: FileKind) => void;
}) {
  const modelReady = engineReady;
  return (
    <div className="relative w-full overflow-hidden">
      {/* Ambient wash, exactly as the design stages it */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-[340px] w-[720px] -translate-x-1/2 rounded-full bg-primary-container/5 blur-[120px]" />
      <div className="pointer-events-none absolute top-24 right-1/4 h-[180px] w-[280px] rounded-full bg-secondary/5 blur-[90px]" />

      <div className="relative z-10 mx-auto flex max-w-[760px] flex-col gap-6 px-margin pt-10 pb-16">
        {/* Hero */}
        <div className="flex flex-col items-center gap-space-xs text-center">
          <div className="inline-flex items-center gap-space-xs rounded-full bg-surface-container-high px-space-sm py-0.5 text-label-sm tracking-wider text-on-surface-variant uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
            Semantic File Search
          </div>
          <h1 className="mt-1 text-headline-lg font-semibold tracking-tight text-primary">
            Find files by intent
          </h1>
          <p className="max-w-lg text-body-md text-on-surface-variant">
            Search code, documents, images and recordings by meaning. Embeddings
            run on this machine with {MODEL_DISPLAY_NAME} — nothing is uploaded.
          </p>
        </div>

        {/* Omni field */}
        <SearchField
          ref={inputRef}
          variant="plain"
          value={query}
          onChange={setQuery}
          onSubmit={onSubmit}
          onClear={onClear}
          busy={busy}
          disabled={disabled}
          modeLabel="Semantic Vector"
          onToggleMode={() => undefined}
          suggestions={[]}
          onSuggestion={() => undefined}
          footer={
            <div className="flex items-center justify-between px-space-md pt-space-xs text-label-sm text-on-surface-variant/70">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
                Zero telemetry. Local inference active.
              </span>
              <span className="transition-colors hover:text-primary">
                Press <KeyCap>Tab</KeyCap> to scope by filetype
              </span>
            </div>
          }
        />

        {modelError && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-space-md py-2 text-body-md text-error">
            The model failed to load. Open Settings to retry.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-space-md py-2 text-body-md text-error">
            {error.message}
          </div>
        )}

        {readyFiles === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-container-low p-space-lg text-center">
            <Icon name="account_tree" className="text-2xl text-primary-container" />
            <p className="text-headline-sm text-on-surface">
              Nothing indexed yet
            </p>
            <p className="max-w-sm text-body-sm text-on-surface-variant">
              Pick a folder from the Index tab, or load the sample corpus there,
              to start searching by meaning.
            </p>
          </div>
        ) : (
          <>
            {/* Suggested intents */}
            <div className="flex flex-col gap-space-sm">
              <div className="flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 text-label-sm tracking-wider text-on-surface-variant uppercase">
                  <Icon name="auto_awesome" className="text-[15px] text-primary-fixed-dim" />
                  Suggested Intents
                </span>
                <span className="text-label-sm text-on-surface-variant/60">
                  Click to run a semantic prompt
                </span>
              </div>
              <div className="grid grid-cols-1 gap-space-sm md:grid-cols-2">
                {SUGGESTED_INTENTS.map((intent, position) => (
                  <button
                    key={intent}
                    type="button"
                    onClick={() => onSubmitQuery(intent)}
                    className={`group text-left flex items-start justify-between gap-space-md rounded-xl bg-surface-container-lowest p-space-md transition-colors hover:bg-surface-container-low ${
                      position === SUGGESTED_INTENTS.length - 1 ? "md:col-span-2" : ""
                    }`}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-body-md font-medium text-on-surface transition-colors group-hover:text-primary">
                        {intent}
                      </span>
                      <span className="flex items-center gap-1 text-code-sm text-on-surface-variant">
                        <span className="text-on-surface-variant/60">natural language</span>
                        <span className="text-surface-container-highest">•</span>
                        <span className="text-primary-fixed-dim">
                          {formatCompact(chunkCount)} chunks in scope
                        </span>
                      </span>
                    </div>
                    <Icon
                      name="arrow_forward"
                      className="mt-0.5 text-[16px] text-on-surface-variant transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                    />
                  </button>
                ))}
              </div>
            </div>

            {/* Recent searches + the index they run against */}
            <div className="grid grid-cols-1 gap-space-lg md:grid-cols-12">
              <div className="flex flex-col gap-space-sm md:col-span-7">
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-label-sm tracking-wider text-on-surface-variant uppercase">
                    <Icon name="history" className="text-[15px]" />
                    Recent Searches
                  </span>
                  {history.length > 0 && (
                    <button
                      type="button"
                      onClick={() => searchHistoryStore.clear()}
                      className="text-label-sm text-on-surface-variant transition-colors hover:text-error"
                    >
                      Clear history
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  {history.length === 0 ? (
                    <div className="rounded-xl bg-surface-container-lowest p-space-md text-center text-code-sm text-on-surface-variant/70">
                      No searches yet — run one and it will show up here.
                    </div>
                  ) : (
                    history.map((entry) => (
                      <button
                        key={entry.query}
                        type="button"
                        onClick={() => onSubmitQuery(entry.query)}
                        className="group flex items-center justify-between rounded-xl bg-surface-container-lowest p-space-md transition-colors hover:bg-surface-container-low"
                      >
                        <div className="flex min-w-0 items-center gap-space-sm">
                          <Icon
                            name="schedule"
                            className="text-[16px] text-on-surface-variant group-hover:text-primary"
                          />
                          <span className="truncate text-code-md text-on-surface group-hover:text-primary">
                            {entry.query}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-space-md text-code-sm text-on-surface-variant">
                          <span>{relativeTime(entry.ranAt)}</span>
                          <span className="rounded bg-surface-container px-1.5 py-0.5 text-label-sm text-on-surface-variant tabular-nums">
                            {entry.matches} {entry.matches === 1 ? "match" : "matches"}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-space-sm md:col-span-5">
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-label-sm tracking-wider text-on-surface-variant uppercase">
                    <Icon name="database" className="text-[15px] text-secondary" />
                    Indexed Target
                  </span>
                  <span className="h-2 w-2 rounded-full bg-primary-container" />
                </div>
                <div className="flex flex-col justify-between gap-space-md rounded-xl bg-surface-container-lowest p-space-md">
                  <div className="flex flex-col gap-space-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-code-sm font-medium text-primary">
                        {workspaceRoot ?? "mixed workspace"}
                      </span>
                      <Badge tone="neutral">
                        {readyFiles} {readyFiles === 1 ? "file" : "files"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-space-sm text-code-sm text-on-surface-variant">
                      <span className="tabular-nums">{formatCompact(chunkCount)} chunks</span>
                      <span>•</span>
                      <span className="text-primary-fixed-dim">
                        {dimension === null
                          ? "vectors loading"
                          : `${dimension.toLocaleString()}-dim vectors`}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 pt-space-sm">
                    <div className="flex items-center justify-between text-label-sm text-on-surface-variant">
                      <span className="flex items-center gap-1">
                        <Icon name="bolt" className="text-[14px] text-on-surface-variant" />
                        {MODEL_DISPLAY_NAME}
                      </span>
                      <span className="font-medium text-primary-fixed-dim">
                        {modelReady
                          ? "100% Ready"
                          : "Loading model…"}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-container">
                      <div
                        className={`h-full bg-primary-container transition-[width] duration-500 ${
                          modelReady ? "w-full" : "w-0"
                        }`}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Keyboard legend — every key here is bound */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-y-space-sm gap-x-space-lg pt-space-md text-label-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-space-md">
            <span className="flex items-center gap-1">
              <KeyCap>⌘K</KeyCap> Focus input
            </span>
            <span className="flex items-center gap-1">
              <KeyCap>↑↓</KeyCap> Navigate results
            </span>
            <span className="flex items-center gap-1">
              <KeyCap>↵</KeyCap> Open preview
            </span>
            <span className="flex items-center gap-1">
              <KeyCap>Esc</KeyCap> Clear / close
            </span>
          </div>
          <div className="flex items-center gap-space-xs font-code-sm text-on-surface-variant/60">
            <Icon name="security" className="text-[14px]" />
            Local sandbox • no network requests
          </div>
        </div>

        {/* Type scoping, reachable by clicking the hint or via the chips */}
        {kinds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-label-sm text-on-surface-variant/70">Scoped to:</span>
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                className="inline-flex items-center gap-1 rounded border border-surface-container-highest/40 bg-surface-container px-1.5 py-0.5 text-code-sm text-on-surface hover:text-error"
              >
                {KIND_FILTERS.find((filter) => filter.id === kind)?.label ?? kind}
                <Icon name="close" className="text-[12px]" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/* ── Engine status strip ─────────────────────────────────────────────────── */

function EngineStatusStrip({
  readyFiles,
  chunkCount,
  embeddingBytes,
}: {
  readyFiles: number;
  chunkCount: number;
  embeddingBytes: number;
}) {
  return (
    <footer className="fixed bottom-0 left-60 right-0 z-30 flex h-8 items-center justify-between gap-space-md bg-surface-container-lowest/95 px-gutter text-code-sm text-on-surface-variant shadow-lg backdrop-blur-md select-none">
      <div className="flex min-w-0 items-center gap-space-md truncate">
        <div className="flex items-center gap-1 text-on-surface">
          <span className="h-1.5 w-1.5 rounded-full bg-primary-container" />
          Indexed files:
          <span className="text-primary-fixed-dim tabular-nums">
            {readyFiles.toLocaleString()}
          </span>
        </div>
        <span className="text-surface-container-highest">•</span>
        <div className="flex items-center gap-1 truncate">
          <Icon name="storage" className="text-xs text-secondary" />
          Vector storage: SQLite snapshot (
          {embeddingBytes > 0 ? formatBytes(embeddingBytes) : "—"} resident)
        </div>
        <span className="text-surface-container-highest">•</span>
        <div className="hidden items-center gap-1 truncate lg:flex">
          <Icon name="lock" className="text-xs text-primary-container" />
          Embeddings never leave this machine
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-space-sm">
        <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-label-sm text-primary">
          {formatCompact(chunkCount)} chunks
        </span>
        <span className="flex items-center gap-0.5 text-label-sm text-primary-fixed-dim">
          <Icon name="bolt" className="text-[13px]" />
          Local inference
        </span>
      </div>
    </footer>
  );
}
