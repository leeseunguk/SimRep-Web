import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { writeZip } from "../src/zip";
const enc = new TextEncoder();
async function archive(marker: string) {
  return await writeZip([{ path: "projects/review/review.simrep", bytes: enc.encode(JSON.stringify({ format: "simrep-project", version: 2, savedAt: marker, arrays: [], meshes: [], view: { camera: null, projection: "perspective", grid: true }, runs: { keep: 4, capMb: 64 } })) }, { path: "files/marker.txt", bytes: enc.encode(marker) }], false);
}
async function choose(page: Page, bytes: Uint8Array, browserName: string) {
  if (browserName === "chromium") {
    await page.evaluate(data => { const file = new File([Uint8Array.from(data)], "review.zip"); (window as unknown as { showOpenFilePicker(): Promise<unknown> }).showOpenFilePicker = async () => [{ getFile: async () => file }]; }, [...bytes]); await page.getByTestId("web-import-archive").click();
  } else {
    const chooser = page.waitForEvent("filechooser"); await page.getByTestId("web-import-archive").click(); await (await chooser).setFiles({ name: "review.zip", mimeType: "application/zip", buffer: Buffer.from(bytes) });
  }
}
async function storedProject(page: Page, name: string) {
  return page.evaluate(async name => {
    const kind = (window as unknown as { __simrepWeb: { storage: string } }).__simrepWeb.storage;
    const db = kind === "indexeddb" ? await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("simrep-web", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }) : null;
    const read = async (p: string): Promise<Uint8Array> => {
      if (db) return new Promise((resolve, reject) => { const r = db.transaction("files").objectStore("files").get(p); r.onsuccess = () => resolve(r.result as Uint8Array); r.onerror = () => reject(r.error); });
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("simrep-web"); return new Uint8Array(await (await (await dir.getFileHandle(encodeURIComponent(p))).getFile()).arrayBuffer());
    };
    try {
      const entries = JSON.parse(new TextDecoder().decode(await read("/.storage/manifest.json"))) as [string, { key: string }][]; const ref = entries.find(([p]) => p === `/projects/${name}/${name}.simrep`); if (!ref) return null;
      return JSON.parse(new TextDecoder().decode(await read(ref[1].key))) as { savedAt: string };
    } finally { db?.close(); }
  }, name);
}
const projectTitle = (page: Page, name: string) => page.locator("header").getByTitle(`/projects/${name}/${name}.simrep`, { exact: true });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("simrep.tour", "seen")); });
test("archive name clashes allocate numeric suffixes and preserve every earlier import", async ({ page, browserName }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("web-compute")).toBeVisible();
  const names = ["review-imported", "review-imported-2", "review-imported-3"];
  const markers = ["original", "second", "third"];
  for (let i = 0; i < names.length; i++) {
    if (i) await page.locator('[data-tour="home"]').click();
    await choose(page, await archive(markers[i]!), browserName);
    await expect(projectTitle(page, names[i]!)).toBeVisible();
    for (let earlier = 0; earlier <= i; earlier++) expect((await storedProject(page, names[earlier]!))?.savedAt).toBe(markers[earlier]);
  }
  await page.locator('[data-tour="home"]').click();
  await page.screenshot({ path: info.outputPath("import-clash.png") });
  await page.reload();
  await expect(page.getByTestId("web-compute")).toBeVisible();
  for (let i = 0; i < names.length; i++) {
    await expect(page.getByTitle(`/projects/${names[i]}/${names[i]}.simrep`, { exact: true })).toBeVisible();
    expect((await storedProject(page, names[i]!))?.savedAt).toBe(markers[i]);
  }
});
test("a saved einzel project archives and reopens in an isolated namespace", async ({ page, browserName }, info) => {
  await page.goto("/"); await expect(page.getByTestId("web-compute")).toBeVisible(); await page.locator('[data-tour="template-einzel"]').click(); await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByText(/^Saved Einzel lens/)).toBeVisible(); const original = await storedProject(page, "Einzel lens");
  const downloaded = page.waitForEvent("download"); await page.getByTestId("topbar-export").getByRole("button", { name: "Export", exact: true }).click(); await page.getByTestId("web-export-archive").click(); const bytes = readFileSync((await (await downloaded).path())!);
  await page.locator('[data-tour="home"]').click(); await choose(page, bytes, browserName); await expect(projectTitle(page, "Einzel lens-imported")).toBeVisible();
  const results = page.getByRole("region", { name: "Results", exact: true }); await expect(results.getByText("Loaded saved results", { exact: true })).toBeVisible(); await expect(results.getByText("40 ions", { exact: true })).toBeVisible();
  expect(await storedProject(page, "Einzel lens")).toEqual(original); await page.screenshot({ path: info.outputPath("import-roundtrip.png") });
});
test("built deployment exposes legal files and runs wasm under CSP without script violations", async ({ page }, info) => {
  const violations: string[] = [], reportEvents = new EventEmitter();
  await page.exposeFunction("recordPolicyViolation", (text: string) => violations.push(text));
  await page.exposeFunction("recordReportPrint", (report: unknown) => reportEvents.emit("printed", report));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", e => { void (window as unknown as { recordPolicyViolation(s: string): Promise<void> }).recordPolicyViolation(`${e.effectiveDirective}: ${e.blockedURI}`); });
    // Keep report collection, layout and image loading real; intercept only the operating-system print dialog.
    window.print = () => {
      const report = { url: location.href, text: document.body.textContent, images: document.images.length, loadedImages: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length, styles: document.styleSheets.length, width: document.documentElement.clientWidth };
      void (window as unknown as { recordReportPrint(r: unknown): Promise<void> }).recordReportPrint(report).then(() => window.dispatchEvent(new Event("afterprint")));
    };
  });
  const response = await page.goto("/"); await expect(page.getByTestId("web-compute")).toBeVisible();
  if (process.env.SIMREP_E2E_PREVIEW === "1") { expect(response!.headers()["content-security-policy"]).toContain("'wasm-unsafe-eval'"); for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) { const r = await page.request.get(`/${file}`); expect(r.ok()).toBe(true); expect((await r.body()).length).toBeGreaterThan(500); } }
  await expect(page.getByRole("link", { name: "Third-party notices", exact: true })).toBeVisible(); await page.locator('[data-tour="template-einzel"]').click(); await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: info.outputPath("csp-desktop.png") });
  await page.getByTestId("topbar-export").getByRole("button", { name: "Export", exact: true }).click(); await page.getByRole("menuitem", { name: /^Report/ }).click();
  const dialog = page.getByTestId("report-dialog"); await dialog.getByRole("radio", { name: "PDF", exact: true }).click();
  const printed = once(reportEvents, "printed", { signal: AbortSignal.timeout(30_000) }); await dialog.getByTestId("report-run").click();
  const [report] = await printed as [{ url: string; text: string; images: number; loadedImages: number; styles: number; width: number }];
  expect(report.url).toBe("about:srcdoc"); expect(report.text).toContain("Einzel lens"); expect(report.images).toBeGreaterThan(0); expect(report.loadedImages).toBe(report.images); expect(report.styles).toBeGreaterThan(0); expect(report.width).toBeGreaterThan(0);
  writeFileSync(info.outputPath("report-print.json"), JSON.stringify(report, null, 2)); await dialog.getByRole("button", { name: "Close", exact: true }).click(); await expect(page.locator('iframe[aria-hidden="true"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath("csp-phone.png") }); expect(violations).toEqual([]); await info.attach("policy-violations", { body: JSON.stringify(violations), contentType: "application/json" });
});
