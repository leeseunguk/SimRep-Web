import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { WebBackend } from "./web/client";
import type { FileStore } from "./storage";
import { download, pickFiles, saveTarget, writeTarget, type SaveTarget } from "./pickers";
import { readZip, writeZip } from "./zip";

/**
 * The Tauri IPC layer of the desktop app, answered in the browser. The SimRep UI runs unchanged as
 * "the desktop app" (isTauri() is true); its commands go to:
 * - the wasm worker (web/client.ts) for everything computational: arrays, refine, fly, exports;
 * - the browser file store (storage.ts, OPFS or IndexedDB) for files the desktop keeps on disk:
 *   opened and computed arrays, projects and their X.simrep.d folders, the autosave;
 * - the browser for dialogs: File System Access pickers where they exist (Chromium), otherwise an
 *   `<input type=file>` and downloads (Safari, Firefox).
 *
 * Paths are virtual: `/files/<pick>/<name>` for opened files, `/files/templates/...` for gallery
 * templates, `/exports/<name>` for exports, `/projects/<name>/<name>.simrep` for saved projects.
 */

export const DIRS = { files: "/files", exports: "/exports", projects: "/projects", recovery: "/recovery/recovery.simrep" } as const;

type Args = Record<string, unknown>;
interface Internals {
  invoke(cmd: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown>;
  runCallback(id: number, data: unknown): void;
}

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (...parts: string[]) => parts.filter((s) => s !== "").join("/").replace(/\/{2,}/g, "/");
const notFound = (path: string) => ({ code: "notFound", detail: `no file ${path}` });
/** Worker errors as the desktop's coded errors (a bare code such as `noSession` is a reason). */
const coded = (err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  // Desktop commands in the worker reject with the desktop's error JSON ({code, detail, reason?}).
  if (detail.startsWith("{")) {
    try {
      const e = JSON.parse(detail) as { code?: unknown };
      if (typeof e.code === "string") return e;
    } catch {
      // Not JSON after all: a plain message.
    }
  }
  if (/^[a-z][A-Za-z]+$/.test(detail)) return { code: "unexpected", detail, reason: { code: detail } };
  return { code: "unexpected", detail };
};
const asBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new TextEncoder().encode(String(v ?? ""));
const buffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** A project data path: `X.simrep.d/rel`, refusing anything that leaves the folder. */
function dataPath(project: string, rel: string, allowEmpty = false): string {
  const segments = rel.replace(/\/$/, "").split("/");
  const ok = rel === "" ? allowEmpty : !/[\\:]/.test(rel) && !rel.startsWith("/") && segments.every((s) => s !== "" && s !== "." && s !== "..");
  if (!/\.simrep$/i.test(project) || !ok) throw { code: "unexpected", detail: `path leaves the project folder: ${rel}` };
  return rel ? `${project}.d/${segments.join("/")}` : `${project}.d`;
}
/** Zip entry names stay inside the store (no `..`, no empty segments). */
const safeEntry = (p: string) => p.split("/").every((s) => s !== "" && s !== "." && s !== "..");

let picks = 0;
const pickDir = (root: string) => `${root}/${Date.now().toString(36)}${(picks++).toString(36)}`;

/** Tauri dialog buttons as the label the plugin compares with (`ask`, `confirm`, `message`). */
function labels(buttons: unknown): [string, string] {
  if (buttons === "YesNo") return ["Yes", "No"];
  if (buttons && typeof buttons === "object" && "OkCancelCustom" in buttons) return (buttons as { OkCancelCustom: [string, string] }).OkCancelCustom;
  if (buttons && typeof buttons === "object" && "OkCustom" in buttons) return [(buttons as { OkCustom: string }).OkCustom, ""];
  return ["Ok", "Cancel"];
}

export interface Shim {
  /** Files picked or dropped: stored together in one new folder; their virtual paths. */
  addFiles(files: File[]): Promise<string[]>;
  /** The open project, its data folder (without ai/) and every file its arrays use, as one ZIP. */
  projectArchive(project: string): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }>;
  /** Unpacks a project archive into the store; the .simrep path inside it. */
  importArchive(bytes: Uint8Array): Promise<string>;
}

