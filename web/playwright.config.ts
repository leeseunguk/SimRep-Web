import { defineConfig, devices } from "@playwright/test";

// SimRep-Web end to end: the real SimRep UI on the real wasm backend (no mocks), served by Vite
// with COOP/COEP. Two engines: Chromium (File System Access pickers, OPFS) and WebKit (Safari's
// engine: no FSA pickers, so <input type=file> and downloads). On Linux hosts without WebKit's
// system libraries set PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 (see README).
const PORT = 1441;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npx vite --mode web --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
