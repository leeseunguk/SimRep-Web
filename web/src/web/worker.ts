/// <reference lib="webworker" />
import type { WasmBackend } from "./pkg/simrep_wasm";
import { registerRefine, type Handler, type Register } from "./refine";
import type { BrowserCapabilities } from "./types";
import { registerDesktop } from "../../../app/browser-desktop";

const nativeCommands = [
  "backend_info", "compute_device", "open_pa", "read_file", "path_info", "close_session",
  "electrode_labels", "open_iob", "inspect_geometry", "build_geometry", "create_template",
  "refine_targets", "refine_start", "refine_cancel", "fast_adjust", "fly", "ion_trace",
  "flight_velocities", "export_array", "export_trajectories", "read_text", "write_text",
  "write_bytes", "remove_file", "recovery_path", "project_dir_write", "project_dir_read",
  "project_dir_list", "project_dir_delete", "file_sha256", "ai_request",
];
interface Request { id: number; cmd: string; args?: Record<string, unknown>; type?: undefined }
interface Ack { type: "channelAck"; sequence: number }
interface Initialize { type: "initialize"; threads?: number }
interface FileBytes { path: string; bytes: Uint8Array }
const scope = self as DedicatedWorkerGlobalScope;
const bytes = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;

async function start(requestedThreads?: number) {
  const started = performance.now();
  // WebKitGTK intermittently stalls nested Rayon module-worker imports, including
  // after reload. Keep its default computation path serial; explicit pools remain opt-in.
  const webkit = navigator.userAgent.includes("AppleWebKit") && !/(Chrome|Chromium|Edg)\//.test(navigator.userAgent);
  const serialWebkit = webkit && requestedThreads === undefined;
  const requested = requestedThreads ?? (serialWebkit ? 1 : navigator.hardwareConcurrency || 1);
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("CPU thread count must be a positive integer");
  // Keep the pool within the native small-grid budget. Larger native pools
  // create another four-thread pool, which std::thread cannot spawn on wasm.
  const count = Math.min(4, requested);
  const shared = self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
  let backend: WasmBackend;
  if (shared && count > 1) {
    const wasm = await import("./pkg-threads/simrep_wasm");
    await wasm.default();
    await wasm.initThreadPool(count);
    backend = new wasm.WasmBackend();
  } else {
    const wasm = await import("./pkg/simrep_wasm");
    await wasm.default();
    backend = new wasm.WasmBackend();
  }
  const threads = backend.current_threads();
  const reason = serialWebkit ? "WebKit defaults to one CPU worker; nested threaded module-worker startup is unreliable" : !shared ? "Cross-origin isolation unavailable; using one CPU worker" : count === 1 ? "One CPU worker selected" : requested > count ? "Browser Rayon pool is capped at four workers" : null;
  const initMs = performance.now() - started;
  const handlers = new Map<string, Handler>();
  const register: Register = (command, handler) => { handlers.set(command, handler); };
  const acknowledgements = new Map<number, () => void>();
  let sequence = 0;
  const channel = (requestId: number, job: number, payload: unknown): Promise<void> =>
    new Promise((resolve) => {
      const index = ++sequence;
      acknowledgements.set(index, resolve);
      const message = { type: "channel", requestId, job, sequence: index, payload };
      if (payload instanceof ArrayBuffer) scope.postMessage(message, [payload]);
      else scope.postMessage(message);
    });

  register("web_register_files", (a) => { for (const f of a.files as FileBytes[]) backend.put_file(f.path, f.bytes); return null; });
  register("backend_info", () => ({ appName: "simrep-web", appVersion: "0.1.0", coreCrate: "simrep-core" }));
  register("compute_device", () => ({ kind: "cpu", name: "CPU", threads, initMs, reason }));
  register("path_info", (a) => { const files = JSON.parse(backend.list_files()) as { path: string; name: string; size: number }[]; return (a.paths as string[]).flatMap((p) => files.filter((f) => f.path === p)); });
  register("open_pa", (a) => bytes(backend.open_pa(a.id as string, a.path as string)));
  register("read_file", (a) => bytes(backend.read_file(a.path as string)));
  register("fast_adjust", (a) => bytes(backend.fast_adjust(a.id as string, JSON.stringify(a.voltages))));
  register("close_session", (a) => { backend.close_session(a.id as string); return null; });
  register("electrode_labels", (a) => bytes(backend.electrode_labels(a.id as string)));
  register("fly", (a) => bytes(backend.fly(JSON.stringify(a.request))));
  register("ion_trace", (a) => bytes(backend.ion_trace(JSON.stringify(a.request), a.ion as number)));
  register("flight_velocities", (a) => bytes(backend.flight_velocities(a.id as string, a.token as number)));
  register("export_array", (a) => JSON.parse(backend.export_array(JSON.stringify(a.request))));
  register("export_trajectories", (a) => backend.export_trajectories(JSON.stringify(a.request), a.path as string));
  register("web_flight_csv", (a) => bytes(backend.flight_csv(a.id as string, a.token as number)));
  register("web_flight_summary", (a) => JSON.parse(backend.flight_summary(a.id as string, a.token as number)));
  registerRefine(register, { backend, channel });
  registerDesktop(register, backend);
  for (const cmd of ["gem2pa", "mesh_import", "mesh-import", "refine_geometry", "refine-geometry"]) register(cmd, (a) => JSON.parse(backend.geometry_command(cmd, JSON.stringify(a.request ?? a))));

  const capabilities: BrowserCapabilities = {
    supportedCommands: [...handlers.keys()],
    unsupportedCommands: nativeCommands.filter((cmd) => !handlers.has(cmd)),
    threads, device: "cpu", precision: "f64", geometry: true, flight: true, multicore: threads > 1,
  };
  scope.onmessage = async ({ data }: MessageEvent<Request | Ack>) => {
    if (data.type === "channelAck") {
      acknowledgements.get(data.sequence)?.();
      acknowledgements.delete(data.sequence);
      return;
    }
    try {
      const handler = handlers.get(data.cmd);
      if (!handler) throw new Error(`unsupported in browser: ${data.cmd}`);
      const value = await handler(data.args ?? {}, data.id);
      if (value instanceof ArrayBuffer) scope.postMessage({ id: data.id, value }, [value]);
      else scope.postMessage({ id: data.id, value });
    } catch (error) {
      scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  scope.postMessage({ type: "ready", capabilities });
}

scope.onmessage = ({ data }: MessageEvent<Initialize>) => {
  if (data.type !== "initialize") return;
  scope.onmessage = null;
  void start(data.threads).catch((error: unknown) => {
    scope.postMessage({ type: "startupError", error: String(error) });
  });
};
