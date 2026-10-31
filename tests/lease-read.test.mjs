import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = await readFile(new URL('../web/src/storage.ts', import.meta.url), 'utf8');
// Exercise the production lease path with a deterministic atomic lease store.
let now = 1000, lease, releaseSnapshot, snapshotTaken;
const snapshotReady = new Promise(resolve => { snapshotTaken = resolve; });
const resume = new Promise(resolve => { releaseSnapshot = resolve; });
const files = new Map();
const db = { transaction() {
  let result;
  const tx = { objectStore() { return {
    get() { const req = {}; queueMicrotask(() => { req.result = lease; req.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return req; },
    put(value) { lease = value; }, delete() { lease = undefined; },
  }; } };
  return tx;
} };
const indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess(); }); return req; } };
const context = vm.createContext({ exports: {}, require: () => ({ checkFileSize() {} }), indexedDB,
  navigator: {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, console,
  Date: { now: () => now }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
});
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
let pause = false;
const raw = { kind: 'indexeddb', async get(p) {
  const value = files.get(p) ?? null;
  if (pause && p === '/.storage/manifest.json') { pause = false; snapshotTaken(); await resume; }
  return value;
}, async put(p,b) { files.set(p,b); }, async delete(p) { files.delete(p); }, async list() { return []; }, async keys() { return [...files.keys()]; } };
const store = context.exports.manifestStore(raw);
await store.put('/a', new TextEncoder().encode('old'));
pause = true;
const pending = store.get('/a').then(value => ({ value }), error => ({ error }));
await snapshotReady;
// The suspended reader is a crashed/suspended lease holder; a new writer
// atomically takes over after its lease deadline without waiting in real time.
now += 31000;
await store.put('/a', new TextEncoder().encode('new'));
releaseSnapshot();
const result = await pending;
assert.match(String(result.error), /lease expired/);
assert.equal(new TextDecoder().decode(await store.get('/a')), 'new');
assert.equal(await store.get('/absent'), null);
console.log('PASS expired snapshot cannot report a false missing file; retry reads committed replacement; committed absence remains null');
