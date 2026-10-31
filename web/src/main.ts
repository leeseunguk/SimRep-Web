// SimRep-Web entry. Order matters: the Tauri IPC shim (isTauri, mocked internals) must exist before
// any SimRep app module loads, because several of them decide at load time whether a native backend
// is present (scene/simulation.ts, results/trace.ts, state/runs.ts). App modules are therefore only
// imported dynamically, after the shim and the host are installed.
import { installShim, type Shim } from "./ipc";
import { memoryStore, openStore, type FileStore } from "./storage";
import { createWebBackend, type WebBackend } from "./web/client";

export interface Boot {
  backend: WebBackend | null;
  /** Why the compute worker did not start (null when it did). */
  backendError: string | null;
  store: FileStore;
  shim: Shim;
}

async function boot() {
  const backend = createWebBackend();
  const store = openStore();
  const shim = installShim(backend, store);
  const [b, s] = await Promise.allSettled([backend, store]);
  const state: Boot = {
    backend: b.status === "fulfilled" ? b.value : null,
    backendError: b.status === "rejected" ? String(b.reason instanceof Error ? b.reason.message : b.reason) : null,
    store: s.status === "fulfilled" ? s.value : memoryStore(),
    shim,
  };
  // Read-only support/e2e facts and a PNG of the visible viewport, without backend handles.
  (window as unknown as { __simrepWeb: unknown }).__simrepWeb = {
    storage: state.store.kind,
    capabilities: state.backend?.capabilities ?? null,
    backendError: state.backendError,
    async captureViewport() {
      const viewport = await import("../.app-src/viewport/viewState");
      await viewport.settleViewportLayout();
      return viewport.captureViewport();
    },
  };
  const { installHost } = await import("./host");
  installHost(state);
  await import("../.app-src/main");
}

void boot();
