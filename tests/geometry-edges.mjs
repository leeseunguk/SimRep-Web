import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/geometry-edges");
const native = process.env.SIMREP_BIN ?? path.join(root, "simrep/target/release/simrep");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
await mkdir(evidence, { recursive: true });
const report = { invocations: [], requests: [], comparisons: [], actions: [] };
const files = [];
async function input(name, bytes) { await mkdir(path.dirname(path.join(evidence, name)), { recursive: true }); await writeFile(path.join(evidence, name), bytes); files.push({ path: name, bytes: Array.from(bytes) }); }
function cli(args) { console.log(`CLI surface: ${native} ${args.join(" ")}`); const r = spawnSync(native, args, { encoding: "utf8", env: { ...process.env, RAYON_NUM_THREADS: "1" }, timeout: 120000 }); report.invocations.push({ surface: "CLI", invocation: [native, ...args], exitCode: r.status, stdout: r.stdout, stderr: r.stderr }); assert.equal(r.status, 0, r.stderr); }
await input("include/main.gem", Buffer.from("pa_define(9,9,1,planar)\ninclude('part')"));
await input("include/part.gem", Buffer.from("e(1){fill{within{box(1,1,3,3)}}}"));
await input("fractional.gem", Buffer.from("pa_define{nx=9,ny=9,nz=1,symmetry='planar',dx=0.5,dy=0.5,surface='fractional'}\ne(1){fill{within{circle(2,2,1.2)}}}"));
await input("two_tetrahedra.stl", await readFile(path.join(root, "evidence/geometry/two_tetrahedra.stl")));
const document = JSON.parse(await readFile(path.join(root, "evidence/geometry/voxel.gltf"), "utf8"));
const bytes = Buffer.from(document.buffers[0].uri.split(",")[1], "base64");
document.buffers[0].uri = "buffer.bin";
await input("gltf/external.gltf", Buffer.from(JSON.stringify(document)));
await input("gltf/buffer.bin", bytes);
await input("recursive.gem", Buffer.from("pa_define(9,9,1,planar)\ninclude('recursive')"));
await input("bad.stl", Buffer.from([1, 2, 3]));
cli(["gem2pa", path.join(evidence, "include/main.gem"), path.join(evidence, "native-include.pa#")]);
cli(["gem2pa", path.join(evidence, "fractional.gem"), path.join(evidence, "native-fractional.pa#")]);
cli(["mesh-import", path.join(evidence, "gltf/external.gltf"), path.join(evidence, "native-external.pa#"), "--grid", "13,7,7"]);
cli(["refine-geometry", path.join(evidence, "two_tetrahedra.stl"), "--grid", "13,7,7", "--electrode", "0=1:0", "--electrode", "1=2:10", "--gap-check", "off", "--out", path.join(evidence, "native-mesh-exact")]);
cli(["refine-geometry", path.join(evidence, "two_tetrahedra.stl"), "--grid", "13,7,7", "--electrode", "0=1:0", "--insulator", "1", "--gap-check", "off", "--out", path.join(evidence, "native-insulator")]);
const browser = await chromium.launch({ headless: true });
report.browserVersion = browser.version();
report.playwrightVersion = JSON.parse(await readFile(path.join(modules, "playwright/package.json"), "utf8")).version;
const server = await createServer({ root: path.join(root, "web"), configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "geometry-edge-qa", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><meta name='viewport' content='width=device-width'><style>pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><title>Geometry edge QA</title><h1>Geometry edge QA</h1><pre id='result'>Running</pre>"); }); } }] });
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => report.actions.push({ pageError: e.message }));
  page.on("request", (r) => report.requests.push({ method: r.method(), url: r.url() }));
  await page.goto(origin);
  const scenarios = [
    { id: "X01", cmd: "gem2pa", args: { path: "include/main.gem", output: "browser-include.pa#" }, pairs: [["browser-include.pa#", "native-include.pa#"]] },
    { id: "X02", cmd: "gem2pa", args: { path: "fractional.gem", output: "browser-fractional.pa#" }, pairs: [["browser-fractional.pa#", "native-fractional.pa#"], ["browser-fractional.pa-surf", "native-fractional.pa-surf"]] },
    { id: "X03", cmd: "mesh_import", args: { path: "gltf/external.gltf", output: "browser-external.pa#", grid: [13, 7, 7] }, pairs: [["browser-external.pa#", "native-external.pa#"]] },
    { id: "X04", cmd: "refine_geometry", args: { path: "two_tetrahedra.stl", output: "browser-mesh-exact", grid: [13, 7, 7], assignments: [{ part: "0", number: 1, voltage: 0 }, { part: "1", number: 2, voltage: 10 }], gapCheck: "off" }, pairs: [["browser-mesh-exact.pa#", "native-mesh-exact.pa#"], ["browser-mesh-exact.cuts.json", "native-mesh-exact.cuts.json"]] },
    { id: "X05", cmd: "refine_geometry", args: { path: "two_tetrahedra.stl", output: "browser-insulator", grid: [13, 7, 7], assignments: [{ part: "0", number: 1, voltage: 0 }], insulators: ["1"], gapCheck: "off" }, pairs: [["browser-insulator.pa#", "native-insulator.pa#"], ["browser-insulator.cuts.json", "native-insulator.cuts.json"]] },
  ];
  console.log("Chromium module-worker surface: createWebBackend().invoke(cmd,args), including actual mesh cuts and collision-only assignments");
  const result = await page.evaluate(async ({ files, scenarios }) => {
    const { createWebBackend } = await import("/src/web/client.ts");
    const backend = await createWebBackend(); await backend.putFiles(files.map((f) => ({ ...f, bytes: Uint8Array.from(f.bytes) })));
    const results = [];
    for (const scenario of scenarios) {
      const summary = await backend.invoke(scenario.cmd, scenario.args);
      const outputs = [];
      for (const [output, native] of scenario.pairs) outputs.push({ output, native, bytes: Array.from(new Uint8Array(await backend.invoke("read_file", { path: output }))) });
      results.push({ ...scenario, summary, outputs });
    }
    const adversarial = [];
    for (const [cmd, args, contains] of [
      ["gem2pa", { path: "recursive.gem" }, "recursive include"],
      ["mesh_import", { path: "bad.stl", grid: [13, 7, 7] }, null],
      ["mesh_import", { path: "two_tetrahedra.stl", grid: [0, 7, 7] }, null],
      ["mesh_import", { path: "two_tetrahedra.stl", grid: [13, 7, 7], electrodes: [1] }, "one electrode number"],
      ["mesh_import", { path: "two_tetrahedra.stl", grid: [13, 7, 7], output: "wrong.pa" }, ".pa# extension"],
    ]) {
      let error = null; try { await backend.invoke(cmd, args); } catch (e) { error = e.message; }
      if (!error || contains && !error.includes(contains)) throw new Error(`bad rejection ${cmd}: ${error}`);
      adversarial.push({ cmd, args, error, verdict: "PASS" });
    }
    const paths = await backend.invoke("path_info", { paths: ["bad.pa#", "recursive.pa#", "wrong.pa"] });
    if (paths.length !== 0) throw new Error("failed operation published an artifact");
    if ((await backend.invoke("backend_info")).coreCrate !== "simrep-core") throw new Error("worker died");
    backend.dispose();
    document.querySelector("#result").textContent = JSON.stringify({ scenarios: results.map((r) => ({ id: r.id, cmd: r.cmd, outputPaths: r.summary.output_paths })), adversarial }, null, 2);
    return { results, adversarial };
  }, { files, scenarios });
  report.adversarial = result.adversarial;
  for (const r of result.results) {
    report.invocations.push({ surface: "Chromium worker", id: r.id, invocation: `backend.invoke(${JSON.stringify(r.cmd)},${JSON.stringify(r.args)})`, summary: r.summary });
    for (const output of r.outputs) {
      const actual = Buffer.from(output.bytes), expected = await readFile(path.join(evidence, output.native));
      await writeFile(path.join(evidence, output.output), actual);
      report.comparisons.push({ id: r.id, actual: output.output, native: output.native, bytes: actual.length, actualSha256: createHash("sha256").update(actual).digest("hex"), nativeSha256: createHash("sha256").update(expected).digest("hex"), byteIdentical: actual.equals(expected) });
    }
  }
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true }); await page.setViewportSize({ width: 375, height: 812 }); await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  assert.ok(report.requests.every((r) => r.url.startsWith(origin))); assert.equal(report.actions.length, 0); assert.ok(report.comparisons.every((r) => r.byteIdentical), JSON.stringify(report.comparisons, null, 2)); report.verdict = "PASS";
} catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
finally { await browser.close(); await server.close(); await writeFile(path.join(evidence, "geometry-edges.json"), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report.comparisons, null, 2));
