//! Browser geometry commands. Inputs and outputs live only in the byte registry.
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use simrep_core::{FieldType, PotentialArray, Symmetry};
use simrep_fly::surface::{SourceGeometry, SourceSurface};
use simrep_geom::{Electrode, SignedDistance};
use simrep_io::PaFile;
use simrep_mesh::{GridSpec, ImportOptions, Mesh, Solid, Transform, read_mesh_with, repair};
use simrep_solve::cutcell::{CutCells, surface_fraction};
use simrep_solve::mg::{Geometry, Grid};
use wasm_bindgen::prelude::*;

use crate::{WasmBackend, encode, error, transpose};

mod gap;

pub(super) type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    path: String,
    output: Option<String>,
    grid: Option<[usize; 3]>,
    spacing: Option<[f64; 3]>,
    #[serde(default)]
    origin: [f64; 3],
    units: Option<String>,
    #[serde(default)]
    repair: bool,
    transform: Option<[f64; 12]>,
    #[serde(default)]
    electrodes: Vec<u32>,
    #[serde(default)]
    assignments: Vec<Assignment>,
    #[serde(default)]
    insulators: Vec<String>,
    #[serde(default)]
    allow_defects: bool,
    #[serde(default = "warn")]
    gap_check: String,
}

fn warn() -> String {
    "warn".into()
}

#[derive(Clone, Deserialize, Serialize)]
struct Assignment {
    part: String,
    number: usize,
    voltage: f64,
}

enum GapSource {
    Gem([[f64; 3]; 2]),
    Mesh(Arc<Solid>),
}

struct Part {
    name: String,
    shape: Arc<dyn SignedDistance>,
    assignment: Assignment,
    source: SourceGeometry,
    gap_source: GapSource,
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
    fn snap(&self, d: f64) -> f64 {
        if d.abs() <= self.tolerance { 0.0 } else { d }
    }
}

impl SignedDistance for SolverShape {
    fn distance(&self, p: [f64; 3]) -> f64 {
        self.snap(self.source.distance(self.point(p)))
    }
    fn segment_distance_bounds(&self, from: [f64; 3], to: [f64; 3]) -> Option<[f64; 2]> {
        self.source
            .segment_distance_bounds(self.point(from), self.point(to))
            .map(|v| v.map(|d| self.snap(d)))
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
    ) -> std::result::Result<(), &'static str> {
        if self.cylindrical {
            for (i, flag) in mask.iter_mut().enumerate() {
                let p = point(i, dims, origin, spacing);
                let d = self.distance(p);
                if !d.is_finite() {
                    return Err("SDF returned a non-finite distance");
                }
                *flag = d <= threshold;
            }
            Ok(())
        } else {
            self.source
                .conductor_mask(dims, origin, spacing, threshold.max(self.tolerance), mask)
        }
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

#[derive(Serialize)]
struct Sidecar {
    version: u32,
    dims: [usize; 3],
    origin_mm: [f64; 3],
    spacing_mm: [f64; 3],
    symmetry: &'static str,
    mirrors: [bool; 3],
    electrode_numbers: Vec<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    collision_only_numbers: Vec<usize>,
    source_geometry: Vec<SourceSurface>,
    assignments: Vec<Assignment>,
    surface_tolerance_mm: f64,
    snap_distance_mm: f64,
    sampled_sdfs: Vec<Value>,
    node_electrode_runs: Vec<(usize, usize, Option<usize>)>,
    solver_fixed_runs: Vec<(usize, usize, bool)>,
    link_intersections: Vec<PhysicalCuts>,
}

#[derive(Serialize)]
struct PhysicalCuts {
    node: usize,
    fractions: [Option<f64>; 6],
    electrodes: [Option<usize>; 6],
}

fn runs<T: PartialEq + Copy>(values: &[T]) -> Vec<(usize, usize, T)> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < values.len() {
        let end = start
            + values[start..]
                .iter()
                .position(|v| *v != values[start])
                .unwrap_or(values.len() - start);
        out.push((start, end, values[start]));
        start = end;
    }
    out
}

fn point(i: usize, dims: [usize; 3], origin: [f64; 3], spacing: [f64; 3]) -> [f64; 3] {
    let c = [i % dims[0], i / dims[0] % dims[1], i / (dims[0] * dims[1])];
    std::array::from_fn(|a| origin[a] + c[a] as f64 * spacing[a])
}

