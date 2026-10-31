import { parseProject } from "../.app-src/state/projectFormat";
import { storeTransaction, type FileStore } from "./storage";
import { readZip } from "./zip";

/** Validate and stage all members before publishing into this project's own namespace. */
export async function importProject(bytes: Uint8Array, store: FileStore): Promise<string> {
  const entries = await readZip(bytes);
  const projects = entries.filter(e => /\.simrep$/i.test(e.path));
  if (projects.length !== 1) throw new Error("the archive must contain exactly one .simrep project");
  const project = projects[0]!;
  if (project.bytes.length > 4 * 1024 * 1024) throw new Error("project document exceeds 4 MiB");
  const doc = parseProject(new TextDecoder("utf-8", { fatal: true }).decode(project.bytes));
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const ref = (v: unknown) => record(v) && typeof v.path === "string" && typeof v.absolute === "string" && !!v.absolute;
  const shape = doc as unknown as Record<string, unknown>, view = shape.view;
  if (!record(view) || !["perspective", "orthographic"].includes(String(view.projection)) || typeof view.grid !== "boolean") throw new Error("invalid project view");
  if (view.camera !== null && (!record(view.camera) || !Array.isArray(view.camera.target) || view.camera.target.length !== 3 || !view.camera.target.every(v => typeof v === "number" && Number.isFinite(v)) || ![view.camera.distance, view.camera.yaw, view.camera.pitch].every(v => typeof v === "number" && Number.isFinite(v)))) throw new Error("invalid project camera");
  if (!Array.isArray(doc.arrays) || !Array.isArray(doc.meshes)) throw new Error("invalid project arrays or meshes");
  for (const a of doc.arrays as unknown[]) {
    if (!record(a) || !ref(a.file) || !record(a.source) || !(a.source.file === null || ref(a.source.file)) || !record(a.voltages) || !record(a.electrodeNames) || !Array.isArray(a.hiddenElectrodes) || ![a.visible, a.liveFly, a.showTrajectories, a.showMirrors].every(v => typeof v === "boolean")) throw new Error("invalid project array");
  }
  for (const m of doc.meshes) if (!record(m) || !ref(m.file) || typeof m.visible !== "boolean" || typeof m.units !== "string") throw new Error("invalid project mesh");
  for (const e of entries) if (!["files", "projects", "exports"].includes(e.path.split("/")[0]!)) throw new Error(`unexpected folder in archive: ${e.path}`);
  const originalName = project.path.split("/").pop()!.replace(/\.simrep$/i, "");
  return storeTransaction(store, async locked => {
    // Allocation and publication are one transaction, including across tabs. Never replace
    // an existing import: choose the first available deterministic numeric suffix.
    const base = `${originalName}-imported`;
    let name = base, root = `/projects/${name}`, suffix = 2;
    while ((await locked.keys(root)).length) {
      name = `${base}-${suffix++}`;
      root = `/projects/${name}`;
    }
    const destination = `${root}/${name}.simrep`;
    const paths = new Map(entries.map(e => [`/${e.path}`, e === project ? destination : e.path.startsWith(`${project.path}.d/`) ? `${destination}.d/${e.path.slice(project.path.length + 3)}` : `${root}/resources/${e.path}`]));
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (record(value)) {
        if (typeof value.absolute === "string" && typeof value.path === "string") {
          const old = value.absolute.startsWith("/") ? value.absolute : `/${value.absolute}`, mapped = paths.get(old);
          if (!mapped) throw new Error(`project references a file absent from the archive: ${value.absolute}`);
          return { ...value, path: mapped.slice(root.length + 1), absolute: mapped };
        }
        return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "recovery").map(([k, v]) => [k, k === "outputDir" && typeof v === "string" ? `${root}/generated` : rewrite(v)]));
      }
      return value;
    };
    const rewritten = rewrite(doc);
    await locked.batch(entries.map(e => ({ path: paths.get(`/${e.path}`)!, bytes: e === project ? new TextEncoder().encode(JSON.stringify(rewritten)) : e.bytes })));
    return destination;
  });
}
