import type { ReactElement, ReactNode, SVGProps } from "react";

/**
 * Icon set.
 *
 * The Stitch design uses Material Symbols, which are loaded from a Google
 * Fonts stylesheet. This app is offline-first, so every glyph the design needs
 * is drawn here as inline SVG instead: no network request, no font payload, and
 * the icons inherit `currentColor` and the same 24px optical grid as the
 * Material set.
 *
 * Add new entries to `GLYPHS` as screens need them — the names match the
 * Material Symbols ligature names used in the design, so the mapping stays
 * auditable against the Stitch HTML.
 */

type Glyph = (props: SVGProps<SVGSVGElement>) => ReactElement;

/* A 24px grid, stroked at 1.8 so the marks hold at 12–20px usage.
   Width/height default to 1em so the icon follows the font-size of the
   `text-*` class it is paired with (the same contract as Material Symbols).
   Without this an <svg> with only a viewBox renders at its 300×150 default. */
function stroke(path: ReactNode) {
  return (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {path}
    </svg>
  );
}

function solid(path: ReactNode) {
  return (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {path}
    </svg>
  );
}

const GLYPHS = {
  /* Search */
  search: stroke(
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.6 15.6 4.4 4.4" />
    </>,
  ),
  manage_search: stroke(
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.6 15.6 4.4 4.4" />
      <path d="M10.5 7.2v6.6M7.2 10.5h6.6" />
    </>,
  ),

  /* Code / AST */
  code: stroke(
    <>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
      <path d="m13.5 5-3 14" />
    </>,
  ),
  data_object: stroke(
    <>
      <path d="M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v3a2 2 0 0 0 2 2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v3a2 2 0 0 1-2 2h-2" />
      <path d="M12 8.5v7" />
    </>,
  ),
  account_tree: stroke(
    <>
      <path d="M5 4v10a3 3 0 0 0 3 3h4" />
      <path d="M12 17v3" />
      <path d="M5 9h8" />
      <circle cx="19" cy="6" r="2" />
      <path d="M13 9h4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h0" />
      <circle cx="19" cy="20" r="2" />
      <path d="M12 14v3" />
    </>,
  ),
  neurology: stroke(
    <>
      <path d="M12 5a3 3 0 0 0-5.6 1.4A3 3 0 0 0 5 12a3 3 0 0 0 1.4 2.6A3 3 0 0 0 9 19a3 3 0 0 0 6 0 3 3 0 0 0 2.6-4.4A3 3 0 0 0 19 12a3 3 0 0 0-4.4-2.6A3 3 0 0 0 12 5Z" />
      <path d="M12 8v8M9 10.5l3 1.5 3-1.5" />
    </>,
  ),
  psychology: stroke(
    <>
      <path d="M9.5 4a3 3 0 0 0-3 3 3.5 3.5 0 0 0-1 6.8V16a2 2 0 0 0 2 2h1v3" />
      <path d="M14.5 4a3 3 0 0 1 3 3 3.5 3.5 0 0 1 1 6.8V16a2 2 0 0 1-2 2h-1" />
      <path d="M12 7v10" />
    </>,
  ),

  /* Status */
  check: stroke(<path d="m4.5 12.5 5 5 10-11" />),
  check_circle: stroke(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.2 2.8 2.8L16.2 9.4" />
    </>,
  ),
  done_all: stroke(
    <>
      <path d="m2 12.5 4 4 8-9" />
      <path d="m10 16.5 1.6 1.6 8-9" />
    </>,
  ),
  verified: stroke(
    <>
      <path d="m12 2.5 2.4 1.9 3-.2 1 2.8 2.5 1.6-1 2.8 1 2.8-2.5 1.6-1 2.8-3-.2L12 21.5 9.6 19.6l-3 .2-1-2.8L3.1 15.4l1-2.8-1-2.8 2.5-1.6 1-2.8 3 .2Z" />
      <path d="m8.6 12.2 2.4 2.4 4.4-4.8" />
    </>,
  ),
  verified_user: stroke(
    <>
      <path d="M12 2.5 4.5 5.5V12c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V5.5Z" />
      <path d="m9 12 2.2 2.2L15.4 10" />
    </>,
  ),
  shield: stroke(
    <path d="M12 2.5 4.5 5.5V12c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V5.5Z" />,
  ),
  lock: stroke(
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>,
  ),
  offline_pin: stroke(
    <>
      <path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 0 0-13 0" />
      <circle cx="12" cy="10" r="2.2" />
      <path d="M4 3.5 20 20.5" />
    </>,
  ),
  visibility: stroke(
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ),
  error_outline: stroke(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.2v.2" />
    </>,
  ),

  /* Engine / runtime */
  memory: stroke(
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>,
  ),
  speed: stroke(
    <>
      <path d="M4 18a9 9 0 1 1 16 0" />
      <path d="m12 13.5 3.5-4" />
      <circle cx="12" cy="14.5" r="1.6" />
    </>,
  ),
  timer: stroke(
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 10v3.8l2.4 1.6M9.5 2.5h5" />
    </>,
  ),
  cached: stroke(
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 3.5V8h-4.5" />
    </>,
  ),
  sync: stroke(
    <>
      <path d="M20 11.5a8 8 0 0 0-14.2-4.4" />
      <path d="M4 12.5a8 8 0 0 0 14.2 4.4" />
      <path d="M5.5 3.5v4h4M18.5 20.5v-4h-4" />
    </>,
  ),
  sync_alt: stroke(
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>,
  ),
  cycle: stroke(
    <>
      <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L21 9.5" />
      <path d="M21 4.5v5h-5" />
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L3 14.5" />
      <path d="M3 19.5v-5h5" />
    </>,
  ),
  bolt: solid(<path d="M13.5 2 4 13.2h5.2L9.5 22 19 10.6h-5.3L13.5 2Z" />),
  pause_circle: stroke(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.8 9v6M14.2 9v6" />
    </>,
  ),
  play_circle: stroke(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5 15.5 12 10 15.5Z" />
    </>,
  ),

  /* Storage */
  database: stroke(
    <>
      <ellipse cx="12" cy="5.8" rx="7.5" ry="3" />
      <path d="M4.5 5.8v6.4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5.8" />
      <path d="M4.5 12.2v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </>,
  ),
  storage: stroke(
    <>
      <rect x="3.5" y="4.5" width="17" height="5" rx="1.5" />
      <rect x="3.5" y="14.5" width="17" height="5" rx="1.5" />
      <path d="M7 7h.2M7 17h.2" />
    </>,
  ),
  ios_share: stroke(
    <>
      <path d="M12 15.5V3.5M8 7l4-3.5L16 7" />
      <path d="M5 13v6.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V13" />
    </>,
  ),

  /* Files */
  file_copy: stroke(
    <>
      <path d="M8.5 8.5V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2.5" />
      <path d="M5.5 10a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2Z" />
    </>,
  ),
  folder: stroke(
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.6 2h6.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" />,
  ),
  folder_open: stroke(
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.6 2h6.2a2 2 0 0 1 2 2v1H3.5Z" />
      <path d="M3.5 9.5h19l-1.8 8.4a2 2 0 0 1-2 1.6H5.9a2 2 0 0 1-2-1.6Z" />
    </>,
  ),
  folder_managed: stroke(
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.6 2h6.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="14" r="2" />
      <path d="M12 11v.5M12 16.5v.5" />
    </>,
  ),
  folder_data: stroke(
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.6 2h6.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" />
      <path d="M9 12.5v4M12 11v7M15 14v2.5" />
    </>,
  ),
  rule_folder: stroke(
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.6 2h6.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" />
      <path d="M8.5 13.5h7M10 11v5M14 11v5" />
    </>,
  ),
  description: stroke(
    <>
      <path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
      <path d="M13 3.5V9h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </>,
  ),
  image: stroke(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m4.5 17.5 4.2-4.2 3.3 3.3 3-3 4 4" />
    </>,
  ),
  format_image_left: stroke(
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M2.5 8.5h3M2.5 12h3M2.5 15.5h3" />
      <circle cx="16" cy="10" r="1.6" />
      <path d="m12 18.5 2.5-2.5 2 2 2-2 2.5 2.5" />
    </>,
  ),

  /* Window controls (custom titlebar) */
  minimize: stroke(<path d="M5 12h14" />),
  maximize: stroke(<rect x="6" y="6" width="12" height="12" rx="1" />),
  restore: stroke(
    <>
      <path d="M8 4h12v12" />
      <rect x="4" y="8" width="12" height="12" rx="1" />
    </>,
  ),

  /* Navigation / arrows */
  arrow_drop_down: stroke(<path d="m6 9.5 6 6 6-6" />),
  expand_more: stroke(<path d="m6 9.5 6 6 6-6" />),
  chevron_right: stroke(<path d="m9.5 5.5 6.5 6.5-6.5 6.5" />),
  arrow_forward: stroke(
    <>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </>,
  ),
  unfold_more: stroke(
    <>
      <path d="m6 10 6 6 6-6" />
      <path d="m6 6.5 6-4 6 4" />
    </>,
  ),
  open_in_new: stroke(
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M17.5 14v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5" />
    </>,
  ),
  swap_horiz: stroke(
    <>
      <path d="M4 8.5h13l-3.2-3.2M20 15.5H7l3.2 3.2" />
    </>,
  ),
  alt_route: stroke(
    <>
      <circle cx="5.5" cy="18.5" r="2" />
      <circle cx="18.5" cy="5.5" r="2" />
      <path d="M7.5 18.5h5a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6.5" />
    </>,
  ),

  /* Actions */
  tune: stroke(
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>,
  ),
  sort: stroke(
    <>
      <path d="M4 6.5h13M4 12h9M4 17.5h5" />
    </>,
  ),
  person: solid(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0Z" />
    </>,
  ),
  refresh: stroke(
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 3.5V8h-4.5" />
    </>,
  ),
  history: stroke(
    <>
      <path d="M3.8 12a8.2 8.2 0 1 0 8.2-8.2A8.2 8.2 0 0 0 5.4 7.6" />
      <path d="M3.5 3.5v4.2h4.2" />
      <path d="M12 7.8V12l3 1.8" />
    </>,
  ),
  add: stroke(<path d="M12 5.5v13M5.5 12h13" />),
  close: stroke(<path d="m6 6 12 12M18 6 6 18" />),
  content_copy: stroke(
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2" />
    </>,
  ),
  terminal: stroke(
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" />
    </>,
  ),
  auto_awesome: stroke(
    <>
      <path d="M11 3.5 12.6 8 17 9.6 12.6 11.2 11 15.7 9.4 11.2 5 9.6 9.4 8Z" />
      <path d="M18 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" />
    </>,
  ),
  spark: solid(
    <path d="M12 2.5 13.6 8 19 9.6 13.6 11.2 12 16.7 10.4 11.2 5 9.6 10.4 8Z" />,
  ),
  blur_on: solid(
    <>
      <circle cx="12" cy="12" r="3.4" opacity="0.9" />
      <circle cx="12" cy="12" r="6.5" opacity="0.28" />
      <circle cx="12" cy="12" r="9.5" opacity="0.12" />
    </>,
  ),
  schedule: stroke(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </>,
  ),
  search_off: stroke(
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.6 15.6 4.4 4.4" />
      <path d="M8 8l5 5M13 8l-5 5" />
    </>,
  ),
  device_reset: stroke(
    <>
      <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9.5" />
      <path d="M20 4.5v5h-5" />
      <path d="M12 9v3.5l2.4 1.6" />
    </>,
  ),
  cleaning_services: stroke(
    <>
      <path d="M9 4.5h6M10 4.5V3h4v1.5" />
      <path d="M8.5 8.5h7l-1 3.5v7a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-7Z" />
      <path d="M17 10.5h.2M18.5 13h.2M17 15.5h.2" />
    </>,
  ),
  security: stroke(
    <>
      <path d="M12 2.75 4.75 5.5V12c0 4.5 3 8.2 7.25 9.25C16.25 20.2 19.25 16.5 19.25 12V5.5Z" />
      <path d="m9 12 2.2 2.2 4-4.4" />
    </>,
  ),
  memory_alt: stroke(
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>,
  ),
  travel_explore: stroke(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5Z" />
    </>,
  ),
  filter_alt: stroke(
    <>
      <path d="M4 5.5h16l-6.2 7.4v5.6l-3.6-2v-3.6Z" />
    </>,
  ),
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof GLYPHS;

export function Icon({
  name,
  className,
  style,
  ...rest
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  const Glyph = GLYPHS[name];
  // `inline-block h-[1em] w-[1em]` binds the box to the font-size set by the
  // accompanying `text-*` class; `shrink-0` keeps flex parents from squashing
  // it. Alignment is an inline style rather than an `align-[…]` utility so it
  // survives regardless of which utilities Tailwind generates.
  const merged = ["inline-block h-[1em] w-[1em] shrink-0 overflow-visible", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Glyph
      className={merged}
      style={{ verticalAlign: "-0.125em", ...style }}
      {...rest}
    />
  );
}
