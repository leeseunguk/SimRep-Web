import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "evidence/flight-node");
const core = process.env.SIMREP_CORE ?? path.join(root, "simrep");
const binary = process.env.SIMREP_BIN ?? path.join(core, "target/release/simrep");
const particles = path.join(core, "examples/data/ions.ion");
const format = (number) => number.toExponential(15).replace(/e\+?(-?)0*(\d+)$/, "e$1$2");
const modes = [];
for (const mode of ["staircase", "exact"]) {
  const tracePath = path.join(output, `${mode}.native.trace.csv`);
  const args = ["--json", "fly", "--pa", path.join(output, "einzel.pa0"), "--particles", particles, "--plane", "1,0,0,58", "--device", "cpu", "--duration-us", "10", "--tolerance", "1e-12", "--nonrelativistic", "--output", path.join(output, `${mode}.native.trace-ends.csv`), "--trajectories", tracePath, "--sample-every", "1"];
  if (mode === "staircase") args.push("--no-cuts");
  const execution = await promisify(execFile)(binary, args, { timeout: 120000, maxBuffer: 8_000_000 });
  const csv = (await readFile(tracePath, "utf8")).trim().split("\n");
  const columns = csv[0].split(",");
  const native = csv.slice(1).map((line) => line.split(",")).filter((row) => row[0] === "1");
  const trace = await readFile(path.join(output, `${mode}.trace.sit1`));
  const headerLength = trace.readUInt32LE(4);
  const header = JSON.parse(trace.subarray(8, 8 + headerLength).toString());
  const rows = [];
  for (let i = 0; i < header.samples; i++) rows.push(Array.from({ length: 9 }, (_, c) => trace.readDoubleLE(8 + headerLength + 72 * i + 8 * c)));
  let firstDivergence;
  let firstTimeDivergence;
  for (let i = 0; i < Math.min(native.length, rows.length); i++) {
    for (let c = 1; c <= 7; c++) {
      const actual = format(rows[i][c - 1]);
      if (actual !== native[i][c]) {
        firstDivergence ??= { sample: i, column: columns[c], expected: native[i][c], actual };
        if (c === 1) firstTimeDivergence ??= { sample: i, expected: native[i][c], actual };
      }
    }
  }
  modes.push({ mode, columns, nativeSamples: native.length, wasmHeader: header, firstDivergence, firstTimeDivergence,
    firstNative: native.slice(0, 12), firstWasm: rows.slice(0, 12), execution: { binary, args, ...execution } });
}
await writeFile(path.join(output, "numerical-diagnostic.json"), JSON.stringify(modes, null, 2));
console.log(JSON.stringify(modes.map(({ mode, nativeSamples, wasmHeader, firstDivergence, firstTimeDivergence }) => ({ mode, nativeSamples, wasmSamples: wasmHeader.samples, firstDivergence, firstTimeDivergence })), null, 2));