export function installShim(backend: Promise<WebBackend>, storeReady: Promise<FileStore>): Shim {
  (globalThis as unknown as { isTauri: boolean }).isTauri = true;
  mockWindows("main");
  const registered = new Set<string>();
  /** Save dialog answers, by the virtual path handed to the app. */
  const targets = new Map<string, SaveTarget>();

  /** Registers the files of `dir` (companions of an array: basis arrays, cuts, GEM includes) with the worker. */
  async function syncDir(dir: string) {
    const [b, store] = await Promise.all([backend, storeReady]);
    const missing = (await store.keys(dir)).filter((p) => dirOf(p) === dir && !registered.has(p));
    if (!missing.length) return;
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const path of missing) {
      const bytes = await store.get(path);
      if (bytes) files.push({ path, bytes });
    }
    await b.putFiles(files);
    for (const f of files) registered.add(f.path);
  }
  /** Copies worker outputs into the store (computed arrays outlive the tab). */
  async function persist(paths: string[]) {
    const [b, store] = await Promise.all([backend, storeReady]);
    for (const path of paths) {
      await store.put(path, new Uint8Array((await b.invoke("read_file", { path })) as ArrayBuffer));
      registered.add(path);
    }
  }
  async function put(path: string, bytes: Uint8Array) {
    await (await storeReady).put(path, bytes);
    registered.delete(path); // the worker has an older copy (or none)
  }
  async function readBytes(path: string): Promise<Uint8Array> {
    const stored = await (await storeReady).get(path);
    if (stored) return stored;
    try {
      return new Uint8Array((await (await backend).invoke("read_file", { path })) as ArrayBuffer);
    } catch {
      throw notFound(path);
    }
  }

  const shim: Shim = {
    async addFiles(files) {
      const dir = pickDir(DIRS.files);
      const out: string[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (/\.zip$/i.test(f.name)) {
          out.push(await shim.importArchive(bytes));
          continue;
        }
        const path = `${dir}/${f.name}`;
        await put(path, bytes);
        out.push(path);
      }
      return out;
    },
    async projectArchive(project) {
      const store = await storeReady;
      const doc = JSON.parse(new TextDecoder().decode((await store.get(project)) ?? new Uint8Array())) as {
        arrays?: { file: { path: string; absolute: string }; source?: { file?: { absolute: string } | null } }[];
        meshes?: { file: { absolute: string } }[];
      };
      const paths = new Set<string>([project]);
      const data = `${project}.d/`;
      for (const p of await store.keys(`${project}.d`)) if (!p.slice(data.length).startsWith("ai/")) paths.add(p);
      // Every file an array uses sits in its folder (basis arrays, cuts, ion files): take the folders.
      const dirs = new Set<string>();
      for (const a of doc.arrays ?? []) {
        dirs.add(dirOf(a.file.absolute));
        if (a.source?.file) dirs.add(dirOf(a.source.file.absolute));
      }
      for (const m of doc.meshes ?? []) dirs.add(dirOf(m.file.absolute));
      for (const d of dirs) for (const p of await store.keys(d)) if (dirOf(p) === d) paths.add(p);
      const entries = [];
      for (const p of [...paths].sort()) {
        const bytes = await store.get(p);
        if (bytes) entries.push({ path: p.slice(1), bytes });
      }
      return { name: `${baseOf(project).replace(/\.simrep$/i, "")}.zip`, bytes: await writeZip(entries) };
    },
    async importArchive(bytes) {
      const entries = await readZip(bytes);
      const project = entries.find((e) => /\.simrep$/i.test(e.path));
      if (!project) throw { code: "unexpected", detail: "the archive holds no .simrep project" };
      for (const e of entries) {
        if (!safeEntry(e.path)) throw { code: "unexpected", detail: `unsafe path in archive: ${e.path}` };
        if (e.path.split("/")[0] === "files" || e.path.split("/")[0] === "projects" || e.path.split("/")[0] === "exports") continue;
        throw { code: "unexpected", detail: `unexpected folder in archive: ${e.path}` };
      }
      for (const e of entries) await put(`/${e.path}`, e.bytes);
      return `/${project.path}`;
    },
  };

  let headers: Record<string, string> = {};
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args, args), { shouldMockEvents: true });
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const mocked = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    headers = options?.headers ?? {};
    return mocked(cmd, args, options);
  };

  /** Dialogs first and synchronously: pickers need the click's user activation. */
  function handle(cmd: string, a: Args, raw: unknown): Promise<unknown> {
    if (cmd === "plugin:dialog|open") return openDialog((a.options ?? {}) as { multiple?: boolean; directory?: boolean; filters?: { extensions: string[] }[] });
    if (cmd === "plugin:dialog|save") return saveDialog((a.options ?? {}) as { defaultPath?: string; filters?: { extensions: string[] }[] });
    const h = headers;
    return answer(cmd, a, raw, h).catch((err: unknown) => {
      throw err && typeof err === "object" && "code" in err ? err : coded(err);
    });
  }

  function openDialog(o: { multiple?: boolean; directory?: boolean; filters?: { extensions: string[] }[] }): Promise<unknown> {
    if (o.directory) return Promise.resolve(null); // no output folders in the browser (host: folders)
    const exts = (o.filters ?? []).flatMap((f) => f.extensions).filter((e) => e !== "*");
    const accept = exts.length ? [...new Set([...exts, ...(exts.includes("simrep") ? ["zip"] : [])])].map((e) => `.${e}`) : [];
    return pickFiles(accept, !!o.multiple).then(async (files) => {
      if (!files) return null;
      const paths = await shim.addFiles(files);
      return o.multiple ? paths : (paths[0] ?? null);
    });
  }

  async function saveDialog(o: { defaultPath?: string; filters?: { extensions: string[] }[] }): Promise<string | null> {
    const name = baseOf((o.defaultPath ?? "export").replace(/\\/g, "/")) || "export";
    // Projects are kept in the browser store (download them as an archive from Export).
    if ((o.filters ?? []).some((f) => f.extensions.includes("simrep"))) {
      const stem = name.replace(/\.simrep$/i, "").replace(/[/\\]/g, "_");
      return `${DIRS.projects}/${stem}/${stem}.simrep`;
    }
    const target = await saveTarget(name);
    if (!target) return null;
    const path = `${DIRS.exports}/${target.name}`;
    targets.set(path, target);
    return path;
  }

  /** Hands export outputs to the user: the first into the chosen file, the rest as downloads. */
  async function deliver(path: string, outputs: string[]) {
    const target = targets.get(path) ?? { kind: "download" as const, name: baseOf(path) };
    targets.delete(path);
    await persist(outputs);
    const store = await storeReady;
    for (const p of outputs) await writeTarget(target, (await store.get(p))!, baseOf(p));
  }

  async function answer(cmd: string, a: Args, raw: unknown, h: Record<string, string>): Promise<unknown> {
    const store = await storeReady;
    switch (cmd) {
      case "plugin:dialog|message":
      case "plugin:dialog|ask":
      case "plugin:dialog|confirm": {
        const [ok, cancel] = labels(a.buttons);
        if (!cancel) {
          window.alert(String(a.message ?? ""));
          return ok;
        }
        return window.confirm(String(a.message ?? "")) ? ok : cancel;
      }
      case "plugin:path|resolve_directory":
        return DIRS.files;
      case "plugin:path|join":
        return join(...(a.paths as string[]));
      case "ai_request":
        throw { code: "unexpected", detail: "unsupported in browser: ai_request" };
      case "path_info": {
        const out = [];
        for (const p of a.paths as string[]) {
          const bytes = await store.get(p);
          if (bytes) out.push({ path: p, name: baseOf(p), size: bytes.length });
        }
        return out;
      }
      case "read_file":
        return buffer(await readBytes(a.path as string));
      case "read_text":
        return new TextDecoder().decode(await readBytes(a.path as string));
      case "write_text":
        await put(a.path as string, new TextEncoder().encode(a.contents as string));
        return null;
      case "write_bytes": {
        const path = decodeURIComponent(h.path ?? "");
        const target = targets.get(path);
        if (target) {
          targets.delete(path);
          await writeTarget(target, asBytes(raw));
        } else await put(path, asBytes(raw));
        return null;
      }
      case "remove_file":
        await store.delete(a.path as string);
        registered.delete(a.path as string);
        return null;
      case "recovery_path":
        return DIRS.recovery;
      case "file_sha256": {
        const digest = await crypto.subtle.digest("SHA-256", buffer(await readBytes(a.path as string)));
        return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
      }
      case "project_dir_write":
        await put(dataPath(decodeURIComponent(h["project-path"] ?? ""), decodeURIComponent(h["rel-path"] ?? "")), asBytes(raw));
        return null;
      case "project_dir_read": {
        const path = dataPath(a.projectPath as string, a.relPath as string);
        const bytes = await store.get(path);
        if (!bytes) throw notFound(path);
        return buffer(bytes);
      }
      case "project_dir_list": {
        const root = dataPath(a.projectPath as string, "", true);
        const dir = dataPath(a.projectPath as string, (a.prefix as string) ?? "", true);
        return (await store.list(dir)).filter((e) => e.path !== dir).map((e) => ({ path: e.path.slice(root.length + 1), size: e.size }));
      }
      case "project_dir_delete":
        await store.delete(dataPath(a.projectPath as string, a.relPath as string));
        return null;
      case "create_template":
        return createTemplate(a.kind as string);
      case "refine_start":
        return refineStart(a);
      case "export_array": {
        const request = a.request as { path: string };
        const names = (await (await backend).invoke(cmd, a)) as string[];
        await deliver(request.path, names.map((n) => join(dirOf(request.path), n)));
        return names;
      }
      case "export_trajectories": {
        const n = await (await backend).invoke(cmd, a);
        await deliver(a.path as string, [a.path as string]);
        return n;
      }
      case "build_geometry": {
        const request = a.request as { path: string; outputDir: string };
        await syncDir(dirOf(request.path));
        const result = (await (await backend).invoke(cmd, a)) as { files: string[] };
        await persist(result.files.map((f) => join(request.outputDir, f)));
        return result;
      }
      default: {
        if (cmd.startsWith("plugin:")) return null; // window chrome: title, size
        // Arrays and their companions reach the worker before it opens them.
        const req = (a.request ?? {}) as { path?: unknown; source?: { path?: unknown } };
        for (const p of [a.path, req.path, req.source?.path]) if (typeof p === "string") await syncDir(dirOf(p));
        return (await backend).invoke(cmd, a);
      }
    }
  }

  /**
   * A gallery template, generated by the worker (desktop templates.rs, byte-identical) in its own
   * registry, then kept in the store under /files/templates/<kind>[-n]/ like Documents/SimRep.
   */
  async function createTemplate(kind: string) {
    const store = await storeReady;
    const created = (await (await backend).invoke("create_template", { kind })) as { path: string; name: string; size: number };
    const bytes = new Uint8Array((await (await backend).invoke("read_file", { path: created.path })) as ArrayBuffer);
    const taken = new Set((await store.keys(`${DIRS.files}/templates`)).map((p) => dirOf(p)));
    let dir = `${DIRS.files}/templates/${kind}`;
    for (let n = 2; taken.has(dir); n++) dir = `${DIRS.files}/templates/${kind}-${n}`;
    const path = `${dir}/${created.name}`;
    await put(path, bytes);
    return { path, name: created.name, size: bytes.length, dir };
  }

  /**
   * Refine through the worker, its messages relayed on the app's Channel in order. The finished
   * array family goes into the store before `done` reaches the app, so it is there to reopen.
   */
  async function refineStart(a: Args) {
    const channel = a.channel as { id: number };
    let index = 0;
    let chain = Promise.resolve();
    const send = (message: unknown) => internals.runCallback(channel.id, { index: index++, message });
    return (await backend).invoke("refine_start", {
      request: a.request,
      channel: (message: unknown) => {
        chain = chain.then(async () => {
          const m = message as { type?: string; files?: string[]; dir?: string };
          if (m?.type === "done" && m.files && m.dir !== undefined) {
            try {
              await persist(m.files.map((f) => join(m.dir!, f)));
            } catch (err) {
              send({ type: "error", message: `refined, but not stored in the browser: ${String(err)}`, reason: null });
              return;
            }
          }
          send(message);
        });
      },
    });
  }

  installDrop(shim);
  return shim;
}

/** Window drops become Tauri drag-drop events with stored paths (the app listens for those). */
function installDrop(shim: Shim) {
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const position = (e: DragEvent) => ({ x: e.clientX, y: e.clientY });
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) void emit("tauri://drag-enter", { paths: ["(files)"], position: position(e) });
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) void emit("tauri://drag-leave", {});
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return void emit("tauri://drag-leave", {});
    void shim.addFiles(files).then((paths) => emit("tauri://drag-drop", { paths, position: position(e) }));
  });
}

export { download };
