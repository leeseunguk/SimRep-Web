import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = path.join(root, "evidence/desktop-commands");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
await mkdir(evidence, { recursive: true });
const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0 } });
const browser = await chromium.launch({ headless: true });
let report = { verdict: "FAIL" };
try {
  await server.listen();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/desktop-worker.ts`);
  console.log("Chromium module-worker surface: build_geometry(sidecar:false) -> open_pa -> refine_targets -> refine_pa -> read_file; exact invocations recorded in desktop-cache.json");
  report = await page.evaluate(async () => {
    const worker = new Worker("/tests/desktop-worker.ts", { type: "module" });
    const pending = new Map(); let next = 0; const invocations = [];
    await new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message));
      worker.onmessage = ({ data }) => {
        if (data.ready) return resolve();
        const call = pending.get(data.id); pending.delete(data.id);
        if (data.error) call.reject(new Error(data.error)); else call.resolve(data.value);
      };
    });
    const invoke = (command, args = {}) => {
      invocations.push({ command, args });
      console.log(`invoke ${command} ${JSON.stringify(args)}`);
      return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ id, command, args }); });
    };
    const contents = "pa_define(17,9,1,planar)\ne(1){fill{within{box(0,0,1.3,8)}}}\ne(2){fill{within{box(14.7,0,16,8)}}}";
    await invoke("write_text", { path: "cache.gem", contents });
    const base = { path: "cache.gem", units: null, repair: false, method: "cutcell", parts: [{ index: 0, number: 1, voltage: 0 }, { index: 1, number: 2, voltage: 60 }], dims: [17, 9, 1], spacing: [1, 1, 1], origin: [0, 0, 0], outputDir: "cache" };
    const results = [];
    for (const sidecar of [true, false]) {
      const request = { ...base, stem: `sidecar-${sidecar}`, sidecar };
      const built = await invoke("build_geometry", { request });
      await invoke("open_pa", { id: "cache", path: built.paHash });
      const targets = await invoke("refine_targets", { id: "cache" });
      const refined = await invoke("refine_pa", { id: "cache" });
      const bytes = [...await invoke("read_file", { path: `cache/sidecar-${sidecar}.pa0` })];
      results.push({ sidecar, built, targets, refined, bytes });
    }
    await invoke("build_geometry", { request: { ...base, stem: "sidecar-false", sidecar: false, method: "aligned" } });
    await invoke("open_pa", { id: "rebuilt", path: "cache/sidecar-false.pa#" });
    const rebuilt = await invoke("refine_targets", { id: "rebuilt" });
    worker.terminate();
    return { invocations, results, rebuilt };
  });
  assert.ok(report.results.every((r) => r.targets.cutcell && r.refined.cutcell && r.refined.converged));
  assert.deepEqual(report.results[0].bytes, report.results[1].bytes);
  assert.deepEqual(report.results[1].built.files, ["sidecar-false.pa#"]);
  assert.ok(!report.results[1].refined.output_paths.some((p) => p.endsWith(".cuts.json")));
  assert.equal(report.rebuilt.cutcell, false);
  report.verdict = "PASS";
} catch (error) {
  report.error = String(error); throw error;
} finally {
  await browser.close(); await server.close();
  await writeFile(path.join(evidence, "desktop-cache.json"), JSON.stringify(report, null, 2));
}
console.log("PASS: sidecar-free exact solve matches sidecar solve; aligned rebuild removes cached exact geometry");
