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
  transaction?<T>(operation: (store: FileStore) => Promise<T>): Promise<T>;
}
type RawStore = Omit<FileStore, "batch" | "transaction"> & {
  publish?(path: string, bytes: Uint8Array, owner?: string): Promise<void>;
};
const under = (p: string, prefix: string) => prefix === "" || p === prefix || p.startsWith(`${prefix.replace(/\/$/, "")}/`);
const copy = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const MANIFEST = "/.storage/manifest.json";
const LEASE = "/.storage/lease";
const LOCK = "simrep-web:store";
const LEASE_MS = 30_000;
interface Stored { key: string; size: number }
interface Lease { owner: string; expires: number }
type Guard = (() => Promise<void>) & { owner?: string };
const localQueues = new WeakMap<object, Promise<unknown>>();
function localLock<T>(key: object, operation: () => Promise<T>): Promise<T> {
  const run = (localQueues.get(key) ?? Promise.resolve()).then(operation);
  localQueues.set(key, run.catch(() => {}));
  return run;
}
let database: Promise<IDBDatabase> | undefined;
function fileDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("simrep-web", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Conditional acquisition and renewal are atomic across tabs. */
async function leaseRecord(owner: string, action: "acquire" | "renew" | "release"): Promise<boolean> {
  const db = await fileDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite"), store = tx.objectStore("files");
    const req = store.get(LEASE); let owned = false;
    req.onsuccess = () => {
      const lease = req.result as Lease | undefined, now = Date.now();
      owned = action === "acquire" ? !lease || lease.expires <= now : lease?.owner === owner && lease.expires > now;
      if (owned) {
        if (action === "release") store.delete(LEASE);
        else store.put({ owner, expires: now + LEASE_MS } satisfies Lease, LEASE);
      }
    };
    tx.oncomplete = () => resolve(owned);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
async function leaseLock<T>(operation: (guard: Guard) => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`${LOCK}:lease`);
  try {
    while (true) {
      // Subscribe before acquisition so a release cannot be missed. The deadline
      // also recovers a crashed tab, or browsers without BroadcastChannel.
      let wake!: () => void;
      const released = new Promise<void>(resolve => { wake = resolve; });
      const listener = () => wake();
      channel?.addEventListener("message", listener);
      const deadline = setTimeout(wake, LEASE_MS);
      try {
        if (await leaseRecord(owner, "acquire")) break;
        await released;
      } finally {
        clearTimeout(deadline); channel?.removeEventListener("message", listener);
      }
    }
    let lost = false;
    const guard: Guard = async () => {
      if (lost || !await leaseRecord(owner, "renew")) {
        lost = true; throw new Error("Storage lock lease expired; retry the operation");
      }
    };
    guard.owner = owner;
    const renewal = setInterval(() => { void guard().catch(() => { lost = true; }); }, LEASE_MS / 3);
    try { return await operation(guard); }
    finally { clearInterval(renewal); await leaseRecord(owner, "release"); channel?.postMessage("released"); }
  } finally { channel?.close(); }
}
async function sharedLock<T>(raw: RawStore, operation: (guard: Guard) => Promise<T>): Promise<T> {
  if (raw.kind === "memory") return localLock(raw, () => operation(async () => {}));
  if (navigator.locks) return await navigator.locks.request(LOCK, { mode: "exclusive" }, () => operation(async () => {}));
  return leaseLock(operation);
}
/** All namespace reads, publication, and collection run under the same store lock. */
export function manifestStore(raw: RawStore): FileStore {
  const load = async () => {
    const bytes = await raw.get(MANIFEST);
    if (bytes) return new Map<string, Stored>(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as [string, Stored][]);
    const entries = (await raw.list("")).filter(e => !e.path.startsWith("/.storage/"));
    return new Map(entries.map(e => [e.path, { key: e.path, size: e.size }]));
  };
  const notify = () => {
    if (raw.kind === "memory" || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(LOCK);
    channel.postMessage("published"); channel.close();
    window.dispatchEvent(new Event("simrep-storage-change"));
  };
  const transaction = <T,>(operation: (store: FileStore) => Promise<T>) => sharedLock(raw, async guard => {
    // Never keep a tab-local manifest snapshot between transactions.
    const manifest = await load();
    const scoped: FileStore = {
      kind: raw.kind,
      async get(p) { const e = manifest.get(p); return e ? raw.get(e.key) : null; },
      async keys(prefix) { return [...manifest.keys()].filter(p => under(p, prefix)).sort(); },
      async list(prefix) { return [...manifest].filter(([p]) => under(p, prefix)).map(([path, e]) => ({ path, size: e.size })).sort((a, b) => a.path.localeCompare(b.path)); },
      put: (path, bytes) => scoped.batch([{ path, bytes }]),
      async delete(p) { await scoped.batch((await scoped.keys(p)).map(path => ({ path, bytes: null }))); },
      transaction: operation => operation(scoped),
      async batch(changes) {
        const next = new Map(manifest), staged: string[] = [];
        for (const c of changes) if (c.bytes) checkFileSize(c.bytes.length, c.path);
        try {
          for (const c of changes) {
            if (c.bytes === null) { next.delete(c.path); continue; }
            const key = `/.storage/data/${crypto.randomUUID()}`;
            staged.push(key); await raw.put(key, c.bytes); next.set(c.path, { key, size: c.bytes.length });
          }
          await guard();
          const bytes = new TextEncoder().encode(JSON.stringify([...next]));
          if (raw.publish) await raw.publish(MANIFEST, bytes, guard.owner);
          else await raw.put(MANIFEST, bytes);
        } catch (error) {
          for (const key of staged) await raw.delete(key);
          throw error;
        }
        const retained = new Set([...next.values()].map(e => e.key));
        const obsolete = [...manifest.values()].filter(e => !retained.has(e.key));
        manifest.clear(); for (const [p, e] of next) manifest.set(p, e);
        for (const e of obsolete) {
          try { await raw.delete(e.key); }
          catch (error) { console.warn("Storage garbage collection failed", error); }
        }
        notify();
      },
    };
    return operation(scoped);
  });
  return {
    kind: raw.kind, transaction,
    get: p => transaction(s => s.get(p)), keys: p => transaction(s => s.keys(p)), list: p => transaction(s => s.list(p)),
    put: (p, b) => transaction(s => s.put(p, b)), delete: p => transaction(s => s.delete(p)), batch: changes => transaction(s => s.batch(changes)),
  };
}
/** Compound operations must use the scoped store, never reacquire the outer lock. */
export function storeTransaction<T>(store: FileStore, operation: (store: FileStore) => Promise<T>): Promise<T> {
  if (!store.transaction) throw new Error("Store does not support transactions");
  return store.transaction(operation);
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
  const probe = `/.storage/probe-${crypto.randomUUID()}`;
  await raw.put(probe, new Uint8Array([1])); await raw.delete(probe);
  return manifestStore(raw);
}
async function idbStore(): Promise<FileStore> {
  const db = await fileDatabase();
  const run = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => new Promise((resolve, reject) => {
    const tx = db.transaction("files", mode), r = fn(tx.objectStore("files"));
    tx.oncomplete = () => resolve((r ? r.result : undefined) as T); tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const all = async () => (await run<IDBValidKey[]>("readonly", s => s.getAllKeys())).filter((k): k is string => typeof k === "string" && k !== LEASE);
  return manifestStore({
    kind: "indexeddb", get: async p => { const b = await run<Uint8Array | undefined>("readonly", s => s.get(p)); return b ? copy(b) : null; },
    put: (p, b) => run("readwrite", s => { s.put(copy(b), p); }),
    publish: (p, b, owner) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite"), store = tx.objectStore("files");
      if (owner) {
        const req = store.get(LEASE);
        req.onsuccess = () => {
          const lease = req.result as Lease | undefined;
          if (lease?.owner !== owner || lease.expires <= Date.now()) {
            reject(new Error("Storage lock lease expired; retry the operation")); tx.abort();
          } else store.put(copy(b), p);
        };
      } else store.put(copy(b), p);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    }),
    async delete(p) { const keys = (await all()).filter(k => under(k, p)); await run("readwrite", s => { keys.forEach(k => s.delete(k)); }); },
    keys: async prefix => (await all()).filter(k => under(k, prefix)).sort(),
    async list(prefix) { const out = []; for (const p of await all()) if (under(p, prefix)) { const b = await run<Uint8Array>("readonly", s => s.get(p)); out.push({ path: p, size: b.length }); } return out; },
  });
}
export async function openStore(): Promise<FileStore> {
  // Lease fencing must share an IDB transaction with manifest publication. OPFS
  // is therefore selected only when the browser supplies non-expiring Web Locks.
  try { if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.storage?.getDirectory === "function") return await opfsStore(); } catch (error) { console.warn("OPFS unavailable", error); }
  try { if (typeof indexedDB !== "undefined") return await idbStore(); } catch (error) { console.warn("IndexedDB unavailable", error); }
  return memoryStore();
}
