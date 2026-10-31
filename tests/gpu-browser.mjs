import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, 'web/node_modules');
const { chromium } = await import(pathToFileURL(path.join(modules, 'playwright/index.mjs')));
const dir = process.env.SIMREP_EVIDENCE ?? path.join(root, 'evidence/gpu');
const fixtures = process.env.SIMREP_GPU_FIXTURES ?? dir;
const pkg = process.env.SIMREP_GPU_PKG ?? path.join(root, 'web/src/web/pkg');
await mkdir(dir, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const map = {
      '/worker.js': [path.join(root, 'tests/gpu-worker.mjs'), 'text/javascript'],
      '/capabilities.js': [path.join(root, 'crates/simrep-wasm/src/gpu/capabilities.js'), 'text/javascript'],
      '/pkg/simrep_wasm.js': [path.join(pkg, 'simrep_wasm.js'), 'text/javascript'],
      '/pkg/simrep_wasm_bg.wasm': [path.join(pkg, 'simrep_wasm_bg.wasm'), 'application/wasm'],
      '/flight-input.json': [path.join(fixtures, 'flight-input.json'), 'application/json'],
      '/native-reference.json': [path.join(fixtures, 'native-reference.json'), 'application/json'],
    };
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><title>SimRep merged wasm WebGPU QA</title><h1>SimRep merged wasm WebGPU worker QA</h1><pre id="result">Running...</pre>');
    } else if (map[url.pathname]) {
      const [filename, mime] = map[url.pathname];
      res.setHeader('Content-Type', mime);
      res.end(await readFile(filename));
    } else { res.statusCode = 404; res.end(); }
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const args = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'];
const browser = await chromium.launch({ headless: true, ...(process.env.SIMREP_CHROMIUM ? { executablePath: process.env.SIMREP_CHROMIUM } : {}), args,
  env: { ...process.env, GALLIUM_OVERRIDE_CPU_CAPS: 'avx', LP_NATIVE_VECTOR_WIDTH: '256' } });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [], requests = [];
  page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', error => logs.push({ type: 'pageerror', text: error.message }));
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('WebGPU scenario exceeded 180 seconds')); }, 180000);
    worker.addEventListener('message', event => { clearTimeout(timeout); worker.terminate(); resolve(event.data); }, { once: true });
    worker.addEventListener('error', event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); }, { once: true });
    worker.postMessage('run');
  }));
  const report = { invocation: { command: 'node tests/gpu-browser.mjs', args, pkg, fixtures }, browserVersion: browser.version(), ...result, logs, requests };
  await page.locator('#result').evaluate((element, value) => { element.textContent = JSON.stringify(value, null, 2); }, report);
  await page.screenshot({ path: path.join(dir, 'browser-worker-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(dir, 'browser-worker-mobile.png'), fullPage: true });
  await writeFile(path.join(dir, 'browser-worker.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(result.ok, result.error);
  assert.ok(requests.every(request => request.method === 'GET' && request.url.startsWith(origin)));
  assert.ok(!logs.some(log => log.type === 'pageerror'));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
