import type { BrowserCapabilities } from "./types";

type Listener = (payload: unknown) => void;
export interface WebChannel { onmessage: Listener }
export interface WebBackend {
  invoke(cmd: string, args?: object): Promise<unknown>;
  listen(event: string, cb: Listener): () => void;
  capabilities: BrowserCapabilities;
  putFiles(files: { path: string; bytes: Uint8Array }[]): Promise<void>;
  dispose(): void;
}

/** Module-worker IPC with desktop Channel callbacks and acknowledged backpressure. */
export async function createWebBackend(options: { threads?: number } = {}): Promise<WebBackend> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Map<string, Set<Listener>>();
  const channels = new Map<number, Listener>();
  let next = 0;
  let failure: Error | undefined;
  let readyResolve!: (capabilities: BrowserCapabilities) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<BrowserCapabilities>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = (error: Error) => {
    failure = error;
    readyReject(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    channels.clear();
    worker.terminate();
  };
  worker.onerror = (event) => fail(new Error(event.message || "browser worker failed"));
  worker.onmessageerror = () => fail(new Error("browser worker message could not be decoded"));
  worker.onmessage = ({ data }: MessageEvent<{
    type?: string;
    capabilities?: BrowserCapabilities;
    id?: number;
    requestId?: number;
    sequence?: number;
    error?: string;
    value?: unknown;
    event?: string;
    payload?: unknown;
  }>) => {
    if (data.type === "ready" && data.capabilities) {
      readyResolve(data.capabilities);
    } else if (data.type === "startupError") {
      fail(new Error(data.error));
    } else if (data.type === "channel" && data.requestId !== undefined) {
      try {
        channels.get(data.requestId)?.(data.payload);
      } finally {
        const terminal = (data.payload as { type?: string } | null)?.type;
        if (terminal === "done" || terminal === "cancelled" || terminal === "error") channels.delete(data.requestId);
        // A callback can enqueue refine_cancel before this ACK. Worker messages
        // from this sender are ordered, so the next cycle observes cancellation.
        worker.postMessage({ type: "channelAck", sequence: data.sequence });
      }
    } else if (data.event) {
      for (const cb of listeners.get(data.event) ?? []) cb(data.payload);
    } else if (data.id !== undefined) {
      const call = pending.get(data.id);
      if (!call) return;
      pending.delete(data.id);
      if (data.error !== undefined) {
        channels.delete(data.id);
        call.reject(new Error(data.error));
      } else call.resolve(data.value);
    }
  };
  const startupDeadline = setTimeout(() => fail(new Error("browser backend initialization timed out")), 30000);
  worker.postMessage({ type: "initialize", threads: options.threads });
  let capabilities: BrowserCapabilities;
  try { capabilities = await ready; } finally { clearTimeout(startupDeadline); }
  const invoke = (cmd: string, args?: object): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++next;
      const payload = { ...args } as Record<string, unknown>;
      if (cmd === "refine_start") {
        const channel = payload.channel as WebChannel | Listener | undefined;
        const callback = typeof channel === "function" ? channel : channel?.onmessage;
        if (typeof callback !== "function") { reject(new Error("refine_start requires a channel callback")); return; }
        channels.set(id, callback);
        delete payload.channel;
      }
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, cmd, args: payload });
      } catch (error) {
        pending.delete(id);
        channels.delete(id);
        reject(error);
      }
    });
  };
  return {
    invoke,
    capabilities,
    listen(event, cb) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(event, set);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(event);
      };
    },
    async putFiles(files) { await invoke("web_register_files", { files }); },
    dispose() { listeners.clear(); fail(new Error("browser backend disposed")); },
  };
}
