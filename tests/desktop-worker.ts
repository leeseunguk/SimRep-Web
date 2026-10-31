/// <reference lib="webworker" />
// Real Chromium worker fixture for the independently owned desktop registration module.
import init, { WasmBackend } from "../web/src/web/pkg/simrep_wasm";
import { registerDesktop } from "../app/browser-desktop";

await init();
const backend = new WasmBackend();
const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
const register = (name: string, handler: (args: Record<string, unknown>) => unknown) => { handlers.set(name, handler); };
registerDesktop(register, backend);
register("web_register_files", (args) => {
  for (const f of args.files as { path: string; bytes: number[] }[]) backend.put_file(f.path, Uint8Array.from(f.bytes));
  return null;
});
register("read_file", (args) => backend.read_file(args.path as string));
register("path_info", () => JSON.parse(backend.list_files()));
register("open_pa", (args) => backend.open_pa(args.id as string, args.path as string));
register("refine_targets", (args) => JSON.parse(backend.refine_targets(JSON.stringify(args))));
register("refine_pa", (args) => JSON.parse(backend.refine_pa(args.id as string, 1e-10, 200)));
self.onmessage = async ({ data }: MessageEvent<{ id: number; command: string; args: Record<string, unknown> }>) => {
  try {
    const handler = handlers.get(data.command);
    if (!handler) throw new Error(`unsupported in browser: ${data.command}`);
    self.postMessage({ id: data.id, value: await handler(data.args) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
self.postMessage({ ready: true, commands: [...handlers.keys()] });
