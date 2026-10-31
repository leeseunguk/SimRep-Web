import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/desktop-commands");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
const native = path.join(root, "target/debug/examples/desktop-reference");
await mkdir(evidence, { recursive: true });
const report = { nativeInvocations: [], invocations: [], comparisons: [], adversarial: [], requests: [], actions: [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function oracle(command, args) {
  const argv = [command, typeof args === "string" ? args : JSON.stringify(args)];
  console.log(`Native desktop surface: ${native} ${argv.map((v) => JSON.stringify(v)).join(" ")}`);
  const result = spawnSync(native, argv, { env: { ...process.env, RAYON_NUM_THREADS: "1" }, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  report.nativeInvocations.push({ command, argv: [native, ...argv], status: result.status, stderr: result.stderr.toString(), stdoutBytes: result.stdout.length, stdoutSha256: sha(result.stdout) });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
const registered = [];
async function input(name, bytes) {
  const filename = path.join(evidence, name);
  await writeFile(filename, bytes);
  registered.push({ path: filename, bytes: [...bytes] });
  return filename;
}
const gem = await input("einzel.gem", await readFile(path.join(root, "simrep/examples/data/einzel.gem")));
const mesh = await input("two_tetrahedra.stl", await readFile(path.join(root, "simrep/crates/simrep-gem/tests/fixtures/two_tetrahedra.stl")));
const lua = await input("lua.gem", Buffer.from("# local n = 5\npa_define(5,5,1,planar)\ne(1){fill{within{box(0,0,1,1)}}}"));
const invalidUtf8 = await input("invalid.bin", Buffer.from([0xff, 0xfe, 0x80]));
const binary = await input("bytes.bin", Buffer.from(Array.from({ length: 1024 * 1024 + 17 }, (_, i) => i % 256)));
const shortIob = await input("short.iob", Buffer.from("SIMIOB"));
const iobBytes = Buffer.alloc(800);
[-20, -10, -10, 120, 30, 30].forEach((v, i) => iobBytes.writeDoubleLE(v, i * 8));
iobBytes.writeInt32LE(1, 48);
[0.5, 0, 0, 2, 0, 0.5, 0, 3, 0, 0, 0.5, 4, 0, 0, 0, 1].forEach((v, i) => iobBytes.writeDoubleLE(v, 52 + 180 + i * 8));
iobBytes.write("EINZEL.PA#  ", 52 + 692, "ascii");
const iob = await input("workbench.iob", iobBytes);
const templates = {};
for (const kind of ["einzel", "quadrupole", "reflectron", "trap"]) {
  templates[kind] = oracle("template", kind);
  await writeFile(path.join(evidence, `native-template-${kind}.pa#`), templates[kind]);
}
await input("einzel.pa#", templates.einzel);
const expectedIob = JSON.parse(oracle("open_iob", iob));
const nativeHash = oracle("file_sha256", binary).toString().trim();
assert.equal(nativeHash, sha(Buffer.from(registered.find((f) => f.path === binary).bytes)));
const inspections = [];
function packet(buffer) {
  assert.equal(buffer.subarray(0, 4).toString(), "SGP1");
  const length = buffer.readUInt32LE(4);
  const header = JSON.parse(buffer.subarray(8, 8 + length));
  delete header.ms;
  return { header, triangles: buffer.subarray(8 + length) };
}
for (const source of [gem, mesh]) {
  const request = { path: source, units: null, repair: true };
  const bytes = oracle("inspect_geometry", request);
  await writeFile(path.join(evidence, `native-inspect-${path.basename(source)}.sgp1`), bytes);
  inspections.push({ request, expected: packet(bytes) });
}
const builds = [];
for (const item of inspections) {
  for (const method of ["aligned", "cutcell"]) {
    const header = item.expected.header;
    const request = {
      path: item.request.path, units: null, repair: true, method,
      parts: header.parts.map((part, i) => ({ index: i, number: i + 1, voltage: i === 1 ? 60 : 0 })),
      dims: header.gem?.dims ?? [13, 7, 7], spacing: header.gem?.spacing ?? [1, 1, 1], origin: [0, 0, 0],
      outputDir: path.join(evidence, "native-builds"), stem: `${path.basename(item.request.path)}-${method}`, sidecar: true,
    };
    const expected = JSON.parse(oracle("build_geometry", request));
    delete expected.ms;
    const files = [];
    for (const name of expected.files) files.push({ name, bytes: await readFile(path.join(request.outputDir, name)) });
    builds.push({ request, expected, files });
  }
}
const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } }, plugins: [{ name: "desktop-qa", configureServer(s) { s.middlewares.use((req, res, next) => {
  if (req.url !== "/") return next();
  res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Desktop browser commands QA</title><h1>Desktop browser commands</h1><pre id='result'>Running</pre>");
}); } }] });
const browser = await chromium.launch({ headless: true });
let page;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("request", (r) => report.requests.push({ method: r.method(), url: r.url() }));
  page.on("console", (m) => report.actions.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => report.actions.push({ pageError: e.message }));
  await page.goto(origin);
  console.log("Chromium module-worker surface: new Worker('/tests/desktop-worker.ts',{type:'module'}); registerDesktop(register,backend); calls recorded before invocation");
  const actual = await page.evaluate(async ({ registered, inspections, builds, binary, iob, lua, invalidUtf8, shortIob }) => {
    const worker = new Worker("/tests/desktop-worker.ts", { type: "module" });
    const pending = new Map(); let next = 0; const calls = [];
    const ready = new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message));
      worker.onmessage = ({ data }) => {
        if (data.ready) { resolve(data.commands); return; }
        const call = pending.get(data.id); pending.delete(data.id);
        if (data.error !== undefined) call.reject(new Error(data.error)); else call.resolve(data.value);
      };
    });
    const commands = await ready;
    const invoke = (command, args = {}) => {
      calls.push({ surface: "Chromium module worker desktop registry", command, args: command === "web_register_files" ? { files: args.files.map((f) => ({ path: f.path, byteLength: f.bytes.length })) } : command === "write_bytes" ? { path: args.path, byteLength: args.bytes.length } : args });
      console.log(`invoke ${command} ${JSON.stringify(calls.at(-1).args)}`);
      return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ id, command, args }); });
    };
    await invoke("web_register_files", { files: registered });
    const results = { commands, templates: [], inspections: [], builds: [], adversarial: [], calls };
    for (const kind of ["einzel", "quadrupole", "reflectron", "trap"]) {
      const created = await invoke("create_template", { kind });
      const bytes = [...new Uint8Array(await invoke("read_file", { path: created.path }))];
      const spa = new Uint8Array(await invoke("open_pa", { id: kind, path: created.path }));
      if (new TextDecoder().decode(spa.subarray(0, 4)) !== "SPA1") throw new Error("template cannot be opened");
      results.templates.push({ kind, created, bytes });
    }
    results.duplicateTemplate = await invoke("create_template", { kind: "einzel" });
    for (const request of inspections) results.inspections.push([...new Uint8Array(await invoke("inspect_geometry", { request }))]);
    for (const request of builds) {
      const result = await invoke("build_geometry", { request });
      const files = [];
      for (const name of result.files) files.push({ name, bytes: [...new Uint8Array(await invoke("read_file", { path: `${request.outputDir}/${name}` }))] });
      results.builds.push({ result, files });
    }
    results.iob = await invoke("open_iob", { path: iob });
    results.hash = await invoke("file_sha256", { path: binary });
    results.recovery = await invoke("recovery_path");
    const text = "Unicode: \uD55C\uAE00 \uD83D\uDE80\nNUL:\u0000\n";
    await invoke("write_text", { path: results.recovery, contents: text });
    results.text = await invoke("read_text", { path: results.recovery });
    if (results.text !== text) throw new Error("text roundtrip");
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    await invoke("write_bytes", { path: "exports/space name.bin", bytes });
    results.bytes = [...await invoke("read_file", { path: "exports/space name.bin" })];
    await invoke("remove_file", { path: "exports/space name.bin" });
    await invoke("remove_file", { path: "exports/space name.bin" });
    const bad = [
      ["unknown-template", "create_template", { kind: "not_a_template" }, "unknown template"],
      ["missing-text", "read_text", { path: "absent" }, "notFound"],
      ["invalid-utf8", "read_text", { path: invalidUtf8 }, "badHeader"],
      ["missing-hash", "file_sha256", { path: "absent" }, "notFound"],
      ["removed-bytes", "read_file", { path: "exports/space name.bin" }, "file not found"],
      ["truncated-iob", "open_iob", { path: shortIob }, "iobShort"],
      ["lua-inspect", "inspect_geometry", { request: { path: lua, repair: false, units: null } }, "unsupported in browser: GEM Lua"],
      ["cad-inspect", "inspect_geometry", { request: { path: "part.step", repair: false, units: null } }, "unsupported in browser: STEP/IGES CAD"],
      ["bad-grid", "build_geometry", { request: { ...builds[0], method: "cutcell", dims: [0, 1, 1] } }, "gridInvalid"],
      ["cad-build", "build_geometry", { request: { ...builds[0], path: "part.iges", dims: [3, 3, 3] } }, "unsupported in browser: STEP/IGES CAD"],
      ...["project_dir_write", "project_dir_read", "project_dir_list", "project_dir_delete", "ai_request", "not_a_command"].map((command) => [command, command, {}, `unsupported in browser: ${command}`]),
    ];
    for (const [id, command, args, expected] of bad) {
      let error; try { await invoke(command, args); } catch (e) { error = e.message; }
      if (!error?.includes(expected)) throw new Error(`${id}: expected ${expected}, got ${error}`);
      results.adversarial.push({ id, command, args, expected, error, verdict: "PASS" });
    }
    results.afterErrors = await invoke("read_text", { path: results.recovery });
    worker.terminate();
    document.querySelector("#result").textContent = JSON.stringify({ templates: results.templates.map((t) => t.created), geometryCases: results.builds.map((r) => r.result), adversarial: results.adversarial }, null, 2);
    return results;
  }, { registered, inspections: inspections.map((i) => i.request), builds: builds.map((b) => b.request), binary, iob, lua, invalidUtf8, shortIob });
  report.invocations = actual.calls;
  report.adversarial = actual.adversarial;
  for (const result of actual.templates) {
    const bytes = Buffer.from(result.bytes), expected = templates[result.kind];
    await writeFile(path.join(evidence, `browser-template-${result.kind}.pa#`), bytes);
    const comparison = { id: `template-${result.kind}`, byteLength: bytes.length, actualSha256: sha(bytes), nativeSha256: sha(expected), byteIdentical: bytes.equals(expected) };
    report.comparisons.push(comparison); assert.ok(comparison.byteIdentical, comparison.id);
    assert.deepEqual(Object.keys(result.created).sort(), ["dir", "name", "path", "size"]);
    assert.equal(result.created.size, bytes.length);
  }
  assert.equal(actual.duplicateTemplate.dir, "SimRep/einzel-2");
  for (let i = 0; i < actual.inspections.length; i++) {
    const bytes = Buffer.from(actual.inspections[i]), parsed = packet(bytes), expected = inspections[i].expected;
    await writeFile(path.join(evidence, `browser-inspect-${path.basename(inspections[i].request.path)}.sgp1`), bytes);
    assert.deepEqual(parsed.header, expected.header);
    assert.ok(parsed.triangles.equals(expected.triangles));
    report.comparisons.push({ id: `inspect-${path.basename(inspections[i].request.path)}`, headerIdenticalExceptMs: true, trianglesByteIdentical: true, triangleBytes: parsed.triangles.length });
  }
  for (let i = 0; i < actual.builds.length; i++) {
    const result = actual.builds[i], expected = builds[i]; delete result.result.ms;
    assert.deepEqual(result.result, expected.expected);
    for (let j = 0; j < result.files.length; j++) {
      const file = result.files[j], bytes = Buffer.from(file.bytes);
      await writeFile(path.join(evidence, `browser-${file.name}`), bytes);
      assert.ok(bytes.equals(expected.files[j].bytes), `${file.name} differs`);
      report.comparisons.push({ id: `build-${file.name}`, byteLength: bytes.length, actualSha256: sha(bytes), nativeSha256: sha(expected.files[j].bytes), byteIdentical: true, resultIdenticalExceptMs: true });
    }
  }
  assert.deepEqual(actual.iob, expectedIob);
  report.comparisons.push({ id: "open-iob", jsonIdentical: true, actual: actual.iob });
  assert.equal(actual.hash, nativeHash);
  report.comparisons.push({ id: "sha256", actual: actual.hash, native: nativeHash, identical: true });
  assert.deepEqual(actual.bytes, Array.from({ length: 512 }, (_, i) => i % 256));
  assert.equal(actual.afterErrors, actual.text);
  report.comparisons.push({ id: "vfs-roundtrip", textIdentical: true, bytesIdentical: true, recoveryPath: actual.recovery, removeIdempotent: true, errorsPreserveOtherFiles: true });
  assert.equal(report.actions.filter((a) => a.pageError).length, 0);
  assert.ok(report.requests.every((r) => r.url.startsWith(origin)));
  report.verdict = "PASS";
} catch (error) {
  report.verdict = "FAIL"; report.error = String(error); throw error;
} finally {
  if (page) {
    await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  }
  await browser.close(); await server.close();
  await writeFile(path.join(evidence, "desktop-commands.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report.comparisons, null, 2));
