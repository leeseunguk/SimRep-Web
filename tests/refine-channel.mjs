import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root, "web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules, "vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules, "playwright/index.mjs")));
const output = process.env.SIMREP_EVIDENCE ?? path.join(root, "evidence/refine-channel");
await mkdir(output, { recursive: true });
const input = Array.from(await readFile(path.join(root, "evidence/cooperative-pa/einzel.pa#")));
const expected = {};
for (const n of [0, 1, 2, 3]) expected[`einzel.pa${n}`] = Array.from(await readFile(path.join(root, `evidence/cooperative-pa/einzel.pa${n}`)));
const server = await createServer({ root: path.join(root, "web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "refine-channel-qa",
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><html><body><h1>Cooperative refine Channel QA</h1><pre id='result'>Running</pre></body></html>");
    }); },
  }],
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const actions = [];
page.on("pageerror", (e) => actions.push({ error: e.message }));
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  const result = await page.evaluate(async ({ input, expected }) => {
    const { createWebBackend } = await import("/src/web/client.ts");
    const backend = await createWebBackend();
    const assertions = [];
    const check = (condition, name) => { if (!condition) throw new Error(name); assertions.push(name); };
    await backend.putFiles([{ path: "einzel.pa#", bytes: Uint8Array.from(input) }]);
    await backend.invoke("open_pa", { id: "lens", path: "einzel.pa#" });
    const targets = await backend.invoke("refine_targets", { id: "lens" });
    check(targets.files.length === 4 && targets.files.every((f) => !f.exists), "virtual refine targets");
    let job;
    const messages = [];
    let complete;
    let failed;
    const signal = new Promise((resolve, reject) => { complete = resolve; failed = reject; });
    const deadline = setTimeout(() => failed(new Error("refine terminal event timed out")), 15000);
    const channel = { onmessage(message) {
      check(typeof job === "number", "job response precedes channel callbacks");
      if (message instanceof ArrayBuffer) {
        messages.push({ binary: new TextDecoder().decode(new Uint8Array(message, 0, 4)) });
      } else {
        messages.push(message);
        if (message.type === "error") failed(new Error(message.message));
        if (message.type === "done") complete(message);
      }
    } };
    try {
      job = await backend.invoke("refine_start", { request: { id: "lens", device: "cpu", voltages: [], tolerance: 1e-10, maxCycles: 100 }, channel });
      const done = await signal;
      check(done.cycles === 29 && done.residual <= 1e-10, "native convergence history");
    } finally { clearTimeout(deadline); }
    check(messages[0].type === "start" && JSON.stringify(messages[0].stages) === "[1,2,3]", "native start payload");
    check(messages.filter((m) => m.type === "stageDone").length === 3, "one stageDone per electrode");
    check(messages.filter((m) => m.type === "done").length === 1, "exactly one done terminal");
    check(messages.some((m) => m.binary === "SPV1"), "binary live preview");
    check(messages.at(-2).binary === "SPA1" && messages.at(-1).type === "done", "final SPA1 precedes done");
    for (const [path, reference] of Object.entries(expected)) {
      const actual = new Uint8Array(await backend.invoke("read_file", { path }));
      check(actual.length === reference.length && actual.every((v, i) => v === reference[i]), `${path} byte-identical to native CLI`);
    }
    const labels = new Uint16Array(await backend.invoke("electrode_labels", { id: "lens" }));
    check(labels.some((n) => n === 2), "native electrode label packet");
    await backend.putFiles([{ path: "cancel.pa#", bytes: Uint8Array.from(input) }]);
    await backend.invoke("open_pa", { id: "cancel", path: "cancel.pa#" });
    let cancelJob;
    let cancelled;
    let cancelFailed;
    const cancellation = new Promise((resolve, reject) => { cancelled = resolve; cancelFailed = reject; });
    const cancelDeadline = setTimeout(() => cancelFailed(new Error("cancel terminal event timed out")), 15000);
    const cancelMessages = [];
    let requested = false;
    let cancelCommand;
    try {
      cancelJob = await backend.invoke("refine_start", { request: { id: "cancel", device: "cpu", voltages: [] }, channel: { onmessage(message) {
        if (message instanceof ArrayBuffer) return;
        cancelMessages.push(message);
        if (message.type === "progress" && !requested) {
          requested = true;
          cancelCommand = backend.invoke("refine_cancel", { job: cancelJob });
        }
        if (message.type === "cancelled") cancelled();
        if (message.type === "done" || message.type === "error") cancelFailed(new Error("wrong cancellation terminal"));
      } } });
      await cancellation;
      await cancelCommand;
    } finally { clearTimeout(cancelDeadline); }
    check(cancelMessages.filter((m) => m.type === "cancelled").length === 1, "exactly one cancelled terminal");
    const afterCancel = await backend.invoke("refine_targets", { id: "cancel" });
    check(afterCancel.files.every((f) => !f.exists), "cancel never commits a partial basis family");
    const preserved = new Uint8Array(await backend.invoke("read_file", { path: "cancel.pa#" }));
    check(preserved.length === input.length && preserved.every((v, i) => v === input[i]), "cancel preserves source bytes");
    await backend.invoke("refine_cancel", { job });
    check((await backend.invoke("backend_info")).coreCrate === "simrep-core", "worker remains usable after cancellation");
    backend.dispose();
    const result = { assertions, messages, cancelMessages };
    document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
    return result;
  }, { input, expected });
  assert.equal(actions.length, 0);
  await page.screenshot({ path: path.join(output, "refine-channel.png"), fullPage: true });
  await writeFile(path.join(output, "refine-channel.json"), JSON.stringify({ result, actions }, null, 2));
  console.log(JSON.stringify({ assertions: result.assertions.length, output }, null, 2));
} finally {
  await page.close();
  await browser.close();
  await server.close();
}
