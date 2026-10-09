import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileKindBadge } from "../../components/Badges";
import { formatBytes, formatScore, shortenPath } from "../../lib/format";
import { previewStore, type PreviewRequest } from "../../lib/preview/previewStore";
import {
  loadPreviewSource,
  rankPreviewMatches,
  toPreviewError,
  type PreviewMatch,
  type PreviewSource,
} from "../../lib/preview/previewService";
import { openFileInSystemApp } from "../../lib/fileOpener";
import type { AppError } from "../../types";

/**
 * Full-window preview panel. Shows the file exactly as it is on disk with line
 * numbers and the matched lines highlighted, or plays the media inline.
 *
 * Content is read through the Rust `read_text_file` command, so the same
 * extension allowlist and size limits as indexing apply. Nothing is cached: the
 * preview always reflects what is on disk right now.
 *
 * The panel slides in over the right two thirds of the window rather than
 * replacing the results, so you keep your place in the list while you read.
 * When it opens on a match, the matched line settles into place with a warm
 * flash — the one moment in the interface worth spending motion on.
 */

const LOADING = "loading";

/** Rows rendered for very large files, to keep the DOM small. */
const MAX_RENDERED_LINES = 4000;
/** Rows shown by "find in file", for the same reason. */
const MAX_FILTERED_LINES = 2000;

