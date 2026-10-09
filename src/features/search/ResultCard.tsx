import { useState } from "react";
import { Icon } from "../../components/Icon";
import { previewStore } from "../../lib/preview/previewStore";
import { openFileInSystemApp } from "../../lib/fileOpener";
import { tokenClassName, tokenizeLine } from "./codeHighlight";
import type { SearchHit } from "../../types";

/**
 * One search result, laid out as the Stitch "result card": a header carrying
 * the similarity score and the file location, a match line, the matched code
 * itself with a line-number gutter, and an action footer.
 *
 * Everything in it is real: the score comes from the embedding dot product, the
 * line range from the chunker, the code from the indexed chunk. The only
 * presentational judgement is which line of the chunk gets the "match" accent —
 * the first one, because that is where the chunk the hit points at begins.
 */

export function ResultCard({
  hit,
  query,
  isTop,
}: {
  hit: SearchHit;
  query: string;
  isTop: boolean;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const isSample = hit.path.startsWith("sample://");
  const isMedia = hit.kind === "image" || hit.kind === "media";

  async function handleOpen() {
    const failure = await openFileInSystemApp(hit.path);
    setOpenError(failure ? failure.message : null);
  }

  function handlePreview() {
    previewStore.open({
      path: hit.path,
      name: hit.name,
      kind: hit.kind,
      query,
      initialChunkIndex: hit.chunkIndex,
    });
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(hit.snippet);
    } catch {
      // Clipboard is unavailable (denied permission); the button stays quiet.
    }
  }

  const tier = matchTier(hit.score);
  const isTopRanked = isTop && tier === "top";
  const lines = isMedia ? [] : hit.snippet.split("\n");
  const firstLine = hit.lineStart ?? 1;

  return (
    <article className="flex w-full flex-col overflow-hidden rounded-lg bg-surface-container-low shadow-md">
      {/* Header: score, location, and what kind of thing was matched */}
      <div className="flex flex-wrap items-center justify-between gap-space-sm border-b border-surface-container-highest/40 bg-surface-container px-space-md py-1.5 select-none">
        <div className="flex min-w-0 items-center gap-space-sm">
          <span className="rounded bg-surface-container-lowest px-1.5 py-0.5 font-code-sm font-semibold text-primary-container border border-primary-container/20 tabular-nums">
            {hit.score.toFixed(2)}
          </span>
          <div className="flex min-w-0 items-center gap-1 text-code-sm">
            <Icon name="code" className="text-[14px] text-secondary" />
            <span className="truncate font-medium text-secondary" title={hit.path}>
              {displayPath(hit)}
            </span>
            {!isMedia && hit.lineStart !== undefined && (
              <span className="text-on-surface-variant/60">
                :{hit.lineStart}
                {hit.lineEnd !== undefined && hit.lineEnd > hit.lineStart
                  ? `-${hit.lineEnd}`
                  : ""}
              </span>
            )}
          </div>
          {isTopRanked && (
            <span className="rounded bg-surface-container-high px-1 py-0.2 text-label-sm text-[10px] font-semibold text-primary-fixed-dim uppercase">
              Top Match
            </span>
          )}
        </div>

        <div className="flex items-center gap-space-md font-code-sm text-on-surface-variant/70">
          <span className="capitalize">{kindLabel(hit.kind)}</span>
          {hit.indexedAt !== null && (
            <span className="flex items-center gap-1 text-[11px]">
              <Icon name="schedule" className="text-[12px]" />
              indexed {relativeDay(hit.indexedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Match line: the similarity, stated as a similarity */}
      <div className="flex items-center gap-2 border-b border-surface-container-highest/30 bg-surface-container-low px-space-md py-1.5">
        <Icon name="psychology" className="flex-shrink-0 text-[14px] text-primary-container" />
        {isMedia ? (
          <span className="truncate text-body-sm text-on-surface-variant">
            <strong className="font-medium text-on-surface">Modality:</strong> matched
            by what is inside this file, not by its text.
          </span>
        ) : hit.lexicalScore !== null ? (
          <span className="truncate text-body-sm text-on-surface-variant">
            <strong className="font-medium text-on-surface">Blended:</strong>{" "}
            <span className="tabular-nums">{hit.score.toFixed(3)}</span>
            <span className="text-on-surface-variant/70">
              {" "}
              · vector {hit.vectorScore.toFixed(2)} · lexical{" "}
              {hit.lexicalScore.toFixed(2)}
            </span>
            {hit.otherMatches > 0 && (
              <> · {hit.otherMatches} other matching chunk{hit.otherMatches === 1 ? "" : "s"} in this file</>
            )}
          </span>
        ) : (
          <span className="truncate text-body-sm text-on-surface-variant">
            <strong className="font-medium text-on-surface">Score:</strong>{" "}
            <span className="tabular-nums">{hit.score.toFixed(3)}</span> cosine
            similarity
            {hit.otherMatches > 0 && (
              <> · {hit.otherMatches} other matching chunk{hit.otherMatches === 1 ? "" : "s"} in this file</>
            )}
          </span>
        )}
      </div>

      {openError && (
        <p className="border-b border-error/30 bg-error/8 px-space-md py-1 text-[11px] text-error">
          {openError}
        </p>
      )}

      {/* The matched code, with a line-number gutter */}
      {!isMedia && (
        <div className="overflow-x-auto bg-surface-container-lowest text-code-sm select-text">
          <div className="flex min-w-[560px]">
            <div className="flex flex-col gap-0.5 border-r border-surface-container-highest/20 bg-surface-container-lowest px-2.5 py-2 text-right text-[12px] text-on-surface-variant/40 select-none tabular-nums">
              {lines.map((_, index) => (
                <span key={index}>{firstLine + index}</span>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-0.5 px-space-md py-2 font-code-sm text-[13px] leading-5 text-on-surface">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className={
                    index === 0
                      ? "-mx-2 flex items-center justify-between gap-2 rounded border-l-2 border-primary-container bg-primary-container/10 px-2"
                      : ""
                  }
                >
                  <CodeLine line={line || " "} />
                  {index === 0 && (
                    <span className="text-label-sm text-[10px] font-semibold text-primary-fixed-dim uppercase">
                      match
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-space-sm border-t border-surface-container-highest/40 bg-surface-container px-space-md py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handlePreview}
            className="flex items-center gap-1 rounded bg-surface-container-high px-2 py-0.5 text-label-sm text-[11px] text-on-surface transition-colors hover:bg-surface-bright"
          >
            <Icon name="account_tree" className="text-[13px] text-primary-container" />
            Preview
          </button>
          {!isSample && !isMedia && (
            <button
              type="button"
              onClick={() => void handleOpen()}
              className="flex items-center gap-1 rounded bg-surface-container-high px-2 py-0.5 text-label-sm text-[11px] text-on-surface transition-colors hover:bg-surface-bright"
              title="Open with the default application"
            >
              <Icon name="open_in_new" className="text-[13px] text-secondary" />
              Open
            </button>
          )}
          <button
            type="button"
            onClick={() => void copySnippet()}
            className="flex items-center gap-1 rounded bg-surface-container-high px-2 py-0.5 text-label-sm text-[11px] text-on-surface transition-colors hover:bg-surface-bright"
          >
            <Icon name="content_copy" className="text-[13px]" />
            Copy
          </button>
        </div>
        <span className="flex items-center gap-1 text-code-sm text-[11px] text-on-surface-variant/70">
          <Icon name="data_object" className="text-[12px]" />
          {isMedia
            ? "media chunk"
            : `${lines.length} lines · chunk ${hit.chunkIndex}`}
        </span>
      </div>
    </article>
  );
}

/** Renders one source line with the design's token tinting. */
function CodeLine({ line }: { line: string }) {
  const tokens = tokenizeLine(line);
  return (
    <span className="min-w-0 truncate">
      {tokens.map((token, index) => (
        <span key={index} className={tokenClassName(token.role)}>
          {token.text}
        </span>
      ))}
    </span>
  );
}

/** Basket label for the badge on the right of the header. */
function kindLabel(kind: SearchHit["kind"]): string {
  switch (kind) {
    case "code":
      return "Code";
    case "markdown":
      return "Markdown";
    case "text":
      return "Text";
    case "data":
      return "Data";
    case "document":
      return "Document";
    case "pdf":
      return "PDF";
    case "docx":
      return "Word";
    case "image":
      return "Image";
    case "media":
      return "Media";
    default:
      return "File";
  }
}

function displayPath(hit: SearchHit): string {
  if (hit.path.startsWith("sample://")) return hit.name;
  return hit.path.replace(/\\/g, "/");
}

/** The design tiers matches by score; the tiers are real bands of cosine score. */
function matchTier(score: number): "top" | "high" | "context" {
  if (score >= 0.8) return "top";
  if (score >= 0.6) return "high";
  return "context";
}

function relativeDay(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? "last month" : `${months}mo ago`;
}
