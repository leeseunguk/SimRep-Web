import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = process.env.SIMREP_CORE ?? path.join(root, "simrep");
const binary = process.env.SIMREP_BIN ?? path.join(core, "target/release/simrep");
const output = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/flight-node");
await mkdir(output, { recursive: true });
const run = promisify(execFile);
const calls = [];
async function native(args) {
  const result = await run(binary, args, { timeout: 120000, maxBuffer: 8_000_000 });
  calls.push({ binary, args, ...result });
  return JSON.parse(result.stdout);
}
const stem = path.join(output, "einzel");
const refinement = await native(["--json", "refine-geometry", path.join(core, "examples/data/einzel.gem"), "--electrode", "1=1:0", "--electrode", "2=2:60", "--electrode", "3=3:0", "--out", stem]);
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
const backend = new WasmBackend();
for (const suffix of ["pa0", "pa1", "pa2", "pa3", "cuts.json"]) backend.put_file(`einzel.${suffix}`, await readFile(`${stem}.${suffix}`));
backend.put_file("ions.ion", await readFile(path.join(core, "examples/data/ions.ion")));
backend.open_pa("einzel", "einzel.pa0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = [];
for (const surfaces of [false, true]) {
  const mode = surfaces ? "exact" : "staircase";
  const csvPath = path.join(output, `${mode}.csv`);
  const args = ["--json", "fly", "--pa", `${stem}.pa0`, "--particles", path.join(core, "examples/data/ions.ion"), "--plane", "1,0,0,58", "--device", "cpu", "--duration-us", "10", "--tolerance", "1e-12", "--nonrelativistic", "--output", csvPath];
  if (!surfaces) args.push("--no-cuts");
  const expectedSummary = await native(args);
  const request = { id: "einzel", voltages: [], source: { kind: "file", path: "ions.ion" }, bounds: null, placement: null,
    durationUs: 10, relativistic: false, precision: "precise", collision: "allCorners", draw: 8, surfaces,
    plane: [1, 0, 0, 58], tolerance: 1e-12, maxStepUs: Number.MAX_VALUE };
  const packet = backend.fly(JSON.stringify(request));
  assert.equal(new TextDecoder().decode(packet.subarray(0, 4)), "STR4");
  const length = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + length)));
  const actual = backend.flight_csv("einzel", header.token);
  const expected = await readFile(csvPath);
  await writeFile(`${csvPath}.wasm`, actual);
  const summary = JSON.parse(backend.flight_summary("einzel", header.token));
  const equal = Buffer.from(actual).equals(expected);
  const trace = backend.ion_trace(JSON.stringify(request), 0);
  assert.equal(new TextDecoder().decode(trace.subarray(0, 4)), "SIT1");
  await writeFile(path.join(output, `${mode}.trace.sit1`), trace);
  const velocities = backend.flight_velocities("einzel", header.token);
  assert.equal(velocities.length, 8 * 3 * 8);
  cases.push({ mode, equal, bytes: expected.length, nativeSha256: sha(expected), wasmSha256: sha(actual), expectedSummary, summary, header });
}
await writeFile(path.join(output, "flight-node.json"), JSON.stringify({ refinement, cases, calls }, null, 2));
for (const result of cases) assert.ok(result.equal, `${result.mode} flight CSV differs from native CLI; inspect ${output}`);
console.log(JSON.stringify({ output, cases: cases.map((c) => ({ mode: c.mode, equal: c.equal, nativeComputeMs: c.expectedSummary.compute_ms, wasmComputeMs: c.summary.compute_ms })) }, null, 2));
backend.free();
