import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), web = path.join(root, "web");
console.log("Surface: release app-source linker. Invocation: node tests/reproducibility.mjs");
const alternate = await mkdtemp(path.join(tmpdir(), "simrep-link-"));
const env = { ...process.env }; delete env.SIMREP_APP_SRC; delete env.SIMREP_RELEASE;
const run = extra => execFileSync(process.execPath, ["scripts/link-app.mjs"], { cwd: web, env: { ...env, ...extra }, encoding: "utf8", stdio: "pipe" });
let rejected;
try {
  for (const name of ["main.tsx", "host.ts"]) await writeFile(path.join(alternate, name), "export {};\n");
  run({ SIMREP_APP_SRC: alternate }); assert.equal(await readlink(path.join(web, ".app-src")), alternate);
  run({}); assert.equal(await readlink(path.join(web, ".app-src")), path.join(root, "simrep/app/src"));
  try { run({ SIMREP_APP_SRC: alternate, SIMREP_RELEASE: "1" }); } catch (e) { rejected = String(e.stderr); }
  assert.match(rejected ?? "", /clean pinned SimRep gitlink/); run({ SIMREP_RELEASE: "1" });
  const report = { verdict: "PASS", checks: ["unsetting development override restores pinned source", "release rejects alternate app source", "release accepts clean gitlink"], rejected };
  await mkdir(path.join(root, "evidence/review-fixes"), { recursive: true }); await writeFile(path.join(root, "evidence/review-fixes/reproducibility.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { run({}); await rm(alternate, { recursive: true, force: true }); }
