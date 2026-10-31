// Production-worker gate, separate from the adapter's identity tests.
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
const server = await createServer({ root: path.join(root, "web"), configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "desktop-integration", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Production desktop registration gate</title>"); }); } }] });
const browser = await chromium.launch({ headless: true });
let report = { verdict: "FAIL" };
try {
  await server.listen();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  console.log("Production Chromium worker surface: createWebBackend({threads:1}); capabilities; invoke('create_template',{kind:'einzel'})");
  report = await page.evaluate(async () => {
    const { createWebBackend } = await import("/src/web/client.ts");
    const backend = await createWebBackend({ threads: 1 });
    const required = ["open_iob", "inspect_geometry", "build_geometry", "create_template", "read_text", "write_text", "write_bytes", "remove_file", "recovery_path", "file_sha256"];
    const result = { invocation: "createWebBackend({threads:1}); invoke('create_template',{kind:'einzel'})", capabilities: backend.capabilities, missing: required.filter((cmd) => !backend.capabilities.supportedCommands.includes(cmd)) };
    try { result.created = await backend.invoke("create_template", { kind: "einzel" }); } catch (error) { result.error = error.message; }
    backend.dispose(); return result;
  });
  assert.deepEqual(report.missing, [], "Frontend worker owner must register app/browser-desktop.ts before capabilities");
  assert.ok(report.created?.path);
  report.verdict = "PASS";
} catch (error) {
  report.verdict = "FAIL"; report.blocker = String(error); process.exitCode = 1;
} finally {
  await browser.close(); await server.close();
  await writeFile(path.join(evidence, "desktop-integration.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
