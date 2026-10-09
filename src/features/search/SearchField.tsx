import { forwardRef } from "react";
import { Icon } from "../../components/Icon";

/**
 * The omni search field, in the two shells the Stitch design gives it.
 *
 * "plain" is the empty-state HUD: a bare dark well with the search affordance,
 * the mode chip and the shortcut cap.
 * "panel" is the results-state HUD: the same well sitting inside a bordered
 * container that also carries the mode toggle, the return hint and the primary
 * Search button, with the suggestion pills beneath it.
 *
 * Both variants drive the same query state, so switching between them never
 * loses what was typed.
 */

export const SEARCH_PLACEHOLDER =
  "Describe what you're looking for… (e.g. “retry exponential backoff” or “auth token expiry”)";

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  variant: "plain" | "panel";
  busy: boolean;
  disabled: boolean;
  /** Mode chip label, e.g. "Semantic (Vector)". */
  modeLabel: string;
  onToggleMode: () => void;
  suggestions: string[];
  onSuggestion: (query: string) => void;
  /** Keyboard hints rendered under the field. */
  footer?: React.ReactNode;
};

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onChange,
      onSubmit,
      onClear,
      variant,
      busy,
      disabled,
      modeLabel,
      onToggleMode,
      suggestions,
      onSuggestion,
      footer,
    },
    ref,
  ) {
    if (variant === "plain") {
      return (
        <form
          className="relative w-full"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="relative flex items-center rounded-xl bg-surface-container-lowest p-space-sm shadow-xl transition-shadow duration-200 focus-within:shadow-[0_0_20px_-4px_rgba(178,247,0,0.25)]">
            <div className="flex items-center justify-center pr-space-xs pl-space-md text-on-surface-variant transition-colors focus-within:text-primary">
              <Icon name="search" className="text-[20px]" />
            </div>
            <input
              ref={ref}
              value={value}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && value.length > 0) {
                  event.preventDefault();
                  onClear();
                }
              }}
              placeholder={SEARCH_PLACEHOLDER}
              aria-label="Search query"
              spellCheck={false}
              autoComplete="off"
              className="w-full bg-transparent px-space-xs py-space-sm text-body-md text-primary placeholder:text-on-surface-variant/60 focus:outline-none"
            />
            <div className="flex items-center gap-space-xs pr-space-xs select-none">
              <span className="inline-flex items-center gap-1 rounded bg-surface-container px-space-sm py-1 text-label-sm font-medium text-on-surface-variant">
                <Icon name="blur_on" className="text-[13px] text-secondary" />
                Semantic Vector
              </span>
              <div className="flex items-center gap-0.5 rounded bg-surface-container-high px-1.5 py-1 text-code-sm text-on-surface-variant">
                <span>⌘</span>
                <span>K</span>
              </div>
            </div>
          </div>
          {footer}
        </form>
      );
    }

    return (
      <form
        className="w-full"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="w-full rounded-lg border border-surface-container-highest/60 bg-surface-container p-1.5 shadow-lg transition-shadow focus-within:shadow-[0_0_20px_-4px_rgba(178,247,0,0.2)]">
          <div className="relative flex items-center gap-space-sm rounded bg-surface-container-lowest px-space-md py-1.5">
            <Icon name="manage_search" className="select-none text-[18px] text-primary-fixed-dim" />
            <input
              ref={ref}
              value={value}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && value.length > 0) {
                  event.preventDefault();
                  onClear();
                }
              }}
              placeholder="Describe what the code does or query intent…"
              aria-label="Search query"
              spellCheck={false}
              autoComplete="off"
              className="w-full border-0 bg-transparent text-body-lg text-primary outline-none placeholder:text-on-surface-variant/40"
            />
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={onToggleMode}
                title="Toggle search vector density"
                className="flex items-center gap-1 rounded border border-surface-container-highest/40 bg-surface-container-high px-2 py-1 text-label-sm text-on-surface transition-colors hover:bg-surface-bright"
              >
                <Icon name="tune" className="text-[13px] text-secondary" />
                {modeLabel}
              </button>
              <span className="hidden items-center rounded bg-surface-container-low px-1.5 py-0.5 text-code-sm text-on-surface-variant/70 select-none md:inline-flex">
                ⌘↵
              </span>
              <button
                type="submit"
                disabled={busy || disabled || value.trim().length === 0}
                className="flex items-center gap-1 rounded bg-primary-container px-2.5 py-1 text-label-sm font-semibold text-on-primary-container transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="bolt" className="text-[14px]" />
                {busy ? "Searching" : "Search"}
              </button>
            </div>
          </div>

          {/* Suggestion pills — running one fills the field and searches. */}
          <div className="flex items-center gap-1.5 overflow-x-auto pt-1.5 px-1 select-none">
            <span className="mr-0.5 text-label-sm text-[10px] tracking-wider text-on-surface-variant/60 uppercase">
              Suggestions:
            </span>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestion(suggestion)}
                className="flex items-center gap-1 truncate rounded bg-surface-container-low px-2 py-0.5 text-body-sm text-[12px] text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary"
              >
                <Icon name="spark" className="text-[12px] text-primary-container" />
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </form>
    );
  },
);

/** A shortcut cap, as used in the design's footers and pills. */
export function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-surface-container-high px-1.5 py-0.5 text-code-sm text-primary">
      {children}
    </kbd>
  );
}
