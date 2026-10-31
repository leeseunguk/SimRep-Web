# Release engineering

## Sources and prerequisites

Clone with `git clone --recurse-submodules <repository-url>`. For an existing
checkout use `git submodule update --init --recursive`. `simrep/` is a real
submodule pinned to public SimRep commit
`6d2dd8c813541a012afa21023a4c555fd991d25a`, including the wasm portability and
app host hook. Wrapper and numeric-probe dependencies resolve into `simrep/crates`.
`web/scripts/link-app.mjs` creates ignored `web/.app-src` pointing at
`simrep/app/src`. `SIMREP_APP_SRC`, relative to `web/` or absolute, overrides it
for development. Leave it unset for releases.

Install Git, Node.js 24 with npm, a native C/C++ linker, and Rust through rustup.
Rustup is required, not merely standalone cargo/rustc. Builds need registry and
Rust distribution access. The wasm script installs wasm32-unknown-unknown and a
local wasm-bindgen-cli pinned to 0.2.129. Threaded wasm uses nightly-2025-11-15
with rust-src and atomics-enabled rebuilt std. Tool downloads live in ignored
`.tools/`; `SIMREP_WASM_TOOLS` selects another tool cache. `CARGO_TARGET_DIR`
overrides the Rust cache. Do not override `SIMREP_WASM_OUT_DIR` for a site build:
the frontend needs its normal package paths.

## Build and QA

From the repository root:

```sh
bash scripts/build.sh
```

This builds serial and threaded wasm, then runs `npm ci` and
`npm run build:web -- --outDir ../dist` in `web/`. Deploy only root `dist/`
contents, not sources, node_modules, target caches or evidence. Vite uses a
relative base; verify asset and worker URLs for the deployment subpath.

```sh
bash scripts/build-wasm.sh nodejs
cargo build --manifest-path simrep/Cargo.toml --locked --release -p simrep-cli
cargo build -p simrep-wasm --example desktop-reference
(cd web && npx playwright install chromium webkit)
export SIMREP_BIN="$PWD/simrep/target/release/simrep"
export SIMREP_CORE="$PWD/simrep"
export SIMREP_APP_MODULES="$PWD/web/node_modules"
node tests/pa-identity.mjs
node tests/json-number-wasm.mjs
node tests/geometry-identity-node.mjs
node tests/flight-identity-node.mjs
node tests/flight-physics.mjs
node tests/einzel-browser.mjs
node tests/desktop-commands.mjs
node tests/desktop-cache.mjs
node tests/desktop-integration.mjs
(cd web && npm run typecheck && npm test)
(cd web && npm run e2e -- --project=chromium)
(cd web && npm run e2e -- --project=webkit)
```

Einzel browser QA consumes the fixtures produced by `flight-physics.mjs`.
Older harnesses may need PA fixtures under ignored `evidence/`; inspect their
requirements. Build success alone is not a browser or identity verdict.

For extracted WebKit dependencies on Linux, set paths to the actual installation:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export LD_LIBRARY_PATH=/path/to/webkit-root/usr/lib/x86_64-linux-gnu
(cd web && npm run e2e -- --project=webkit)
```

Skipping validation does not install libraries. Linux WebKitGTK is not real
Safari verification. Chrome/Edge 113+ require available WebGPU for the 3D view;
Safari/Firefox use computation without that view. Application GPU compute stays
gated off until simrep-fly provides a public field export. WebKit defaults to the
serial CPU f64 package; explicit threaded pools there remain experimental.

## Update the SimRep pin

```sh
git -C simrep fetch origin
git -C simrep checkout <reviewed-full-commit-id>
git add simrep
```

Rebuild wasm and the app, rerun identity and browser tests, inspect license
changes, and record the full upstream revision. The repository records the
gitlink, not copies of upstream source. Commit a verified pin update after review.

## Static hosting and isolation

Use HTTPS or localhost. Multicore needs COOP `same-origin` and COEP
`require-corp`. The build copies `web/public/_headers` into `dist/_headers` for
Netlify and Cloudflare Pages:

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cache-Control: no-store
```

Keep the no-store policy: WebKit module-worker cache revalidation can stall after
reload, even with the serial package. The release's Vite preview server sends it;
the development server avoids conditional ETag responses. On other static hosts,
configure equivalent response headers. Inspect actual headers on worker JS and
wasm, not only HTML. No-store trades repeat-download bandwidth for reliable reloads.

Set `dist` as the publish directory. Upload manually or through the host CLI;
no GitHub Actions are required. Keep wasm, workers and fonts same-origin or
provide correct CORS/CORP headers. Inspect actual response headers and verify
`self.crossOriginIsolated === true` and actual worker count after deployment.

GitHub Pages does not interpret `_headers`. The frontend ships and registers
coi-serviceworker for hosts without custom isolation headers; the first controlled
visit may reload once. When isolation is unavailable, use the serial fallback.
Verify the deployed Pages subpath. WebKit release QA uses no-store headers;
reliable WebKit reloads on Pages are not established by that QA. Use a host with
configurable headers for the verified WebKit configuration.
These build commands never push, deploy or invoke GitHub Actions.
