import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// SimRep-Web on the real wasm backend, in Chromium and WebKit (Safari's engine). No IPC mocks: the
// app's Tauri calls go through src/ipc.ts to the worker and the browser store. Waits are on
// observable state (text, test ids, store contents), never on fixed delays.

interface WebInfo {
  storage: "opfs" | "indexeddb" | "memory";
  capabilities: { threads: number; supportedCommands: string[]; unsupportedCommands: string[] } | null;
  backendError: string | null;
}

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = (name: string) => readFileSync(fixtures + name);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("simrep.tour", "seen"));
});

async function ready(page: Page): Promise<WebInfo> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("web-compute")).toBeVisible();
  const info = await page.evaluate(() => (window as unknown as { __simrepWeb: WebInfo }).__simrepWeb);
  expect(info.backendError).toBeNull();
  expect(errors).toEqual([]);
  return info;
}

/** Puts `name` on the page as a drop (the same path as a user dropping it on the window). */
async function drop(page: Page, name: string, bytes: Buffer) {
  await page.evaluate(
    ([n, data]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(data)], n));
      for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, [...bytes]] as const,
  );
}

test("start-up: real worker, browser store, browser-only features say why", async ({ page, browserName }) => {
  const info = await ready(page);
  expect(info.capabilities!.threads).toBeGreaterThanOrEqual(1);
  if (browserName === "webkit") expect(info.capabilities!.threads).toBe(1);
  // Only services a web page cannot have are missing; templates, geometry and IOB are there.
  expect([...info.capabilities!.unsupportedCommands].sort()).toEqual(["ai_request", "project_dir_delete", "project_dir_list", "project_dir_read", "project_dir_write"]);
  for (const cmd of ["create_template", "inspect_geometry", "build_geometry", "open_iob", "refine_start", "fly"]) expect(info.capabilities!.supportedCommands).toContain(cmd);
  // WebKit's OPFS cannot write from the page (no createWritable): IndexedDB instead.
  expect(info.storage).toBe(browserName === "webkit" ? "indexeddb" : "opfs");
  await expect(page.getByTestId("web-storage")).toHaveAttribute("data-kind", info.storage);
  await expect(page.getByTestId("web-start-panel")).toContainText("Nothing is uploaded");
  for (const id of ["einzel", "quadrupole", "reflectron", "trap"]) await expect(page.locator(`[data-tour="template-${id}"]`)).toBeEnabled();

  // The assistant explains itself instead of failing.
  await page.getByTestId("ai-accounts-open").click();
  await expect(page.getByText("The assistant needs the desktop app").first()).toBeVisible();
});

test("einzel template: generated, refined and flown in the browser; survives a reload", async ({ page }) => {
  await ready(page);
  await page.locator('[data-tour="template-einzel"]').click();
  await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/40 flown · 40 drawn/)).toBeVisible();
  // The refined family is in the browser store, not only in the worker.
  const stored = await page.evaluate(async () => {
    const out: string[] = [];
    const root = await navigator.storage.getDirectory().catch(() => null);
    if (root) {
      try {
        const dir = await root.getDirectoryHandle("simrep-web");
        for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string]> }).entries()) out.push(decodeURIComponent(name));
      } catch {
        // No OPFS folder: IndexedDB is the store (checked below).
      }
    }
    if (!out.length) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open("simrep-web", 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const keys = await new Promise<IDBValidKey[]>((res) => {
        const r = db.transaction("files").objectStore("files").getAllKeys();
        r.onsuccess = () => res(r.result);
      });
      out.push(...keys.map(String));
    }
    return out.filter((p) => p.startsWith("/files/templates/einzel/")).map((p) => p.split("/").pop()).sort();
  });
  expect(stored).toEqual(["einzel.pa#", "einzel.pa0", "einzel.pa1", "einzel.pa2", "einzel.pa3"]);

  // Save the project (into the browser store), reload, reopen it from recent projects.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved Einzel lens/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("web-compute")).toBeVisible();
  await page.getByTitle("/projects/Einzel lens/Einzel lens.simrep", { exact: true }).click();
  await expect(page.getByTestId("results-stored")).toHaveText("Loaded saved results", { timeout: 60_000 });
});

