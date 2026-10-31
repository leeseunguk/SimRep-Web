import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lines = ["", "## Rust standard libraries", "", "The serial and atomics-rebuilt threaded standard libraries are redistributed under their original licenses. Their complete upstream library copyright inventories include standard-library third-party components not represented by the application's Cargo metadata.", ""];
for (const toolchain of ["1.95.0", "nightly-2025-11-15"]) {
  const sysroot = execFileSync("rustc", [`+${toolchain}`, "--print", "sysroot"], { encoding: "utf8" }).trim();
  const source = path.join(sysroot, "share/doc/rust"), relative = `THIRD_PARTY_LICENSES/rust-standard-library-${toolchain}`;
  for (const file of ["COPYRIGHT-library.html", "licenses"]) {
    await stat(path.join(source, file)); await mkdir(path.join(root, relative), { recursive: true });
    await cp(path.join(source, file), path.join(root, relative, file), { recursive: true });
  }
  if ((await readFile(path.join(root, relative, "COPYRIGHT-library.html"))).length < 1000) throw new Error(`Missing complete ${toolchain} standard-library copyright inventory`);
  lines.push(`- Rust ${toolchain}: [full library inventory](${relative}/COPYRIGHT-library.html), with its linked full license texts in the accompanying licenses directory.`);
  await cp(path.join(root, relative), path.join(root, "dist", relative), { recursive: true });
}
await appendFile(path.join(root, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`);
await cp(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(root, "dist/THIRD_PARTY_NOTICES.md"));
console.log("Packaged full serial/threaded Rust standard-library notices and license texts.");
