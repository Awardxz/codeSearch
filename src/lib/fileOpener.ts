import { openPath } from "@tauri-apps/plugin-opener";
import type { AppError } from "../types";

/**
 * Opens the original file with the system default application via the
 * opener plugin. Uses the plugin's safe native path API — never a shell
 * command built from the path.
 */
export async function openFileInSystemApp(path: string): Promise<AppError | null> {
  try {
    await openPath(path);
    return null;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The file could not be opened.";
    return { code: "unknown", message };
  }
}
