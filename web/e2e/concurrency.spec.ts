import { expect, test, type Page } from "@playwright/test";
import { writeZip } from "../src/zip";

type Internals = { invoke(cmd: string, args: unknown): Promise<unknown> };
type QaWindow = Window & { __TAURI_INTERNALS__: Internals; __qaPublished?: Promise<void> };
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("web-compute")).toBeVisible();
}
async function invoke(page: Page, cmd: string, args: unknown): Promise<unknown> {
  return page.evaluate(({ cmd, args }) => (window as unknown as QaWindow).__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
}
async function watchPublication(page: Page, paths: string[]) {
  await page.evaluate(paths => {
    const win = window as unknown as QaWindow;
    win.__qaPublished = new Promise<void>((resolve, reject) => {
      const channel = new BroadcastChannel("simrep-web:store");
      const cleanup = () => { clearTimeout(deadline); channel.close(); window.removeEventListener("simrep-storage-change", check); };
      const check = () => {
        void win.__TAURI_INTERNALS__.invoke("path_info", { paths }).then(found => {
          if ((found as unknown[]).length === paths.length) { cleanup(); resolve(); }
        }, error => { cleanup(); reject(error); });
      };
      const deadline = setTimeout(() => { cleanup(); reject(new Error(`Publication missing: ${paths.join(", ")}`)); }, 30_000);
      channel.addEventListener("message", check);
      window.addEventListener("simrep-storage-change", check);
    });
  }, paths);
}
const document = (marker: string) => JSON.stringify({
  format: "simrep-project", version: 2, arrays: [], meshes: [],
  view: { camera: null, projection: "perspective", grid: true }, savedAt: marker,
});
async function dropArchive(page: Page, name: string, marker: string) {
  const bytes = await writeZip([{ path: `projects/${name}/${name}.simrep`, bytes: new TextEncoder().encode(document(marker)) }], false);
  await page.evaluate(data => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(data)], "project.zip", { type: "application/zip" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...bytes]);
}
for (const fallback of [false, true]) test.describe(fallback ? "IDB lease fallback" : "Web Locks", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(noLocks => {
      localStorage.setItem("simrep.tour", "seen");
      if (noLocks) Object.defineProperty(navigator, "locks", { value: undefined });
    }, fallback);
  });
  test("multi-tab saves preserve unrelated projects, refresh and survive reload", async ({ context, page }, testInfo) => {
    console.log(`Surface: two real browser pages, ${fallback ? "IDB lease" : "Web Locks"}. Invocation: concurrent __TAURI_INTERNALS__.invoke(write_text) then read_text and reload.`);
    const other = await context.newPage();
    await Promise.all([ready(page), ready(other)]);
    if (fallback) await expect(page.getByTestId("web-storage")).toHaveAttribute("data-kind", "indexeddb");
    const paths = ["/projects/A/A.simrep", "/projects/B/B.simrep"];
    await Promise.all([page, other].map((tab, i) => invoke(tab, "write_text", { path: paths[i], contents: document(String(i)) })));
    for (const tab of [page, other]) for (const path of paths) await expect(tab.getByTitle(path, { exact: true })).toBeVisible();
    await Promise.all([page.reload(), other.reload()]);
    await Promise.all([page, other].map(tab => expect(tab.getByTestId("web-compute")).toBeVisible()));
    for (const tab of [page, other]) {
      for (let i = 0; i < paths.length; i++) expect(JSON.parse(await invoke(tab, "read_text", { path: paths[i] }) as string).savedAt).toBe(String(i));
    }
    await Promise.all([page, other].map((tab, i) => invoke(tab, "write_text", { path: paths[0], contents: document(`replace-${i}`) })));
    const winners = await Promise.all([page, other].map(tab => invoke(tab, "read_text", { path: paths[0] })));
    expect(winners[0]).toBe(winners[1]);
    expect(["replace-0", "replace-1"]).toContain(JSON.parse(winners[0] as string).savedAt);
    const artifact = testInfo.outputPath("two-tabs.png");
    await page.screenshot({ path: artifact });
    await testInfo.attach("two-tab saved projects", { path: artifact, contentType: "image/png" });
    await testInfo.attach("saved-state", { body: JSON.stringify({ paths, winner: JSON.parse(winners[0] as string) }), contentType: "application/json" });
    await other.close();
  });
  for (const sameName of [true, false]) test(`concurrent imports preserve ${sameName ? "same" : "different"} archive names`, async ({ context, page }, testInfo) => {
    console.log(`Surface: two real browser pages, ${fallback ? "IDB lease" : "Web Locks"}. Invocation: simultaneous ZIP drop events (${sameName ? "same" : "different"} project names), real importer, read_text and reload.`);
    const other = await context.newPage();
    await Promise.all([ready(page), ready(other)]);
    const paths = ["/projects/race-imported/race-imported.simrep", sameName ? "/projects/race-imported-2/race-imported-2.simrep" : "/projects/other-imported/other-imported.simrep"];
    // Subscribe to actual publication before triggering imports. Import opens the
    // project (hiding the recent list), so do not use a hidden UI as its signal.
    await watchPublication(page, paths);
    await Promise.all([dropArchive(page, "race", "first"), dropArchive(other, sameName ? "race" : "other", "second")]);
    await page.evaluate(async () => { await (window as unknown as QaWindow).__qaPublished; });
    await Promise.all([page.reload(), other.reload()]);
    await Promise.all([page, other].map(tab => expect(tab.getByTestId("web-compute")).toBeVisible()));
    for (const tab of [page, other]) {
      const markers = await Promise.all(paths.map(async path => JSON.parse(await invoke(tab, "read_text", { path }) as string).savedAt));
      expect(markers.sort()).toEqual(["first", "second"]);
      for (const path of paths) await expect(tab.getByTitle(path, { exact: true })).toBeVisible();
    }
    await testInfo.attach("preserved-imports", { body: JSON.stringify({ paths, markers: ["first", "second"] }), contentType: "application/json" });
    await other.close();
  });
  if (fallback) test("expired lease from a crashed tab is recovered", async ({ page }, testInfo) => {
    console.log("Surface: real IndexedDB and production IPC. Invocation: seed expired lease, write_text, read_text.");
    await ready(page);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("simrep-web", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put({ owner: "crashed-tab", expires: Date.now() - 1 }, "/.storage/lease");
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    const path = "/projects/recovered/recovered.simrep";
    await invoke(page, "write_text", { path, contents: document("recovered") });
    const stored = await invoke(page, "read_text", { path });
    expect(JSON.parse(stored as string).savedAt).toBe("recovered");
    await testInfo.attach("recovered-lease", { body: stored as string, contentType: "application/json" });
  });
});
