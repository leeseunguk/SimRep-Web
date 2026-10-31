//! Desktop export commands, writing only into the worker's byte store.
use std::path::Path;

use serde::Deserialize;
use simrep_core::PotentialArray;
use simrep_io::PaFile;
use simrep_mesh::vtk::{
    write_revolved_vts_with, write_trajectories_csv_with, write_vti_with, write_vtp_with,
};
use simrep_mesh::{
    Mesh, SurfaceOptions, Trajectory, TrajectoryPoint, Transform, electrode_surface_with_options,
    pa_isosurface,
};
use wasm_bindgen::prelude::*;

use super::{Placement, Request as FlyRequest, WasmBackend};
use crate::{decode, encode, error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Surface {
    angular_segments: usize,
    sweep_degrees: f64,
    extrusion_depth_mm: f64,
}
impl From<Surface> for SurfaceOptions {
    fn from(s: Surface) -> Self {
        Self {
            angular_segments: s.angular_segments,
            sweep_degrees: s.sweep_degrees,
            extrusion_depth_mm: s.extrusion_depth_mm,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum What {
    #[serde(rename_all = "camelCase")]
    Geometry {
        surface: Surface,
        names: Vec<(usize, String)>,
    },
    #[serde(rename_all = "camelCase")]
    Grid {
        field: bool,
        angular_segments: usize,
        sweep_degrees: f64,
    },
    Isosurface {
        potential: f64,
        surface: Surface,
    },
    Pa {
        format: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    path: String,
    voltages: Vec<(usize, f64)>,
    placement: Option<Placement>,
    what: What,
}

fn place(mesh: &mut Mesh, placement: Option<Placement>) -> Result<(), String> {
    if let Some(p) = placement {
        let mut matrix = Transform::IDENTITY.0;
        for (row, values) in matrix.iter_mut().enumerate().take(3) {
            for (column, axis) in p.axes.iter().enumerate() {
                values[column] = axis[row] * p.scale;
            }
            values[3] = p.origin[row];
        }
        for part in &mut mesh.parts {
            part.transform(Transform(matrix))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

impl WasmBackend {
    fn numbered(&self, id: &str, file: &PaFile) -> Result<PotentialArray, String> {
        let mut array = file.array.clone();
        let labels = self.electrode_labels(id).map_err(|e| format!("{e:?}"))?;
        if !labels.is_empty() {
            for (value, label) in array.potentials.iter_mut().zip(labels.as_chunks::<2>().0) {
                *value = u16::from_le_bytes(*label) as f64;
            }
        }
        Ok(array)
    }

    fn export_array_inner(&mut self, r: Request) -> Result<Vec<String>, String> {
        let source_path = self.sessions.get(&r.id).ok_or("noSession")?.clone();
        let source = decode(&self.files, Path::new(&source_path)).map_err(|e| e.to_string())?;
        let path = Path::new(&r.path);
        let mut outputs = Vec::new();
        let mut bytes = Vec::new();
        match r.what {
            What::Geometry { surface, names } => {
                let mut mesh = electrode_surface_with_options(
                    &self.numbered(&r.id, &source)?,
                    [0.; 3],
                    None,
                    surface.into(),
                )
                .map_err(|e| e.to_string())?;
                for part in &mut mesh.parts {
                    if let Some((_, name)) = names
                        .iter()
                        .find(|(n, _)| part.name == format!("electrode-{n}"))
                    {
                        part.name.clone_from(name);
                    }
                }
                place(&mut mesh, r.placement)?;
                mesh.write_to(path, &mut bytes).map_err(|e| e.to_string())?;
            }
            What::Grid {
                field,
                angular_segments,
                sweep_degrees,
            } => {
                let (_, _, array) = self.array_at(&r.id, &r.voltages)?;
                let origin = r.placement.map_or([0.; 3], |p| p.origin);
                bytes = if path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("vts"))
                {
                    write_revolved_vts_with(
                        &array,
                        origin,
                        field,
                        angular_segments,
                        sweep_degrees,
                        || Ok(Vec::new()),
                    )
                } else {
                    write_vti_with(&array, origin, field, || Ok(Vec::new()))
                }
                .map_err(|e| e.to_string())?;
            }
            What::Isosurface { potential, surface } => {
                let (_, _, array) = self.array_at(&r.id, &r.voltages)?;
                let mut mesh = pa_isosurface(&array, [0.; 3], potential, surface.into())
                    .map_err(|e| e.to_string())?;
                if mesh.parts.iter().all(|p| p.triangles.is_empty()) {
                    return Err("noIsosurface".into());
                }
                place(&mut mesh, r.placement)?;
                mesh.write_to(path, &mut bytes).map_err(|e| e.to_string())?;
            }
            What::Pa { format } => match format.as_str() {
                "pa" => {
                    let (_, mut file, array) = self.array_at(&r.id, &r.voltages)?;
                    file.array = array;
                    file.pa0 = None;
                    bytes = encode(&file).map_err(|e| e.to_string())?;
                }
                "paHash" => {
                    let mut file = PaFile::new(self.numbered(&r.id, &source)?);
                    file.array.refinable = true;
                    file.ng = source.ng;
                    bytes = encode(&file).map_err(|e| e.to_string())?;
                }
                "pa0" => {
                    let metadata = source.pa0.as_ref().ok_or("noFastAdjustSet")?;
                    let (_, mut base, array) = self.array_at(&r.id, &r.voltages)?;
                    base.array = array;
                    bytes = encode(&base).map_err(|e| e.to_string())?;
                    for (number, _) in metadata
                        .electrode_indices
                        .iter()
                        .enumerate()
                        .filter(|(_, i)| **i != -1)
                    {
                        let suffix = if number == 0 {
                            "pa_".into()
                        } else {
                            format!("pa{number}")
                        };
                        let basis = decode(
                            &self.files,
                            &Path::new(&source_path).with_extension(&suffix),
                        )
                        .map_err(|e| e.to_string())?;
                        let mut file = base.clone();
                        file.pa0 = None;
                        file.max_voltage = file.max_voltage.max(100_000.);
                        file.array.potentials = basis.array.potentials;
                        outputs.push((
                            path.with_extension(suffix).to_string_lossy().into_owned(),
                            encode(&file).map_err(|e| e.to_string())?,
                        ));
                    }
                }
                _ => return Err(format!("unknown PA format {format}")),
            },
        }
        outputs.insert(0, (r.path, bytes));
        let names = outputs
            .iter()
            .map(|(p, _)| {
                Path::new(p)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        self.files.extend(outputs);
        Ok(names)
    }
}

#[wasm_bindgen]
impl WasmBackend {
    pub fn export_array(&mut self, request: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request).map_err(error)?;
        serde_json::to_string(&self.export_array_inner(request).map_err(error)?).map_err(error)
    }

    pub fn export_trajectories(&mut self, request: &str, path: &str) -> Result<usize, JsValue> {
        let request: FlyRequest = serde_json::from_str(request).map_err(error)?;
        let record = self.run_flight(request, 0).map_err(error)?;
        let trajectories: Vec<_> = record
            .drawn
            .iter()
            .filter_map(|(index, result)| {
                let points = result
                    .trajectory
                    .as_deref()?
                    .iter()
                    .map(|s| TrajectoryPoint {
                        time_us: s.time_us,
                        position_mm: s.position_mm,
                        velocity_mm_per_us: s.velocity_mm_per_us,
                    })
                    .collect::<Vec<_>>();
                (points.len() >= 2).then_some(Trajectory {
                    id: (index + 1) as u64,
                    points,
                })
            })
            .collect();
        if trajectories.is_empty() {
            return Err(error("noTrajectories"));
        }
        let bytes = if Path::new(path)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
        {
            write_trajectories_csv_with(&trajectories, || Ok(Vec::new()))
        } else {
            write_vtp_with(&trajectories, || Ok(Vec::new()))
        }
        .map_err(error)?;
        self.files.insert(path.into(), bytes);
        Ok(trajectories.len())
    }
}
