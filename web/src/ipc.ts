import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { WebBackend } from "./web/client";
import type { FileStore } from "./storage";
import { download, pickFiles, saveTarget, writeTarget, type SaveTarget } from "./pickers";
import { writeZip } from "./zip";
import { importProject } from "./archive";
import { checkFileSize, MAX_TOTAL_BYTES, readInput, safePath } from "./limits";
export const DIRS = { files: "/files", exports: "/exports", projects: "/projects", recovery: "/recovery/recovery.simrep" } as const;
type Args = Record<string, unknown>;
interface Internals { invoke(cmd: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown>; runCallback(id: number, data: unknown): void }
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (...parts: string[]) => parts.filter(s => s !== "").join("/").replace(/\/{2,}/g, "/");
const notFound = (path: string) => ({ code: "notFound", detail: `no file ${path}` });
const coded = (err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.startsWith("{")) { try { const e = JSON.parse(detail) as { code?: unknown }; if (typeof e.code === "string") return e; } catch { /* plain message */ } }
  if (/^[a-z][A-Za-z]+$/.test(detail)) return { code: "unexpected", detail, reason: { code: detail } };
  return { code: "unexpected", detail };
};
const asBytes = (v: unknown): Uint8Array => v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new TextEncoder().encode(String(v ?? ""));
const buffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
function dataPath(project: string, rel: string, allowEmpty = false): string {
  const clean = rel.replace(/\/$/, "");
  if (!/\.simrep$/i.test(project) || !(clean === "" ? allowEmpty : safePath(clean))) throw { code: "unexpected", detail: `path leaves the project folder: ${rel}` };
  return clean ? `${project}.d/${clean}` : `${project}.d`;
}
let picks = 0;
const pickDir = (root: string) => `${root}/${Date.now().toString(36)}${(picks++).toString(36)}`;
function labels(buttons: unknown): [string, string] {
  if (buttons === "YesNo") return ["Yes", "No"];
  if (buttons && typeof buttons === "object" && "OkCancelCustom" in buttons) return (buttons as { OkCancelCustom: [string, string] }).OkCancelCustom;
  if (buttons && typeof buttons === "object" && "OkCustom" in buttons) return [(buttons as { OkCustom: string }).OkCustom, ""];
  return ["Ok", "Cancel"];
}
export interface Shim {
  addFiles(files: File[]): Promise<string[]>;
  projectArchive(project: string): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }>;
  importArchive(bytes: Uint8Array): Promise<string>;
}
export function installShim(backend: Promise<WebBackend>, storeReady: Promise<FileStore>): Shim {
  (globalThis as unknown as { isTauri: boolean }).isTauri = true;
  mockWindows("main");
  const registered = new Set<string>(), targets = new Map<string, SaveTarget>();
  const hash = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(b)))].map(x => x.toString(16).padStart(2, "0")).join("");
  async function forget(paths: string[]) {
    const b = await backend;
    for (const path of paths) { await b.invoke("remove_file", { path }); registered.delete(path); }
  }
  /** Persistent manifest is authoritative; no worker fallback may resurrect a deleted file. */
  async function syncDir(dir: string) {
    const [b, store] = await Promise.all([backend, storeReady]);
    const paths = await store.keys(dir), present = new Set(paths);
    await forget([...registered].filter(p => (p === dir || p.startsWith(`${dir}/`)) && !present.has(p)));
    const files: { path: string; bytes: Uint8Array }[] = [];
    let total = 0;
    for (const path of paths) {
      if (path.endsWith(".identity.json")) continue;
      const bytes = await store.get(path); if (!bytes) continue;
      checkFileSize(bytes.length, path); total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("project exceeds worker resident-byte budget (256 MiB)");
      if (path.endsWith(".cuts.json")) {
        const identity = await store.get(`${path}.identity.json`);
        let valid = false;
        if (identity) {
          const pairs = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(identity)) as Record<string, string>;
          valid = pairs[baseOf(path)] === await hash(bytes);
          for (const [name, expected] of Object.entries(pairs)) {
            if (!safePath(name) || name.includes("/")) { valid = false; break; }
            const data = await store.get(join(dirOf(path), name)); if (!data || await hash(data) !== expected) valid = false;
          }
          const stem = path.slice(0, -10);
          if (paths.some(p => p.startsWith(`${stem}.pa`) && !pairs[baseOf(p)])) valid = false;
        }
        if (!valid) { console.warn(`Ignoring cuts sidecar with missing or mismatched PA identity: ${path}`); await forget([path]); continue; }
      }
      files.push({ path, bytes });
    }
    await b.putFiles(files); for (const f of files) registered.add(f.path);
  }
  async function persist(paths: string[], removed: string[] = []) {
    const [b, store] = await Promise.all([backend, storeReady]);
    const changes: { path: string; bytes: Uint8Array | null }[] = removed.map(path => ({ path, bytes: null }));
    for (const path of paths) changes.push({ path, bytes: new Uint8Array(await b.invoke("read_file", { path }) as ArrayBuffer) });
    const inventory = await b.invoke("web_list_files") as { path: string }[];
    const cuts = new Set(paths.filter(p => p.endsWith(".cuts.json")));
    for (const p of paths) if (/\.pa[0-9#_]*/.test(p)) { const side = p.replace(/\.pa[0-9#_]*$/, ".cuts.json"); if (inventory.some(f => f.path === side) && !removed.includes(side)) cuts.add(side); }
    for (const path of cuts) {
      const stem = path.slice(0, -10), pairs: Record<string, string> = {};
      for (const f of inventory) if (f.path === path || f.path.startsWith(`${stem}.pa`)) pairs[baseOf(f.path)] = await hash(new Uint8Array(await b.invoke("read_file", { path: f.path }) as ArrayBuffer));
      changes.push({ path: `${path}.identity.json`, bytes: new TextEncoder().encode(JSON.stringify(pairs)) });
    }
    try { await store.batch(changes); } catch (error) {
      await forget([...paths, ...removed]); await syncDir(dirOf(paths[0] ?? removed[0] ?? "/files")); throw error;
    }
    await forget(removed); for (const p of paths) registered.add(p);
  }
  async function put(path: string, bytes: Uint8Array) { checkFileSize(bytes.length, path); await (await storeReady).put(path, bytes); await forget([path]); }
  async function remove(path: string) { const store = await storeReady; const paths = await store.keys(path); await store.delete(path); await forget([...new Set([...paths, path])]); }
  async function readBytes(path: string) { const bytes = await (await storeReady).get(path); if (!bytes) throw notFound(path); return bytes; }
  const shim: Shim = {
    async addFiles(files) {
      for (const f of files) checkFileSize(f.size, f.name);
      if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) throw new Error("selection exceeds 256 MiB input budget");
      const dir = pickDir(DIRS.files), out: string[] = [], changes = [];
      for (const f of files) {
        const bytes = await readInput(f);
        if (/\.zip$/i.test(f.name)) { out.push(await shim.importArchive(bytes)); continue; }
        const name = f.webkitRelativePath || f.name; if (!safePath(name)) throw new Error(`unsafe input path: ${name}`);
        const path = `${dir}/${name}`; changes.push({ path, bytes }); out.push(path);
      }
      await (await storeReady).batch(changes); return out;
    },
    async projectArchive(project) {
      const store = await storeReady;
      const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(project))) as { arrays?: { file: { absolute: string }; source?: { file?: { absolute: string } | null } }[]; meshes?: { file: { absolute: string } }[] };
      const paths = new Set<string>([project]);
      for (const p of await store.keys(`${project}.d`)) if (!p.slice(project.length + 3).startsWith("ai/")) paths.add(p);
      const dirs = new Set<string>();
      for (const a of doc.arrays ?? []) { dirs.add(dirOf(a.file.absolute)); if (a.source?.file) dirs.add(dirOf(a.source.file.absolute)); }
      for (const m of doc.meshes ?? []) dirs.add(dirOf(m.file.absolute));
      // Include this project's resources without copying neighboring saved projects.
      for (const p of await store.keys(`${dirOf(project)}/resources`)) paths.add(p);
      for (const d of dirs) for (const p of await store.keys(d)) paths.add(p);
      const entries = []; for (const path of [...paths].sort()) { const bytes = await store.get(path); if (bytes) entries.push({ path: path.slice(1), bytes }); }
      return { name: `${baseOf(project).replace(/\.simrep$/i, "")}.zip`, bytes: await writeZip(entries) };
    },
    async importArchive(bytes) { return importProject(bytes, await storeReady); },
  };
  let headers: Record<string, string> = {};
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args, args), { shouldMockEvents: true });
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__, mocked = internals.invoke;
  internals.invoke = (cmd, args, options) => { headers = options?.headers ?? {}; return mocked(cmd, args, options); };
  function handle(cmd: string, a: Args, raw: unknown): Promise<unknown> {
    if (cmd === "plugin:dialog|open") return openDialog((a.options ?? {}) as { multiple?: boolean; directory?: boolean; filters?: { extensions: string[] }[] });
    if (cmd === "plugin:dialog|save") return saveDialog((a.options ?? {}) as { defaultPath?: string; filters?: { extensions: string[] }[] });
    return answer(cmd, a, raw, headers).catch((err: unknown) => { throw err && typeof err === "object" && "code" in err ? err : coded(err); });
  }
  function openDialog(o: { multiple?: boolean; directory?: boolean; filters?: { extensions: string[] }[] }): Promise<unknown> {
    if (o.directory) return Promise.resolve(null);
    const exts = (o.filters ?? []).flatMap(f => f.extensions).filter(e => e !== "*");
    const accept = exts.length ? [...new Set([...exts, ...(exts.includes("simrep") ? ["zip"] : [])])].map(e => `.${e}`) : [];
    return pickFiles(accept, !!o.multiple).then(async files => { if (!files) return null; const paths = await shim.addFiles(files); return o.multiple ? paths : paths[0] ?? null; });
  }
  async function saveDialog(o: { defaultPath?: string; filters?: { extensions: string[] }[] }): Promise<string | null> {
    const name = baseOf((o.defaultPath ?? "export").replace(/\\/g, "/")) || "export";
    if ((o.filters ?? []).some(f => f.extensions.includes("simrep"))) { const stem = name.replace(/\.simrep$/i, "").replace(/[/\\]/g, "_"); return `${DIRS.projects}/${stem}/${stem}.simrep`; }
    const target = await saveTarget(name); if (!target) return null; const path = `${DIRS.exports}/${target.name}`; targets.set(path, target); return path;
  }
  async function deliver(path: string, outputs: string[]) {
    const target = targets.get(path) ?? { kind: "download" as const, name: baseOf(path) }; targets.delete(path); await persist(outputs);
    for (const p of outputs) await writeTarget(target, await readBytes(p), baseOf(p));
  }
  async function answer(cmd: string, a: Args, raw: unknown, h: Record<string, string>): Promise<unknown> {
    const store = await storeReady;
    switch (cmd) {
      case "plugin:dialog|message": case "plugin:dialog|ask": case "plugin:dialog|confirm": { const [ok, cancel] = labels(a.buttons); if (!cancel) { window.alert(String(a.message ?? "")); return ok; } return window.confirm(String(a.message ?? "")) ? ok : cancel; }
      case "plugin:path|resolve_directory": return DIRS.files;
      case "plugin:path|join": return join(...a.paths as string[]);
      case "ai_request": throw { code: "unexpected", detail: "unsupported in browser: ai_request" };
      case "path_info": { const out = []; for (const p of a.paths as string[]) { const b = await store.get(p); if (b) out.push({ path: p, name: baseOf(p), size: b.length }); } return out; }
      case "read_file": return buffer(await readBytes(a.path as string));
      case "read_text": { try { return new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(a.path as string)); } catch (error) { if (error instanceof TypeError) throw { code: "badHeader", detail: "file is not valid UTF-8" }; throw error; } }
      case "write_text": await put(a.path as string, new TextEncoder().encode(a.contents as string)); return null;
      case "write_bytes": { const path = decodeURIComponent(h.path ?? ""), target = targets.get(path); if (target) { targets.delete(path); await writeTarget(target, asBytes(raw)); } else await put(path, asBytes(raw)); return null; }
      case "remove_file": await remove(a.path as string); return null;
      case "recovery_path": return DIRS.recovery;
      case "file_sha256": return hash(await readBytes(a.path as string));
      case "project_dir_write": await put(dataPath(decodeURIComponent(h["project-path"] ?? ""), decodeURIComponent(h["rel-path"] ?? "")), asBytes(raw)); return null;
      case "project_dir_read": return buffer(await readBytes(dataPath(a.projectPath as string, a.relPath as string)));
      case "project_dir_list": { const root = dataPath(a.projectPath as string, "", true), dir = dataPath(a.projectPath as string, a.prefix as string ?? "", true); return (await store.list(dir)).filter(e => e.path !== dir).map(e => ({ path: e.path.slice(root.length + 1), size: e.size })); }
      case "project_dir_delete": await remove(dataPath(a.projectPath as string, a.relPath as string)); return null;
      case "create_template": return createTemplate(a.kind as string);
      case "refine_start": return refineStart(a);
      case "export_array": { const request = a.request as { path: string }; const names = await (await backend).invoke(cmd, a) as string[]; await deliver(request.path, names.map(n => join(dirOf(request.path), n))); return names; }
      case "export_trajectories": { const n = await (await backend).invoke(cmd, a); await deliver(a.path as string, [a.path as string]); return n; }
      case "build_geometry": {
        const request = a.request as { path: string; outputDir: string }; await syncDir(dirOf(request.path));
        // Load the old output family before build so the worker's deletion list includes old sidecars.
        if (request.outputDir !== dirOf(request.path)) await syncDir(request.outputDir);
        const b = await backend;
        const result = await b.invoke(cmd, a) as { files: string[] };
        const paths = result.files.map(f => join(request.outputDir, f));
        const removed = await b.invoke("web_deleted_files") as string[];
        await persist(paths, [...removed, ...removed.filter(p => p.endsWith(".cuts.json")).map(p => `${p}.identity.json`)]); return result;
      }
      default: {
        if (cmd.startsWith("plugin:")) return null;
        const req = (a.request ?? {}) as { path?: unknown; source?: { path?: unknown } };
        for (const p of [a.path, req.path, req.source?.path]) if (typeof p === "string") await syncDir(dirOf(p));
        return (await backend).invoke(cmd, a);
      }
    }
  }
  async function createTemplate(kind: string) {
    const b = await backend, store = await storeReady;
    const created = await b.invoke("create_template", { kind }) as { path: string; name: string };
    const bytes = new Uint8Array(await b.invoke("read_file", { path: created.path }) as ArrayBuffer);
    await b.invoke("remove_file", { path: created.path });
    const taken = new Set((await store.keys(`${DIRS.files}/templates`)).map(dirOf));
    let dir = `${DIRS.files}/templates/${kind}`; for (let n = 2; taken.has(dir); n++) dir = `${DIRS.files}/templates/${kind}-${n}`;
    const path = `${dir}/${created.name}`; await put(path, bytes); return { path, name: created.name, size: bytes.length, dir };
  }
  async function refineStart(a: Args) {
    const channel = a.channel as { id: number }; let index = 0, chain = Promise.resolve();
    const send = (message: unknown) => internals.runCallback(channel.id, { index: index++, message });
    return (await backend).invoke("refine_start", { request: a.request, channel: (message: unknown) => {
      chain = chain.then(async () => {
        const m = message as { type?: string; files?: string[]; dir?: string };
        if (m?.type === "done" && m.files && m.dir !== undefined) { try { await persist(m.files.map(f => join(m.dir!, f))); } catch (err) { send({ type: "error", message: `refined, but not stored in the browser: ${String(err)}`, reason: null }); return; } }
        send(message);
      });
    } });
  }
  installDrop(shim); return shim;
}
function installDrop(shim: Shim) {
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const position = (e: DragEvent) => ({ x: e.clientX, y: e.clientY }); let depth = 0;
  window.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); if (depth++ === 0) void emit("tauri://drag-enter", { paths: ["(files)"], position: position(e) }); });
  window.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) void emit("tauri://drag-leave", {}); });
  window.addEventListener("drop", e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0;
    const files = Array.from(e.dataTransfer?.files ?? []); if (!files.length) return void emit("tauri://drag-leave", {});
    void shim.addFiles(files).then(paths => emit("tauri://drag-drop", { paths, position: position(e) })).catch(error => { window.alert(`Import failed: ${String(error)}`); void emit("tauri://drag-leave", {}); });
  });
}
export { download };
