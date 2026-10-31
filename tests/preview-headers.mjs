import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), web = path.join(root, "web"), output = path.join(root, "evidence/review-fixes/http");
const { preview } = await import(pathToFileURL(path.join(web, "node_modules/vite/dist/node/index.js")));
const { chromium, webkit } = await import(pathToFileURL(path.join(web, "node_modules/playwright/index.mjs")));
console.log("Surface: real built-site preview HTTP and Chromium/WebKit. Invocation: node tests/preview-headers.mjs; HTTP requests use curl -i --range 0-1; browsers append a deliberately forbidden inline script after worker startup.");
await mkdir(output, { recursive: true });
const server = await preview({ root: web, configFile: path.join(web, "vite.config.ts"), build: { outDir: path.join(root, "dist") }, preview: { port: 0, strictPort: false, host: "127.0.0.1" } });
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`, assets = await readdir(path.join(root, "dist/assets"));
  const wasm = assets.filter(n => n.endsWith(".wasm")), worker = assets.find(n => /^worker-.*\.js$/.test(n)); assert.equal(wasm.length, 2); assert.ok(worker);
  const policy = (await readFile(path.join(root, "dist/_headers"), "utf8")).split("\n").find(l => l.trim().startsWith("Content-Security-Policy:"))?.trim().slice("Content-Security-Policy:".length).trim(); assert.ok(policy);
  const cases = [], inline = [];
  for (const [i, pathname] of ["/", `/assets/${worker}`, ...wasm.map(n => `/assets/${n}`), "/LICENSE", "/THIRD_PARTY_NOTICES.md"].entries()) {
    const argv = ["-i", "--silent", "--show-error", "--max-time", "15", "--range", "0-1", origin + pathname];
    const { stdout } = await run("curl", argv, { encoding: "latin1", maxBuffer: 8 * 1024 * 1024 }); const raw = Buffer.from(stdout, "latin1"), headers = stdout.split("\r\n\r\n")[0];
    assert.match(headers, /^HTTP\/1\.1 (200|206)/); assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/i); assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/i);
    const csp = headers.split("\r\n").find(l => /^content-security-policy:/i.test(l))?.split(": ").slice(1).join(": "); assert.equal(csp, policy); assert.ok(!csp.match(/script-src[^;]*'unsafe-inline'/));
    const artifact = path.join(output, `${i}.http`); await writeFile(artifact, raw); cases.push({ pathname, invocation: ["curl", ...argv], verdict: "PASS", artifact });
  }
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); await page.goto(origin); await page.waitForSelector('[data-testid="web-compute"]');
      const result = await page.evaluate(() => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("CSP violation event deadline")), 5000);
        const observed = e => { if (!e.effectiveDirective.startsWith("script-src")) return; clearTimeout(deadline); document.removeEventListener("securitypolicyviolation", observed); resolve({ executed: window.__qaInlineRan === true, directive: e.effectiveDirective, blockedURI: e.blockedURI }); };
        document.addEventListener("securitypolicyviolation", observed); const script = document.createElement("script"); script.textContent = "window.__qaInlineRan = true"; document.head.append(script);
      }));
      assert.equal(result.executed, false); assert.match(result.directive, /^script-src/);
      const artifact = path.join(output, `csp-${name}.png`); await page.screenshot({ path: artifact }); inline.push({ engine: name, invocation: "append inline script after real worker startup", result, verdict: "PASS", artifact });
    } finally { await browser.close(); }
  }
  const report = { verdict: "PASS", cases, inline }; await writeFile(path.join(output, "headers.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await new Promise(resolve => server.httpServer.close(resolve)); }