test("GEM geometry: wizard builds and refines through the real backend", async ({ page }) => {
  await ready(page);
  await drop(page, "einzel.gem", fixture("einzel.gem"));
  const wizard = page.locator('aside[aria-label="Import geometry"]');
  await expect(wizard).toContainText("GEM geometry · 3 electrode(s)");
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByRole("button", { name: "Next" }).click();
  // No output folders in the browser: the change-folder button is not offered.
  await expect(wizard.getByRole("button", { name: "Change folder…" })).toHaveCount(0);
  await wizard.getByRole("button", { name: "Build & refine" }).click();
  await expect(wizard).toContainText("Ready to fly", { timeout: 90_000 });
});

test("opening files: picker or file input, by feature detection", async ({ page, browserName }) => {
  await ready(page);
  const pickers = await page.evaluate(() => ({ open: "showOpenFilePicker" in window, save: "showSaveFilePicker" in window }));
  // WebKit (Safari) has no File System Access pickers; Chromium has both.
  expect(pickers).toEqual(browserName === "webkit" ? { open: false, save: false } : { open: true, save: true });
  if (pickers.open) {
    // Chromium: answer the native picker from the page (Playwright cannot drive it).
    await page.evaluate((data) => {
      const file = new File([Uint8Array.from(data)], "einzel.pa#");
      (window as unknown as { showOpenFilePicker(): Promise<unknown> }).showOpenFilePicker = async () => [{ getFile: async () => file }];
    }, [...fixture("einzel.pa#")]);
    await page.getByRole("button", { name: "Open SIMION files…" }).click();
  } else {
    // WebKit: the fallback <input type=file>, which Playwright answers like a user would.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open SIMION files…" }).click();
    await (await chooser).setFiles({ name: "einzel.pa#", mimeType: "application/octet-stream", buffer: fixture("einzel.pa#") });
  }
  await expect(page.getByRole("treeitem", { name: /^einzel\.pa# 121×21/ })).toBeVisible({ timeout: 30_000 });
});

test("results export: save picker in Chromium, download in WebKit", async ({ page, browserName }) => {
  await ready(page);
  await page.locator('[data-tour="template-einzel"]').click();
  await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
  const results = page.locator('[data-tour="results-export"]');
  if (browserName === "webkit") {
    const download = page.waitForEvent("download");
    await results.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: /End states of all ions/ }).click();
    const d = await download;
    expect(d.suggestedFilename()).toBe("einzel-end-states.csv");
    const text = readFileSync((await d.path())!, "utf8");
    expect(text.split("\n")[0]).toContain("ion");
    expect(text.trim().split("\n")).toHaveLength(41);
  } else {
    // Chromium: the save picker answered from the page with an in-memory writable.
    await page.evaluate(() => {
      const w = window as unknown as { __saved: { name: string; text: string } | null; showSaveFilePicker(o: { suggestedName: string }): Promise<unknown> };
      w.__saved = null;
      w.showSaveFilePicker = async ({ suggestedName }) => ({
        name: suggestedName,
        createWritable: async () => {
          const parts: BlobPart[] = [];
          return { write: async (b: BlobPart) => void parts.push(b), close: async () => void (w.__saved = { name: suggestedName, text: await new Blob(parts).text() }) };
        },
      });
    });
    await results.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: /End states of all ions/ }).click();
    const saved = await page.waitForFunction(() => (window as unknown as { __saved: unknown }).__saved).then((h) => h.jsonValue() as Promise<{ name: string; text: string }>);
    expect(saved.name).toBe("einzel-end-states.csv");
    expect(saved.text.trim().split("\n")).toHaveLength(41);
  }
});
