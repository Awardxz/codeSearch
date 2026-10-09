import type { FileKind, IndexedFileStatus } from "../types";
import { Icon } from "./Icon";

/**
 * Small shared presentational helpers: badges, chips, and a progress bar.
 *
 * Restyled against the Stitch design system: monospace labels, 4px corners,
 * tonal surfaces rather than colour washes. Classification stays quiet enough
 * that it never competes with the content it labels.
 */

export type BadgeTone =
  | "neutral"
  | "accent"
  | "muted"
  | "success"
  | "warning"
  | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-surface-container-high text-on-surface border-surface-container-highest",
  accent:
    "bg-surface-container-high text-primary-fixed-dim border-surface-container-highest",
  muted: "bg-surface-container text-on-surface-variant border-surface-container-highest/60",
  success: "bg-surface-container-high text-primary-fixed-dim border-primary-container/30",
  warning: "bg-surface-container-high text-warning border-surface-container-highest",
  danger: "bg-surface-container-high text-error border-surface-container-highest",
};

/** The design's chip: monospace, 4px, hairline. */
export function Badge({
  children,
  tone = "neutral",
  icon,
  title,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  icon?: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-label-sm tabular-nums ${TONE_CLASS[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

const KIND_BADGES: Record<FileKind, { label: string; tone: BadgeTone }> = {
  text: { label: "TXT", tone: "muted" },
  code: { label: "CODE", tone: "accent" },
  markdown: { label: "MD", tone: "muted" },
  data: { label: "DATA", tone: "warning" },
  document: { label: "DOC", tone: "muted" },
  pdf: { label: "PDF", tone: "danger" },
  docx: { label: "DOCX", tone: "danger" },
  image: { label: "IMAGE", tone: "success" },
  media: { label: "MEDIA", tone: "warning" },
  unsupported: { label: "?", tone: "muted" },
};

export function FileKindBadge({ kind }: { kind: FileKind }) {
  const badge = KIND_BADGES[kind];
  return (
    <Badge tone={badge.tone}>
      <span className="tracking-[0.04em]">{badge.label}</span>
    </Badge>
  );
}

const STATUS_BADGES: Record<IndexedFileStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-on-surface-variant" },
  extracting: { label: "Reading", className: "text-on-surface" },
  embedding: { label: "Embedding", className: "text-primary-fixed-dim" },
  ready: { label: "Ready", className: "text-success" },
  failed: { label: "Failed", className: "text-error" },
};

export function StatusBadge({ status }: { status: IndexedFileStatus }) {
  const badge = STATUS_BADGES[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-label-sm ${badge.className}`}>
      {status === "ready" && (
        <Icon name="check_circle" className="text-[12px]" />
      )}
      {badge.label}
    </span>
  );
}

/** The design's progress bar: a 4px track, no chrome. */
export function ProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-surface-container-highest"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Progress"}
    >
      <div
        className="h-full rounded-full bg-primary-container transition-[width] duration-500 ease-[var(--ease-out-quart)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
