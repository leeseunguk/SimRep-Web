import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = process.env.SIMREP_CORE ?? path.join(root, "simrep");
const binary = process.env.SIMREP_BIN ?? path.join(core, "target/release/simrep");
const output = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence", "cpu-pa");
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { WasmBackend } = require(path.join(root, "target/node-pkg/simrep_wasm.js"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { recursive: true });
const source = path.join(output, "einzel.pa#");
const invocations = [];
async function native(args) {
  const result = await run(binary, args, { timeout: 120_000, maxBuffer: 8_000_000 });
  invocations.push({ binary, args, stdout: result.stdout, stderr: result.stderr });
  return result;
}
await native(["gem2pa", path.join(core, "examples/data/einzel.gem"), source]);
const refined = await native(["--json", "refine", source, "--device", "cpu"]);
const nativeSummary = JSON.parse(refined.stdout);
const backend = new WasmBackend();
backend.put_file(source, await readFile(source));
const packet = backend.open_pa("einzel", source);
assert.equal(new TextDecoder().decode(packet.subarray(0, 4)), "SPA1");
const wasmSummary = JSON.parse(backend.refine_pa("einzel", 1e-10, 100));
assert.equal(wasmSummary.threads, 1);
assert.equal(wasmSummary.converged, true);
const comparisons = [];
for (const nativePath of nativeSummary.output_paths) {
  const expected = await readFile(nativePath);
  const actual = backend.read_file(nativePath);
  const name = path.basename(nativePath);
  const wasmPath = path.join(output, `${name}.wasm`);
  await writeFile(wasmPath, actual);
  const equal = Buffer.from(actual).equals(expected);
  comparisons.push({ name, nativePath, wasmPath, bytes: expected.length, equal,
    nativeSha256: sha256(expected), wasmSha256: sha256(actual) });
  assert.ok(equal, `${name}: native and wasm output differ`);
}
const adjusted = backend.fast_adjust("einzel", JSON.stringify([[1, 0], [2, 60], [3, 0]]));
assert.equal(new TextDecoder().decode(adjusted.subarray(0, 4)), "SPQ1");
await writeFile(path.join(output, "fast-adjust.spq1"), adjusted);
const adversarial = [];
function refuses(name, action) {
  let rejected = false;
  let message;
  try { action(); } catch (error) { rejected = true; message = String(error); }
  assert.ok(rejected, `${name} did not reject`);
  adversarial.push({ name, rejected, message });
}
refuses("missing file", () => backend.read_file("missing.pa"));
refuses("unknown electrode", () => backend.fast_adjust("einzel", "[[999,1]]"));
refuses("duplicate electrode", () => backend.fast_adjust("einzel", "[[2,60],[2,61]]"));
backend.put_file("truncated.pa", new Uint8Array([255, 255, 255, 255]));
refuses("truncated PA", () => backend.open_pa("bad", "truncated.pa"));
const huge = new Uint8Array(28);
const view = new DataView(huge.buffer);
view.setInt32(0, -1, true);
for (const offset of [16, 20, 24]) view.setInt32(offset, 1000, true);
backend.put_file("huge.pa", huge);
refuses("oversized PA before allocation", () => backend.open_pa("huge", "huge.pa"));
backend.open_pa("retry", source);
const before = backend.read_file(source);
refuses("nonconvergence", () => backend.refine_pa("retry", 1e-30, 0));
assert.deepEqual(backend.read_file(source), before);
backend.close_session("einzel");
refuses("closed session", () => backend.fast_adjust("einzel", "[]"));
const evidence = {
  verdict: "PASS for staircase PA refinement",
  nativeSummary, wasmSummary, comparisons, adversarial, invocations,
};
await writeFile(path.join(output, "pa-identity.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output, nativeComputeMs: nativeSummary.compute_ms,
  wasmComputeMs: wasmSummary.compute_ms, identicalFiles: comparisons.length,
  adversarialRejections: adversarial.length, threads: wasmSummary.threads }, null, 2));
backend.free();
