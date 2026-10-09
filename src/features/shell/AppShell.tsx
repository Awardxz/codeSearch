import { useEffect, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { useAppServices } from "../../hooks/useAppServices";
import { MODEL_DISPLAY_NAME } from "../../lib/embeddings/config";
import { commonRootOf, formatCompact, shortenPath } from "../../lib/format";
import { focusSearchField } from "../search/searchFocus";
import { Titlebar } from "./Titlebar";

/**
 * Application shell: the Stitch desktop frame.
 *
 * A fixed 240px navigation rail plus a fixed 40px context header, exactly as
 * the Stitch screens compose them — the rail carries the workspace identity and
 * the engine readout, the header carries the breadcrumb and the running engine
 * pill, and the screen owns everything below.
 *
 * Everything shown here is measured from the app's real state: the workspace
 * root is derived from the indexed paths, the chunk count is the index's, and
 * the engine card reports what the embedding worker is actually doing.
 */

export type ScreenId = "search" | "index" | "settings";

export const SIDEBAR_WIDTH = "w-60";
export const HEADER_HEIGHT = "h-10";

const NAV_ITEMS: {
  id: ScreenId;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}[] = [
  {
    id: "search",
    label: "Search",
    icon: <Icon name="search" className="text-base" />,
    shortcut: "⌘K",
  },
  {
    id: "index",
    label: "Index",
    icon: <Icon name="account_tree" className="text-base" />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <Icon name="tune" className="text-base" />,
  },
];

export function AppShell({
  screen,
  onNavigate,
  overlay,
  children,
}: {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  /** Rendered above the whole frame, e.g. the preview sheet. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const { index, embeddingStatus } = useAppServices();

  // Ctrl/Cmd+K jumps to the search field from anywhere in the window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onNavigate("search");
        focusSearchField();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate]);

  const readyFiles = index.files.filter((file) => file.status === "ready");
  const chunkCount = readyFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const workspaceRoot = commonRootOf(readyFiles.map((file) => file.path));

  return (
    <div className="relative h-full overflow-hidden bg-canvas">
      {/* Custom window frame: drag region plus minimize / maximize / close.
          The native Tauri titlebar is disabled in tauri.conf.json. */}
      <Titlebar />

      {/* ── Navigation rail ─────────────────────────────────────────────── */}
      <aside
        className={`fixed top-10 left-0 z-50 flex h-[calc(100vh-2.5rem)] ${SIDEBAR_WIDTH} flex-col justify-between border-r border-surface-container-highest bg-surface-container-lowest select-none`}
      >
        <div className="flex flex-col">
          {/* Brand */}
          <div className="border-b border-surface-container-highest/40 p-space-lg">
            <div className="flex items-center gap-space-sm">
              <img
                src="brand/codesearch-logo.png"
                alt="codeSearch"
                className="h-6 w-auto object-contain"
              />
              <div className="flex items-baseline gap-space-xs">
                <span className="text-headline-sm font-semibold tracking-tight text-primary">
                  codeSearch
                </span>
                <span className="text-label-sm text-on-surface-variant/70">
                  v0.1.0
                </span>
              </div>
            </div>
            <div className="mt-space-xs text-label-sm tracking-wider text-on-surface-variant uppercase">
              Local Code Intelligence
            </div>
          </div>

          {/* Workspace */}
          <div className="p-space-md">
            <div className="flex items-center justify-between gap-space-xs rounded border border-surface-container-highest bg-surface-container-low px-space-sm py-space-xs text-on-surface-variant">
              <div className="flex min-w-0 items-center gap-space-xs">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-container ring-2 ring-primary-container/20" />
                <span
                  className="truncate text-code-sm text-on-surface"
                  title={workspaceRoot ?? "No workspace indexed yet"}
                >
                  {workspaceRoot
                    ? shortenPath(workspaceRoot, 30)
                    : "no workspace"}
                </span>
              </div>
              <span className="shrink-0 text-label-sm rounded bg-surface-container px-1.5 py-0.5 text-on-surface-variant tabular-nums">
                {readyFiles.length} {readyFiles.length === 1 ? "file" : "files"}
              </span>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex flex-col gap-0.5 px-space-sm pt-space-xs">
            {NAV_ITEMS.map((item) => {
              const active = screen === item.id;
              const trailing =
                item.id === "index" && chunkCount > 0
                  ? `${formatCompact(chunkCount)} chunks`
                  : item.shortcut;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={`press flex items-center justify-between rounded-r px-space-md py-space-sm text-left transition-colors ${
                    active
                      ? "border-l-2 border-primary-container bg-surface-container font-medium text-primary"
                      : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                  }`}
                >
                  <span className="flex items-center gap-space-sm">
                    {item.icon}
                    <span className="text-body-md">{item.label}</span>
                  </span>
                  {trailing && (
                    <span className="text-code-sm rounded bg-surface-container-high px-1.5 py-0.5 text-on-surface-variant">
                      {trailing}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Engine readout */}
        <div className="border-t border-surface-container-highest/60 p-space-md">
          <div className="flex flex-col gap-space-xs rounded border border-surface-container-highest bg-surface-container-low p-space-sm">
            <div className="flex items-center justify-between">
              <span className="text-label-sm font-medium text-primary">
                {MODEL_DISPLAY_NAME}
              </span>
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  embeddingStatus.phase === "ready"
                    ? "bg-primary-container shadow-[0_0_8px_rgba(178,247,0,0.8)]"
                    : embeddingStatus.phase === "error"
                      ? "bg-error"
                      : "animate-pulse-soft bg-primary-container"
                }`}
              />
            </div>
            <div className="text-code-sm text-on-surface-variant">
              Local ONNX Runtime · {enginePhaseLabel(embeddingStatus.phase)}
            </div>
            <div className="flex items-center justify-between border-t border-surface-container-highest/40 pt-space-xs text-code-sm text-on-surface-variant">
              <span className="flex items-center gap-1">
                <Icon name="memory" className="text-xs" />
                {acceleratorLabel(embeddingStatus.backend)}
              </span>
              <span className="flex items-center gap-0.5 text-primary-fixed-dim">
                <Icon name="lock" className="text-xs" />
                Offline
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="pl-60">
        <header
          className={`fixed top-10 right-0 left-60 z-40 flex ${HEADER_HEIGHT} items-center justify-between border-b border-surface-container-highest bg-surface-container-lowest/90 px-space-lg backdrop-blur-md select-none`}
        >
          <div className="flex items-center gap-space-md text-code-sm text-on-surface-variant">
            <span className="font-medium text-primary">codeSearch</span>
            <span className="text-surface-container-highest">/</span>
            <span>workspace</span>
            <span className="text-surface-container-highest">/</span>
            <span className="text-on-surface">{screen}</span>
          </div>
          <div className="flex items-center gap-space-md">
            <div className="flex items-center gap-space-xs rounded bg-surface-container border border-surface-container-highest px-space-sm py-0.5 text-code-sm text-on-surface-variant">
              <span
                className={`h-2 w-2 rounded-full ${
                  embeddingStatus.phase === "error"
                    ? "bg-error"
                    : "bg-primary-container"
                }`}
              />
              <span>
                {embeddingStatus.phase === "error"
                  ? "Engine Error"
                  : "Embedding Engine Active"}
              </span>
            </div>
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary">
              <Icon name="person" className="text-[14px] text-on-primary" />
            </div>
          </div>
        </header>

        <main className="mt-20 h-[calc(100vh-5rem)] w-full overflow-y-auto bg-surface-container-lowest">
          {children}
        </main>
      </div>

      {/* Ctrl/Cmd+K jumps to the search field from anywhere in the window. */}
      <span className="hidden" aria-hidden="true" />
      {overlay}
    </div>
  );
}

function enginePhaseLabel(phase: string): string {
  switch (phase) {
    case "loading":
      return "Loading";
    case "error":
      return "Failed";
    case "ready":
      return "Ready";
    default:
      return "Idle";
  }
}

function acceleratorLabel(backend: "webgpu" | "wasm" | null): string {
  if (backend === "webgpu") return "WebGPU · GPU";
  if (backend === "wasm") return "WASM · CPU";
  return "Detecting device…";
}

/**
 * The context sub-bar every screen sits below. It is the running summary of the
 * index: what is being searched, and over how much of it.
 */
export function ContextSubBar({
  readyFiles,
  chunkCount,
  indexedAt,
}: {
  readyFiles: number;
  chunkCount: number;
  indexedAt: number | null;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-space-sm bg-surface-container-lowest px-gutter py-space-sm select-none">
      <div className="flex items-center gap-space-sm text-label-sm text-on-surface-variant">
        <span className="font-semibold tracking-widest text-primary-fixed-dim uppercase">
          Semantic Code Search
        </span>
        <span className="h-1 w-1 rounded-full bg-surface-container-highest" />
        <span className="flex items-center gap-1 text-code-sm text-on-surface">
          <Icon name="folder_data" className="text-[13px] text-secondary" />
          index: local
          <span className="text-on-surface-variant/70 font-normal">
            ({readyFiles.toLocaleString()} files indexed)
          </span>
        </span>
        <span className="h-1 w-1 rounded-full bg-surface-container-highest" />
        <span className="flex items-center gap-1 text-code-sm text-on-surface-variant">
          <Icon name="database" className="text-[13px] text-primary-container" />
          vss-index: active
        </span>
      </div>
      <div className="flex items-center gap-space-md">
        <div className="flex items-center gap-1 rounded bg-surface-container-low px-2 py-0.5 text-label-sm text-on-surface-variant/80">
          <span>Chunks:</span>
          <span className="text-code-sm text-primary">
            {formatCompact(chunkCount)}
          </span>
        </div>
        <div className="flex items-center gap-1 text-code-sm text-on-surface-variant">
          <span className="tabular-nums">
            {indexedAt === null ? "—" : new Date(indexedAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}
