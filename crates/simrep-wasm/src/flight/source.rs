use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use simrep_fly::{FlightOptions, Integrator, Particle, Vector};

pub(super) const MAX_IONS: usize = 1_000_000;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placement {
    pub origin: Vector,
    pub axes: [Vector; 3],
    pub scale: f64,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            origin: [0.; 3],
            axes: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            scale: 1.,
        }
    }
}

impl Placement {
    pub(crate) fn local(self, p: Vector) -> Vector {
        let p: Vector = std::array::from_fn(|a| (p[a] - self.origin[a]) / self.scale);
        self.axes.map(|axis| (0..3).map(|a| axis[a] * p[a]).sum())
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Source {
    #[serde(rename_all = "camelCase")]
    Beam {
        count: usize,
        mass_amu: f64,
        charge_e: f64,
        energy_ev: f64,
        position_mm: Vector,
        direction: Vector,
        cone_deg: f64,
        shape: Shape,
        width_mm: f64,
    },
    File {
        path: String,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Shape {
    Point,
    Line,
    Disk,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum CoilInput {
    Segment {
        first_mm: Vector,
        last_mm: Vector,
        current_a: f64,
    },
    Loop {
        center_mm: Vector,
        normal: Vector,
        radius_mm: f64,
        current_a: f64,
    },
    Solenoid {
        first_mm: Vector,
        last_mm: Vector,
        radius_mm: f64,
        current_a: f64,
        turns: usize,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub id: String,
    #[serde(default)]
    pub voltages: Vec<(usize, f64)>,
    pub(super) source: Source,
    pub bounds: Option<[f64; 6]>,
    pub placement: Option<Placement>,
    pub duration_us: f64,
    pub relativistic: bool,
    #[serde(default = "live")]
    pub precision: String,
    #[serde(default = "collision")]
    pub collision: String,
    #[serde(default = "draw")]
    pub draw: usize,
    #[serde(default = "yes")]
    pub surfaces: bool,
    pub plane: Option<[f64; 4]>,
    pub tolerance: Option<f64>,
    pub max_step_us: Option<f64>,
    pub step_us: Option<f64>,
    pub integrator: Option<String>,
    pub bfield: Option<Vector>,
    #[serde(default)]
    pub magnetic_pa: Vec<String>,
    #[serde(default)]
    pub(super) coils: Vec<CoilInput>,
    pub bfield_coil: Option<String>,
    pub cuts: Option<String>,
    #[serde(default)]
    pub exact_coils: bool,
}
fn live() -> String {
    "live".into()
}
fn collision() -> String {
    "allCorners".into()
}
fn draw() -> usize {
    300
}
fn yes() -> bool {
    true
}

impl Request {
    pub(super) fn options(&self) -> Result<FlightOptions, String> {
        if !["live", "precise"].contains(&self.precision.as_str()) {
            return Err("invalid flight precision".into());
        }
        if !["allCorners", "nearestNode"].contains(&self.collision.as_str()) {
            return Err("invalid electrode collision rule".into());
        }
        let integrator = match self.integrator.as_deref().unwrap_or("rk45") {
            "rk45" => Integrator::Rk45,
            "boris" => Integrator::Boris,
            _ => return Err("invalid integrator".into()),
        };
        let tolerance = self.tolerance.unwrap_or(1e-8);
        Ok(FlightOptions {
            integrator,
            duration_us: self.duration_us,
            relativistic: self.relativistic,
            relative_tolerance: tolerance,
            position_tolerance_mm: tolerance,
            velocity_tolerance_mm_per_us: tolerance,
            automatic_tolerance: self.tolerance.is_none(),
            max_step_us: self.max_step_us.unwrap_or(0.1),
            initial_step_us: self.step_us.unwrap_or(0.001),
            ..FlightOptions::default()
        })
    }

    pub(super) fn particles(
        &self,
        files: &BTreeMap<String, Vec<u8>>,
    ) -> Result<Vec<Particle>, String> {
        let particles = match &self.source {
            Source::Beam { .. } => self.beam()?,
            Source::File { path } => {
                let bytes = files
                    .get(path)
                    .ok_or_else(|| format!("particle file not found: {path}"))?;
                let source = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
                let extension = Path::new(path)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy();
                let definitions = if extension.eq_ignore_ascii_case("ion") {
                    simrep_io::parse_ion(source)
                } else if extension.eq_ignore_ascii_case("fly2") {
                    simrep_io::parse_fly2(source)
                } else {
                    return Err("unsupported particle format; expected .ion or .fly2".into());
                }
                .map_err(|e| e.to_string())?;
                definitions
                    .into_iter()
                    .map(|p| {
                        self.particle(
                            p.mass_amu,
                            p.charge_e,
                            p.position_mm,
                            p.energy_ev,
                            p.direction,
                            p.birth_time_us,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        if particles.is_empty() || particles.len() > MAX_IONS {
            return Err(format!("particle count must be in 1..={MAX_IONS}"));
        }
        Ok(particles)
    }

    fn particle(
        &self,
        mass: f64,
        charge: f64,
        position: Vector,
        energy: f64,
        direction: Vector,
        birth: f64,
    ) -> Result<Particle, String> {
        if self.relativistic {
            Particle::from_relativistic_energy(mass, charge, position, energy, direction, birth)
        } else {
            Particle::from_energy(mass, charge, position, energy, direction, birth)
        }
        .map_err(|e| e.to_string())
    }

    fn beam(&self) -> Result<Vec<Particle>, String> {
        let Source::Beam {
            count,
            mass_amu,
            charge_e,
            energy_ev,
            position_mm,
            direction,
            cone_deg,
            shape,
            width_mm,
        } = self.source
        else {
            unreachable!()
        };
        if !(1..=MAX_IONS).contains(&count) {
            return Err("invalid beam count".into());
        }
        let norm = |v: Vector| v.iter().map(|v| v * v).sum::<f64>().sqrt();
        let length = norm(direction);
        if !length.is_finite()
            || length <= 0.
            || !(0. ..=180.).contains(&cone_deg)
            || !width_mm.is_finite()
            || width_mm < 0.
        {
            return Err("invalid beam direction, cone or width".into());
        }
        let d = direction.map(|v| v / length);
        let up = if d[1].abs() > 0.99 {
            [0., 0., 1.]
        } else {
            [0., 1., 0.]
        };
        let k = up[0] * d[0] + up[1] * d[1] + up[2] * d[2];
        let perpendicular: Vector = std::array::from_fn(|a| up[a] - k * d[a]);
        let u = perpendicular.map(|v| v / norm(perpendicular));
        let w = [
            d[1] * u[2] - d[2] * u[1],
            d[2] * u[0] - d[0] * u[2],
            d[0] * u[1] - d[1] * u[0],
        ];
        let golden = std::f64::consts::PI * (3. - 5.0_f64.sqrt());
        let cos_cone = cone_deg.to_radians().cos();
        (0..count)
            .map(|i| {
                let t = (i as f64 + 0.5) / count as f64;
                let offset = match shape {
                    Shape::Point => [0.; 3],
                    Shape::Line => u.map(|v| v * (t - 0.5) * width_mm),
                    Shape::Disk => {
                        let r = 0.5 * width_mm * t.sqrt();
                        let (s, c) = (i as f64 * golden).sin_cos();
                        std::array::from_fn(|a| r * (c * u[a] + s * w[a]))
                    }
                };
                let j = (i * 7919) % count;
                let tj = (j as f64 + 0.5) / count as f64;
                let cos_theta = 1. - (1. - cos_cone) * tj;
                let sin_theta = (1. - cos_theta * cos_theta).max(0.).sqrt();
                let (sp, cp) = (j as f64 * golden).sin_cos();
                let dir =
                    std::array::from_fn(|a| d[a] * cos_theta + (cp * u[a] + sp * w[a]) * sin_theta);
                let position = std::array::from_fn(|a| position_mm[a] + offset[a]);
                self.particle(mass_amu, charge_e, position, energy_ev, dir, 0.)
            })
            .collect()
    }
}