export function PreviewPanel() {
  const request = useSyncExternalStore(
    previewStore.subscribe,
    previewStore.getSnapshot,
    previewStore.getServerSnapshot,
  ).request;

  const [source, setSource] = useState<PreviewSource | null>(null);
  const [status, setStatus] = useState<typeof LOADING | "ready" | "error">(LOADING);
  const [error, setError] = useState<AppError | null>(null);
  const [matches, setMatches] = useState<PreviewMatch[]>([]);
  const [activeMatch, setActiveMatch] = useState(0);
  const [filter, setFilter] = useState("");
  const [jumpTo, setJumpTo] = useState<number | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);

  /** Object URL of the media currently previewed, released on unmount. */
  const mediaUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (mediaUrlRef.current) {
        URL.revokeObjectURL(mediaUrlRef.current);
        mediaUrlRef.current = null;
      }
    },
    [],
  );

  // Escape closes the panel from anywhere.
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        previewStore.close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request]);

  // Guards against a slow read landing after the panel closed or moved on.
  const loadTokenRef = useRef(0);

  useEffect(() => {
    if (!request) {
      setSource(null);
      setMatches([]);
      setActiveMatch(0);
      setStatus(LOADING);
      setError(null);
      setExternalError(null);
      setFilter("");
      setJumpTo(null);
      return;
    }

    const token = ++loadTokenRef.current;
    setStatus(LOADING);
    setError(null);
    setExternalError(null);
    setSource(null);
    setMatches([]);
    setActiveMatch(0);
    setFilter("");
    setJumpTo(null);

    void (async () => {
      try {
        const [nextSource, nextMatches] = await Promise.all([
          loadPreviewSource(request.path),
          rankPreviewMatches({
            path: request.path,
            query: request.query,
            initialChunkIndex: request.initialChunkIndex,
          }).catch(() => [] as PreviewMatch[]),
        ]);

        if (token !== loadTokenRef.current) {
          // The panel already moved on; do not leak this object URL.
          if (nextSource.mediaUrl) URL.revokeObjectURL(nextSource.mediaUrl);
          return;
        }

        mediaUrlRef.current = nextSource.mediaUrl;
        setSource(nextSource);
        setMatches(nextMatches);

        const initial = request.initialChunkIndex;
        const initialIndex =
          initial === null
            ? 0
            : Math.max(
                0,
                nextMatches.findIndex((match) => match.chunkIndex === initial),
              );
        setActiveMatch(initialIndex);
        setStatus("ready");
      } catch (caught) {
        if (token !== loadTokenRef.current) return;
        setError(toPreviewError(caught));
        setStatus("error");
      }
    })();
  }, [request]);

  function openExternal(path: string) {
    void (async () => {
      const failure = await openFileInSystemApp(path);
      setExternalError(failure ? failure.message : null);
    })();
  }

  if (!request) return null;

  return (
    <>
      {/*
        A scrim rather than a modal backdrop: it dims the results enough to
        signal that the preview has focus, but leaves them fully legible so you
        can look at another hit without closing and reopening.
      */}
      <button
        type="button"
        aria-label="Close preview"
        onClick={() => previewStore.close()}
        className="animate-scrim-in absolute inset-0 z-30 cursor-default bg-black/45"
      />

      <div className="animate-sheet-in absolute inset-y-0 right-0 z-40 flex w-[62%] min-w-[32rem] flex-col border-l border-line-strong bg-surface-container-lowest shadow-[-32px_0_64px_-24px_rgba(0,0,0,0.9)]">
      {status === "loading" && (
        <div className="flex flex-1 items-center justify-center gap-3 text-[13px] text-on-surface-variant">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse-soft absolute inline-flex h-full w-full rounded-full bg-primary-container" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-container" />
          </span>
          Reading {request.name}
        </div>
      )}

      {status === "error" && (
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4">
          <div className="rounded-lg border border-error/30 bg-error/8 px-5 py-4">
            <p className="text-[15px] font-medium text-error">
              This file cannot be previewed
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-on-surface">
              {error?.message}
            </p>
            <p className="mt-2.5 text-[11px] leading-relaxed text-on-surface-variant">
              Preview shows plain text. Images, audio and video are opened in
              their own player, because their contents are embedded rather than
              displayed as text.
            </p>
          </div>
          <div className="flex gap-2.5">
            <BackButton />
            <button
              type="button"
              onClick={() => openExternal(request.path)}
              className="press rounded bg-primary-container px-[18px] py-2.5 text-[13px] font-medium text-on-primary-container hover:brightness-105"
            >
              Open with system app
            </button>
          </div>
        </div>
      )}

      {status === "ready" && source && (
        <PreviewBody
          request={request}
          source={source}
          matches={matches}
          activeMatch={activeMatch}
          onSelectMatch={(index) => {
            setJumpTo(null);
            setActiveMatch(index);
          }}
          filter={filter}
          onFilterChange={setFilter}
          jumpTo={jumpTo}
          onJumpTo={setJumpTo}
          externalError={externalError}
          onOpenExternal={openExternal}
        />
      )}
    </div>
    </>
  );
}

