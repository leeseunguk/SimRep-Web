#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
unset SIMREP_APP_SRC
export SIMREP_RELEASE=1
bash "$root/scripts/build-wasm.sh" web
bash "$root/scripts/build-wasm.sh" web-threads
(cd "$root/web" && npm ci && npm run build:web -- --outDir ../dist)
node "$root/scripts/third-party-notices.mjs"
node "$root/scripts/toolchain-notices.mjs"
printf 'Static site generated at %s/dist\n' "$root"
