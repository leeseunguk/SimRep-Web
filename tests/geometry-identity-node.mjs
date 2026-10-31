import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = process.env.SIMREP_CORE ?? path.join(root, "simrep");
const binary = process.env.SIMREP_BIN ?? path.join(core, "target/release/simrep");
const output = path.join(root, "evidence/geometry-node");
await mkdir(output, { recursive: true });
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
const backend = new WasmBackend();
const report = { invocations: [], comparisons: [], adversarial: [] };
async function input(name, bytes) {
  await mkdir(path.dirname(path.join(output, name)), { recursive: true });
  await writeFile(path.join(output, name), bytes);
  backend.put_file(name, bytes);
}
function native(args) {
  console.log(`Native CLI surface: ${binary} ${args.join(" ")}`);
  const stdout = execFileSync(binary, args, { encoding: "utf8", timeout: 120000, env: { ...process.env, RAYON_NUM_THREADS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  report.invocations.push({ surface: "native CLI", binary, args, stdout });
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function compare(name, command, args, cliArgs, outputs) {
  native(cliArgs);
  console.log(`Node wasm surface: backend.geometry_command(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  const summary = JSON.parse(backend.geometry_command(command, JSON.stringify(args)));
  report.invocations.push({ surface: "Node wasm", name, command, args, summary });
  for (const [actualName, expectedName] of outputs) {
    const actual = backend.read_file(actualName), expected = await readFile(path.join(output, expectedName));
    await writeFile(path.join(output, actualName), actual);
    const equal = Buffer.from(actual).equals(expected);
    report.comparisons.push({ name, actualName, expectedName, equal, actualSha256: hash(actual), nativeSha256: hash(expected) });
    assert.ok(equal, `${name}: ${actualName} differs from native ${expectedName}`);
  }
}
try {
  await input("einzel.gem", await readFile(path.join(core, "examples/data/einzel.gem")));
  await input("two_tetrahedra.stl", await readFile(path.join(core, "crates/simrep-gem/tests/fixtures/two_tetrahedra.stl")));
  await input("include/main.gem", Buffer.from("pa_define(9,9,1,planar)\ninclude('part')"));
  await input("include/part.gem", Buffer.from("e(1){fill{within{box(1,1,3,3)}}}"));
  await compare("literal GEM", "gem2pa", { path: "einzel.gem", output: "browser-gem.pa#" }, ["gem2pa", path.join(output, "einzel.gem"), path.join(output, "native-gem.pa#")], [["browser-gem.pa#", "native-gem.pa#"]]);
  await compare("relative include", "gem2pa", { path: "include/main.gem", output: "browser-include.pa#" }, ["gem2pa", path.join(output, "include/main.gem"), path.join(output, "native-include.pa#")], [["browser-include.pa#", "native-include.pa#"]]);
  await compare("mesh import", "mesh_import", { path: "two_tetrahedra.stl", output: "browser-stl.pa#", grid: [13, 7, 7] }, ["mesh-import", path.join(output, "two_tetrahedra.stl"), path.join(output, "native-stl.pa#"), "--grid", "13,7,7"], [["browser-stl.pa#", "native-stl.pa#"]]);
  await compare("exact geometry", "refine_geometry", { path: "einzel.gem", output: "browser-exact", assignments: [{ part: "1", number: 1, voltage: 0 }, { part: "2", number: 2, voltage: 60 }, { part: "3", number: 3, voltage: 0 }] }, ["refine-geometry", path.join(output, "einzel.gem"), "--electrode", "1=1:0", "--electrode", "2=2:60", "--electrode", "3=3:0", "--device", "cpu", "--out", path.join(output, "native-exact")], [["browser-exact.pa#", "native-exact.pa#"], ["browser-exact.cuts.json", "native-exact.cuts.json"]]);
  for (const [name, command, args] of [
    ["missing GEM", "gem2pa", { path: "missing.gem" }],
    ["invalid grid", "mesh_import", { path: "two_tetrahedra.stl", grid: [0, 7, 7] }],
    ["missing assignments", "refine_geometry", { path: "einzel.gem", assignments: [] }],
  ]) {
    console.log(`Node wasm adversarial surface: backend.geometry_command(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
    let error;
    try { backend.geometry_command(command, JSON.stringify(args)); } catch (e) { error = String(e); }
    assert.ok(error, `${name}: invalid input accepted`);
    report.adversarial.push({ name, command, args, error, verdict: "PASS" });
  }
  backend.geometry_command("gem2pa", JSON.stringify({ path: "einzel.gem", output: "recovery.pa#" }));
  assert.ok(backend.read_file("recovery.pa#").length > 0);
  report.verdict = "PASS";
} catch (error) {
  report.verdict = "FAIL";
  report.error = String(error);
  throw error;
} finally {
  backend.free();
  await writeFile(path.join(output, "identity.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
