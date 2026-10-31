import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
const backend = new WasmBackend();
backend.put_file("numbers.gem", await readFile(path.join(root, "simrep/examples/data/einzel.gem")));
backend.geometry_command("gem2pa", JSON.stringify({ path: "numbers.gem", output: "numbers.pa#" }));
backend.open_pa("numbers", "numbers.pa#");
const rows = [];
for (const tolerance of [1e-12, 1e-8, Number.MAX_VALUE, 0.001, 0.1, 0.25, 60]) {
  const job = backend.refine_begin(JSON.stringify({ id: "numbers", device: "cpu", tolerance }));
  const message = JSON.parse(job.start_message());
  rows.push({ requested: tolerance, parsed: message.tolerance, equal: Object.is(message.tolerance, tolerance) });
  job.free();
}
await mkdir(path.join(root, "evidence/flight-node"), { recursive: true });
await writeFile(path.join(root, "evidence/flight-node/json-numbers-wasm.json"), JSON.stringify(rows, null, 2));
for (const row of rows) assert.ok(row.equal, `f64 JSON changed ${row.requested}`);
console.log(JSON.stringify(rows, null, 2));
backend.free();
