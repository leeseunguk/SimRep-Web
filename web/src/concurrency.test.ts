import { expect, it } from "vitest";
import { importProject } from "./archive";
import { manifestStore, memoryStore } from "./storage";
import { writeZip } from "./zip";
const enc = new TextEncoder();
it("preserves unrelated projects across independently opened stores and refreshes reads", async () => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const raw = {
    kind: "memory" as const,
    get: async (p: string) => files.get(p) ?? null,
    put: async (p: string, b: Uint8Array) => { files.set(p, new Uint8Array(b)); },
    delete: async (p: string) => { files.delete(p); },
    keys: async (prefix: string) => [...files.keys()].filter(p => p.startsWith(prefix)),
    list: async (prefix: string) => [...files].filter(([p]) => p.startsWith(prefix)).map(([path, b]) => ({ path, size: b.length })),
  };
  const a = manifestStore(raw), b = manifestStore(raw);
  await Promise.all([a.keys(""), b.keys("")]);
  await Promise.all([a.put("/projects/A/A.simrep", enc.encode("A")), b.put("/projects/B/B.simrep", enc.encode("B"))]);
  for (const store of [a, b, manifestStore(raw)]) expect(await store.keys("/projects")).toEqual(["/projects/A/A.simrep", "/projects/B/B.simrep"]);
});
async function archive(name: string, savedAt: string) {
  return writeZip([{ path: `projects/${name}/${name}.simrep`, bytes: enc.encode(JSON.stringify({ format: "simrep-project", version: 2, arrays: [], meshes: [], view: { camera: null, projection: "perspective", grid: true }, savedAt })) }], false);
}
for (const sameName of [true, false]) it(`preserves concurrent imports with ${sameName ? "same" : "different"} archive names`, async () => {
  const store = memoryStore();
  const inputs = await Promise.all([archive("race", "first"), archive(sameName ? "race" : "other", "second")]);
  const paths = await Promise.all(inputs.map(bytes => importProject(bytes, store)));
  expect(new Set(paths).size).toBe(2);
  expect((await Promise.all(paths.map(async p => JSON.parse(new TextDecoder().decode((await store.get(p))!)).savedAt))).sort()).toEqual(["first", "second"]);
});
it("uses the first free suffix without replacing existing imports or their resources", async () => {
  const store = memoryStore();
  const original = await importProject(await archive("race", "original"), store);
  await store.put("/projects/race-imported/resource.bin", enc.encode("keep"));
  const paths = await Promise.all([importProject(await archive("race", "second"), store), importProject(await archive("race", "third"), store)]);
  expect(paths.sort()).toEqual(["/projects/race-imported-2/race-imported-2.simrep", "/projects/race-imported-3/race-imported-3.simrep"]);
  expect(JSON.parse(new TextDecoder().decode((await store.get(original))!)).savedAt).toBe("original");
  expect(new TextDecoder().decode((await store.get("/projects/race-imported/resource.bin"))!)).toBe("keep");
});
