import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "evidence/flight-node");
const output = path.join(root, "evidence/exact-refine");
await mkdir(output, { recursive: true });
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
const backend = new WasmBackend();
for (const suffix of ["pa#", "cuts.json"]) backend.put_file(`einzel.${suffix}`, await readFile(path.join(source, `einzel.${suffix}`)));
backend.open_pa("exact", "einzel.pa#");
const job = backend.refine_begin(JSON.stringify({ id: "exact", voltages: [[2, 60]], tolerance: 1e-10, maxCycles: 100 }));
const messages = [JSON.parse(job.start_message())];
let terminal = false;
for (let steps = 0; steps < 400 && !terminal; steps++) {
  const result = JSON.parse(job.step());
  messages.push(...result.messages);
  terminal = result.terminal;
}
assert.ok(terminal, "exact refinement exceeded its bounded cycle budget");
backend.refine_commit(job);
const comparisons = [];
for (const suffix of ["pa0", "pa1", "pa2", "pa3", "cuts.json"]) {
  const expected = await readFile(path.join(source, `einzel.${suffix}`));
  const actual = backend.read_file(`einzel.${suffix}`);
  await writeFile(path.join(output, `einzel.${suffix}`), actual);
  comparisons.push({ suffix, equal: Buffer.from(actual).equals(expected),
    nativeSha256: createHash("sha256").update(expected).digest("hex"),
    wasmSha256: createHash("sha256").update(actual).digest("hex") });
}
const summary = JSON.parse(job.summary());
await writeFile(path.join(output, "identity.json"), JSON.stringify({ summary, messages, comparisons }, null, 2));
for (const result of comparisons) assert.ok(result.equal, `${result.suffix} exact native/wasm bytes differ`);
assert.equal(summary.cutcell, true);
assert.equal(messages.at(-1).type, "done");
console.log(JSON.stringify({ summary, comparisons }, null, 2));
job.free();
backend.free();
