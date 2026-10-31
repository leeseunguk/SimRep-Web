import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/geometry-stl");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
await mkdir(evidence, { recursive: true });
const gem = Buffer.from("pa_define(13,7,7,planar)\ne(1){locate(0.25,0,0,1){fill{within{stl('two_tetrahedra.stl',1.1,1.1,1.1)}}}}"), mesh = await readFile(path.join(root, "evidence/geometry/two_tetrahedra.stl"));
await writeFile(path.join(evidence, "import.gem"), gem); await writeFile(path.join(evidence, "two_tetrahedra.stl"), mesh);
const native = process.env.SIMREP_BIN ?? path.join(root, "simrep/target/release/simrep");
const args = ["gem2pa", path.join(evidence, "import.gem"), path.join(evidence, "native.pa#")];
console.log(`CLI surface: ${native} ${args.join(" ")}`);
const r = spawnSync(native, args, { encoding: "utf8", timeout: 120000 });
const report = { native: { invocation: [native, ...args], exitCode: r.status, stdout: r.stdout, stderr: r.stderr }, actions: [], requests: [] };
assert.equal(r.status, 0, r.stderr);
const server = await createServer({ root: path.join(root, "web"), configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "stl-gem-qa", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><meta name='viewport' content='width=device-width'><style>pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>GEM STL bytes QA</h1><pre id='result'>Running</pre>"); }); } }] });
const browser = await chromium.launch({ headless: true });
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => report.actions.push(e.message)); page.on("request", (q) => report.requests.push({ method: q.method(), url: q.url() })); await page.goto(origin);
  console.log("Chromium worker surface: backend.invoke('gem2pa',{path:'import.gem',output:'browser.pa#'}) with registered GEM and STL bytes");
  const result = await page.evaluate(async ({ gem, mesh }) => {
    const { createWebBackend } = await import("/src/web/client.ts"); const backend = await createWebBackend();
    await backend.putFiles([{ path: "import.gem", bytes: Uint8Array.from(gem) }, { path: "two_tetrahedra.stl", bytes: Uint8Array.from(mesh) }, { path: "missing.gem", bytes: new TextEncoder().encode("pa_define(5,5,5,planar)\ne(1){fill{within{stl('missing.stl')}}}") }]);
    let rejection = null; try { await backend.invoke("gem2pa", { path: "missing.gem" }); } catch (e) { rejection = e.message; }
    if (!rejection?.includes("missing.stl")) throw new Error(`missing STL did not reject: ${rejection}`);
    const summary = await backend.invoke("gem2pa", { path: "import.gem", output: "browser.pa#" });
    const bytes = Array.from(new Uint8Array(await backend.invoke("read_file", { path: "browser.pa#" })));
    backend.dispose(); document.querySelector("#result").textContent = JSON.stringify({ summary, rejection }, null, 2); return { summary, rejection, bytes };
  }, { gem: Array.from(gem), mesh: Array.from(mesh) });
  const actual = Buffer.from(result.bytes), expected = await readFile(path.join(evidence, "native.pa#")); await writeFile(path.join(evidence, "browser.pa#"), actual);
  report.browser = { invocation: "backend.invoke('gem2pa',{path:'import.gem',output:'browser.pa#'})", summary: result.summary, bytes: actual.length, actualSha256: createHash("sha256").update(actual).digest("hex"), nativeSha256: createHash("sha256").update(expected).digest("hex"), byteIdentical: actual.equals(expected) };
  report.adversarial = { class: "missing embedded STL", expected: "reject and retain a usable worker", error: result.rejection, verdict: "PASS" };
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true }); await page.setViewportSize({ width: 375, height: 812 }); await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  assert.ok(actual.equals(expected)); assert.equal(report.actions.length, 0); assert.ok(report.requests.every((q) => q.url.startsWith(origin))); report.verdict = "PASS";
} catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
finally { await browser.close(); await server.close(); await writeFile(path.join(evidence, "geometry-stl.json"), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
