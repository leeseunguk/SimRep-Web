import type { WasmBackend, RefineJob } from "./pkg/simrep_wasm";

export type Args = Record<string, unknown>;
export type Handler = (args: Args, requestId: number) => unknown | Promise<unknown>;
export type Register = (command: string, handler: Handler) => void;
export interface RefineContext {
  backend: WasmBackend;
  channel(requestId: number, job: number, payload: unknown): Promise<void>;
}

interface Step {
  terminal: boolean;
  messages: { type: string; [key: string]: unknown }[];
}

const bytes = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;

/** One task turn before publishing the first channel message, after invoke's job response. */
function task(): Promise<void> {
  return new Promise((resolve) => {
    const ports = new MessageChannel();
    ports.port1.onmessage = () => {
      ports.port1.close();
      ports.port2.close();
      resolve();
    };
    ports.port2.postMessage(null);
  });
}

export function registerRefine(register: Register, context: RefineContext): void {
  const jobs = new Map<number, RefineJob>();
  const summaries = new Map<number, unknown>();
  let sequence = 0;
  const send = (requestId: number, job: number, payload: unknown) => context.channel(requestId, job, payload);

  async function run(id: number, requestId: number, job: RefineJob) {
    try {
      await task();
      await send(requestId, id, JSON.parse(job.start_message()));
      let previousStage = -1;
      let previewAt = -Infinity;
      for (;;) {
        const result = JSON.parse(job.step()) as Step;
        const done = result.messages.find((message) => message.type === "done");
        for (const message of result.messages) {
          if (message.type !== "done") await send(requestId, id, message);
        }
        if (result.terminal) {
          summaries.set(id, JSON.parse(job.summary()));
          if (summaries.size > 4) {
            const first = summaries.keys().next().value;
            if (first !== undefined) summaries.delete(first);
          }
          if (done) {
            context.backend.refine_commit(job);
            await send(requestId, id, bytes(job.result_packet()));
            await send(requestId, id, done);
          }
          break;
        }
        const stage = result.messages.find((message) => message.type === "progress")?.stage;
        const now = performance.now();
        if (stage !== previousStage || now - previewAt >= 120) {
          await send(requestId, id, bytes(job.preview()));
          previousStage = typeof stage === "number" ? stage : previousStage;
          previewAt = now;
        }
      }
    } catch (error) {
      await send(requestId, id, { type: "error", message: String(error), reason: null });
    } finally {
      jobs.delete(id);
      job.free();
    }
  }

  register("refine_targets", (a) => JSON.parse(context.backend.refine_targets(JSON.stringify(a))));
  register("refine_start", (a, requestId) => {
    const job = context.backend.refine_begin(JSON.stringify(a.request));
    const id = ++sequence;
    jobs.set(id, job);
    void run(id, requestId, job);
    return id;
  });
  register("refine_cancel", (a) => { jobs.get(a.job as number)?.cancel(); return null; });
  register("web_refine_summary", (a) => { const result = summaries.get(a.job as number); if (result === undefined) throw new Error("refine summary expired"); return result; });
}
