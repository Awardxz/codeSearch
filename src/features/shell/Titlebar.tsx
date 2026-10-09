import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "../../components/Icon";

/**
 * Custom window titlebar. The native Tauri frame is disabled
 * (`decorations: false` in tauri.conf.json), so this bar owns the window:
 * dragging, minimizing, maximizing/restoring and closing.
 *
 * Tauri calls are dynamically imported and guarded, so the bar still renders
 * (inertly) outside the Tauri runtime — in `vite dev` in a browser and in the
 * SSR smoke test. Nothing Tauri-specific runs during render.
 */

export const TITLEBAR_HEIGHT = "h-10";

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  startDragging: () => Promise<void>;
};

let windowPromise: Promise<TauriWindow | null> | null = null;

/** Resolve the current Tauri window, or null outside the Tauri runtime. */
function getTauriWindow(): Promise<TauriWindow | null> {
  if (!windowPromise) {
    windowPromise = (async () => {
      try {
        const mod = await import("@tauri-apps/api/window");
        return mod.getCurrentWindow() as unknown as TauriWindow;
      } catch {
        return null;
      }
    })();
  }
  return windowPromise;
}

export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  const refreshMaximized = useCallback(async () => {
    const win = await getTauriWindow();
    if (!win) return;
    try {
      setMaximized(await win.isMaximized());
    } catch {
      // Not running under Tauri (browser dev, tests): stay inert.
    }
  }, []);

  useEffect(() => {
    void refreshMaximized();
    // Maximizing, restoring and Aero-snap all resize the DOM window, so this
    // keeps the maximize/restore glyph truthful without Tauri event APIs.
    window.addEventListener("resize", refreshMaximized);
    return () => window.removeEventListener("resize", refreshMaximized);
  }, [refreshMaximized]);

  async function handleMinimize() {
    const win = await getTauriWindow();
    try {
      await win?.minimize();
    } catch {
      // Ignore: no window to minimize outside Tauri.
    }
  }

  async function handleToggleMaximize() {
    const win = await getTauriWindow();
    if (!win) return;
    try {
      await win.toggleMaximize();
    } catch {
      // Ignore: nothing to toggle outside Tauri.
    } finally {
      void refreshMaximized();
    }
  }

  async function handleClose() {
    const win = await getTauriWindow();
    try {
      await win?.close();
    } catch {
      // Ignore: no window to close outside Tauri.
    }
  }

  /**
   * Begin a native window drag. This is the imperative counterpart to the
   * `data-tauri-drag-region` attribute on the header: the attribute alone can
   * be unreliable on Windows, so a mousedown on the bar itself also asks the
   * OS to take over the drag. Button presses are excluded so the window
   * controls keep working, and anything but the primary button is ignored so
   * right-clicks still behave normally.
   */
  async function handleDragMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const win = await getTauriWindow();
    try {
      await win?.startDragging();
    } catch {
      // Ignore: no window to drag outside Tauri.
    }
  }

  return (
    <header
      data-tauri-drag-region
      onMouseDown={(event) => void handleDragMouseDown(event)}
      onDoubleClick={() => void handleToggleMaximize()}
      className={`fixed top-0 right-0 left-0 z-[60] flex ${TITLEBAR_HEIGHT} items-center justify-between border-b border-surface-container-highest bg-surface-container-lowest select-none`}
    >
      <div className="flex min-w-0 items-center gap-space-sm px-space-md">
        <img
          src="brand/codesearch-logo.png"
          alt=""
          aria-hidden="true"
          className="h-4 w-auto object-contain"
          draggable={false}
        />
        <span className="truncate text-label-md text-on-surface-variant">
          codeSearch
        </span>
      </div>

      <div className="flex h-full shrink-0 items-stretch">
        <WindowButton
          label="Minimize"
          icon="minimize"
          onClick={() => void handleMinimize()}
        />
        <WindowButton
          label={maximized ? "Restore" : "Maximize"}
          icon={maximized ? "restore" : "maximize"}
          onClick={() => void handleToggleMaximize()}
        />
        <WindowButton
          label="Close"
          icon="close"
          danger
          onClick={() => void handleClose()}
        />
      </div>
    </header>
  );
}

function WindowButton({
  label,
  icon,
  danger,
  onClick,
}: {
  label: string;
  icon: IconName;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex w-12 items-center justify-center text-[11px] transition-colors ${
        danger
          ? "text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
          : "text-on-surface-variant hover:bg-surface-container-high hover:text-primary"
      }`}
    >
      <Icon name={icon} />
    </button>
  );
}
