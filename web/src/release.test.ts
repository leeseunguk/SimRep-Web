import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const script of ["lease-read.test.mjs", "wasm-freshness.test.mjs"]) {
  it(`runs the release regression ${script}`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(`../../tests/${script}`, import.meta.url))]);
    expect(stdout).toMatch(/PASS/);
  });
}
