import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

// Exercise the real wasm registry/native consumer, not a mock XML parser.
// Generate the Node package first: bash scripts/build-wasm.sh nodejs.
let results: { id: string; verdict: string }[];
beforeAll(async () => {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["tests/threemf-limits.mjs"], {
    cwd, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  results = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1));
}, 125_000);

for (const id of [
  "component-alias-last", "component-alias-first", "item-alias",
  "huge-attribute", "many-attributes", "entities", "external-entity", "attribute-entity",
  "count-mismatch", "triangle-count-mismatch", "count-limit",
  "actual-vertex-limit", "actual-triangle-limit", "deep-nesting",
  "memoized-component-depth", "expanded-name-bytes", "xml-size", "relationship-dtd",
  "valid-recovery", "attribute-boundaries", "escaped-attribute",
]) {
  test(`3MF real wasm: ${id}`, () => {
    expect(results.find((result) => result.id === id)?.verdict).toBe("PASS");
  });
}