fn validate(dims: [usize; 3], origin: [f64; 3], spacing: [f64; 3]) -> Result<()> {
    let n = GridSpec {
        dims,
        origin_mm: origin,
        spacing_mm: spacing,
    }
    .validate()?;
    if dims[0] < 2 || dims[1] < 2 || n > 40_000_000 {
        return Err("geometry requires nx,ny >= 2 and at most 40000000 points".into());
    }
    Ok(())
}

fn load(files: &BTreeMap<String, Vec<u8>>, path: &Path) -> io::Result<Vec<u8>> {
    let path = path.to_string_lossy();
    files
        .get(path.as_ref())
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("file not found: {path}")))
}

fn gem(files: &BTreeMap<String, Vec<u8>>, request: &Request) -> Result<simrep_gem::Gem> {
    let files = files.clone();
    simrep_gem::read_gem_with(&request.path, move |path| {
        load(&files, path).map_err(|e| simrep_gem::Error(e.to_string()))
    })
    .map_err(|e| {
        if e.0.contains("unsupported in browser: GEM Lua") {
            "unsupported in browser: GEM Lua".into()
        } else {
            Box::new(e) as Box<dyn std::error::Error + Send + Sync>
        }
    })
}

fn mesh(files: &BTreeMap<String, Vec<u8>>, request: &Request) -> Result<Mesh> {
    let mut transform = Transform::IDENTITY;
    if let Some(matrix) = request.transform {
        for i in 0..3 {
            transform.0[i].copy_from_slice(&matrix[i * 4..(i + 1) * 4]);
        }
    }
    let mut mesh = read_mesh_with(
        &request.path,
        ImportOptions {
            units: request.units.as_deref().map(str::parse).transpose()?,
            transform,
        },
        |path| load(files, path),
    )?;
    if request.repair {
        for part in &mut mesh.parts {
            repair(part)?;
        }
    }
    Ok(mesh)
}

#[wasm_bindgen]
impl WasmBackend {
    /// Geometry-specific invoke adapter; all generated files are registered atomically.
    pub fn geometry_command(
        &mut self,
        command: &str,
        args: &str,
    ) -> std::result::Result<String, JsValue> {
        self.geometry_inner(command, args)
            .map(|v| v.to_string())
            .map_err(error)
    }
}

impl WasmBackend {
    fn geometry_inner(&mut self, command: &str, args: &str) -> Result<Value> {
        let request: Request = serde_json::from_str(args)?;
        match command {
            "gem2pa" => {
                let gem = gem(&self.files, &request)?;
                validate(gem.dimensions, [0.0; 3], gem.spacing_mm)?;
                let raster = gem.rasterize()?;
                let output = request.output.unwrap_or_else(|| {
                    Path::new(&request.path)
                        .with_extension("pa#")
                        .to_string_lossy()
                        .into_owned()
                });
                let mut paths = vec![output.clone()];
                let surface_path = Path::new(&output)
                    .with_extension("pa-surf")
                    .to_string_lossy()
                    .into_owned();
                let surfaces = raster
                    .surfaces
                    .as_ref()
                    .filter(|s| s.axes.iter().any(|a| !a.is_empty()))
                    .map(|s| {
                        let mut bytes = Vec::new();
                        s.write(&mut bytes).map(|()| bytes)
                    })
                    .transpose()?;
                let pa_bytes = encode(&raster.pa)?;
                self.files.insert(output, pa_bytes);
                if let Some(bytes) = surfaces {
                    self.files.insert(surface_path.clone(), bytes);
                    paths.push(surface_path);
                } else {
                    self.files.remove(&surface_path);
                }
                let numbers: std::collections::BTreeSet<_> = raster
                    .pa
                    .array
                    .potentials
                    .iter()
                    .zip(&raster.pa.array.electrodes)
                    .filter_map(|(&v, &e)| e.then_some(v as i64))
                    .collect();
                Ok(
                    json!({"output_paths":paths,"dims":gem.dimensions,"spacing_mm":gem.spacing_mm,"electrode_numbers":numbers}),
                )
            }
            "mesh_import" | "mesh-import" => {
                let dims = request.grid.ok_or("mesh input requires --grid nx,ny,nz")?;
                let spacing = request.spacing.unwrap_or([1.0; 3]);
                validate(dims, request.origin, spacing)?;
                if dims.iter().any(|&n| n < 2) {
                    return Err("3D import requires at least 2 nodes on every axis".into());
                }
                let output = request.output.clone().unwrap_or_else(|| {
                    Path::new(&request.path)
                        .with_extension("pa#")
                        .to_string_lossy()
                        .into_owned()
                });
                if Path::new(&output).extension().is_none_or(|s| s != "pa#") {
                    return Err("mesh-import output must have .pa# extension".into());
                }
                let mesh = mesh(&self.files, &request)?;
                let numbers = if request.electrodes.is_empty() {
                    (1..=mesh.parts.len() as u32).collect::<Vec<_>>()
                } else {
                    request.electrodes.clone()
                };
                if numbers.len() != mesh.parts.len()
                    || numbers.contains(&0)
                    || numbers.iter().any(|&n| n > 100_000)
                {
                    return Err("supply one electrode number in 1..=100000 for every part".into());
                }
                let mut a = PotentialArray::new(dims[0], dims[1], dims[2]);
                [a.dx_mm, a.dy_mm, a.dz_mm] = spacing;
                for (part, &number) in mesh.parts.iter().zip(&numbers) {
                    let solid = if request.allow_defects {
                        Solid::from_surface(part)?
                    } else {
                        Solid::new(part)?
                    };
                    let mut mask = vec![false; a.potentials.len()];
                    solid.conductor_mask(dims, request.origin, spacing, 0.0, &mut mask)?;
                    for (i, hit) in mask.into_iter().enumerate() {
                        if hit {
                            a.electrodes[i] = true;
                            a.potentials[i] = f64::from(number);
                        }
                    }
                }
                self.files.insert(output.clone(), encode(&PaFile::new(a))?);
                Ok(
                    json!({"output_paths":[output],"dims":dims,"spacing_mm":spacing,"electrode_numbers":numbers}),
                )
            }
            "refine_geometry" | "refine-geometry" => self.build_exact(request),
            _ => Err(format!("unsupported in browser: {command}").into()),
        }
    }

