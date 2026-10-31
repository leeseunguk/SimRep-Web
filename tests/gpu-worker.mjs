import init, { WebGpuSession } from '/pkg/simrep_wasm.js';
import { webGpuCapabilities, requireWebGpuPrecision } from '/capabilities.js';
self.onmessage = async () => {
  const actions = [];
  const rejected = async fn => { try { await fn(); return null; } catch (error) { return String(error); } };
  try {
    actions.push('Initialize merged CPU/geometry/WebGPU wasm module in a module worker');
    await init();
    actions.push('Detect navigator.gpu and adapter limits in worker');
    const detected = await webGpuCapabilities();
    const f64Error = await rejected(() => WebGpuSession.create('f64'));
    const jsF64Error = await rejected(() => requireWebGpuPrecision('f64'));
    if (!f64Error?.includes('only f32') || !jsF64Error?.includes('only f32')) throw new Error('f64 refusal did not propagate');
    actions.push('Create actual wgpu WebGPU f32 device');
    const session = await WebGpuSession.create('f32');
    const capabilities = session.capabilities();
    const potential = Array(9 * 7).fill(0);
    const mask = Array(9 * 7).fill(false);
    for (let y = 0; y < 7; ++y) {
      mask[y * 9] = true; mask[y * 9 + 8] = true; potential[y * 9 + 8] = 8;
    }
    actions.push('Solve 9x7 Cartesian staircase capacitor with CPU f64 residual and WebGPU f32 V-cycles');
    const solved = await session.solve({ potential, mask, dims: [9, 7, 1], spacingMm: [1, 1, 1], relativeTolerance: 1e-9, absoluteTolerance: 0, maxCycles: 200 }, 'f32');
    const maxError = Math.max(...solved.potential.map((v, i) => Math.abs(v - i % 9)));
    if (!solved.converged || maxError > 1e-6) throw new Error(`Capacitor solve failed: ${maxError}`);
    actions.push('Reject malformed packed flight before GPU submission');
    const malformedError = await rejected(() => session.fly({ parameter_bytes: [], coefficient_f32: [], mask_u32: [], ion_bytes: [] }, 'f32'));
    if (!malformedError?.includes('640 bytes')) throw new Error('Malformed parameter ABI accepted');
    actions.push('Fly freshly exported merged einzel staircase fixture on actual WebGPU');
    const input = await (await fetch('/flight-input.json')).json();
    const reference = await (await fetch('/native-reference.json')).json();
    const output = await session.fly(input, 'f32');
    const bytes = Uint8Array.from(output.end_state_bytes);
    const view = new DataView(bytes.buffer);
    const referenceBytes = Uint8Array.from(reference.nativeEndStates);
    const nativeView = new DataView(referenceBytes.buffer);
    const reasons = Array.from({ length: bytes.length / 64 }, (_, i) => view.getUint32(i * 64 + 24, true));
    const sameNative = reasons.length === 15 && reasons.every((r, i) => r === reference.nativeF32Reasons[i]);
    const sameCpu = reasons.length === 15 && reasons.every((r, i) => r === reference.cpuF64Reasons[i]);
    let maxTofDifferenceUs = 0;
    for (let i = 0; i < reasons.length; ++i) {
      const tof = view.getFloat32(i * 64 + 44, true) + view.getFloat32(i * 64 + 60, true);
      const referenceTof = nativeView.getFloat32(i * 64 + 44, true) + nativeView.getFloat32(i * 64 + 60, true);
      maxTofDifferenceUs = Math.max(maxTofDifferenceUs, Math.abs(tof - referenceTof));
    }
    const result = {
      detected, capabilities, f64Error, jsF64Error, malformedError,
      solve: { converged: solved.converged, cycles: solved.cycles, residual: solved.residual, maxError, computeMs: solved.computeMs },
      flight: { ions: reasons.length, reasons, sameNativeF32Splats: sameNative, sameCpuF64Splats: sameCpu,
        computeMs: output.compute_ms, nativeF32ComputeMs: reference.nativeF32ComputeMs, cpuF64ComputeMs: reference.cpuF64ComputeMs,
        maxTofDifferenceUs, byteEqual: bytes.length === referenceBytes.length && bytes.every((b, i) => b === referenceBytes[i]) },
    };
    session.free();
    if (!sameNative || !sameCpu) throw new Error(`Splat discrepancy: ${JSON.stringify(result)}`);
    self.postMessage({ ok: true, actions, result });
  } catch (error) {
    self.postMessage({ ok: false, actions, error: String(error), stack: error?.stack });
  }
};
