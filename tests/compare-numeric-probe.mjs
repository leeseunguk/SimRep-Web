import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "evidence/flight-node");
const probe = createRequire(import.meta.url)(path.join(root, "evidence/numeric-probe-pkg/simrep_numeric_probe.js"));
const pa = await readFile(path.join(output, "einzel.pa0"));
const cuts = await readFile(path.join(output, "einzel.cuts.json"));
const bits = (value) => { const b = new ArrayBuffer(8); const view = new DataView(b); view.setFloat64(0, value, true); return view.getBigUint64(0, true).toString(16).padStart(16, "0"); };
const modes = [];
for (const exact of [false, true]) {
  const native = JSON.parse(await readFile(path.join(output, exact ? "native-exact-probe.json" : "native-field-probe.json"), "utf8"));
  const wasm = JSON.parse(probe.evaluate(pa, exact ? cuts : new Uint8Array()));
  const differences = { samples: [], math: [], jsMath: [] };
  for (const kind of ["samples", "math"]) {
    for (let i = 0; i < native[kind].length; i++) {
      for (let c = 0; c < native[kind][i].data.bits.length; c++) {
        if (native[kind][i].data.bits[c] !== wasm[kind][i].data.bits[c]) {
          differences[kind].push({ input: native[kind][i].point ?? native[kind][i].x, component: c,
            native: native[kind][i].data.values[c], wasm: wasm[kind][i].data.values[c],
            nativeBits: native[kind][i].data.bits[c], wasmBits: wasm[kind][i].data.bits[c] });
        }
      }
    }
  }
  const kernels = {0:(x)=>Math.pow(x,-0.2),4:Math.sin,5:Math.cos,6:Math.sin,7:Math.cos,8:Math.log};
  for (const row of native.math) for (const [component, kernel] of Object.entries(kernels)) {
    const actual = kernel(row.x);
    if (bits(actual) !== row.data.bits[component]) differences.jsMath.push({input:row.x,component:Number(component),native:row.data.values[component],js:actual});
  }
  const counts = (rows) => rows.reduce((out,row)=>{out[row.component]=(out[row.component]??0)+1;return out;},{});
  modes.push({ exact, fieldDifferences:differences.samples.length,mathDifferences:counts(differences.math),jsMathDifferences:counts(differences.jsMath),differences });
}
await writeFile(path.join(output, "bit-probe-comparison.json"), JSON.stringify(modes, null, 2));
console.log(JSON.stringify(modes.map(({differences,...summary})=>summary),null,2));
