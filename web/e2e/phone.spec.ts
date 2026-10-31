import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.describe("390x844 browser host", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("einzel canvas occupies at least 90% of the phone width without horizontal scroll", async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem("simrep.tour", "seen"));
    await page.goto("/");
    await page.locator('[data-tour="template-einzel"]').click();
    await expect(page.getByText("Einzel lens is ready")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("The 3D view needs WebGPU or WebGL2")).toHaveCount(0);
    const canvas = page.locator('section[aria-label="3D view"] canvas');
    await expect(canvas).toBeVisible();
    const metrics = await canvas.evaluate(c => ({
      width: c.getBoundingClientRect().width,
      height: c.getBoundingClientRect().height,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      legalTop: document.querySelector("footer.legal")!.getBoundingClientRect().top,
      statusBottom: document.querySelector('[data-testid="status-renderer"]')!.parentElement!.getBoundingClientRect().bottom,
    }));
    expect(metrics.width).toBeGreaterThanOrEqual(metrics.viewportWidth * 0.9);
    expect(metrics.height).toBeGreaterThan(0);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.statusBottom).toBeLessThanOrEqual(metrics.legalTop);
    await writeFile(info.outputPath("phone-metrics.json"), JSON.stringify(metrics, null, 2));
    await page.screenshot({ path: info.outputPath("phone-390x844.png"), scale: "css" });
    await info.attach("phone-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
  });
});
