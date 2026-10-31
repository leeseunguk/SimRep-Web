#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
kind="${1:-web}"
target="$kind"
case "$kind" in
  web) out="$root/web/src/web/pkg" ;;
  nodejs) out="$root/target/node-pkg" ;;
  web-threads) out="$root/web/src/web/pkg-threads"; target=web ;;
  *) printf 'usage: bash scripts/build-wasm.sh [web|nodejs|web-threads]\n' >&2; exit 2 ;;
esac
command -v rustup >/dev/null || { printf 'rustup is required; install Rust with rustup first.\n' >&2; exit 1; }
out="${SIMREP_WASM_OUT_DIR:-$out}"
features=()
if [[ -n "${SIMREP_WASM_FEATURES:-}" ]]; then features=(--features "$SIMREP_WASM_FEATURES"); fi
version=0.2.129
tools="${SIMREP_WASM_TOOLS:-$root/.tools}"
bindgen="$tools/bin/wasm-bindgen"
if [[ ! -x "$bindgen" ]] || [[ "$("$bindgen" --version)" != "wasm-bindgen $version" ]]; then
  cargo install wasm-bindgen-cli --version "$version" --locked --root "$tools" --force
fi
if [[ "$("$bindgen" --version)" != "wasm-bindgen $version" ]]; then
  printf 'expected wasm-bindgen %s at %s\n' "$version" "$bindgen" >&2
  exit 1
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target}"
if [[ "$kind" == web-threads ]]; then
  toolchain=nightly-2025-11-15
  rustup toolchain install "$toolchain" --profile minimal --component rust-src --target wasm32-unknown-unknown
  export CARGO_TARGET_DIR="$CARGO_TARGET_DIR/threads"
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+atomics,+bulk-memory,+mutable-globals"
  # Bindgen 0.2.129 requires shared/imported memory and exported TLS data.
  # These are final-link flags; only the atomics flags rebuild std.
  cargo +"$toolchain" rustc --manifest-path "$root/Cargo.toml" -p simrep-wasm --lib --release --target wasm32-unknown-unknown --features threads "${features[@]}" -Z build-std=std,panic_abort -- \
    -C link-arg=--shared-memory \
    -C link-arg=--import-memory \
    -C link-arg=--max-memory=4294967296 \
    -C link-arg=--export=__wasm_init_tls \
    -C link-arg=--export=__tls_size \
    -C link-arg=--export=__tls_align \
    -C link-arg=--export=__tls_base
else
  rustup target add wasm32-unknown-unknown
  cargo build --manifest-path "$root/Cargo.toml" --locked -p simrep-wasm --release --target wasm32-unknown-unknown "${features[@]}"
fi
"$bindgen" --target "$target" --out-dir "$out" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/simrep_wasm.wasm"
if [[ "$target" == web ]]; then cp "$root/scripts/wasm-package.json" "$out/package.json"; fi
printf 'Generated %s package at %s\n' "$kind" "$out"