    fn build_exact(&mut self, request: Request) -> Result<Value> {
        let is_gem = Path::new(&request.path)
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("gem"));
        let mut sources = Vec::new();
        let mut pa = if is_gem {
            if request.units.is_some() || request.repair {
                return Err("--units and --repair apply only to mesh input".into());
            }
            let gem = gem(&self.files, &request)?;
            if gem.field_type != FieldType::Electrostatic || !gem.refinable {
                return Err("refine-geometry requires refinable electrostatic geometry".into());
            }
            let dims = request.grid.unwrap_or(gem.dimensions);
            let spacing = request.spacing.unwrap_or(gem.spacing_mm);
            validate(dims, request.origin, spacing)?;
            let mut a = PotentialArray::new(dims[0], dims[1], dims[2]);
            a.symmetry = gem.symmetry;
            a.mirrors = gem.mirrors;
            [a.dx_mm, a.dy_mm, a.dz_mm] = spacing;
            for s in gem.electrode_sdfs()? {
                let name = s.voltage.to_string();
                let source = SourceGeometry::gem(&s)?;
                let bounds = s.bounds_mm();
                sources.push((
                    name,
                    Arc::new(s) as Arc<dyn SignedDistance>,
                    source,
                    GapSource::Gem(bounds),
                ));
            }
            let mut pa = PaFile::new(a);
            pa.ng = gem.ng;
            pa
        } else {
            let dims = request.grid.ok_or("mesh input requires --grid nx,ny,nz")?;
            let spacing = request.spacing.unwrap_or([1.0; 3]);
            validate(dims, request.origin, spacing)?;
            if dims[2] < 2 {
                return Err("mesh input requires a planar 3D grid (nz >= 2)".into());
            }
            for (i, part) in mesh(&self.files, &request)?.parts.into_iter().enumerate() {
                let solid = Arc::new(Solid::new(&part)?);
                let name = if part.name.is_empty() {
                    i.to_string()
                } else {
                    part.name.clone()
                };
                let source = SourceGeometry::mesh(&part, None)?;
                sources.push((
                    name,
                    Arc::clone(&solid) as Arc<dyn SignedDistance>,
                    source,
                    GapSource::Mesh(solid),
                ));
            }
            let mut a = PotentialArray::new(dims[0], dims[1], dims[2]);
            [a.dx_mm, a.dy_mm, a.dz_mm] = spacing;
            PaFile::new(a)
        };
        let dims = [pa.array.nx, pa.array.ny, pa.array.nz];
        let spacing = [pa.array.dx_mm, pa.array.dy_mm, pa.array.dz_mm];
        let cylindrical = pa.array.symmetry == Symmetry::Cylindrical;
        if cylindrical && (dims[2] != 1 || request.origin[1] != 0.0 || request.origin[2] != 0.0) {
            return Err("cylindrical PA requires nz=1 and radial/z origins zero; shift axial origin or spacing instead".into());
        }
        for e in &request.assignments {
            if e.part.is_empty() || !(1..=1000).contains(&e.number) || !e.voltage.is_finite() {
                return Err("part is required, number must be 1..1000, voltage finite".into());
            }
        }
        let mut used = vec![false; request.assignments.len()];
        let mut used_insulators = vec![false; request.insulators.len()];
        let mut voltages = BTreeMap::new();
        let mut parts = Vec::new();
        let mut insulators = Vec::new();
        let mut next_number = request
            .assignments
            .iter()
            .map(|e| e.number)
            .max()
            .unwrap_or(0);
        for (i, (name, shape, source, gap_source)) in sources.into_iter().enumerate() {
            let matches = request
                .assignments
                .iter()
                .enumerate()
                .filter(|(_, e)| e.part == name || !is_gem && e.part == i.to_string())
                .collect::<Vec<_>>();
            let insulator_matches = request
                .insulators
                .iter()
                .enumerate()
                .filter(|(_, p)| **p == name || !is_gem && **p == i.to_string())
                .collect::<Vec<_>>();
            if matches.len() + insulator_matches.len() != 1 {
                return Err(format!(
                    "part {i} {name:?} requires exactly one --electrode or --insulator assignment"
                )
                .into());
            }
            if let Some((slot, selector)) = insulator_matches.first().copied() {
                if used_insulators[slot] {
                    return Err(format!("ambiguous part selector {selector:?}").into());
                }
                used_insulators[slot] = true;
                next_number += 1;
                insulators.push(Part {
                    name,
                    shape,
                    source,
                    gap_source,
                    assignment: Assignment {
                        part: selector.clone(),
                        number: next_number,
                        voltage: 0.0,
                    },
                });
            } else {
                let (slot, assignment) = matches[0];
                if used[slot] {
                    return Err(format!("ambiguous part selector {:?}", assignment.part).into());
                }
                used[slot] = true;
                if voltages
                    .insert(assignment.number, assignment.voltage)
                    .is_some_and(|v| v != assignment.voltage)
                {
                    return Err(
                        "parts sharing an electrode number must have the same voltage".into(),
                    );
                }
                parts.push(Part {
                    name,
                    shape,
                    source,
                    gap_source,
                    assignment: assignment.clone(),
                });
            }
        }
        if used.contains(&false) {
            return Err("an --electrode selector did not match any input part".into());
        }
        if used_insulators.contains(&false) {
            return Err("an --insulator selector did not match any input part".into());
        }
        if voltages.is_empty() {
            return Err("geometry has no electrodes".into());
        }
        let tolerance = 1e-9
            * (0..3)
                .filter(|&a| dims[a] > 1)
                .map(|a| spacing[a])
                .fold(f64::INFINITY, f64::min);
        let gap = gap::check(&request.gap_check, &parts, dims, request.origin, spacing)?;
        let mut owners = vec![None; pa.array.potentials.len()];
        for part in &parts {
            let mut mask = vec![false; owners.len()];
            part.shape
                .conductor_mask(dims, request.origin, spacing, tolerance, &mut mask)?;
            for (owner, hit) in owners.iter_mut().zip(mask) {
                if !hit {
                    continue;
                }
                if owner.is_some_and(|n| n != part.assignment.number) {
                    return Err(format!(
                        "different electrode numbers overlap at a PA node ({})",
                        part.name
                    )
                    .into());
                }
                *owner = Some(part.assignment.number);
            }
        }
        for number in voltages.keys() {
            if !owners.contains(&Some(*number)) {
                return Err(format!(
                    "electrode {number} has no inside/on-surface grid node; refine the grid"
                )
                .into());
            }
        }
        let grid = Grid {
            dims: if cylindrical {
                [dims[1], dims[0], 1]
            } else {
                dims
            },
            spacing: if cylindrical {
                [spacing[1], spacing[0], spacing[2]]
            } else {
                spacing
            },
            geometry: if cylindrical {
                Geometry::Cylindrical { radial_origin: 0.0 }
            } else {
                Geometry::Planar
            },
        };
        let origin = if cylindrical {
            [0.0, request.origin[0], 0.0]
        } else {
            request.origin
        };
        let electrodes = parts
            .iter()
            .map(|p| {
                Electrode::new(
                    p.assignment.number as f64,
                    SolverShape {
                        source: Arc::clone(&p.shape),
                        cylindrical,
                        tolerance,
                    },
                )
            })
            .collect::<Vec<_>>();
        let cuts = CutCells::new_with_root_tolerance(grid, origin, &electrodes, tolerance)?;
        let fixed = if cylindrical {
            transpose(&cuts.fixed, grid.dims[0], grid.dims[1])
        } else {
            cuts.fixed.clone()
        };
        let mut physical_cuts = Vec::new();
        let band = spacing.into_iter().fold(0.0_f64, f64::max) + tolerance;
        let near = parts
            .iter()
            .map(|part| {
                let mut mask = vec![false; owners.len()];
                part.shape
                    .mark_near_nodes(dims, request.origin, spacing, band, &mut mask);
                mask
            })
            .collect::<Vec<_>>();
        for (i, owner) in owners.iter().enumerate() {
            if owner.is_some() || near.iter().all(|mask| !mask[i]) {
                continue;
            }
            let p = point(i, dims, request.origin, spacing);
            let c = [i % dims[0], i / dims[0] % dims[1], i / (dims[0] * dims[1])];
            let mut fractions = [None; 6];
            let mut numbers = [None; 6];
            for s in 0..6 {
                let axis = s / 2;
                if s % 2 == 0 && c[axis] == 0 || s % 2 == 1 && c[axis] + 1 == dims[axis] {
                    continue;
                }
                let mut q = p;
                q[axis] += if s % 2 == 0 {
                    -spacing[axis]
                } else {
                    spacing[axis]
                };
                for (part, near) in parts.iter().zip(&near) {
                    if !near[i] || part.shape.segment_clear(p, q, tolerance) {
                        continue;
                    }
                    if let Some(t) = surface_fraction(part.shape.as_ref(), p, q, tolerance)
                        && fractions[s].is_none_or(|previous| t < previous)
                    {
                        fractions[s] = Some(t);
                        numbers[s] = Some(part.assignment.number);
                    }
                }
            }
            if fractions.iter().any(Option::is_some) {
                physical_cuts.push(PhysicalCuts {
                    node: i,
                    fractions,
                    electrodes: numbers,
                });
            }
        }
        pa.array.electrodes = owners.iter().map(Option::is_some).collect();
        pa.array.potentials = owners.iter().map(|n| n.unwrap_or(0) as f64).collect();
        let collision_only_numbers = insulators
            .iter()
            .map(|p| p.assignment.number)
            .collect::<Vec<_>>();
        let sidecar = Sidecar {
            version: 3,
            dims,
            origin_mm: request.origin,
            spacing_mm: spacing,
            symmetry: if cylindrical { "cylindrical" } else { "planar" },
            mirrors: [pa.array.mirrors.x, pa.array.mirrors.y, pa.array.mirrors.z],
            electrode_numbers: voltages
                .keys()
                .copied()
                .chain(collision_only_numbers.iter().copied())
                .collect(),
            collision_only_numbers,
            source_geometry: parts
                .iter()
                .chain(&insulators)
                .map(|p| SourceSurface {
                    number: p.assignment.number,
                    geometry: p.source.clone(),
                })
                .collect(),
            assignments: request.assignments,
            surface_tolerance_mm: tolerance,
            snap_distance_mm: cuts.snap_distance,
            sampled_sdfs: Vec::new(),
            node_electrode_runs: runs(&owners),
            solver_fixed_runs: runs(&fixed),
            link_intersections: physical_cuts,
        };
        let stem = request.output.unwrap_or_else(|| request.path.clone());
        let geometry_path = Path::new(&stem)
            .with_extension("pa#")
            .to_string_lossy()
            .into_owned();
        let cuts_path = Path::new(&stem)
            .with_extension("cuts.json")
            .to_string_lossy()
            .into_owned();
        let pa_bytes = encode(&pa)?;
        let cuts_bytes = serde_json::to_vec(&sidecar)?;
        self.files.insert(geometry_path.clone(), pa_bytes);
        self.files.insert(cuts_path.clone(), cuts_bytes);
        Ok(
            json!({"output_paths":[geometry_path,cuts_path],"dims":dims,"spacing_mm":spacing,"voltages":voltages,"gap_check":gap,"solve_pending":true}),
        )
    }
}
