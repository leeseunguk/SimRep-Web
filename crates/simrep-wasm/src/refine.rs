//! Cooperative multigrid jobs. Each step performs at most one V-cycle.
//!
//! Keep the solver's gauge between calls: adding the Dirichlet origin after
//! every cycle would round the iterate and break native byte identity.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use simrep_core::{PotentialArray, Symmetry};
use simrep_io::{Pa0Metadata, PaFile};
use simrep_solve::cutcell::CutCells;
use simrep_solve::mg::{self, Geometry, Grid, Options};
use wasm_bindgen::prelude::*;

use super::{
    WasmBackend, anti_mirror, decode, electrode_number, encode, error, packet_at, transpose,
};
#[path = "exact.rs"]
mod exact;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    output_dir: Option<String>,
    #[serde(default = "cpu")]
    device: String,
    #[serde(default)]
    voltages: Vec<(usize, f64)>,
    #[serde(default = "tolerance")]
    tolerance: f64,
    #[serde(default = "max_cycles")]
    max_cycles: usize,
}
fn cpu() -> String {
    "cpu".into()
}
fn tolerance() -> f64 {
    1e-10
}
fn max_cycles() -> usize {
    200
}

struct Stage {
    file: PaFile,
    values: Vec<f64>,
    fixed: Vec<bool>,
    grid: Grid,
    cuts: Option<CutCells>,
    gauge: f64,
    cylindrical: bool,
    cycles: usize,
}

impl Stage {
    fn new(mut file: PaFile, cuts: Option<CutCells>) -> Result<Self, String> {
        let array = &mut file.array;
        let mut fixed = array.electrodes.clone();
        for (i, constraint) in fixed.iter_mut().enumerate() {
            if anti_mirror(array, i) {
                if array.electrodes[i] && array.potentials[i] != 0. {
                    return Err("nonzero electrode on an anti-mirror plane".into());
                }
                *constraint = true;
                array.potentials[i] = 0.;
            }
        }
        let cylindrical = array.symmetry == Symmetry::Cylindrical;
        let grid = if cylindrical {
            fixed = transpose(&fixed, array.nx, array.ny);
            Grid {
                dims: [array.ny, array.nx, 1],
                spacing: [array.dy_mm, array.dx_mm, array.dz_mm],
                geometry: Geometry::Cylindrical { radial_origin: 0. },
            }
        } else {
            Grid {
                dims: [array.nx, array.ny, array.nz],
                spacing: [array.dx_mm, array.dy_mm, array.dz_mm],
                geometry: Geometry::Planar,
            }
        };
        let mut values = if cylindrical {
            transpose(&array.potentials, array.nx, array.ny)
        } else {
            array.potentials.clone()
        };
        if let Some(cuts) = &cuts {
            fixed.clone_from(&cuts.fixed);
            values.clone_from(&cuts.values);
        }
        let first = fixed
            .iter()
            .position(|&f| f)
            .ok_or("PA has no electrodes")?;
        let gauge = values[first];
        for value in &mut values {
            *value -= gauge;
        }
        let cuts = cuts
            .map(|c| c.with_voltages(|v| v - gauge))
            .transpose()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            file,
            values,
            fixed,
            grid,
            cuts,
            gauge,
            cylindrical,
            cycles: 0,
        })
    }

    fn array(&self) -> PotentialArray {
        let mut result = self.file.array.clone();
        let values: Vec<_> = self.values.iter().map(|v| v + self.gauge).collect();
        result.potentials = if self.cylindrical {
            transpose(&values, self.grid.dims[0], self.grid.dims[1])
        } else {
            values
        };
        result
    }
}

#[wasm_bindgen]
pub struct RefineJob {
    id: String,
    source: PaFile,
    output: PathBuf,
    options: Options,
    voltages: Vec<(usize, f64)>,
    indices: Vec<i64>,
    stages: Vec<Option<usize>>,
    stage_index: usize,
    active: Option<Stage>,
    cuts: Option<CutCells>,
    sidecar: Option<(String, Vec<u8>)>,
    base: PaFile,
    outputs: BTreeMap<String, Vec<u8>>,
    total_cycles: usize,
    residual: f64,
    compute_ms: f64,
    prep_ms: f64,
    cancelled: bool,
    finished: bool,
    adjustable: bool,
}

