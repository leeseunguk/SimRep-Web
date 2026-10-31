import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), output = path.join(root, "evidence/review-fixes");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
await mkdir(output, { recursive: true });
console.log("Surface: Chromium production installShim + real serial wasm worker + manifest memory store. Invocation: node tests/review-browser.mjs");
const server = await createServer({ root: path.join(root, "web"), configFile: false, resolve: { preserveSymlinks: true }, optimizeDeps: { noDiscovery: true }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "review-gate", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Review regression gate</title>"); }); } }] });
const browser = await chromium.launch({ headless: true }); let report = { verdict: "FAIL" }; const warnings = [];
try {
  await server.listen(); const page = await browser.newPage(); page.on("console", m => { if (m.type() === "warning") warnings.push(m.text()); }); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  report = await page.evaluate(async () => {
    const { createWebBackend } = await import("/src/web/client.ts"), { installShim } = await import("/src/ipc.ts"), { memoryStore } = await import("/src/storage.ts"), { writeZip } = await import("/src/zip.ts"), { Channel } = await import("/node_modules/@tauri-apps/api/core.js");
    const store = memoryStore(), calls = [], checks = []; let b = await createWebBackend({ threads: 1 }); installShim(Promise.resolve(b), Promise.resolve(store));
    const invoke = async (command, args) => { calls.push({ command, args }); return window.__TAURI_INTERNALS__.invoke(command, args); };
    const check = (value, criterion) => { if (!value) throw new Error(criterion); checks.push(criterion); }; const text = new TextEncoder();
    async function refine(id, outputDir) {
      const channel = new Channel(); let timer;
      const terminal = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("refinement did not reach a terminal")), 20_000);
        channel.onmessage = message => { if (message?.type === "done") resolve(message); else if (message?.type === "error" || message?.type === "cancelled") reject(new Error(JSON.stringify(message))); };
      });
      try {
        await invoke("refine_start", { request: { id, outputDir, device: "cpu", tolerance: 1e-10, maxCycles: 200, voltages: [[1, 0], [2, 60]] }, channel });
        const done = await terminal, files = [];
        for (const name of done.files) files.push({ name, bytes: [...await store.get(`${outputDir}/${name}`)] });
        return files;
      } finally { clearTimeout(timer); }
    }
    try {
      const path = "/files/cache/a.gem"; await store.put(path, text.encode("pa_define(17,9,1,planar)\ne(1){fill{within{box(0,0,1.3,8)}}}\ne(2){fill{within{box(14.7,0,16,8)}}}"));
      const request = { path, units: null, repair: false, method: "cutcell", parts: [{ index: 0, number: 1, voltage: 0 }, { index: 1, number: 2, voltage: 60 }], dims: [17, 9, 1], spacing: [1, 1, 1], origin: [0, 0, 0], outputDir: "/files/cache", stem: "result", sidecar: true };
      await invoke("build_geometry", { request }); check(!!await store.get("/files/cache/result.cuts.json"), "H3 cut-cell sidecar persisted");
      await invoke("build_geometry", { request: { ...request, method: "aligned", sidecar: false } }); await invoke("open_pa", { id: "before", path: "/files/cache/result.pa#" }); const before = await invoke("refine_targets", { id: "before" });
      check(!before.cutcell && await store.get("/files/cache/result.cuts.json") === null, "H3 aligned rebuild removes persisted cuts");
      const refinedBefore = await refine("before", "/exports/before");
      b.dispose(); b = await createWebBackend({ threads: 1 }); const shim = installShim(Promise.resolve(b), Promise.resolve(store));
      await invoke("open_pa", { id: "after", path: "/files/cache/result.pa#" }); const after = await invoke("refine_targets", { id: "after" }); check(!after.cutcell, "H3 reload retains aligned physics");
      const refinedAfter = await refine("after", "/exports/after");
      check(JSON.stringify(refinedBefore) === JSON.stringify(refinedAfter), "H3 aligned PA0 and bases remain byte-identical after backend recreation");
      await invoke("build_geometry", { request }); const changed = await store.get("/files/cache/result.pa#"); changed[changed.length - 8] ^= 1; await store.put("/files/cache/result.pa#", changed);
      await invoke("open_pa", { id: "mismatch", path: "/files/cache/result.pa#" }); check(!(await invoke("refine_targets", { id: "mismatch" })).cutcell, "H3 PA hash mismatch ignores stale cuts");
      await invoke("remove_file", { path: "/files/cache/result.pa#" }); let deleted = false; try { await invoke("read_file", { path: "/files/cache/result.pa#" }); } catch { deleted = true; } check(deleted, "H3 deleted worker bytes cannot resurrect");
      const buffer = new Uint8Array(72); new Float32Array(buffer.buffer, 0, 12).set([0,0,0,1,0,0,0,1,0,0,0,1]); new Uint16Array(buffer.buffer, 48, 12).set([0,2,1,0,1,3,0,3,2,1,2,3]);
      const gltf = { asset: { version: "2.0" }, buffers: [{ uri: "parts/tetra.bin", byteLength: 72 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }], accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0,0,0], max: [1,1,1] }, { bufferView: 1, componentType: 5123, count: 12, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
      const imported = await shim.importArchive(await writeZip([
        { path: "projects/nested/nested.simrep", bytes: text.encode(JSON.stringify({ format: "simrep-project", version: 2, arrays: [], meshes: [], view: { camera: null, projection: "perspective", grid: true } })) },
        { path: "files/job/main.gem", bytes: text.encode('pa_define(17,9,1,planar)\ninclude("parts/shape.gem")') }, { path: "files/job/parts/shape.gem", bytes: text.encode("e(1){fill{within{box(0,0,1,8)}}}") },
        { path: "files/gltf/main.gltf", bytes: text.encode(JSON.stringify(gltf)) }, { path: "files/gltf/parts/tetra.bin", bytes: buffer },
      ]));
      const resources = imported.slice(0, imported.lastIndexOf("/")) + "/resources/files";
      for (const [file, criterion] of [["job/main.gem", "M1 nested archive GEM include reaches actual worker"], ["gltf/main.gltf", "M1 nested archive glTF buffer reaches actual worker"]]) { const inspected = await invoke("inspect_geometry", { request: { path: `${resources}/${file}`, units: null, repair: false } }); check(inspected.byteLength > 8, criterion); }
      await store.put("/files/bad/data.txt", new Uint8Array([255])); let utf = false; try { await invoke("read_text", { path: "/files/bad/data.txt" }); } catch (e) { utf = e.code === "badHeader"; } check(utf, "M2 shim rejects invalid UTF-8 with badHeader");
      await store.put("/files/large/a.gem", text.encode("pa_define(7000,6000,1,planar)")); let grid = false; try { await invoke("inspect_geometry", { request: { path: "/files/large/a.gem", units: null, repair: false } }); } catch (e) { grid = JSON.stringify(e).includes("40000000"); } check(grid, "H4 just-over-cap GEM inspection rejected before rasterization");
      let particles = false; try { await b.putFiles([{ path: "large.fly2", bytes: text.encode("particles {standard_beam {n=1000001}}") }]); } catch (e) { particles = String(e).includes("1000000"); } check(particles, "H4 FLY2 expansion rejected at registry boundary");
      return { verdict: "PASS", calls, checks, before, after, refinedBefore, refinedAfter, keys: await store.keys("") };
    } finally { b.dispose(); }
  });
  assert.equal(report.verdict, "PASS"); assert.ok(warnings.some(w => w.includes("mismatched PA identity")));
  report.refinementFiles = [];
  assert.equal(report.refinedBefore.length, 3); assert.equal(report.refinedAfter.length, 3);
  for (let i = 0; i < report.refinedBefore.length; i++) {
    const before = report.refinedBefore[i], after = report.refinedAfter[i]; assert.equal(before.name, after.name);
    const bytes = Buffer.from(before.bytes); assert.deepEqual(bytes, Buffer.from(after.bytes));
    const left = path.join(output, `before-${before.name}`), right = path.join(output, `after-${after.name}`);
    await writeFile(left, bytes); await writeFile(right, Buffer.from(after.bytes)); report.refinementFiles.push({ before: left, after: right, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  delete report.refinedBefore; delete report.refinedAfter;
} catch (error) { report = { ...report, verdict: "FAIL", error: String(error) }; process.exitCode = 1; }
finally { await browser.close(); await server.close(); await writeFile(path.join(output, "production-shim.json"), JSON.stringify({ ...report, warnings }, null, 2)); }
console.log(JSON.stringify(report, null, 2));
