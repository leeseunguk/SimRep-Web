import { checkFileSize, MAX_TOTAL_BYTES } from "./limits";
interface FsaWindow {
  showOpenFilePicker?(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { suggestedName?: string }): Promise<FileSystemFileHandle>;
}
const fsa = () => window as unknown as FsaWindow;
export const hasOpenPicker = () => typeof fsa().showOpenFilePicker === "function";
export const hasSavePicker = () => typeof fsa().showSaveFilePicker === "function";
const aborted = (err: unknown) => (err as DOMException)?.name === "AbortError";
function validate(files: File[] | null): File[] | null {
  if (!files) return null;
  for (const f of files) checkFileSize(f.size, f.name);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) throw new Error("selection exceeds 256 MiB input budget");
  return files;
}
export function pickFiles(accept: string[], multiple: boolean): Promise<File[] | null> {
  const open = fsa().showOpenFilePicker;
  if (open) return open.call(window, { multiple }).then(handles => Promise.all(handles.map(h => h.getFile())).then(validate), (err: unknown) => { if (aborted(err)) return null; throw err; });
  return new Promise<File[] | null>((resolve, reject) => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = multiple;
    if (accept.length) input.accept = accept.join(","); input.hidden = true; input.dataset.simrepPicker = "";
    const done = (files: File[] | null) => { input.remove(); try { resolve(validate(files)); } catch (error) { reject(error); } };
    input.addEventListener("change", () => done(input.files?.length ? Array.from(input.files) : null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true }); document.body.append(input); input.click();
  });
}
export type SaveTarget = { kind: "handle"; name: string; handle: FileSystemFileHandle } | { kind: "download"; name: string };
export async function saveTarget(name: string): Promise<SaveTarget | null> {
  const save = fsa().showSaveFilePicker; if (!save) return { kind: "download", name };
  try { const handle = await save.call(window, { suggestedName: name }); return { kind: "handle", name: handle.name, handle }; }
  catch (err) { if (aborted(err)) return null; return { kind: "download", name }; }
}
export function download(name: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })), a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function writeTarget(target: SaveTarget, bytes: Uint8Array, name = target.name): Promise<void> {
  if (target.kind === "handle" && name === target.name) { const w = await target.handle.createWritable(); await w.write(bytes as Uint8Array<ArrayBuffer>); await w.close(); }
  else download(name, bytes);
}
