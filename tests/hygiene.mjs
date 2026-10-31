import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
console.log("Surface: first-party tracked/candidate files and complete built distribution, including binary strings. Invocation: node tests/hygiene.mjs");
const files = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
async function walk(dir) { for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) await walk(p); else if (e.isFile()) files.add(p); } }
await walk("dist");
const patterns = {
  personalPath: /(?:\/home\/|[A-Za-z]:[\\/]Users[\\/]|\/mnt\/[a-z]\/Users\/)(?!<user>|user(?:[\\/]|$)|username(?:[\\/]|$))[^\\/\s"']+[\\/]/,
  credential: /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
};
const findings = []; let inspected = 0;
for (const file of files) {
  const info = await stat(path.join(root, file)); if (!info.isFile()) continue; inspected++;
  if (info.size > 10 * 1024 * 1024) findings.push({ file, kind: "file exceeds 10 MiB", bytes: info.size });
  const text = (await readFile(path.join(root, file))).toString("latin1");
  for (const [kind, pattern] of Object.entries(patterns)) if (pattern.test(text)) findings.push({ file, kind });
}
const report = { verdict: findings.length ? "FAIL" : "PASS", inspected, maxFileBytes: 10 * 1024 * 1024, scope: "first-party Git candidates and built dist; submodule contents are outside this scan", findings };
await mkdir(path.join(root, "evidence/review-fixes"), { recursive: true }); await writeFile(path.join(root, "evidence/review-fixes/hygiene.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); assert.deepEqual(findings, []);
