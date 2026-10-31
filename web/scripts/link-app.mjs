// Points web/.app-src at the SimRep app sources this build wraps. The one setting is
// SIMREP_APP_SRC (a path, absolute or relative to web/); the default is the pinned submodule
// ../simrep/app/src. Without the variable an existing link is kept, so one `SIMREP_APP_SRC=...
// npm run link-app` is enough during development.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const link = path.join(web, ".app-src");
const fromEnv = process.env.SIMREP_APP_SRC;
const current = fs.existsSync(link) ? fs.readlinkSync(link) : null;
const target = path.resolve(web, fromEnv ?? current ?? "../simrep/app/src");

if (!fs.existsSync(path.join(target, "main.tsx")) || !fs.existsSync(path.join(target, "host.ts"))) {
  console.error(`SimRep app sources not found at ${target} (need main.tsx and host.ts).`);
  console.error("Set SIMREP_APP_SRC to the app/src folder of a SimRep checkout with the host hooks, e.g.");
  console.error("  SIMREP_APP_SRC=../simrep/app/src npm run link-app");
  process.exit(1);
}
if (current !== target) {
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link, "dir");
}
console.log(`.app-src -> ${target}`);
