import { defineConfig, devices } from "@playwright/test";
const PORT = 1441;
export default defineConfig({
  testDir: "e2e", timeout: 120_000, expect: { timeout: 30_000 }, fullyParallel: false, workers: 1, reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: "en-US", viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: process.env.SIMREP_E2E_PREVIEW === "1" ? `npx vite preview --mode web --outDir ../dist --port ${PORT} --strictPort` : `npx vite --mode web --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false, timeout: 60_000,
  },
});
