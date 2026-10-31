// Call in the worker that will execute WebGPU, not only in the page.
export async function webGpuCapabilities() {
  if (!globalThis.navigator?.gpu) {
    return { available: false, reason: 'navigator.gpu is unavailable', precision: 'f32', f64: false };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    return { available: false, reason: 'No WebGPU adapter', precision: 'f32', f64: false };
  }
  const limits = Object.fromEntries([
    'maxBufferSize', 'maxStorageBufferBindingSize',
    'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupsPerDimension',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX',
  ].map(name => [name, adapter.limits[name]]));
  return {
    available: limits.maxStorageBuffersPerShaderStage >= 8,
    precision: 'f32', f64: false, shaderF16Required: false,
    timestampQuery: adapter.features.has('timestamp-query'),
    limits,
    adapter: adapter.info ? {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
    } : null,
  };
}

export function requireWebGpuPrecision(precision) {
  if (precision !== 'f32') {
    throw new Error('WebGPU supports only f32 kernels; use CPU wasm for f64');
  }
}