function PreviewBody({
  request,
  source,
  matches,
  activeMatch,
  onSelectMatch,
  filter,
  onFilterChange,
  jumpTo,
  onJumpTo,
  externalError,
  onOpenExternal,
}: {
  request: PreviewRequest;
  source: PreviewSource;
  matches: PreviewMatch[];
  activeMatch: number;
  onSelectMatch: (index: number) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  jumpTo: number | null;
  onJumpTo: (line: number | null) => void;
  externalError: string | null;
  onOpenExternal: (path: string) => void;
}) {
  const activeMatchRange = matches[activeMatch] ?? null;
  const activeLine = jumpTo ?? activeMatchRange?.lineStart ?? null;
  const isText = source.modality === "text";

  const lines = useMemo(() => splitLines(source.content), [source.content]);

  const matchLineSet = useMemo(() => {
    const set = new Set<number>();
    const range = activeMatchRange;
    if (range?.lineStart && range.lineEnd) {
      for (
        let line = range.lineStart;
        line <= Math.min(range.lineEnd, lines.length);
        line++
      ) {
        set.add(line);
      }
    }
    return set;
  }, [activeMatchRange, lines.length]);

  // Bring the matched block into view whenever it changes.
  useEffect(() => {
    if (!activeLine) return;
    const target = document.querySelector(`[data-line="${activeLine}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [activeLine]);

  // Window large files so the DOM stays small; always keep the target in.
  const window = useMemo(
    () => computeWindow(lines.length, activeLine),
    [lines.length, activeLine],
  );

  return (
    <>
      {/* Header */}
      <header className="elevated relative z-10 flex shrink-0 items-start gap-4 px-8 py-4">
        <BackButton />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <FileKindBadge kind={request.kind} />
            <h1 className="truncate text-[15px] font-medium leading-snug tracking-[-0.01em] text-primary">
              {source.name}
            </h1>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-on-surface-variant" title={source.path}>
            {source.isSample
              ? "built-in sample document"
              : shortenPath(source.path, 100)}
            {isText && (
              <>
                {" · "}
                {lines.length.toLocaleString()} lines
              </>
            )}
            {source.sizeBytes > 0 && ` · ${formatBytes(source.sizeBytes)}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {matches.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Previous match"
                aria-label="Previous match"
                onClick={() =>
                  onSelectMatch((activeMatch - 1 + matches.length) % matches.length)
                }
                className="press rounded border border-line-strong px-2.5 py-1.5 text-xs text-on-surface hover:border-surface-container-highest"
              >
                ‹
              </button>
              <span className="min-w-[3.5rem] text-center text-[11px] tabular-nums text-on-surface-variant">
                {activeMatch + 1} of {matches.length}
              </span>
              <button
                type="button"
                title="Next match"
                aria-label="Next match"
                onClick={() => onSelectMatch((activeMatch + 1) % matches.length)}
                className="press rounded border border-line-strong px-2.5 py-1.5 text-xs text-on-surface hover:border-surface-container-highest"
              >
                ›
              </button>
            </div>
          )}
          {!source.isSample && source.modality === "text" && (
            <button
              type="button"
              onClick={() => onOpenExternal(source.path)}
              className="press rounded border border-line-strong px-3.5 py-2 text-xs font-medium text-on-surface hover:border-surface-container-highest"
            >
              System app
            </button>
          )}
          <button
            type="button"
            onClick={() => previewStore.close()}
            className="press rounded bg-surface-container-high px-4 py-2 text-xs font-medium text-primary hover:bg-primary-container hover:text-on-primary-container"
          >
            Close
          </button>
        </div>
      </header>

      {/* Match summary and find-in-file, text only */}
      {isText && (
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-line bg-surface-container-low px-8 py-2.5">
          {activeMatchRange?.lineStart ? (
            <p className="text-[11px] text-on-surface">
              <span className="font-medium text-primary-fixed-dim">
                {activeMatchRange.lineEnd && activeMatchRange.lineEnd !== activeMatchRange.lineStart
                  ? `lines ${activeMatchRange.lineStart} to ${activeMatchRange.lineEnd}`
                  : `line ${activeMatchRange.lineStart}`}
              </span>
              {matchLineSet.size > 0 && (
                <span className="text-on-surface-variant">
                  {" "}
                  · {matchLineSet.size} highlighted
                </span>
              )}
              {activeMatchRange.score > 0 && (
                <span className="ml-2.5 font-mono tabular-nums text-on-surface-variant/40">
                  {formatScore(activeMatchRange.score)}
                </span>
              )}
            </p>
          ) : matches.length > 0 ? (
            // The file is in the index but no line location is known, so the
            // whole file is shown. Saying so is more useful than a bare line
            // number that does not exist.
            <p className="text-[11px] text-on-surface-variant">
              Showing the whole file — no single line is highlighted for this
              match.
            </p>
          ) : (
            <p className="text-[11px] text-on-surface-variant">
              No chunk in this file scored above zero for the current query, so
              the whole file is shown.
            </p>
          )}

          <div className="ml-auto flex items-center gap-2.5">
            <label htmlFor="preview-find" className="text-[11px] text-on-surface-variant">
              Find in file
            </label>
            <input
              id="preview-find"
              value={filter}
              onChange={(event) => onFilterChange(event.currentTarget.value)}
              placeholder="text to locate"
              className="w-52 rounded-lg border border-line-strong bg-surface-container-low px-2.5 py-1.5 font-mono text-[11px] text-primary outline-none transition-colors placeholder:text-on-surface-variant/40 focus:border-primary-container"
            />
          </div>
        </div>
      )}

      {externalError && (
        <p className="shrink-0 border-b border-error/30 bg-error/8 px-8 py-2 text-[11px] text-error">
          {externalError}
        </p>
      )}

      {!isText && window.capped && (
        <p className="shrink-0 border-b border-line bg-surface-container px-8 py-1.5 text-[11px] text-on-surface-variant">
          Showing lines {window.start.toLocaleString()} to {window.end.toLocaleString()} of{" "}
          {lines.length.toLocaleString()} to keep rendering fast. Use the match
          navigation or find-in-file to jump elsewhere.
        </p>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest">
        {source.modality === "image" && source.mediaUrl && (
          <div className="flex h-full items-center justify-center p-10">
            <img
              src={source.mediaUrl}
              alt={source.name}
              className="animate-fade-in max-h-full max-w-full rounded-lg border border-line shadow-[0_24px_64px_-24px_rgba(0,0,0,0.8)]"
            />
          </div>
        )}

        {source.modality === "audio" && source.mediaUrl && (
          <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-6 p-10">
            <div className="elevated flex h-28 w-28 items-center justify-center rounded-full">
              <svg viewBox="0 0 24 24" className="h-12 w-12 text-primary-container" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M9 17.5V6.5l10-2v11" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="6.2" cy="17.5" r="2.8" />
                <circle cx="16.2" cy="15.5" r="2.8" />
              </svg>
            </div>
            <p className="text-[15px] font-medium text-primary">{source.name}</p>
            <audio controls src={source.mediaUrl} className="w-full" />
          </div>
        )}

        {source.modality === "video" && source.mediaUrl && (
          <div className="flex h-full items-center justify-center p-10">
            <video
              controls
              src={source.mediaUrl}
              className="animate-fade-in max-h-full max-w-full rounded-lg border border-line shadow-[0_24px_64px_-24px_rgba(0,0,0,0.8)]"
            />
          </div>
        )}

        {isText &&
          (filter.trim() ? (
            <FilteredView lines={lines} query={filter} onJumpTo={onJumpTo} />
          ) : (
            <NumberedLines
              lines={lines}
              start={window.start}
              end={window.end}
              matchLineSet={matchLineSet}
              activeLine={activeLine}
            />
          ))}
      </div>
    </>
  );
}

function NumberedLines({
  lines,
  start,
  end,
  matchLineSet,
  activeLine,
}: {
  lines: string[];
  start: number;
  end: number;
  matchLineSet: Set<number>;
  activeLine: number | null;
}) {
  const gutterWidth = `${Math.max(4, String(end).length)}ch`;

  return (
    <div className="min-w-full font-mono text-[13px] leading-[1.75]">
      {lines.slice(start - 1, end).map((text, offset) => {
        const lineNumber = start + offset;
        const isMatch = matchLineSet.has(lineNumber);
        const isActive = activeLine === lineNumber;

        return (
          <div
            key={lineNumber}
            data-line={lineNumber}
            className={`flex w-full transition-colors duration-200 ${
              isActive ? "animate-flash-match" : isMatch ? "bg-primary-container/10" : ""
            }`}
          >
            <span
              aria-hidden="true"
              className={`sticky left-0 z-10 shrink-0 border-r border-line px-4 py-[2px] text-right tabular-nums select-none ${
                isMatch ? "bg-surface-container-lowest text-primary-fixed-dim" : "bg-surface-container-lowest text-on-surface-variant/40"
              }`}
              style={{ width: gutterWidth, minWidth: gutterWidth }}
            >
              {lineNumber}
            </span>
            <span
              className={`flex-1 px-5 py-[2px] whitespace-pre ${
                isMatch ? "text-primary" : "text-on-surface"
              }`}
            >
              {text.length > 0 ? (
                isMatch ? (
                  // The highlighter. Only ever used for this.
                  <mark className="rounded-[3px] bg-primary-container/20 px-0.5 text-primary-container">
                    {text}
                  </mark>
                ) : (
                  text
                )
              ) : (
                " "
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FilteredView({
  lines,
  query,
  onJumpTo,
}: {
  lines: string[];
  query: string;
  onJumpTo: (line: number) => void;
}) {
  const needle = query.trim().toLowerCase();
  const matchingLines = lines
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((entry) => entry.text.toLowerCase().includes(needle));
  const shown = matchingLines.slice(0, MAX_FILTERED_LINES);

  if (matchingLines.length === 0) {
    return (
      <p className="px-8 py-12 text-center text-[13px] text-on-surface-variant">
        No lines contain “{query.trim()}”.
      </p>
    );
  }

  return (
    <div className="min-w-full font-mono text-[13px] leading-[1.75]">
      <p className="px-8 py-3 text-[11px] text-on-surface-variant">
        {matchingLines.length.toLocaleString()} line
        {matchingLines.length === 1 ? "" : "s"} of {lines.length.toLocaleString()}{" "}
        contain “{query.trim()}” — choose one to jump to it.
      </p>
      {shown.map((entry) => (
        <div
          key={entry.lineNumber}
          data-line={entry.lineNumber}
          onClick={() => onJumpTo(entry.lineNumber)}
          title="Jump to this line"
          className="press flex w-full cursor-pointer hover:bg-surface-container-low"
        >
          <span className="shrink-0 border-r border-line bg-surface-container-lowest px-4 py-[2px] text-right tabular-nums text-on-surface-variant/40 select-none">
            {entry.lineNumber}
          </span>
          <span className="flex-1 px-5 py-[2px] whitespace-pre text-on-surface">
            {entry.text.length > 0 ? entry.text : " "}
          </span>
        </div>
      ))}
      {matchingLines.length > shown.length && (
        <p className="px-8 py-4 text-[11px] text-on-surface-variant">
          And {(matchingLines.length - shown.length).toLocaleString()} more. Narrow
          the text to see them.
        </p>
      )}
    </div>
  );
}

function BackButton() {
  return (
    <button
      type="button"
      onClick={() => previewStore.close()}
      title="Back to results"
      className="press shrink-0 rounded border border-line-strong px-3.5 py-2 text-xs font-medium text-on-surface hover:border-surface-container-highest"
    >
      Back
    </button>
  );
}

/**
 * Rows to render for a file. Small files render in full; larger files render a
 * window centred on the line being looked at.
 */
function computeWindow(
  totalLines: number,
  targetLine: number | null,
): { start: number; end: number; capped: boolean } {
  if (totalLines <= MAX_RENDERED_LINES) {
    return { start: 1, end: totalLines, capped: false };
  }

  const anchor = targetLine ?? 1;
  let start = Math.max(1, anchor - Math.floor(MAX_RENDERED_LINES / 2));
  let end = Math.min(totalLines, start + MAX_RENDERED_LINES - 1);
  if (anchor < start) {
    start = anchor;
    end = Math.min(totalLines, start + MAX_RENDERED_LINES - 1);
  }
  if (anchor > end) {
    end = Math.min(totalLines, anchor);
    start = Math.max(1, end - MAX_RENDERED_LINES + 1);
  }

  return { start, end, capped: true };
}

/** Split into lines without altering any of the file's actual text. */
function splitLines(content: string): string[] {
  const withoutBom = content.replace(/^﻿/, "");
  return withoutBom.split(/\r\n|\r|\n/);
}