impl RefineJob {
    fn new(backend: &WasmBackend, request: Request) -> Result<Self, String> {
        let prep = web_time::Instant::now();
        if request.device == "gpu" {
            return Err("unsupported in browser: GPU refine".into());
        }
        if !["cpu", "auto"].contains(&request.device.as_str()) {
            return Err("invalid refine device".into());
        }
        let path = backend.sessions.get(&request.id).ok_or("noSession")?;
        let source = decode(&backend.files, Path::new(path)).map_err(|e| e.to_string())?;
        if !source.array.refinable {
            return Err("PA is marked non-refinable (field map)".into());
        }
        let extension = Path::new(path)
            .extension()
            .unwrap_or_default()
            .to_string_lossy();
        let adjustable = extension.eq_ignore_ascii_case("pa#");
        if !adjustable && !extension.eq_ignore_ascii_case("pa") {
            return Err("refine input must have a .pa or .pa# extension".into());
        }
        if !request.tolerance.is_finite() || request.tolerance <= 0. {
            return Err("tolerance must be finite and positive".into());
        }
        let output = request.output_dir.as_ref().map_or_else(
            || PathBuf::from(path),
            |dir| Path::new(dir).join(Path::new(path).file_name().unwrap_or_default()),
        );
        let mut indices = vec![-1; 1001];
        if adjustable {
            for (i, (&v, &fixed)) in source
                .array
                .potentials
                .iter()
                .zip(&source.array.electrodes)
                .enumerate()
            {
                if fixed {
                    let n = electrode_number(v).unwrap_or(0);
                    if indices[n] == -1
                        || (n == 0 && v.abs() > source.array.potentials[indices[n] as usize].abs())
                    {
                        indices[n] = i as i64;
                    }
                }
            }
            let end = indices
                .iter()
                .rposition(|&v| v != -1)
                .ok_or("PA# has no electrodes")?;
            indices.truncate((end + 1).max(32));
        }
        let mut seen = std::collections::BTreeSet::new();
        for &(n, v) in &request.voltages {
            if !v.is_finite() || !seen.insert(n) || indices.get(n).is_none_or(|&i| i == -1) {
                return Err("unknown, duplicate or invalid electrode voltage".into());
            }
        }
        let stages = if adjustable {
            indices
                .iter()
                .enumerate()
                .filter_map(|(n, &i)| (i != -1).then_some((n != 0).then_some(n)))
                .collect()
        } else {
            vec![None]
        };
        let (cuts, sidecar) = if adjustable {
            match exact::load(&backend.files, path, &source)? {
                Some((cuts, path, bytes)) => (Some(cuts), Some((path, bytes))),
                None => match backend.desktop_state.prepared(Path::new(path)) {
                    Some(prepared) => (Some(prepared.cut_cells(None)?), None),
                    None => (None, None),
                },
            }
        } else {
            (None, None)
        };
        let mut base = source.clone();
        if adjustable {
            base.array.potentials.fill(0.);
        }
        Ok(Self {
            id: request.id,
            source,
            output,
            options: Options {
                relative_tolerance: request.tolerance,
                max_cycles: request.max_cycles,
                ..Options::default()
            },
            voltages: request.voltages,
            indices,
            stages,
            stage_index: 0,
            active: None,
            cuts,
            sidecar,
            base,
            outputs: BTreeMap::new(),
            total_cycles: 0,
            residual: 0.,
            compute_ms: 0.,
            prep_ms: prep.elapsed().as_secs_f64() * 1000.,
            cancelled: false,
            finished: false,
            adjustable,
        })
    }

    fn begin_stage(&mut self) -> Result<(), String> {
        let mut file = self.source.clone();
        let slot = self.stages[self.stage_index].unwrap_or(0);
        if self.adjustable {
            let scalable = if self.indices[0] == -1 {
                0.
            } else {
                self.source.array.potentials[self.indices[0] as usize]
            };
            file.pa0 = None;
            file.max_voltage = self.source.max_voltage.max(100_000.);
            for (i, value) in file.array.potentials.iter_mut().enumerate() {
                let input = self.source.array.potentials[i];
                *value = if !self.source.array.electrodes[i] {
                    0.
                } else if slot == 0 && electrode_number(input).is_none() {
                    if scalable == 0. {
                        0.
                    } else {
                        (input / scalable) * 10_000.
                    }
                } else if electrode_number(input) == Some(slot) {
                    10_000.
                } else {
                    0.
                };
            }
        }
        let cuts = self
            .cuts
            .as_ref()
            .map(|c| {
                c.with_voltages(|v| {
                    if electrode_number(v) == Some(slot) {
                        10_000.
                    } else {
                        0.
                    }
                })
            })
            .transpose()
            .map_err(|e| e.to_string())?;
        self.active = Some(Stage::new(file, cuts)?);
        Ok(())
    }

