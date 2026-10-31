/**
 * File pickers and saving, feature-detected. The File System Access pickers (showOpenFilePicker /
 * showSaveFilePicker) exist in Chromium browsers only; Safari and Firefox get an `<input type=file>`
 * for opening and a download link for saving. Pickers need the click that asked for them (user
 * activation), so callers start them without awaiting anything first.
 */

interface FsaWindow {
  showOpenFilePicker?(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { suggestedName?: string }): Promise<FileSystemFileHandle>;
}
const fsa = () => window as unknown as FsaWindow;

/** True when this browser has the File System Access open picker (Chromium). */
export const hasOpenPicker = () => typeof fsa().showOpenFilePicker === "function";
/** True when this browser has the File System Access save picker (Chromium). */
export const hasSavePicker = () => typeof fsa().showSaveFilePicker === "function";

const aborted = (err: unknown) => (err as DOMException)?.name === "AbortError";

/** Asks for files; null when the user cancels. `accept`: extensions with the dot (input fallback). */
export function pickFiles(accept: string[], multiple: boolean): Promise<File[] | null> {
  const open = fsa().showOpenFilePicker;
  if (open) {
    // No `types`: Chromium rejects extensions such as ".pa#" there. The input fallback filters.
    return open.call(window, { multiple }).then(
      (handles) => Promise.all(handles.map((h) => h.getFile())),
      (err: unknown) => {
        if (aborted(err)) return null;
        throw err;
      },
    );
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept.length) input.accept = accept.join(",");
    input.hidden = true;
    input.dataset.simrepPicker = "";
    const done = (files: File[] | null) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(input.files?.length ? Array.from(input.files) : null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Where saved bytes go: a file the user chose (File System Access) or a download. */
export type SaveTarget = { kind: "handle"; name: string; handle: FileSystemFileHandle } | { kind: "download"; name: string };

/**
 * Asks where to save `name`; null when the user cancels. Without the save picker, or when it
 * refuses (no user activation left), the file becomes a download under its suggested name.
 */
export async function saveTarget(name: string): Promise<SaveTarget | null> {
  const save = fsa().showSaveFilePicker;
  if (!save) return { kind: "download", name };
  try {
    const handle = await save.call(window, { suggestedName: name });
    return { kind: "handle", name: handle.name, handle };
  } catch (err) {
    if (aborted(err)) return null;
    return { kind: "download", name };
  }
}

/** Downloads `bytes` as `name` (a link with the download attribute). */
export function download(name: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Writes `bytes` to the target: into the chosen file, or as a download named `name`. */
export async function writeTarget(target: SaveTarget, bytes: Uint8Array, name = target.name): Promise<void> {
  if (target.kind === "handle" && name === target.name) {
    const w = await target.handle.createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
  } else download(name, bytes);
}
