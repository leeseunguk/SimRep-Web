import { beforeEach, describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { invoke } from "@tauri-apps/api/core";
import { importProject } from "./archive";
import { installShim } from "./ipc";
import { manifestStore, memoryStore, type FileStore } from "./storage";
import { MAX_ENTRIES, MAX_FILE_BYTES, readInput } from "./limits";
import { crc32, readZip, writeZip } from "./zip";
import type { WebBackend } from "./web/client";
const enc = new TextEncoder(), dec = new TextDecoder();
const view = { camera: null, projection: "perspective", grid: true };
const project = enc.encode(JSON.stringify({ format: "simrep-project", version: 2, arrays: [], meshes: [], view }));
beforeEach(() => { vi.stubGlobal("window", { addEventListener: vi.fn(), confirm: vi.fn(() => false), alert: vi.fn(), prompt: vi.fn() }); });
function backend() {
  const files = new Map<string, Uint8Array>(); let deleted: string[] = [];
  const b: WebBackend = {
    capabilities: { supportedCommands: [], unsupportedCommands: [], threads: 1, device: "cpu", precision: "f64", geometry: true, flight: true, multicore: false },
    async invoke(cmd, args) {
      const a = args as { path: string; request?: { method: string; outputDir: string } };
      if (cmd === "remove_file") { files.delete(a.path); return null; }
      if (cmd === "read_file") { const bytes = files.get(a.path); if (!bytes) throw new Error("missing"); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
      if (cmd === "web_list_files") return [...files.keys()].map(path => ({ path }));
      if (cmd === "web_deleted_files") return deleted;
      if (cmd === "build_geometry") {
        const dir = a.request!.outputDir; files.set(`${dir}/result.pa#`, enc.encode(a.request!.method)); deleted = [];
        if (a.request!.method === "cutcell") files.set(`${dir}/result.cuts.json`, enc.encode("cuts")); else if (files.delete(`${dir}/result.cuts.json`)) deleted.push(`${dir}/result.cuts.json`);
        return { files: a.request!.method === "cutcell" ? ["result.pa#", "result.cuts.json"] : ["result.pa#"] };
      }
      return null;
    },
    putFiles: async inputs => { for (const f of inputs) files.set(f.path, f.bytes); }, listen: () => () => {}, dispose: () => {},
  };
  return { b, files };
}
function rawStore() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>(); let fail = false;
  const raw: Omit<FileStore, "batch"> = {
    kind: "memory", get: async p => files.get(p) ?? null,
    async put(p, b) { if (fail && p.endsWith("manifest.json")) throw new Error("quota"); files.set(p, new Uint8Array(b)); },
    delete: async p => { files.delete(p); }, keys: async prefix => [...files.keys()].filter(p => p.startsWith(prefix)),
    list: async prefix => [...files].filter(([p]) => p.startsWith(prefix)).map(([path, b]) => ({ path, size: b.length })),
  };
  return { raw, files, setFail: (v: boolean) => { fail = v; } };
}
describe("review archive boundaries", () => {
  for (const path of ["../x", "/absolute", "files/../x", "C:/x", "files\\x", "files//x"]) it(`rejects zip-slip ${path}`, async () => {
    await expect(readZip(await writeZip([{ path, bytes: project }], false))).rejects.toThrow(/unsafe/);
  });
  it("rejects duplicate names and symlinks", async () => {
    await expect(readZip(await writeZip([{ path: "a", bytes: project }, { path: "a", bytes: project }], false))).rejects.toThrow(/duplicate/);
    const z = await writeZip([{ path: "a", bytes: project }], false), v = new DataView(z.buffer), central = v.getUint32(z.length - 6, true);
    v.setUint32(central + 38, 0xa1ff0000, true); await expect(readZip(z)).rejects.toThrow(/symlink/);
  });
  it("rejects too many entries and forged local headers", async () => {
    const z = await writeZip([{ path: "a", bytes: project }], false), v = new DataView(z.buffer); v.setUint16(z.length - 12, MAX_ENTRIES + 1, true); await expect(readZip(z)).rejects.toThrow(/entries/);
    const mismatch = await writeZip([{ path: "a", bytes: project }], false); new DataView(mismatch.buffer).setUint32(22, 1, true); await expect(readZip(mismatch)).rejects.toThrow(/local header/);
  });
  it("aborts a real zip bomb even when both size headers lie", async () => {
    const data = new Uint8Array(16 * 1024 * 1024), compressed = deflateRawSync(data);
    const stored = await writeZip([{ path: "a", bytes: compressed }], false), v = new DataView(stored.buffer), central = v.getUint32(stored.length - 6, true);
    v.setUint16(8, 8, true); v.setUint16(central + 10, 8, true); v.setUint32(14, crc32(data), true); v.setUint32(central + 16, crc32(data), true); v.setUint32(22, 1, true); v.setUint32(central + 24, 1, true); await expect(readZip(stored)).rejects.toThrow(/expansion budget/);
  });
  it("checks File.size before reading", async () => {
    const arrayBuffer = vi.fn(); await expect(readInput({ size: MAX_FILE_BYTES + 1, name: "large", arrayBuffer } as unknown as File)).rejects.toThrow(/limit/); expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("isolates project imports and rewrites resource references", async () => {
    const store = memoryStore(); await store.put("/projects/a/a.simrep", enc.encode("original")); await store.put("/files/x/a.stl", enc.encode("original geometry"));
    const doc = enc.encode(JSON.stringify({ format: "simrep-project", version: 2, arrays: [], meshes: [{ file: { path: "../../files/x/a.stl", absolute: "/files/x/a.stl" }, visible: true, units: "mm" }], view }));
    const path = await importProject(await writeZip([{ path: "projects/a/a.simrep", bytes: doc }, { path: "files/x/a.stl", bytes: enc.encode("imported") }]), store);
    expect(path).toBe("/projects/a-imported/a-imported.simrep"); expect(dec.decode((await store.get("/projects/a/a.simrep"))!)).toBe("original"); expect(dec.decode((await store.get("/files/x/a.stl"))!)).toBe("original geometry"); expect(JSON.parse(dec.decode((await store.get(path))!)).meshes[0].file.absolute).toBe("/projects/a-imported/resources/files/x/a.stl");
  });
  for (const invalid of ["not JSON", JSON.stringify({ format: "simrep-project", version: 2, arrays: [], meshes: [] })]) it("rejects an invalid project before any write", async () => {
    const store = memoryStore(); await store.put("/projects/victim/victim.simrep", enc.encode("original")); await expect(importProject(await writeZip([{ path: "projects/victim/victim.simrep", bytes: enc.encode(invalid) }]), store)).rejects.toThrow(); expect(await store.keys("")).toEqual(["/projects/victim/victim.simrep"]);
  });
});
describe("authoritative persistent manifest and IPC", () => {
  it("rolls back a failed family and reloads only the committed manifest", async () => {
    const { raw, files, setFail } = rawStore(), store = manifestStore(raw); await store.put("/a", enc.encode("old")); setFail(true); await expect(store.batch([{ path: "/a", bytes: enc.encode("new") }, { path: "/b", bytes: enc.encode("partial") }])).rejects.toThrow(/quota/);
    setFail(false); files.set("/.storage/data/orphan", enc.encode("orphan")); const reloaded = manifestStore(raw); expect(await reloaded.keys("")).toEqual(["/a"]); expect(dec.decode((await reloaded.get("/a"))!)).toBe("old");
  });
  it("registers nested companions, rejects UTF-8, and deletes from both stores", async () => {
    const store = memoryStore(), { b, files } = backend(); installShim(Promise.resolve(b), Promise.resolve(store)); await store.put("/files/job/main.gem", enc.encode("include")); await store.put("/files/job/parts/a.gem", enc.encode("shape")); await invoke("inspect_geometry", { request: { path: "/files/job/main.gem" } }); expect(files.has("/files/job/parts/a.gem")).toBe(true);
    await store.put("/files/bad", new Uint8Array([255])); await expect(invoke("read_text", { path: "/files/bad" })).rejects.toMatchObject({ code: "badHeader" }); await invoke("remove_file", { path: "/files/job/main.gem" }); expect(files.has("/files/job/main.gem")).toBe(false); await expect(invoke("read_file", { path: "/files/job/main.gem" })).rejects.toMatchObject({ code: "notFound" });
  });
  it("removes cut-cell sidecars on an aligned rebuild and never resurrects them on reload", async () => {
    const store = memoryStore(), first = backend(); installShim(Promise.resolve(first.b), Promise.resolve(store)); await store.put("/files/job/a.gem", enc.encode("gem")); const request = { path: "/files/job/a.gem", outputDir: "/files/job", method: "cutcell" };
    await invoke("build_geometry", { request }); expect(await store.get("/files/job/result.cuts.json.identity.json")).not.toBeNull(); await invoke("build_geometry", { request: { ...request, method: "aligned" } }); expect(await store.get("/files/job/result.cuts.json")).toBeNull();
    const second = backend(); installShim(Promise.resolve(second.b), Promise.resolve(store)); await invoke("open_pa", { id: "reload", path: "/files/job/result.pa#" }); expect(second.files.has("/files/job/result.cuts.json")).toBe(false);
  });
  it("ignores a cuts sidecar after PA bytes change", async () => {
    const store = memoryStore(), { b, files } = backend(); installShim(Promise.resolve(b), Promise.resolve(store)); await store.put("/files/job/a.gem", enc.encode("gem")); await invoke("build_geometry", { request: { path: "/files/job/a.gem", outputDir: "/files/job", method: "cutcell" } }); await store.put("/files/job/result.pa#", enc.encode("different PA"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}); await invoke("open_pa", { id: "changed", path: "/files/job/result.pa#" }); expect(files.has("/files/job/result.cuts.json")).toBe(false); expect(warning).toHaveBeenCalled(); warning.mockRestore();
  });
});
