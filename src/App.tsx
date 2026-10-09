import { useState } from "react";
import { AppServicesProvider, useAppServices } from "./hooks/useAppServices";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SearchScreen } from "./features/search/SearchScreen";
import { IndexScreen } from "./features/indexing/IndexScreen";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { PreviewPanel } from "./features/preview/PreviewPanel";
import {
  AppShell,
  ContextSubBar,
  type ScreenId,
} from "./features/shell/AppShell";

/**
 * Application shell: the Stitch desktop frame with the three workflow screens
 * mounted inside it. The rail and the context bar are the frame; search, index
 * and settings are the product. The preview panel is an overlay above all of
 * it, because it reads as a sheet sliding over the results rather than as a
 * fourth destination.
 */

function Shell() {
  const [screen, setScreen] = useState<ScreenId>("search");
  const { index } = useAppServices();

  const readyFiles = index.files.filter((file) => file.status === "ready");
  const chunkCount = readyFiles.reduce((sum, file) => sum + file.chunks.length, 0);
  const lastIndexedAt = readyFiles.reduce<number | null>(
    (latest, file) =>
      file.indexedAt === null
        ? latest
        : latest === null || file.indexedAt > latest
          ? file.indexedAt
          : latest,
    null,
  );

  return (
    <AppShell
      screen={screen}
      onNavigate={setScreen}
      overlay={<PreviewPanel />}
    >
      {/* Settings carries its own preferences rail instead of the context bar. */}
      {screen !== "settings" && (
        <ContextSubBar
          readyFiles={readyFiles.length}
          chunkCount={chunkCount}
          indexedAt={lastIndexedAt}
        />
      )}

      {screen === "search" && <SearchScreen />}
      {screen === "index" && <IndexScreen />}
      {screen === "settings" && <SettingsScreen />}
    </AppShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppServicesProvider>
        <Shell />
      </AppServicesProvider>
    </ErrorBoundary>
  );
}
