#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/scripts/build-wasm.sh" web
bash "$root/scripts/build-wasm.sh" web-threads
(cd "$root/web" && npm ci && npm run build:web -- --outDir ../dist)
printf 'Static site generated at %s/dist\n' "$root"
