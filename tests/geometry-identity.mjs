import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = process.env.SIMREP_CORE ?? path.join(root, "simrep");
const evidence = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/geometry");
const native = process.env.SIMREP_BIN ?? path.join(core, "target/release/simrep");
const appModules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(appModules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(appModules, "playwright/index.mjs")));
await mkdir(evidence, { recursive: true });
const report = { invocations: [], actions: [], requests: [], comparisons: [], adversarial: [] };
const hash = (b) => createHash("sha256").update(b).digest("hex");
function run(args, expected = 0) {
  console.log(`CLI surface: ${native} ${args.join(" ")}`);
  const result = spawnSync(native, args, { encoding: "utf8", env: { ...process.env, RAYON_NUM_THREADS: "1" }, timeout: 120000 });
  report.invocations.push({ surface: "native CLI", invocation: [native, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, expected, result.stderr);
}
const registered = [];
async function input(name, bytes) {
  await writeFile(path.join(evidence, name), bytes);
  registered.push({ path: name, bytes: Array.from(bytes) });
}
function zip(entries) {
  let offset = 0;
  const chunks = [], central = [];
  for (const [filename, text] of Object.entries(entries)) {
    const name = Buffer.from(filename), bytes = Buffer.from(text), checksum = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += local.length + name.length + bytes.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}
await input("einzel.gem", await readFile(path.join(core, "examples/data/einzel.gem")));
await input("two_tetrahedra.stl", await readFile(path.join(core, "crates/simrep-gem/tests/fixtures/two_tetrahedra.stl")));
await input("tetra.ply", Buffer.from("ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n1 1 1\n1 4 1\n4 1 1\n1 1 4\n3 0 1 2\n3 0 2 3\n3 0 3 1\n3 2 1 3\n"));
await input("tetra.3mf", zip({
  "_rels/.rels": '<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>',
  "3D/3dmodel.model": '<model unit="millimeter"><resources><object id="1" name="tetra"><mesh><vertices><vertex x="1" y="1" z="1"/><vertex x="1" y="4" z="1"/><vertex x="4" y="1" z="1"/><vertex x="1" y="1" z="4"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3"/><triangle v1="0" v2="3" v3="1"/><triangle v1="2" v2="1" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
}));
for (const [name, text] of Object.entries({
  "lua.gem": "# local n = 5\npa_define(5,5,1,planar)\ne(1){fill{within{box(0,0,1,1)}}}",
  "modern-lua.gem": "pa_define{nx=5,ny=5,nz=1}\nfor i=1,3 do end",
  "gap.gem": "pa_define(9,9,1,planar)\ne(1){fill{within{box(0,0,2,8)}}}\ne(2){fill{within{box(2.5,0,5,8)}}}",
})) await input(name, Buffer.from(text));
run(["gem2pa", path.join(evidence, "einzel.gem"), path.join(evidence, "native-gem.pa#")]);
run(["refine-geometry", path.join(evidence, "einzel.gem"), "--electrode", "1=1:0", "--electrode", "2=2:60", "--electrode", "3=3:0", "--out", path.join(evidence, "native-exact"), "--device", "cpu"]);
run(["mesh-import", path.join(evidence, "two_tetrahedra.stl"), path.join(evidence, "native-stl.pa#"), "--grid", "13,7,7"]);
for (const extension of ["obj", "gltf", "glb"]) {
  run(["export", "geometry", path.join(evidence, "native-stl.pa#"), path.join(evidence, `voxel.${extension}`)]);
  await input(`voxel.${extension}`, await readFile(path.join(evidence, `voxel.${extension}`)));
}
const meshFiles = ["two_tetrahedra.stl", "voxel.obj", "tetra.ply", "tetra.3mf", "voxel.gltf", "voxel.glb"];
for (const filename of meshFiles) run(["mesh-import", path.join(evidence, filename), path.join(evidence, `native-${filename}.pa#`), "--grid", "13,7,7"]);
run(["refine-geometry", path.join(evidence, "gap.gem"), "--electrode", "1=1:0", "--electrode", "2=2:10", "--out", path.join(evidence, "native-gap"), "--gap-check", "error"], 1);
const browser = await chromium.launch({ headless: true });
const server = await createServer({ root: path.join(root, "web"), configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "geometry-qa", configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Geometry QA</title><h1>Browser geometry QA</h1><pre id='result'>Running</pre>"); }); } }] });
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (m) => report.actions.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => report.actions.push({ pageError: e.message }));
  page.on("request", (r) => report.requests.push({ method: r.method(), url: r.url() }));
  await page.goto(origin);
  const scenarios = [
    { id: "G01", command: "gem2pa", args: { path: "einzel.gem", output: "browser-gem.pa#" }, outputs: [["browser-gem.pa#", "native-gem.pa#"]] },
    { id: "G02", command: "refine_geometry", args: { path: "einzel.gem", output: "browser-exact", assignments: [{ part: "1", number: 1, voltage: 0 }, { part: "2", number: 2, voltage: 60 }, { part: "3", number: 3, voltage: 0 }] }, outputs: [["browser-exact.pa#", "native-exact.pa#"], ["browser-exact.cuts.json", "native-exact.cuts.json"]] },
    ...meshFiles.map((filename, i) => ({ id: `G${i + 3}`, command: "mesh_import", args: { path: filename, output: `browser-${filename}.pa#`, grid: [13, 7, 7] }, outputs: [[`browser-${filename}.pa#`, `native-${filename}.pa#`]] })),
  ];
  console.log("Chromium module-worker surface: createWebBackend().invoke(command,args); commands/arguments captured in geometry-identity.json");
  const result = await page.evaluate(async ({ registered, scenarios }) => {
    const { createWebBackend } = await import("/src/web/client.ts");
    const backend = await createWebBackend();
    await backend.putFiles(registered.map((f) => ({ ...f, bytes: Uint8Array.from(f.bytes) })));
    const results = [];
    for (const scenario of scenarios) {
      const summary = await backend.invoke(scenario.command, scenario.args);
      const outputs = [];
      for (const [output, native] of scenario.outputs) outputs.push({ output, native, bytes: Array.from(new Uint8Array(await backend.invoke("read_file", { path: output }))) });
      results.push({ ...scenario, summary, outputs });
    }
    const adversarial = [];
    for (const path of ["lua.gem", "modern-lua.gem"]) {
      let error = null; try { await backend.invoke("gem2pa", { path }); } catch (e) { error = e.message; }
      if (error !== "unsupported in browser: GEM Lua") throw new Error(`Lua rejection: ${error}`);
      adversarial.push({ id: path, command: "gem2pa", args: { path }, error, verdict: "PASS" });
    }
    const assignments = [{ part: "1", number: 1, voltage: 0 }, { part: "2", number: 2, voltage: 10 }];
    for (const mode of ["warn", "off", "error"]) {
      const args = { path: "gap.gem", output: `gap-${mode}`, assignments, gapCheck: mode };
      let error = null, value = null; try { value = await backend.invoke("refine_geometry", args); } catch (e) { error = e.message; }
      if (mode === "error" ? !error?.startsWith("gap check failed:") : error !== null) throw new Error(`gap mode ${mode}: ${error}`);
      adversarial.push({ id: `gap-${mode}`, command: "refine_geometry", args, error, value, verdict: "PASS" });
    }
    for (const assignments of [[], [{ part: "1", number: 1, voltage: 0 }], [{ part: "1", number: 1001, voltage: 0 }]]) {
      let error = null; try { await backend.invoke("refine_geometry", { path: "gap.gem", assignments }); } catch (e) { error = e.message; }
      if (!error) throw new Error("invalid assignment accepted");
      adversarial.push({ id: "invalid-assignment", assignments, error, verdict: "PASS" });
    }
    if ((await backend.invoke("backend_info")).coreCrate !== "simrep-core") throw new Error("worker did not survive errors");
    backend.dispose();
    document.querySelector("#result").textContent = JSON.stringify({ scenarios: results.map((r) => ({ id: r.id, command: r.command, outputPaths: r.summary.output_paths })), adversarial }, null, 2);
    return { results, adversarial };
  }, { registered, scenarios });
  report.adversarial = result.adversarial;
  for (const resultCase of result.results) {
    report.invocations.push({ surface: "Chromium worker", id: resultCase.id, invocation: `backend.invoke(${JSON.stringify(resultCase.command)}, ${JSON.stringify(resultCase.args)})`, summary: resultCase.summary });
    for (const output of resultCase.outputs) {
      const actual = Buffer.from(output.bytes), expected = await readFile(path.join(evidence, output.native));
      await writeFile(path.join(evidence, output.output), actual);
      const same = actual.equals(expected);
      report.comparisons.push({ id: resultCase.id, actual: output.output, native: output.native, bytes: actual.length, actualSha256: hash(actual), nativeSha256: hash(expected), byteIdentical: same });
    }
  }
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  assert.ok(report.requests.every((r) => r.url.startsWith(origin)), "external network request");
  assert.equal(report.actions.filter((a) => a.pageError).length, 0);
  assert.ok(report.comparisons.every((r) => r.byteIdentical), JSON.stringify(report.comparisons, null, 2));
  report.verdict = "PASS";
} catch (error) {
  report.verdict = "FAIL"; report.error = String(error); throw error;
} finally {
  await browser.close(); await server.close();
  await writeFile(path.join(evidence, "geometry-identity.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report.comparisons, null, 2));
