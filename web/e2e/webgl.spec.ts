import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Real browser host and wasm computation, with WebGPU absent before the app starts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("simrep.tour", "seen");
    delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu;
  });
});

/** The same capture path as the app's report exporter; wait for two identical frames. */
async function settled(page: Page) {
  return page.evaluate(async () => {
    const url = "/.app-src/viewport/viewState.ts";
    const { captureViewport } = await import(/* @vite-ignore */ url) as typeof import("../.app-src/viewport/viewState");
    let previous: Uint8ClampedArray | undefined;
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const blob = await captureViewport();
      if (!blob) throw new Error("the 3D view is not mounted");
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("capture decode failed")); });
      const objectUrl = URL.createObjectURL(blob);
      image.src = objectUrl;
      await loaded;
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(objectUrl);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      if (previous?.length === data.length && data.every((v, i) => v === previous![i])) {
        // Reconstruct the capture background to distinguish scene pixels from an empty gradient.
        const css = getComputedStyle(document.documentElement);
        const rx = 1.2 * canvas.width;
        const ry = 0.9 * canvas.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height * 0.4);
        ctx.scale(1, ry / rx);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        gradient.addColorStop(0, css.getPropertyValue("--vp-bg-center").trim());
        gradient.addColorStop(1, css.getPropertyValue("--vp-bg-edge").trim());
        ctx.fillStyle = gradient;
        ctx.fillRect(-canvas.width, -canvas.height * rx / ry, canvas.width * 2, canvas.height * 2 * rx / ry);
        ctx.restore();
        const bg = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let drawn = 0;
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.abs(data[i]! - bg[i]!) + Math.abs(data[i + 1]! - bg[i + 1]!) + Math.abs(data[i + 2]! - bg[i + 2]!) > 12) drawn++;
          for (let j = 0; j < 3; j++) hash = Math.imul(hash ^ data[i + j]!, 16777619);
        }
        return { drawnShare: drawn / (canvas.width * canvas.height), hash: hash >>> 0, width: canvas.width, height: canvas.height };
      }
      previous = data;
    }
    throw new Error("viewport did not produce two identical frames before deadline");
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`WebGL2 einzel flight and trajectory pixels (${theme})`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((theme) => localStorage.setItem("simrep.theme", theme), theme);
    await page.goto("/");
    await expect(page.getByTestId("web-compute")).toBeVisible();
    await expect(page.getByTestId("status-renderer")).toHaveText("Renderer: WebGL2");
    await expect(page.getByTestId("status-renderer")).toHaveAttribute("data-renderer", "webgl2");
    expect(await page.evaluate(() => "gpu" in navigator)).toBe(false);
    await page.locator('[data-tour="template-einzel"]').click();
    await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/40 flown · 40 drawn/)).toBeVisible();
    await expect(page.getByText("The 3D view needs WebGPU or WebGL2")).toHaveCount(0);
    const on = await settled(page);
    expect(on.drawnShare).toBeGreaterThan(0.02);
    const toggle = page.getByRole("switch", { name: "Show trajectories" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const off = await settled(page);
    expect(off.drawnShare).toBeGreaterThan(0.02);
    expect(off.hash).not.toBe(on.hash);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await settled(page)).toEqual(on);
    expect(errors).toEqual([]);
    await info.attach("pixel-evidence", { body: JSON.stringify({ browserName, theme, on, off, errors }), contentType: "application/json" });
    const shot = process.env.SIMREP_WEBGL_SHOTS ?? info.outputDir;
    await mkdir(shot, { recursive: true });
    const screenshot = path.join(shot, `${browserName}-webgl2-einzel-${theme}-1280.png`);
    await page.screenshot({ path: screenshot, scale: "css" });
    await info.attach("einzel-scene", { path: screenshot, contentType: "image/png" });
  });
}

test("neither graphics API: unavailable card names both renderers", async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : (get as (...args: unknown[]) => unknown).call(this, id, ...rest);
    } as typeof get;
  });
  await page.goto("/");
  await expect(page.getByTestId("web-compute")).toBeVisible();
  await expect(page.getByRole("alert").getByText("The 3D view needs WebGPU or WebGL2")).toBeVisible();
  await expect(page.getByTestId("status-renderer")).toHaveText("No WebGPU or WebGL2");
});
