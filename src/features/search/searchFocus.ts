/**
 * Focus target for the global ⌘K / Ctrl+K shortcut.
 *
 * The shortcut lives in the shell (it must work from any screen) but the input
 * lives in the search screen, so the screen registers its focus callback here
 * while it is mounted. The shell switches to the search screen and then asks
 * this module to focus, which keeps window-level key handling out of React
 * state and avoids passing a ref through three layers.
 */

let focusTarget: (() => void) | null = null;

export function registerSearchFocusTarget(target: (() => void) | null): void {
  focusTarget = target;
}

export function focusSearchField(): void {
  focusTarget?.();
}
