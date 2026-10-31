# Historical merged-core integration verification

This document summarizes an earlier integration run, not the current release's
fresh-clone verdict. Read current release logs and its manual QA matrix for new
evidence. Historical worker-local paths have been replaced with portable artifact
locations; those historical artifacts are not shipped here.

The earlier integration baseline was SimRep
`0a3dd20e3adc1b9a67c0810d13338b047b7beb27`. That historical integration used
`6d2dd8c813541a012afa21023a4c555fd991d25a`. The current release pins public
`c767439184c4ba8e099daf1a05c1484e12defaa5` as a real submodule, including
wasm portability, app host hooks, responsive layouts/touch and the WebGL2/Astra
main-repository fixes. No development symlink or unpublished patch is required.

## Historical findings (not reverified by this document)

The portability integration retained default native GPU and Lua support while
separating optional browser WebGPU dependencies and CPU wasm entry points.
Native baseline comparisons reportedly matched 14 files: GEM PA#, staircase and
exact PA0 families, exact cuts, two flight CSVs, mesh PA#, and uniform-B CSV.
The historical native suite reported 402 passing tests and 18 ignored
fixture/benchmark tests. Rust LSP timed out and did not establish clean diagnostics.

The historical Chromium matrix reported staircase/exact PA0 family and flight
CSV identity for serial fallback, one isolated worker and four actual workers;
geometry reported 18 byte comparisons and cancellation reported 57 assertions.
Those backend results do not establish React product UI behavior.
Original reports were `evidence/integration/final-verification.json`,
`evidence/integration/manual-qa.md` and browser logs/screenshots under
`evidence/integration/browser/` in the original evidence archive.
They are historical references, not artifacts created or certified here.

## Known export exception

The strict `tests/exports.mjs` OBJ assertion was reported failing: topology
matched but 1,974 of 108,288 coordinate scalars differed by at most two ULPs
(`8.881784197001252e-16` mm) from platform trigonometric rounding. The test was
not weakened. Do not generalize PA0/CSV byte identity to trigonometric exports.
See [web-performance.md](web-performance.md) for the reproduction contract.

## Current release boundary

The root LICENSE and third-party inventory remain separate from upstream source.
`simrep/` is tracked as a gitlink; generated wasm, evidence, dist and tool caches
are ignored. The frontend owns React integration and static-host behavior.
See [RELEASE.md](RELEASE.md) for reproducible commands and deployment guidance.
