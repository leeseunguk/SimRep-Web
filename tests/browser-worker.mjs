import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appModules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(appModules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(appModules, "playwright/index.mjs")));
const evidence = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/browser-worker");
const files = [];
for (const suffix of ["0", "1", "2", "3"]) {
  const bytes = await readFile(path.join(root, "evidence/cpu-pa", `einzel.pa${suffix}`));
  files.push({ path: `einzel.pa${suffix}`, bytes: Array.from(bytes) });
}
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const isolated of [false, true]) {
    const headers = isolated ? {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    } : {};
    const server = await createServer({
      root: path.join(root, "web"),
      configFile: false,
      server: { host: "127.0.0.1", port: 0, headers },
      plugins: [{
        name: "manual-worker-qa-entry",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/") return next();
            for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
            response.setHeader("Content-Type", "text/html");
            response.end("<!doctype html><html><head><title>CPU wasm worker QA</title></head><body><h1>SimRep CPU wasm worker QA</h1><pre id='result'>Running real worker scenarios</pre></body></html>");
          });
        },
      }],
    });
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const actions = [];
    const requests = [];
    page.on("console", (message) => actions.push({ console: message.type(), text: message.text() }));
    page.on("pageerror", (error) => actions.push({ pageError: error.message }));
    page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
    try {
      await page.goto(origin);
      const result = await page.evaluate(async ({ files }) => {
        const { createWebBackend } = await import("/src/web/client.ts");
        const backend = await createWebBackend({ threads: 1 });
        const assertions = [];
        const check = (condition, name) => {
          if (!condition) throw new Error(name);
          assertions.push(name);
        };
        await backend.putFiles(files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) })));
        const info = await backend.invoke("backend_info");
        check(info.coreCrate === "simrep-core", "native backend_info shape");
        const device = await backend.invoke("compute_device");
        check(device.kind === "cpu" && device.threads === 1 && Number.isFinite(device.initMs), "actual CPU device shape");
        const paths = await backend.invoke("path_info", { paths: ["missing", "einzel.pa0"] });
        check(paths.length === 1 && paths[0].size === files[0].bytes.length, "byte registry path_info");
        const opened = await backend.invoke("open_pa", { id: "lens", path: "einzel.pa0" });
        check(opened instanceof ArrayBuffer, "open_pa returns ArrayBuffer");
        const magic = (packet) => new TextDecoder().decode(new Uint8Array(packet, 0, 4));
        check(magic(opened) === "SPA1", "open_pa SPA1 packet");
        const length = new DataView(opened).getUint32(4, true);
        const header = JSON.parse(new TextDecoder().decode(new Uint8Array(opened, 8, length)));
        check(header.fast.state === "ready" && header.pa0.adjustable === 3, "PA0 sibling family loaded");
        const adjusted = await backend.invoke("fast_adjust", { id: "lens", voltages: [[1, 0], [2, 60], [3, 0]] });
        check(magic(adjusted) === "SPQ1", "fast_adjust SPQ1 packet");
        const adjustedLength = new DataView(adjusted).getUint32(4, true);
        const adjustedHeader = JSON.parse(new TextDecoder().decode(new Uint8Array(adjusted, 8, adjustedLength)));
        check(adjustedHeader.fast.electrodes.find((e) => e.number === 2).voltage === 60, "changed voltage reaches wasm");
        const bytes = await backend.invoke("read_file", { path: "einzel.pa0" });
        check(new Uint8Array(bytes).every((v, i) => v === files[0].bytes[i]), "raw PA bytes preserved");
        for (const command of [...backend.capabilities.unsupportedCommands, "not_a_command"]) {
          let rejected = false;
          try { await backend.invoke(command); } catch (error) {
            rejected = error instanceof Error && error.message === `unsupported in browser: ${command}`;
          }
          check(rejected, `unsupported rejection: ${command}`);
        }
        await backend.putFiles([{ path: "truncated.pa", bytes: new Uint8Array([1, 2]) }]);
        let malformed = false;
        try { await backend.invoke("open_pa", { id: "bad", path: "truncated.pa" }); }
        catch (error) { malformed = error instanceof Error; }
        check(malformed, "truncated PA rejects as Error");
        check((await backend.invoke("backend_info")).coreCrate === "simrep-core", "worker survives malformed input");
        await backend.invoke("close_session", { id: "lens" });
        let closed = false;
        try { await backend.invoke("fast_adjust", { id: "lens", voltages: [] }); }
        catch (error) { closed = error instanceof Error; }
        check(closed, "closed session rejects");
        const pending = backend.invoke("read_file", { path: "einzel.pa0" });
        backend.dispose();
        let disposed = false;
        try { await pending; } catch (error) { disposed = error instanceof Error; }
        check(disposed, "dispose rejects in-flight call without a timer");
        const result = { crossOriginIsolated, capabilities: backend.capabilities, assertions };
        document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
        return result;
      }, { files });
      assert.equal(result.crossOriginIsolated, isolated);
      assert.equal(result.capabilities.threads, 1);
      assert.equal(result.capabilities.multicore, false);
      assert.ok(requests.every((request) => request.url.startsWith(origin)), "unexpected external network request");
      assert.equal(actions.filter((action) => action.pageError).length, 0);
      const screenshot = path.join(evidence, isolated ? "isolated.png" : "single-thread.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ verdict: "PASS for listed commands only", origin, isolated, result, requests, actions, screenshot });
    } finally {
      await page.close();
      await server.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(path.join(evidence, "browser-worker.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ modes: results.length, assertions: results.map((r) => r.result.assertions.length), evidence }, null, 2));
