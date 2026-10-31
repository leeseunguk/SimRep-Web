import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = ['test', '--locked', '-p', 'simrep-wasm', '--lib', process.argv[2] ?? 'desktop::vfs::limits'];
console.log(`cargo ${args.join(' ')}`);
const run = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
const summaries = [...run.stdout.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
const passed = summaries.reduce((n, match) => n + Number(match[1]), 0);
if (!passed) {
  console.error('Rust test coverage failure: zero tests passed (empty or ignored selection).');
  process.exit(1);
}
console.log(`Verified ${passed} passing Rust tests.`);
