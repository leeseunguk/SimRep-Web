//! Rebuild the native cut-cell operator from portable cuts-v3 source geometry.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::{Engine, engine::general_purpose::STANDARD};
use bincode::Options;
use rayon::prelude::*;
use serde::Deserialize;
use simrep_core::Symmetry;
use simrep_fly::surface::{SourceGeometry, SourceSurface};
use simrep_geom::{Electrode, SignedDistance};
use simrep_io::PaFile;
use simrep_solve::cutcell::CutCells;
use simrep_solve::mg::{Geometry, Grid};

#[derive(Deserialize)]
struct Sidecar {
    version: u32,
    dims: [usize; 3],
    origin_mm: [f64; 3],
    spacing_mm: [f64; 3],
    symmetry: String,
    #[serde(default)]
    collision_only_numbers: Vec<usize>,
    source_geometry: Vec<SourceSurface>,
    surface_tolerance_mm: Option<f64>,
}

struct SolverShape {
    source: Arc<dyn SignedDistance>,
    cylindrical: bool,
    tolerance: f64,
}

impl SolverShape {
    fn point(&self, mut p: [f64; 3]) -> [f64; 3] {
        if self.cylindrical {
            p.swap(0, 1);
        }
        p
    }

    fn snap(&self, value: f64) -> f64 {
        if value.abs() <= self.tolerance {
            0.
        } else {
            value
        }
    }
}

impl SignedDistance for SolverShape {
    fn distance(&self, p: [f64; 3]) -> f64 {
        self.snap(self.source.distance(self.point(p)))
    }

    fn segment_distance_bounds(&self, from: [f64; 3], to: [f64; 3]) -> Option<[f64; 2]> {
        self.source
            .segment_distance_bounds(self.point(from), self.point(to))
            .map(|b| b.map(|d| self.snap(d)))
    }

    fn segment_single_interval(&self, from: [f64; 3], to: [f64; 3], level: f64) -> bool {
        self.source.segment_single_interval(
            self.point(from),
            self.point(to),
            if level.abs() <= self.tolerance {
                self.tolerance
            } else {
                level
            },
        )
    }

    fn segment_clear(&self, from: [f64; 3], to: [f64; 3], tolerance: f64) -> bool {
        self.source
            .segment_clear(self.point(from), self.point(to), tolerance)
    }

    fn conductor_mask(
        &self,
        dims: [usize; 3],
        origin: [f64; 3],
        spacing: [f64; 3],
        threshold: f64,
        mask: &mut [bool],
    ) -> Result<(), &'static str> {
        if self.cylindrical {
            let bad = AtomicBool::new(false);
            mask.par_iter_mut().enumerate().for_each(|(i, flag)| {
                let c = [i % dims[0], i / dims[0] % dims[1], i / (dims[0] * dims[1])];
                let point = std::array::from_fn(|a| origin[a] + c[a] as f64 * spacing[a]);
                let distance = self.distance(point);
                if !distance.is_finite() {
                    bad.store(true, Ordering::Relaxed);
                }
                *flag = distance <= threshold;
            });
            return if bad.load(Ordering::Relaxed) {
                Err("SDF returned a non-finite distance")
            } else {
                Ok(())
            };
        }
        self.source
            .conductor_mask(dims, origin, spacing, threshold.max(self.tolerance), mask)
    }

    fn mark_near_nodes(
        &self,
        dims: [usize; 3],
        origin: [f64; 3],
        spacing: [f64; 3],
        band: f64,
        near: &mut [bool],
    ) {
        if self.cylindrical {
            near.fill(true);
        } else {
            self.source
                .mark_near_nodes(dims, origin, spacing, band, near);
        }
    }
}

pub(crate) fn load(
    files: &BTreeMap<String, Vec<u8>>,
    path: &str,
    file: &PaFile,
) -> Result<Option<(CutCells, String, Vec<u8>)>, String> {
    let path = Path::new(path)
        .with_extension("cuts.json")
        .to_string_lossy()
        .into_owned();
    let Some(bytes) = files.get(&path) else {
        return Ok(None);
    };
    let sidecar: Sidecar = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if sidecar.version != 3 {
        return Err("exact refinement requires cuts-v3 source geometry".into());
    }
    let a = &file.array;
    let cylindrical = a.symmetry == Symmetry::Cylindrical;
    if sidecar.dims != [a.nx, a.ny, a.nz]
        || sidecar.spacing_mm != [a.dx_mm, a.dy_mm, a.dz_mm]
        || sidecar.symmetry != if cylindrical { "cylindrical" } else { "planar" }
    {
        return Err("cuts geometry differs from PA".into());
    }
    let tolerance = sidecar
        .surface_tolerance_mm
        .unwrap_or(1e-9 * sidecar.spacing_mm.into_iter().fold(f64::INFINITY, f64::min));
    if !tolerance.is_finite() || tolerance <= 0. {
        return Err("invalid cut-cell surface tolerance".into());
    }
    let mut electrodes = Vec::new();
    for source in sidecar.source_geometry {
        if sidecar.collision_only_numbers.contains(&source.number) {
            continue;
        }
        if !(1..=1000).contains(&source.number) {
            return Err("invalid physical electrode number".into());
        }
        let shape: Arc<dyn SignedDistance> = match source.geometry {
            SourceGeometry::Gem { data } => {
                let binary = STANDARD.decode(data).map_err(|e| e.to_string())?;
                let sdf: simrep_gem::ElectrodeSdf = bincode::DefaultOptions::new()
                    .with_fixint_encoding()
                    .with_limit(binary.len() as u64)
                    .reject_trailing_bytes()
                    .deserialize(&binary)
                    .map_err(|e| e.to_string())?;
                sdf.validate().map_err(|e| e.to_string())?;
                Arc::new(sdf)
            }
            SourceGeometry::Mesh { data, .. } => {
                let binary = STANDARD.decode(data).map_err(|e| e.to_string())?;
                let part =
                    simrep_mesh::Part::from_source_bytes(&binary).map_err(|e| e.to_string())?;
                let solid = simrep_mesh::Solid::new(&part).map_err(|e| e.to_string())?;
                Arc::new(move |p| solid.signed_distance(p))
            }
        };
        electrodes.push(Electrode::new(
            source.number as f64,
            SolverShape {
                source: shape,
                cylindrical,
                tolerance,
            },
        ));
    }
    let grid = if cylindrical {
        Grid {
            dims: [a.ny, a.nx, 1],
            spacing: [a.dy_mm, a.dx_mm, a.dz_mm],
            geometry: Geometry::Cylindrical { radial_origin: 0. },
        }
    } else {
        Grid {
            dims: sidecar.dims,
            spacing: sidecar.spacing_mm,
            geometry: Geometry::Planar,
        }
    };
    let origin = if cylindrical {
        [0., sidecar.origin_mm[0], 0.]
    } else {
        sidecar.origin_mm
    };
    let cuts = CutCells::new_with_root_tolerance(grid, origin, &electrodes, tolerance)
        .map_err(|e| e.to_string())?;
    Ok(Some((cuts, path, bytes.clone())))
}
