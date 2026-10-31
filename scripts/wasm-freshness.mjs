import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const [mode, directory] = process.argv.slice(2);
if (!['record', 'check'].includes(mode) || !directory) throw new Error('usage: wasm-freshness.mjs record|check PACKAGE_DIR');
const out = path.resolve(directory), stamp = path.join(out, '.source-hash.json');
const sources = execFileSync('git', ['ls-files', '--recurse-submodules', '-z'], { cwd: root }).toString().split('\0')
  .filter(p => /\.(rs|toml|lock)$/.test(p) || /^scripts\/(build-wasm\.sh|wasm-package\.json|wasm-freshness\.mjs)$/.test(p)).sort();
async function digest(base, names) {
  const hash = createHash('sha256');
  for (const name of names) { hash.update(name); hash.update('\0'); hash.update(await readFile(path.join(base, name))); hash.update('\0'); }
  return hash.digest('hex');
}
const artifacts = (await readdir(out)).filter(p => /\.(wasm|js|ts|json)$/.test(p) && p !== '.source-hash.json').sort();
if (!artifacts.some(p => p.endsWith('.wasm'))) throw new Error(`No wasm artifact in ${out}`);
const current = { sources: await digest(root, sources), artifacts: await digest(out, artifacts) };
if (mode === 'record') await writeFile(stamp, JSON.stringify(current) + '\n');
else {
  const recorded = JSON.parse(await readFile(stamp, 'utf8'));
  if (recorded.sources !== current.sources || recorded.artifacts !== current.artifacts) throw new Error(`Stale wasm package: ${out}; rebuild with scripts/build-wasm.sh`);
  console.log(`Fresh wasm package: ${out} sources=${current.sources} artifacts=${current.artifacts}`);
}
