#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
unset SIMREP_APP_SRC
export SIMREP_RELEASE=1
bash "$root/scripts/build-wasm.sh" web
bash "$root/scripts/build-wasm.sh" web-threads
bash "$root/scripts/build-wasm.sh" nodejs
for package in "$root/web/src/web/pkg" "$root/web/src/web/pkg-threads" "$root/target/node-pkg"; do
  node "$root/scripts/wasm-freshness.mjs" check "$package"
done
(cd "$root/web" && npm ci && npm run build:web -- --outDir ../dist)
node "$root/scripts/third-party-notices.mjs"
node "$root/scripts/toolchain-notices.mjs"
printf 'Static site generated at %s/dist\n' "$root"