    fn finish_stage(&mut self) -> Result<(), String> {
        let stage = self.active.take().unwrap();
        let mut file = stage.file.clone();
        file.array = stage.array();
        let slot = self.stages[self.stage_index].unwrap_or(0);
        let path = if self.adjustable {
            self.output.with_extension(if slot == 0 {
                "pa_".into()
            } else {
                format!("pa{slot}")
            })
        } else {
            self.output.clone()
        };
        if self.adjustable {
            let voltage = if slot == 0 {
                self.source.array.potentials[self.indices[0] as usize]
            } else {
                self.voltages
                    .iter()
                    .find(|v| v.0 == slot)
                    .map_or(0., |v| v.1)
            };
            for (i, (out, &basis)) in self
                .base
                .array
                .potentials
                .iter_mut()
                .zip(&file.array.potentials)
                .enumerate()
            {
                if slot == 0 && self.source.array.electrodes[i] {
                    let input = self.source.array.potentials[i];
                    *out = if electrode_number(input).is_none() {
                        input
                    } else {
                        0.
                    };
                } else {
                    *out += basis * (voltage / 10_000.);
                }
            }
        } else {
            self.base = file.clone();
        }
        self.outputs.insert(
            path.to_string_lossy().into_owned(),
            encode(&file).map_err(|e| e.to_string())?,
        );
        self.stage_index += 1;
        if self.stage_index == self.stages.len() {
            if self.adjustable {
                self.base.pa0 = Some(Pa0Metadata {
                    reference_voltage: 10_000.,
                    electrode_indices: self.indices.clone(),
                    scalable: None,
                });
                self.outputs.insert(
                    self.output
                        .with_extension("pa0")
                        .to_string_lossy()
                        .into_owned(),
                    encode(&self.base).map_err(|e| e.to_string())?,
                );
            }
            if let Some((_, bytes)) = &self.sidecar {
                self.outputs.insert(
                    self.output
                        .with_extension("cuts.json")
                        .to_string_lossy()
                        .into_owned(),
                    bytes.clone(),
                );
            }
            self.finished = true;
        }
        Ok(())
    }
}

#[wasm_bindgen]
impl RefineJob {
    pub fn start_message(&self) -> String {
        json!({"type":"start","device":{"kind":"cpu","name":"CPU","threads":rayon::current_num_threads()},"stages":self.stages,"points":self.source.array.potentials.len(),"tolerance":self.options.relative_tolerance,"maxCycles":self.options.max_cycles}).to_string()
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
    }

    pub fn step(&mut self) -> Result<String, JsValue> {
        self.step_inner().map(|v| v.to_string()).map_err(error)
    }

    pub fn preview(&self) -> Vec<u8> {
        let array = self
            .active
            .as_ref()
            .map_or_else(|| self.base.array.clone(), Stage::array);
        let mut bytes = Vec::with_capacity(8 + 4 * array.potentials.len());
        bytes.extend_from_slice(b"SPV1");
        bytes
            .extend_from_slice(&(self.stage_index.min(self.stages.len() - 1) as u32).to_le_bytes());
        for v in array.potentials {
            bytes.extend_from_slice(&(v as f32).to_le_bytes());
        }
        bytes
    }

    pub fn result_packet(&self) -> Result<Vec<u8>, JsValue> {
        if !self.finished || self.cancelled {
            return Err(error("refine job has no committed result"));
        }
        let path = self.result_path();
        let fast = super::fast_status(&self.outputs, &path, &self.base, &[]);
        Ok(packet_at(
            &self.outputs,
            &self.base,
            &path,
            self.outputs[&path].len(),
            fast,
            false,
        ))
    }

    pub fn summary(&self) -> String {
        json!({"converged":self.finished && !self.cancelled,"cycles":self.total_cycles,"final_residual":self.residual,"tolerance":self.options.relative_tolerance,"compute_ms":self.compute_ms,"prep_ms":self.prep_ms,"threads":rayon::current_num_threads(),"executed":{"device":"cpu","precision":"f64","backend":null},"output_paths":self.outputs.keys().collect::<Vec<_>>(),"cutcell":self.cuts.is_some()}).to_string()
    }
}

impl RefineJob {
    fn result_path(&self) -> String {
        if self.adjustable {
            self.output.with_extension("pa0")
        } else {
            self.output.clone()
        }
        .to_string_lossy()
        .into_owned()
    }

