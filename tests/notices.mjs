import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rename, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
console.log("Surface: build notices generator and deployed dist files. Invocation: node tests/notices.mjs");
const license = path.join(root, "web/node_modules/react/LICENSE"), hidden = path.join(root, "web/node_modules/react/.qa-hidden-license");
let rejection;
await rename(license, hidden);
try {
  try { execFileSync(process.execPath, ["scripts/third-party-notices.mjs"], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (e) { rejection = String(e.stderr); }
} finally { await rename(hidden, license); }
assert.match(rejection ?? "", /Full license text missing[\s\S]*npm react@/);
execFileSync(process.execPath, ["scripts/third-party-notices.mjs"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/toolchain-notices.mjs"], { cwd: root, stdio: "inherit" });
const source = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md")), shipped = await readFile(path.join(root, "dist/THIRD_PARTY_NOTICES.md"));
assert.deepEqual(shipped, source); assert.deepEqual(await readFile(path.join(root, "dist/LICENSE")), await readFile(path.join(root, "LICENSE")));
const links = [...source.toString().matchAll(/\]\((THIRD_PARTY_LICENSES\/[^)]+)\)/g)].map(m => m[1]);
for (const relative of links) assert.ok((await stat(path.join(root, "dist", relative))).size >= 100, relative);
const report = { verdict: "PASS", checks: ["missing npm license aborts generation", "root and deployable notices/license byte equality", "every linked deployed full license exists"], linkedTexts: links.length, rejection };
await mkdir(path.join(root, "evidence/review-fixes"), { recursive: true }); await writeFile(path.join(root, "evidence/review-fixes/notices.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
