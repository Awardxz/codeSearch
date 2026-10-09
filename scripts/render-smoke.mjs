/**
 * Temporary render smoke test: renders <App /> to a string through Vite's SSR
 * module pipeline. This is what catches render-throwing bugs (e.g. an unbound
 * store method) before the app is ever opened in the Tauri window.
 */
import { createServer } from "vite";
import { renderToString } from "react-dom/server";

const server = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "warn",
});

try {
  const { default: App } = await server.ssrLoadModule("/src/App.tsx");
  const { embeddingClient } = await server.ssrLoadModule(
    "/src/lib/embeddings/embeddingClient.ts",
  );
  const { indexStore } = await server.ssrLoadModule("/src/lib/indexing/indexStore.ts");

  // Regression guard: `useSyncExternalStore` calls these with no receiver, so
  // they must work when detached from the instance.
  for (const [name, fn] of [
    ["embeddingClient.getStatus", embeddingClient.getStatus],
    ["indexStore.getSnapshot", indexStore.getSnapshot],
  ]) {
    if (typeof fn !== "function") throw new Error(`${name} is not a function.`);
    const value = fn();
    if (value === undefined || value === null) {
      throw new Error(`${name}() returned nothing when called detached.`);
    }
  }

  const html = renderToString(App());

  for (const needle of ["codeSearch", "Search", "Index", "Settings", "Find files by intent", "Nothing indexed yet", "Minimize", "Maximize", "Close"]) {
    if (!html.includes(needle)) {
      throw new Error(`Rendered output is missing expected text: "${needle}"`);
    }
  }

  // The active nav item carries aria-current; the other two are present
  // without it.
  const navCount = (html.match(/aria-current/g) ?? []).length;
  console.log(`Rendered ${html.length} chars of HTML; ${navCount} nav item(s) with aria-current.`);
  console.log("RENDER SMOKE TEST PASSED");
  process.exitCode = 0;
} catch (error) {
  console.error("RENDER SMOKE TEST FAILED:");
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
