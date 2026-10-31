# CPU wasm verification and timing

This source package contains executable identity harnesses, not the original
operator's evidence archive. Historical integration results are labeled in
[integration-verification.md](integration-verification.md); they do not replace
fresh-clone evidence for the current revision.

## Reproduction

Use the real pinned `simrep/` submodule and [release prerequisites](RELEASE.md).

```sh
cargo build --manifest-path simrep/Cargo.toml --locked --release -p simrep-cli
export SIMREP_BIN="$PWD/simrep/target/release/simrep"
export SIMREP_CORE="$PWD/simrep"
export SIMREP_APP_MODULES="$PWD/web/node_modules"
bash scripts/build-wasm.sh nodejs
bash scripts/build-wasm.sh web
bash scripts/build-wasm.sh web-threads
(cd web && npm ci && npx playwright install chromium)
node tests/flight-physics.mjs
node tests/einzel-browser.mjs
```

`evidence/einzel-browser/matrix.json` records native argv/stdout/stderr, actual
browser device reports, assertions, same-origin request logs, per-run timings and
SHA256 values. Native/browser PA and CSV bytes plus desktop/mobile screenshots
are beside it. Generated packages and evidence are not tracked source.

## Identity contract

Start from `examples/data/einzel.gem` and `examples/data/ions.ion` in the pinned
submodule, not native-solved output as the browser's result. Staircase uses
browser `gem2pa` then cooperative refinement; exact uses `refine_geometry` with
assignments `1=1:0`, `2=2:60`, `3=3:0`, then the shared cut-cell refine job.
Compare PA0 and PA1/PA2/PA3 against native CPU output byte for byte.

Fly all eight ions to detector `1,0,0,58` with duration 10 us, tolerance 1e-12,
nonrelativistic motion and the CLI's unbounded maximum step. Staircase disables
cuts and adjusts electrode 2 to 60 V. Exact uses its sibling cuts and adjusted
PA0. Compare complete CSV bytes, not just rounded summary values. Run serial
fallback and actual one/four-worker isolated variants and record the reported
pool sizes. Requesting four workers does not prove four workers initialized.

The magnetic/source harness compares uniform B with ION/FLY2, scalar magnetic
PA and coils; the JSON-number harness checks f64 request preservation. Browser
harnesses are backend verification rather than product React UI verification.

## Timing policy

Compare only reported `compute_ms`. Parsing, IO, initialization, field/hierarchy
preparation, Channel delivery, serialization and display sampling are excluded.
Cooperative refinement charges preparation between V-cycles to `prep_ms`.
Use five measured repetitions after a warm-up, report the median and range,
and compare equivalent native thread counts and actual initialized wasm pools.
Small grids and eight ions cannot establish a general crossover or speed ratio.
No historical workstation-specific timing is republished as a release result.

## Export precision limit

The existing strict `tests/exports.mjs` OBJ byte assertion is retained. Historical
runs found identical topology but 1,974 of 108,288 scalars differing by at most
two ULPs (`8.881784197001252e-16` mm) from native/wasm trigonometric rounding.
Do not claim cross-platform byte identity for f64 trigonometric mesh/revolved
grid exports. That exception does not relax the mandatory PA0/flight CSV checks.
Run the tests on the current pinned revision before recording any new verdict.
