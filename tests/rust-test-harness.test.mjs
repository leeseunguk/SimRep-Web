import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['scripts/test-rust.mjs', 'desktop::limits'], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
assert.equal(run.status, 1);
assert.match(run.stdout, /test result: ok\. 0 passed;/);
assert.match(run.stderr, /Rust test coverage failure/);
console.log('PASS real cargo zero-selection result is rejected');