    fn step_inner(&mut self) -> Result<Value, String> {
        if self.finished {
            return Err("refine job already ended".into());
        }
        if self.cancelled {
            self.finished = true;
            self.outputs.clear();
            return Ok(json!({"terminal":true,"messages":[{"type":"cancelled"}]}));
        }
        if self.active.is_none() {
            self.begin_stage()?;
        }
        let stage_index = self.stage_index;
        let active = self.active.as_mut().unwrap();
        let options = Options {
            max_cycles: usize::from(active.cycles < self.options.max_cycles),
            ..self.options
        };
        let report = if let Some(cuts) = &active.cuts {
            cuts.solve(&mut active.values, options)
        } else {
            mg::solve(&mut active.values, &active.fixed, active.grid, options)
        }
        .map_err(|e| e.to_string())?;
        self.compute_ms += report.timings.solve.as_secs_f64() * 1000.;
        self.prep_ms += report.timings.setup.as_secs_f64() * 1000.;
        let mut messages = Vec::new();
        if active.cycles == 0 {
            let initial = report.residual_history[0];
            messages.push(json!({"type":"progress","stage":stage_index,"cycle":0,"residual":initial.relative,"absolute":initial.absolute,"elapsedMs":self.compute_ms + self.prep_ms}));
        }
        active.cycles += report.iterations;
        self.total_cycles += report.iterations;
        let residual = *report.residual_history.last().unwrap();
        if report.iterations > 0 {
            messages.push(json!({"type":"progress","stage":stage_index,"cycle":active.cycles,"residual":residual.relative,"absolute":residual.absolute,"elapsedMs":self.compute_ms + self.prep_ms}));
        }
        if report.converged {
            self.residual = self.residual.max(residual.relative);
            messages.push(json!({"type":"stageDone","stage":stage_index,"cycles":active.cycles,"residual":residual.relative}));
            self.finish_stage()?;
        } else if active.cycles >= self.options.max_cycles {
            return Err(format!(
                "refinement did not converge after {} cycles",
                active.cycles
            ));
        }
        if self.finished {
            messages.push(json!({"type":"done","files":self.outputs.keys().map(|p| Path::new(p).file_name().unwrap_or_default().to_string_lossy()).collect::<Vec<_>>(),"dir":self.output.parent().unwrap_or(Path::new("")).to_string_lossy(),"ms":self.compute_ms + self.prep_ms,"cycles":self.total_cycles,"residual":self.residual,"device":{"kind":"cpu","name":"CPU","threads":rayon::current_num_threads()}}));
        }
        Ok(json!({"terminal":self.finished,"messages":messages}))
    }
}

#[wasm_bindgen]
impl WasmBackend {
    pub fn refine_begin(&self, request: &str) -> Result<RefineJob, JsValue> {
        RefineJob::new(self, serde_json::from_str(request).map_err(error)?).map_err(error)
    }

    pub fn refine_commit(&mut self, job: &RefineJob) -> Result<(), JsValue> {
        if !job.finished || job.cancelled {
            return Err(error("refine job did not finish"));
        }
        self.files.extend(job.outputs.clone());
        self.sessions.insert(job.id.clone(), job.result_path());
        Ok(())
    }

    pub fn refine_targets(&self, request: &str) -> Result<String, JsValue> {
        let request: Value = serde_json::from_str(request).map_err(error)?;
        let id = request["id"]
            .as_str()
            .ok_or_else(|| error("missing session id"))?;
        let job = RefineJob::new(
            self,
            Request {
                id: id.into(),
                output_dir: request["outputDir"].as_str().map(str::to_owned),
                device: cpu(),
                voltages: Vec::new(),
                tolerance: tolerance(),
                max_cycles: max_cycles(),
            },
        )
        .map_err(error)?;
        let files: Vec<_> = job.stages.iter().map(|&n| {
            let path = if job.adjustable { job.output.with_extension(n.map_or_else(|| "pa_".into(), |n| format!("pa{n}"))) } else { job.output.clone() };
            json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"exists":self.files.contains_key(&path.to_string_lossy().into_owned())})
        }).chain(job.adjustable.then(|| { let path = job.output.with_extension("pa0"); json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"exists":self.files.contains_key(&path.to_string_lossy().into_owned())}) })).collect();
        Ok(json!({"dir":job.output.parent().unwrap_or(Path::new("")).to_string_lossy(),"files":files,"cutcell":job.cuts.is_some()}).to_string())
    }
}
