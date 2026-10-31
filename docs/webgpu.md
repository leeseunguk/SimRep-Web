# Optional WebGPU backend

The merged SimRep portability patch uses independent `gpu`, `lua` and `webgpu` features. Native defaults retain GPU/Lua. The wasm wrapper disables core defaults, and its optional `webgpu` feature enables `simrep-solve/webgpu`, `simrep-fly/webgpu`, JS bindings and async wasm-bindgen futures. CPU f64, geometry and cooperative refinement remain available in the same module.

```sh
SIMREP_WASM_FEATURES=webgpu bash scripts/build-wasm.sh web
```

The bindings live in `crates/simrep-wasm/src/gpu/` and are registered from the Rust crate root behind `#[cfg(feature = "webgpu")]`. They export `WebGpuSession`; they do not silently change CPU IPC `fly`/`refine_start` into GPU requests. Frontend field packing and GPU request adaptation remain the `web/` owner's responsibility.

## Entry points and limits

Import `webGpuCapabilities` from `src/gpu/capabilities.js` inside a module worker. It checks `navigator.gpu`, requests a high-performance adapter and reports limits/timestamp support. shader-f16 is not required. `await WebGpuSession.create("f32")` initializes the actual wgpu device; `session.capabilities()` reports enabled limits. GPU precision must be `f32`; `f64` rejects with `WebGPU supports only f32 kernels; use CPU wasm for f64`.

`session.solve(request, "f32")` accepts `potential`, `mask`, `dims`, `spacingMm`, `relativeTolerance`, `absoluteTolerance` and `maxCycles`. Cartesian staircase multigrid corrections run on GPU f32; the outer iterate and true residual run on wasm CPU f64. Results report `mixed-f32-f64`, convergence, residual and optional GPU pass timestamps. This is not GPU f64. Cylindrical, dielectric, Poisson and exact-surface GPU solves are not exposed.

`session.fly(input, "f32")` accepts the native f32 packed ABI: `parameter_bytes` (640-byte Parameters), `coefficient_f32` (expanded field powers), `mask_u32` (node flags followed by packed cell degrees/solid bit) and `ion_bytes` (144 bytes per Ion). It returns 64-byte EndState records and optional GPU timestamp milliseconds. Packing must preserve reconstruction degrees and bit-12 solid flags; nearest-node masks are not interchangeable.

This low-level API is not desktop fly IPC. Static RK45 staircase flight is exposed; GPU SDF/exact surfaces, time-varying voltages, collisions and trajectory sampling are not. CPU f64 is the reference path for those supported CPU operations. Adapter availability and storage/dispatch limits are checked at runtime.

## Reproduction with the integrated crate

First generate fresh native fixture inputs and reference results from the merged SimRep source:

```sh
export SIMREP_WEBGPU_EVIDENCE_DIR="$PWD/evidence/gpu"
GALLIUM_OVERRIDE_CPU_CAPS=avx LP_NATIVE_VECTOR_WIDTH=256 \
  cargo test --manifest-path simrep/Cargo.toml --release -p simrep-fly \
  --features webgpu portable_einzel_matches_native_f32_and_cpu_splats -- --nocapture
SIMREP_WASM_FEATURES=webgpu bash scripts/build-wasm.sh web
node tests/gpu-browser.mjs
```

Set `SIMREP_APP_MODULES` to Vite/Playwright's node_modules if needed. `SIMREP_CHROMIUM` selects a Chromium executable; `SIMREP_GPU_PKG`, `SIMREP_GPU_FIXTURES` and `SIMREP_EVIDENCE` override the generated package, fresh reference and report paths. The browser harness uses the actual integrated wasm module, not the GPU worker's old standalone QA crate. It starts/closes an asset server and browser itself.

The harness records browser version, adapter/device limits, exact invocation, action/network logs, f64/malformed-input rejections, capacitor residual and all 15 einzel splat classes compared with native GPU f32 and CPU f64. Desktop/mobile screenshots and `browser-worker.json` are saved beside the native references. Software WebGPU/Vulkan adapters are useful correctness coverage, not hardware speed evidence. Cross-adapter raw terminal bytes are not promised identical. Compute times use GPU pass timestamps only and remain null when unavailable.
