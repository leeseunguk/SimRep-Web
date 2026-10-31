//! The existing CPU f64 flyer, with in-memory sources and desktop packets.
use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use simrep_core::PotentialArray;
use simrep_fly::physics::magnetic::{
    Coil, Electromagnetic, MagneticField, MagneticPa, PreparedMagneticField,
};
use simrep_fly::surface::SurfaceModel;
use simrep_fly::{
    FlightOptions, FlightResult, GridField, InstanceField, Particle, Reconstruction, fly_many,
};
use simrep_io::PaFile;
use simrep_io::fast_adjust::read_fast_adjust_with;
use wasm_bindgen::prelude::*;
use web_time::Instant;

#[path = "../export.rs"]
mod export;
mod packet;
mod source;
mod trace;
use super::{WasmBackend, decode, error};
use source::CoilInput;
pub(crate) use source::{Placement, Request};

pub(crate) struct Record {
    pub(crate) request: Request,
    pub(crate) particles: Vec<Particle>,
    pub(crate) results: Vec<FlightResult>,
    pub(crate) drawn: Vec<(usize, FlightResult)>,
    file: PaFile,
    labels: Vec<u16>,
    surface_path: Option<String>,
    field_ms: f64,
    fly_ms: f64,
    paths_ms: f64,
    total_ms: f64,
    pub(crate) token: u32,
}

struct World {
    file: PaFile,
    electric: InstanceField,
    magnetic: MagneticField,
    particles: Vec<Particle>,
    options: FlightOptions,
    labels: Vec<u16>,
    surface_path: Option<String>,
    bounds: Option<[[f64; 3]; 2]>,
    prep_ms: f64,
}

impl WasmBackend {
    pub(crate) fn array_at(
        &self,
        id: &str,
        voltages: &[(usize, f64)],
    ) -> Result<(String, PaFile, PotentialArray), String> {
        let path = self.sessions.get(id).ok_or("noSession")?.clone();
        let file = decode(&self.files, Path::new(&path)).map_err(|e| e.to_string())?;
        if Path::new(&path)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pa#"))
        {
            return Err("array must be refined before flying or exporting fields".into());
        }
        let array = if file.pa0.is_some() {
            read_fast_adjust_with(&path, voltages, |p| decode(&self.files, p))
                .map_err(|e| e.to_string())?
        } else {
            if !voltages.is_empty() {
                return Err("electrode voltages require a PA0 basis family".into());
            }
            file.array.clone()
        };
        Ok((path, file, array))
    }

    fn world(&self, request: &Request) -> Result<World, String> {
        let started = Instant::now();
        let options = request.options()?;
        let (path, file, array) = self.array_at(&request.id, &request.voltages)?;
        let place = request.placement.unwrap_or_default();
        let bounds = request
            .bounds
            .map(|b| [[b[0], b[1], b[2]], [b[3], b[4], b[5]]]);
        let plane = request.plane.map(|p| ([p[0], p[1], p[2]], p[3]));
        let grid = GridField::with_reconstruction(array, Reconstruction::BoundaryAware)
            .map_err(|e| e.to_string())?;
        let grid = if request.collision == "nearestNode" {
            grid.with_nearest_node_collisions()
        } else {
            grid
        };
        let mut electric =
            InstanceField::new(grid, place.origin, place.axes, place.scale, bounds, plane)
                .map_err(|e| e.to_string())?;
        let sibling = Path::new(&path)
            .with_extension("cuts.json")
            .to_string_lossy()
            .into_owned();
        let surface_path = if request.surfaces {
            request
                .cuts
                .clone()
                .or_else(|| self.files.contains_key(&sibling).then_some(sibling))
        } else {
            None
        };
        if let Some(path) = &surface_path {
            let bytes = self
                .files
                .get(path)
                .ok_or_else(|| format!("cuts file not found: {path}"))?;
            let surfaces = SurfaceModel::from_reader(bytes.as_slice())
                .map_err(|e| e.to_string())?
                .with_tolerance(options.position_tolerance_mm / place.scale)
                .map_err(|e| e.to_string())?;
            electric = electric
                .with_surface(Arc::new(surfaces))
                .map_err(|e| e.to_string())?;
        }
        let mut magnetic = MagneticField {
            uniform_gauss: request.bfield.unwrap_or([0.; 3]),
            ..Default::default()
        };
        if magnetic.uniform_gauss.iter().any(|v| !v.is_finite()) {
            return Err("uniform magnetic field must be finite".into());
        }
        for path in &request.magnetic_pa {
            let pa = decode(&self.files, Path::new(path)).map_err(|e| e.to_string())?;
            let mut field = MagneticPa::placed(
                pa.array,
                pa.ng as f64,
                place.origin,
                place.axes,
                place.scale,
                bounds,
            )
            .map_err(|e| e.to_string())?;
            let sidecar = Path::new(path)
                .with_extension("mag.json")
                .to_string_lossy()
                .into_owned();
            if let Some(bytes) = self.files.get(&sidecar) {
                let data: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
                if data["version"] != 1
                    || data["formulation"] != "scalar"
                    || !data["components"].is_null()
                {
                    return Err("magnetic PA requires a version 1 scalar sidecar".into());
                }
                let cells = serde_json::from_value(data["solid_cells"].clone())
                    .map_err(|e| e.to_string())?;
                field = field
                    .with_material_cells(cells)
                    .map_err(|e| e.to_string())?;
            }
            magnetic.arrays.push(field);
        }
        let mut coils = request.coils.clone();
        if let Some(path) = &request.bfield_coil {
            let bytes = self
                .files
                .get(path)
                .ok_or_else(|| format!("coil file not found: {path}"))?;
            coils.extend(
                serde_json::from_slice::<Vec<CoilInput>>(bytes).map_err(|e| e.to_string())?,
            );
        }
        for coil in coils {
            match coil {
                CoilInput::Segment {
                    first_mm,
                    last_mm,
                    current_a,
                } => magnetic
                    .coils
                    .push(Coil::segment(first_mm, last_mm, current_a).map_err(|e| e.to_string())?),
                CoilInput::Loop {
                    center_mm,
                    normal,
                    radius_mm,
                    current_a,
                } => magnetic.coils.push(
                    Coil::hoop(center_mm, normal, radius_mm, current_a)
                        .map_err(|e| e.to_string())?,
                ),
                CoilInput::Solenoid {
                    first_mm,
                    last_mm,
                    radius_mm,
                    current_a,
                    turns,
                } => magnetic.coils.extend(
                    MagneticField::solenoid(first_mm, last_mm, radius_mm, current_a, turns)
                        .map_err(|e| e.to_string())?
                        .coils,
                ),
            }
        }
        let labels = self
            .electrode_labels(&request.id)
            .map_err(|e| format!("{e:?}"))?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect();
        let particles = request.particles(&self.files)?;
        Ok(World {
            file,
            electric,
            magnetic,
            particles,
            options,
            labels,
            surface_path,
            bounds,
            prep_ms: started.elapsed().as_secs_f64() * 1000.,
        })
    }

