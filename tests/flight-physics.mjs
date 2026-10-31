import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "evidence/flight-physics");
const binary = process.env.SIMREP_BIN ?? path.join(root, "simrep/target/release/simrep");
await mkdir(output, { recursive: true });
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
const backend = new WasmBackend();
function pa(magnetic = false) {
  const bytes = new Uint8Array(32 + 9 ** 3 * 8);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, -1, true); view.setInt32(4, 1, true); view.setFloat64(8, 100000, true);
  for (const offset of [16,20,24]) view.setInt32(offset, 9, true);
  if (magnetic) {
    view.setInt32(28, 8 | (100 << 4), true);
    for (let i = 0; i < 9 ** 3; i++) view.setFloat64(32 + i * 8, -10 * Math.floor(i / 81), true);
  }
  return bytes;
}
const inputs = {
  "vacuum.pa": pa(), "magnetic.pa": pa(true),
  "one.ion": new TextEncoder().encode("0,1,1,4,4,4,0,0,1\n"),
  "one.fly2": new TextEncoder().encode("particles { standard_beam { n=1, mass=1, charge=1, ke=1, position=vector(4,4,4), direction=vector(1,0,0) } }"),
  "coils.json": new TextEncoder().encode(JSON.stringify([{ kind: "loop", center_mm: [4,4,4], normal: [0,0,1], radius_mm: 20, current_a: 100 }])),
};
for (const [name, bytes] of Object.entries(inputs)) { backend.put_file(name, bytes); await writeFile(path.join(output,name), bytes); }
backend.open_pa("vacuum", "vacuum.pa");
const cases = [];
for (const kind of ["uniform-ion", "uniform-fly2", "magnetic-pa", "coils"]) {
  const source = kind === "uniform-fly2" ? "one.fly2" : "one.ion";
  const csvPath = path.join(output, `${kind}.csv`);
  const args = ["--json", "fly", "--pa", path.join(output,"vacuum.pa"), "--particles", path.join(output,source), "--device", "cpu", "--duration-us", "0.2", "--integrator", "boris", "--step-us", "0.0001", "--tolerance", "1e-12", "--nonrelativistic", "--allow-time-limit", "--output", csvPath];
  const request = { id: "vacuum", source: { kind: "file", path: source }, durationUs: 0.2, relativistic: false, integrator: "boris", stepUs: 0.0001, tolerance: 1e-12, maxStepUs: Number.MAX_VALUE };
  if (kind.startsWith("uniform")) { args.push("--bfield", "0,0,1000"); request.bfield = [0,0,1000]; }
  if (kind === "magnetic-pa") { args.push("--magnetic-pa", path.join(output,"magnetic.pa")); request.magneticPa = ["magnetic.pa"]; }
  if (kind === "coils") { args.push("--bfield-coil", path.join(output,"coils.json"), "--exact-coils"); request.bfieldCoil = "coils.json"; request.exactCoils = true; }
  const native = await promisify(execFile)(binary,args,{timeout:120000,maxBuffer:8_000_000});
  const packet = backend.fly(JSON.stringify(request));
  const length = new DataView(packet.buffer,packet.byteOffset).getUint32(4,true);
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(8,8+length)));
  const csv = backend.flight_csv("vacuum",header.token);
  const expected = await readFile(csvPath);
  await writeFile(`${csvPath}.wasm`,csv);
  const row = new TextDecoder().decode(csv).trim().split("\n")[1].split(",");
  assert.ok(Math.abs(Number(row[5])-1) < 1e-10, `${kind}: magnetic field changed kinetic energy`);
  if (kind.startsWith("uniform") || kind === "magnetic-pa") {
    const acceleration = 1.602176634e-19 / 1.66053906892e-27 * 1e-6;
    const omega = acceleration * 1e-4 * 1000;
    const radius = Math.sqrt(2*acceleration) / omega;
    assert.ok(Math.abs(Number(row[2])-(4+radius*Math.sin(omega*0.2))) < 1e-6);
    assert.ok(Math.abs(Number(row[3])-(4+radius*(Math.cos(omega*0.2)-1))) < 1e-6);
  }
  cases.push({ kind, equal: Buffer.from(csv).equals(expected), nativeSummary: JSON.parse(native.stdout), wasmSummary: JSON.parse(backend.flight_summary("vacuum",header.token)), request });
}
await writeFile(path.join(output,"identity.json"),JSON.stringify(cases,null,2));
for (const c of cases) assert.ok(c.equal, `${c.kind}: native/wasm CSV differs`);
console.log(JSON.stringify(cases.map(({kind,equal})=>({kind,equal})),null,2));
backend.free();
