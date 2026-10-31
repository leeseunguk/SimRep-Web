import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), root = path.dirname(web);
const link = path.join(web, ".app-src");
// Unsetting SIMREP_APP_SRC always restores the pinned source; no retained dev-state dependency.
const target = path.resolve(web, process.env.SIMREP_APP_SRC ?? "../simrep/app/src");
if (process.env.SIMREP_RELEASE === "1") {
  // The index is the intended gitlink, including an explicitly staged pin update before commit.
  const pin = execFileSync("git", ["rev-parse", ":simrep"], { cwd: root, encoding: "utf8" }).trim();
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(root, "simrep"), encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: path.join(root, "simrep"), encoding: "utf8" }).trim();
  if (pin !== actual || dirty || target !== path.join(root, "simrep/app/src")) throw new Error("Release app source must be the clean pinned SimRep gitlink");
}
if (!fs.existsSync(path.join(target, "main.tsx")) || !fs.existsSync(path.join(target, "host.ts"))) throw new Error(`SimRep app sources not found at ${target}`);
if (!fs.existsSync(link) || fs.readlinkSync(link) !== target) { fs.rmSync(link, { force: true }); fs.symlinkSync(target, link, "dir"); }
console.log(`.app-src -> ${target}`);