    pub(crate) fn run_flight(&self, request: Request, token: u32) -> Result<Record, String> {
        let started = Instant::now();
        let World {
            file,
            electric,
            magnetic,
            particles,
            options,
            labels,
            surface_path,
            bounds,
            prep_ms,
        } = self.world(&request)?;
        let prepared = if request.exact_coils {
            PreparedMagneticField::exact(&magnetic)
        } else {
            magnetic
                .prepare_coil_map(bounds)
                .map_err(|e| e.to_string())?
        };
        let field = Electromagnetic {
            electric,
            magnetic: prepared,
        };
        let compute = Instant::now();
        let results = fly_many(&field, &particles, &options).map_err(|e| e.to_string())?;
        let fly_ms = compute.elapsed().as_secs_f64() * 1000.;
        let paths = Instant::now();
        let count = (if request.draw == 0 { 300 } else { request.draw })
            .min(10_000)
            .min(particles.len());
        let picks: Vec<_> = (0..count).map(|k| k * particles.len() / count).collect();
        let subset: Vec<_> = picks.iter().map(|&i| particles[i].clone()).collect();
        let drawn = fly_many(
            &field,
            &subset,
            &FlightOptions {
                sample_every: Some(1),
                ..options
            },
        )
        .map_err(|e| e.to_string())?;
        let drawn = picks.into_iter().zip(drawn).collect();
        let paths_ms = paths.elapsed().as_secs_f64() * 1000.;
        Ok(Record {
            request,
            particles,
            results,
            drawn,
            file,
            labels,
            surface_path,
            field_ms: prep_ms,
            fly_ms,
            paths_ms,
            total_ms: started.elapsed().as_secs_f64() * 1000.,
            token,
        })
    }
}

#[wasm_bindgen]
impl WasmBackend {
    pub fn fly(&mut self, request: &str) -> Result<Vec<u8>, JsValue> {
        let request: Request = serde_json::from_str(request).map_err(error)?;
        self.next_token += 1;
        let record = self.run_flight(request, self.next_token).map_err(error)?;
        let bytes = packet::flight_packet(&record);
        let old: Vec<_> = self
            .flights
            .iter()
            .filter_map(|(&n, r)| (r.request.id == record.request.id).then_some(n))
            .collect();
        if old.len() >= 4 {
            self.flights.remove(&old[0]);
        }
        self.flights.insert(record.token, record);
        Ok(bytes)
    }

    pub fn flight_velocities(&self, id: &str, token: u32) -> Result<Vec<u8>, JsValue> {
        let record = self
            .flights
            .get(&token)
            .filter(|r| r.request.id == id)
            .ok_or_else(|| error("flightExpired"))?;
        Ok(record
            .results
            .iter()
            .flat_map(|r| r.final_state.velocity_mm_per_us)
            .flat_map(f64::to_le_bytes)
            .collect())
    }

    pub fn flight_csv(&self, id: &str, token: u32) -> Result<Vec<u8>, JsValue> {
        let record = self
            .flights
            .get(&token)
            .filter(|r| r.request.id == id)
            .ok_or_else(|| error("flightExpired"))?;
        Ok(packet::csv(record).into_bytes())
    }

    pub fn flight_summary(&self, id: &str, token: u32) -> Result<String, JsValue> {
        let record = self
            .flights
            .get(&token)
            .filter(|r| r.request.id == id)
            .ok_or_else(|| error("flightExpired"))?;
        Ok(json!({"ion_count":record.results.len(),"compute_ms":record.fly_ms,"prep_ms":record.field_ms,"threads":rayon::current_num_threads(),"executed":{"device":"cpu","precision":"f64","surface_mode":if record.surface_path.is_some(){"exact"}else{"staircase"}},"splat_counts":packet::counts(record),"arrival_tof_us":packet::arrival_statistics(record)}).to_string())
    }
}
