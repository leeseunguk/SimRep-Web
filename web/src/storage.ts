import { checkFileSize } from "./limits";
export type StorageKind = "opfs" | "indexeddb" | "memory";
export interface FileStore {
  kind: StorageKind;
  get(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<{ path: string; size: number }[]>;
  keys(prefix: string): Promise<string[]>;
  batch(changes: { path: string; bytes: Uint8Array | null }[]): Promise<void>;
}
type RawStore = Omit<FileStore, "batch">;
const under = (p: string, prefix: string) => prefix === "" || p === prefix || p.startsWith(`${prefix.replace(/\/$/, "")}/`);
const copy = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const MANIFEST = "/.storage/manifest.json";
interface Stored { key: string; size: number }
/** Immutable objects plus one atomically replaced manifest are the sole source of truth on reload. */
export function manifestStore(raw: RawStore): FileStore {
  const ready = (async () => {
    const bytes = await raw.get(MANIFEST);
    if (bytes) return new Map<string, Stored>(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as [string, Stored][]);
    const entries = (await raw.list("")).filter(e => !e.path.startsWith("/.storage/"));
    return new Map(entries.map(e => [e.path, { key: e.path, size: e.size }]));
  })();
  let serial = Promise.resolve();
  const store: FileStore = {
    kind: raw.kind,
    async get(p) { await serial; const e = (await ready).get(p); return e ? raw.get(e.key) : null; },
    async keys(prefix) { await serial; return [...(await ready).keys()].filter(p => under(p, prefix)).sort(); },
    async list(prefix) { await serial; return [...(await ready)].filter(([p]) => under(p, prefix)).map(([path, e]) => ({ path, size: e.size })).sort((a, b) => a.path.localeCompare(b.path)); },
    put: (path, bytes) => store.batch([{ path, bytes }]),
    async delete(p) { await store.batch((await store.keys(p)).map(path => ({ path, bytes: null }))); },
    batch(changes) {
      const run = serial.then(async () => {
        const manifest = await ready, next = new Map(manifest), staged: string[] = [];
        for (const c of changes) if (c.bytes) checkFileSize(c.bytes.length, c.path);
        try {
          for (const c of changes) {
            if (c.bytes === null) { next.delete(c.path); continue; }
            const key = `/.storage/data/${crypto.randomUUID()}`;
            staged.push(key); await raw.put(key, c.bytes); next.set(c.path, { key, size: c.bytes.length });
          }
          await raw.put(MANIFEST, new TextEncoder().encode(JSON.stringify([...next])));
        } catch (error) {
          for (const key of staged) await raw.delete(key);
          throw error;
        }
        const retained = new Set([...next.values()].map(e => e.key));
        const obsolete = [...manifest.values()].filter(e => !retained.has(e.key));
        manifest.clear(); for (const [p, e] of next) manifest.set(p, e);
        for (const e of obsolete) { try { await raw.delete(e.key); } catch (error) { console.warn("Storage garbage collection failed", error); } }
      });
      serial = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return store;
}
export function memoryStore(): FileStore {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  return manifestStore({
    kind: "memory", get: async p => files.has(p) ? copy(files.get(p)!) : null,
    put: async (p, b) => { files.set(p, copy(b)); },
    delete: async p => { for (const k of files.keys()) if (under(k, p)) files.delete(k); },
    list: async prefix => [...files].filter(([p]) => under(p, prefix)).map(([path, b]) => ({ path, size: b.length })),
    keys: async prefix => [...files.keys()].filter(p => under(p, prefix)).sort(),
  });
}
async function opfsStore(): Promise<FileStore> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("simrep-web", { create: true });
  const name = (p: string) => encodeURIComponent(p);
  const entries = async () => {
    const out: { path: string; handle: FileSystemFileHandle }[] = [];
    for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries())
      if (h.kind === "file") out.push({ path: decodeURIComponent(n), handle: h as FileSystemFileHandle });
    return out;
  };
  const raw: RawStore = {
    kind: "opfs",
    async get(p) {
      try { const f = await (await dir.getFileHandle(name(p))).getFile(); checkFileSize(f.size, p); return new Uint8Array(await f.arrayBuffer()); }
      catch (e) { if ((e as DOMException)?.name === "NotFoundError") return null; throw e; }
    },
    async put(p, b) { const w = await (await dir.getFileHandle(name(p), { create: true })).createWritable(); await w.write(copy(b)); await w.close(); },
    async delete(p) { for (const e of await entries()) if (under(e.path, p)) await dir.removeEntry(name(e.path)); },
    async list(prefix) { const out = []; for (const e of await entries()) if (under(e.path, prefix)) out.push({ path: e.path, size: (await e.handle.getFile()).size }); return out; },
    keys: async prefix => (await entries()).map(e => e.path).filter(p => under(p, prefix)).sort(),
  };
  await raw.put("/.storage/probe", new Uint8Array([1])); await raw.delete("/.storage/probe");
  return manifestStore(raw);
}
async function idbStore(): Promise<FileStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("simrep-web", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);
  });
  const run = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => new Promise((resolve, reject) => {
    const tx = db.transaction("files", mode), r = fn(tx.objectStore("files"));
    tx.oncomplete = () => resolve((r ? r.result : undefined) as T); tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const all = async () => (await run<IDBValidKey[]>("readonly", s => s.getAllKeys())).filter((k): k is string => typeof k === "string");
  return manifestStore({
    kind: "indexeddb", get: async p => { const b = await run<Uint8Array | undefined>("readonly", s => s.get(p)); return b ? copy(b) : null; },
    put: (p, b) => run("readwrite", s => { s.put(copy(b), p); }),
    async delete(p) { const keys = (await all()).filter(k => under(k, p)); await run("readwrite", s => { keys.forEach(k => s.delete(k)); }); },
    keys: async prefix => (await all()).filter(k => under(k, prefix)).sort(),
    async list(prefix) { const out = []; for (const p of await all()) if (under(p, prefix)) { const b = await run<Uint8Array>("readonly", s => s.get(p)); out.push({ path: p, size: b.length }); } return out; },
  });
}
export async function openStore(): Promise<FileStore> {
  try { if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") return await opfsStore(); } catch (error) { console.warn("OPFS unavailable", error); }
  try { if (typeof indexedDB !== "undefined") return await idbStore(); } catch (error) { console.warn("IndexedDB unavailable", error); }
  return memoryStore();
}
