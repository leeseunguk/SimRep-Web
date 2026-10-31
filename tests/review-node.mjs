import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { WasmBackend } = createRequire(import.meta.url)(path.join(root, "target/node-pkg/simrep_wasm.js"));
console.log("Surface: real Node wasm API. Invocation: node tests/review-node.mjs (prepared-cache guard/release; pending and shared family ownership; five 40-ion, 50000-step flights; long trace; thirty open/close cycles)");
const b = new WasmBackend(), runs = [];
const pa = new Uint8Array(32 + 9 ** 3 * 8), v = new DataView(pa.buffer);
v.setInt32(0, -1, true); v.setInt32(4, 1, true); v.setFloat64(8, 100000, true);
for (const at of [16, 20, 24]) v.setInt32(at, 9, true);
const header = packet => JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + new DataView(packet.buffer, packet.byteOffset).getUint32(4, true))));
try {
  const gem = new TextEncoder().encode("pa_define(17,9,1,planar)\ne(1){fill{within{box(0,0,1.3,8)}}}"); b.put_file("cache.gem", gem);
  const build = { path: "cache.gem", units: null, repair: false, method: "cutcell", parts: [{ index: 0, number: 1, voltage: 0 }], dims: [17, 9, 1], spacing: [1, 1, 1], origin: [0, 0, 0], outputDir: "cache", stem: "model", sidecar: false };
  const before = b.list_files(); let budgetError;
  try { b.desktop_command("build_geometry", JSON.stringify({ request: { ...build, dims: [2100, 2100, 1] } })); } catch (e) { budgetError = String(e); }
  assert.match(budgetError ?? "", /resident-byte budget/); assert.equal(b.list_files(), before);
  b.desktop_command("build_geometry", JSON.stringify({ request: build })); b.open_pa("prepared", "cache/model.pa#");
  const prepared = JSON.parse(b.retention_stats()); assert.equal(prepared.prepared_geometries, 1); b.close_session("prepared"); assert.equal(JSON.parse(b.retention_stats()).prepared_geometries, 0);
  b.desktop_command("remove_file", JSON.stringify({ path: "cache.gem" }));
  b.put_file("old.pa", pa); b.open_pa("old", "old.pa"); b.put_file("pending.pa", pa); b.close_session("old"); assert.deepEqual(b.read_file("pending.pa"), pa); b.open_pa("pending", "pending.pa"); b.close_session("pending");
  b.put_file("shared.pa", pa); b.open_pa("one", "shared.pa"); b.open_pa("two", "shared.pa"); b.close_session("one"); assert.deepEqual(b.read_file("shared.pa"), pa); b.close_session("two");
  b.put_file("vacuum.pa", pa); b.open_pa("long", "vacuum.pa");
  const request = { id: "long", source: { kind: "beam", count: 40, massAmu: 1, chargeE: 1, energyEv: 0.0001, positionMm: [4, 4, 4], direction: [1, 0, 0], coneDeg: 0, shape: "point", widthMm: 0 }, durationUs: 0.05, relativistic: false, integrator: "boris", stepUs: 0.000001, draw: 40 };
  for (let i = 0; i < 5; i++) {
    const result = header(b.fly(JSON.stringify(request))), stats = JSON.parse(b.retention_stats());
    assert.equal(result.ions, 40); assert.ok(stats.flight_bytes <= 128 * 1024 * 1024); assert.ok(stats.flight_records <= 4); if (i === 0) assert.ok(stats.sample_bytes <= 32 * 1024 * 1024); runs.push({ result, stats });
  }
  const trace = header(b.ion_trace(JSON.stringify(request), 0)); assert.ok(trace.steps >= 40000); assert.ok(trace.samples <= 5000); assert.equal(trace.thinned, true); b.close_session("long");
  for (let i = 0; i < 30; i++) { const p = `open-${i}.pa`; b.put_file(p, pa); b.open_pa(`session-${i}`, p); b.close_session(`session-${i}`); assert.equal(JSON.parse(b.retention_stats()).file_bytes, 0); }
  const final = JSON.parse(b.retention_stats()); assert.equal(final.flight_records, 0); assert.equal(final.prepared_geometries, 0);
  const report = { verdict: "PASS", budgetError, prepared, runs, trace, final, checks: ["prepared geometry budget rejects before allocation without mutating files", "prepared geometry released on family close", "pending registration survives another family closing", "shared family survives until its last session closes", "sample bytes bounded during long integration", "global flight byte budget", "four-record maximum", "single-ion trace bounded during integration", "registry released over thirty open/close cycles"] };
  await mkdir(path.join(root, "evidence/review-fixes"), { recursive: true }); await writeFile(path.join(root, "evidence/review-fixes/retention.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { b.free(); }
