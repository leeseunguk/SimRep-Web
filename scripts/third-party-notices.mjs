import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", "wasm32-unknown-unknown", "--features", "webgpu,threads"], { cwd: root, encoding: "utf8", maxBuffer: 32_000_000 }));
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n])), resolved = new Set();
function visit(id) { if (resolved.has(id)) return; resolved.add(id); for (const dep of nodes.get(id)?.deps ?? []) visit(dep.pkg); }
visit(metadata.packages.find(p => p.name === "simrep-wasm").id);
const packages = metadata.packages.filter(p => p.source && resolved.has(p.id)).map(p => ({ name: p.name, version: p.version, license: p.license, repository: p.repository, authors: p.authors, directory: path.dirname(p.manifest_path), ecosystem: "Rust" }));
const web = path.join(root, "web"), packageJson = JSON.parse(await readFile(path.join(web, "package.json"), "utf8")), npmSeen = new Set();
async function npmVisit(name, from = web) {
  let directory = path.join(from, "node_modules", name);
  for (;;) {
    try { await stat(path.join(directory, "package.json")); break; }
    catch (error) { const parent = path.dirname(from); if (parent === from) throw error; from = parent; directory = path.join(from, "node_modules", name); }
  }
  if (npmSeen.has(directory)) return; npmSeen.add(directory);
  const p = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  packages.push({ name: p.name, version: p.version, license: p.license, repository: typeof p.repository === "string" ? p.repository : p.repository?.url, directory, ecosystem: "npm" });
  for (const dependency of Object.keys(p.dependencies ?? {})) await npmVisit(dependency, directory);
}
for (const name of [...Object.keys(packageJson.dependencies), "coi-serviceworker"]) await npmVisit(name);
packages.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const lines = ["# Third-party notices", "", "Generated from the locked wasm Cargo dependency closure (including optional GPU/thread code and build tools) and the npm production dependency closure plus coi-serviceworker. Fonts are included through their @fontsource packages and SIL OFL texts. This is a conservative superset of bundled code. The separate root LICENSE applies to SimRep and the wrapper. Full license texts are shipped below. Packages whose registry archives omit license files are explicitly identified, with an elected Apache-2.0 text for the exact metadata-declared version; all other missing texts fail the build.", "", "| Ecosystem | Package | License | Full license texts |", "| --- | --- | --- | --- |"];
const missing = [];
async function licenses(directory, prefix = "", depth = 0) {
  const found = [];
  for (const e of await readdir(directory, { withFileTypes: true })) {
    if (e.isFile() && /^(licen[cs]e|copying|notice|copyright|ofl)([._-]|$)/i.test(e.name)) found.push(path.join(prefix, e.name));
    else if (e.isDirectory() && depth < 2 && /^(licenses?|legal)$/i.test(e.name)) found.push(...await licenses(path.join(directory, e.name), path.join(prefix, e.name), depth + 1));
  }
  return found;
}
// These exact archives declare Apache-2.0 (or MIT OR Apache-2.0) but omit its text.
const apacheOmissions = new Set(["profiling@1.0.18", "spirv@0.4.0+sdk-1.4.341.0", "wasm_sync@0.1.2"]);
for (const p of packages) {
  const names = await licenses(p.directory), links = []; let fullText = false;
  for (const name of names) {
    const bytes = await readFile(path.join(p.directory, name)); if (bytes.length < 100) continue;
    const relative = `THIRD_PARTY_LICENSES/${p.ecosystem.toLowerCase()}-${p.name.replaceAll("/", "_")}-${p.version}/${name}`;
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), bytes); links.push(`[${name}](${relative})`);
    if (/^(licen[cs]e|copying|ofl)([._-]|$)/i.test(path.basename(name))) fullText = true;
  }
  if (!fullText && p.ecosystem === "Rust" && apacheOmissions.has(`${p.name}@${p.version}`) && p.license.includes("Apache-2.0")) {
    const relative = `THIRD_PARTY_LICENSES/rust-${p.name}-${p.version}/LICENSE-APACHE`;
    const text = await readFile(path.join(root, "THIRD_PARTY_LICENSES/arrayvec-0.7.8/LICENSE-APACHE"));
    if (text.length < 10000) throw new Error("vendored full Apache-2.0 text missing");
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); fullText = true;
    links.push(`[Apache-2.0, elected; registry omits text](${relative}); ${p.repository ?? ""}; ${(p.authors ?? []).join(", ")}`);
  }
  if (!fullText) missing.push(`${p.ecosystem} ${p.name}@${p.version}`);
  lines.push(`| ${p.ecosystem} | ${p.name} ${p.version} | ${p.license ?? "See license text"} | ${links.join(", ")} |`);
}
if (missing.length) throw new Error(`Full license text missing; refusing distribution:\n${missing.join("\n")}`);
await writeFile(path.join(root, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`);
const dist = path.join(root, "dist"); await mkdir(dist, { recursive: true });
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES"]) await cp(path.join(root, name), path.join(dist, name), { recursive: true });
console.log(`Recorded and packaged full licenses for ${packages.length} Rust/npm packages.`);
