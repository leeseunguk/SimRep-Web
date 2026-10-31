//! Optional WebGPU entry points. See docs/webgpu.md for the feature hook.
use serde::{Deserialize, Serialize};
use simrep_solve::mg::{Geometry, Grid, Options};
use simrep_solve::webgpu::Gpu;
use wasm_bindgen::prelude::*;

fn error(value: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&value.to_string()).into()
}

#[wasm_bindgen]
pub struct WebGpuSession {
    gpu: Gpu,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolveRequest {
    potential: Vec<f64>,
    mask: Vec<bool>,
    dims: [usize; 3],
    spacing_mm: [f64; 3],
    relative_tolerance: f64,
    absolute_tolerance: f64,
    max_cycles: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SolveResponse {
    potential: Vec<f64>,
    converged: bool,
    cycles: usize,
    residual: f64,
    compute_ms: Option<f64>,
    device: &'static str,
    precision: &'static str,
}

#[wasm_bindgen]
impl WebGpuSession {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(precision: String) -> Result<WebGpuSession, JsValue> {
        Gpu::require_precision(&precision).map_err(error)?;
        let gpu = Gpu::new()
            .await
            .map_err(error)?
            .ok_or_else(|| error("WebGPU adapter unavailable; select CPU f64"))?;
        Ok(Self { gpu })
    }

    /// Report actual selected-device limits, not navigator guesses.
    pub fn capabilities(&self) -> Result<JsValue, JsValue> {
        let limits = self.gpu.device.limits();
        serde_json::json!({
            "device": "gpu",
            "precision": "f32",
            "f64": false,
            "shaderF16Required": false,
            "backend": "webgpu",
            "adapter": self.gpu.info.name,
            "limits": {
                "maxBufferSize": limits.max_buffer_size,
                "maxStorageBufferBindingSize": limits.max_storage_buffer_binding_size,
                "maxStorageBuffersPerShaderStage": limits.max_storage_buffers_per_shader_stage,
                "maxComputeWorkgroupsPerDimension": limits.max_compute_workgroups_per_dimension
            },
            "supported": ["staircaseCorrection", "packedStaircaseFlight"],
            "unsupported": ["f64", "exactSurfaces", "sdfSurfaces", "timeVaryingVoltages", "collisions"]
        })
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(error)
    }

    pub async fn solve(&self, request: JsValue, precision: String) -> Result<JsValue, JsValue> {
        Gpu::require_precision(&precision).map_err(error)?;
        let mut request: SolveRequest = serde_wasm_bindgen::from_value(request).map_err(error)?;
        let report = self
            .gpu
            .solve(
                &mut request.potential,
                &request.mask,
                Grid {
                    dims: request.dims,
                    spacing: request.spacing_mm,
                    geometry: Geometry::Planar,
                },
                Options {
                    relative_tolerance: request.relative_tolerance,
                    absolute_tolerance: request.absolute_tolerance,
                    max_cycles: request.max_cycles,
                    ..Options::default()
                },
            )
            .await
            .map_err(error)?;
        serde_wasm_bindgen::to_value(&SolveResponse {
            potential: request.potential,
            converged: report.converged,
            cycles: report.cycles,
            residual: report.residual,
            compute_ms: report.compute_ms,
            device: "gpu",
            precision: "mixed-f32-f64",
        })
        .map_err(error)
    }

    /// Packed native f32 GPU ABI, not a desktop fly IPC request. The worker
    /// must explicitly adapt its reconstructed field before calling this.
    pub async fn fly(&self, input: JsValue, precision: String) -> Result<JsValue, JsValue> {
        Gpu::require_precision(&precision).map_err(error)?;
        let input: simrep_fly::webgpu::FlightInput =
            serde_wasm_bindgen::from_value(input).map_err(error)?;
        let output = simrep_fly::webgpu::fly(&self.gpu, &input)
            .await
            .map_err(error)?;
        serde_wasm_bindgen::to_value(&output).map_err(error)
    }
}
