/**
 * Browser file store for SimRep-Web: the virtual folders the UI sees as paths (`/files/...` for
 * opened and computed arrays, `/projects/...` for saved projects and their `X.simrep.d/` data,
 * `/recovery/...` for the autosave). Origin Private File System (OPFS) first; IndexedDB when OPFS
 * cannot write (Safari before 26 has no `createWritable` on the main thread, private windows refuse
 * OPFS); memory as the last resort, which lasts only until the tab closes.
 */

export type StorageKind = "opfs" | "indexeddb" | "memory";

export interface FileStore {
  kind: StorageKind;
  get(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  /** Removes `path` and everything below `path/`. */
  delete(path: string): Promise<void>;
  /** Every file at or below folder `prefix` (no trailing slash), sorted by path. */
  list(prefix: string): Promise<{ path: string; size: number }[]>;
  /** Paths at or below folder `prefix`, without reading their bytes. */
  keys(prefix: string): Promise<string[]>;
}

const under = (path: string, prefix: string) => prefix === "" || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
const sorted = <T extends { path: string }>(list: T[]) => list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const copy = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

export function memoryStore(): FileStore {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    kind: "memory",
    get: async (p) => (files.has(p) ? copy(files.get(p)!) : null),
    put: async (p, b) => void files.set(p, copy(b)),
    delete: async (p) => {
      for (const k of [...files.keys()]) if (under(k, p)) files.delete(k);
    },
    list: async (prefix) => sorted([...files].filter(([k]) => under(k, prefix)).map(([path, b]) => ({ path, size: b.length }))),
    keys: async (prefix) => [...files.keys()].filter((k) => under(k, prefix)).sort(),
  };
}

/** OPFS: one flat folder, file names are the encoded virtual paths (no nested-folder bookkeeping). */
async function opfsStore(): Promise<FileStore> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("simrep-web", { create: true });
  const name = (p: string) => encodeURIComponent(p);
  const entries = async () => {
    const out: { path: string; handle: FileSystemFileHandle }[] = [];
    for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries())
      if (h.kind === "file") out.push({ path: decodeURIComponent(n), handle: h as FileSystemFileHandle });
    return out;
  };
  const store: FileStore = {
    kind: "opfs",
    async get(p) {
      try {
        const f = await (await dir.getFileHandle(name(p))).getFile();
        return new Uint8Array(await f.arrayBuffer());
      } catch (err) {
        if ((err as DOMException)?.name === "NotFoundError") return null;
        throw err;
      }
    },
    async put(p, b) {
      const w = await (await dir.getFileHandle(name(p), { create: true })).createWritable();
      await w.write(copy(b));
      await w.close();
    },
    async delete(p) {
      for (const e of await entries()) if (under(e.path, p)) await dir.removeEntry(name(e.path));
    },
    async list(prefix) {
      const out: { path: string; size: number }[] = [];
      for (const e of await entries()) if (under(e.path, prefix)) out.push({ path: e.path, size: (await e.handle.getFile()).size });
      return sorted(out);
    },
    keys: async (prefix) => (await entries()).map((e) => e.path).filter((k) => under(k, prefix)).sort(),
  };
  // Probe: a store that cannot write must not be chosen (Safari < 26, private windows).
  const probe = "/.probe";
  await store.put(probe, new Uint8Array([1]));
  if ((await store.get(probe))?.[0] !== 1) throw new Error("OPFS read-back failed");
  await store.delete(probe);
  return store;
}

function idbStore(): Promise<FileStore> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("simrep-web", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const run = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> =>
        new Promise((res, rej) => {
          const tx = db.transaction("files", mode);
          const r = fn(tx.objectStore("files"));
          tx.oncomplete = () => res((r ? r.result : undefined) as T);
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        });
      const all = () => run<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
      const store: FileStore = {
        kind: "indexeddb",
        get: async (p) => {
          const v = await run<Uint8Array | undefined>("readonly", (s) => s.get(p));
          return v ? copy(v) : null;
        },
        put: (p, b) => run("readwrite", (s) => void s.put(copy(b), p)),
        delete: async (p) => {
          const keys = (await all()).filter((k) => typeof k === "string" && under(k, p));
          await run("readwrite", (s) => void keys.forEach((k) => s.delete(k)));
        },
        list: async (prefix) => {
          const out: { path: string; size: number }[] = [];
          for (const k of await all()) {
            if (typeof k !== "string" || !under(k, prefix)) continue;
            const v = await run<Uint8Array | undefined>("readonly", (s) => s.get(k));
            out.push({ path: k, size: v?.length ?? 0 });
          }
          return sorted(out);
        },
        keys: async (prefix) => (await all()).filter((k): k is string => typeof k === "string" && under(k, prefix)).sort(),
      };
      resolve(store);
    };
  });
}

/** The best store this browser offers (see the module comment). */
export async function openStore(): Promise<FileStore> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") return await opfsStore();
  } catch {
    // OPFS present but unusable here: IndexedDB next.
  }
  try {
    if (typeof indexedDB !== "undefined") return await idbStore();
  } catch {
    // No IndexedDB either (rare): keep files for this tab only.
  }
  return memoryStore();
}
