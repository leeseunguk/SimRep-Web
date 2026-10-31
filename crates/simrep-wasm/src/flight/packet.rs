use std::fmt::Write;

use serde_json::{Value, json};
use simrep_core::Symmetry;
use simrep_fly::{ELECTRIC_ACCELERATION, FlightResult, SPEED_OF_LIGHT, SplatReason, Vector};
use simrep_io::PaFile;

use super::{Record, Request};

pub(super) fn energy(mass: f64, velocity: Vector, relativistic: bool) -> f64 {
    let v2 = velocity.iter().map(|v| v * v).sum::<f64>();
    if relativistic {
        let inverse_gamma = (1. - v2 / SPEED_OF_LIGHT.powi(2)).sqrt();
        mass * v2 / (ELECTRIC_ACCELERATION * inverse_gamma * (1. + inverse_gamma))
    } else {
        mass * v2 / (2. * ELECTRIC_ACCELERATION)
    }
}

fn statistics(values: &[f64], null_empty: bool) -> Value {
    if values.is_empty() {
        return if null_empty {
            json!({"mean":null,"std":null,"min":null,"max":null})
        } else {
            json!({"n":0,"mean":0.,"std":0.,"min":0.,"max":0.})
        };
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance =
        values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / values.len() as f64;
    let mut result = json!({"mean":mean,"std":variance.sqrt(),"min":values.iter().copied().fold(f64::INFINITY,f64::min),"max":values.iter().copied().fold(f64::NEG_INFINITY,f64::max)});
    if !null_empty {
        result["n"] = json!(values.len());
    }
    result
}

pub(super) fn reason(reason: SplatReason) -> &'static str {
    match reason {
        SplatReason::Electrode { .. } | SplatReason::SurfaceElectrode { .. } => "electrode",
        SplatReason::OutsideGrid => "outside",
        SplatReason::StopPlane => "plane",
        SplatReason::TimeLimit => "time_limit",
        SplatReason::StepLimit => "step_limit",
        SplatReason::StepUnderflow => "step_underflow",
        SplatReason::NonFinite => "nonfinite",
    }
}

pub(super) fn counts(record: &Record) -> Value {
    let mut counts = json!({"electrode":0,"outside":0,"plane":0,"time_limit":0,"step_limit":0,"step_underflow":0,"nonfinite":0,"beam_diverged":0,"beam_leader_stopped":0});
    for r in &record.results {
        let key = reason(r.splat_reason);
        counts[key] = json!(counts[key].as_u64().unwrap() + 1);
    }
    counts
}

pub(super) fn arrival_statistics(record: &Record) -> Value {
    let values: Vec<_> = record
        .results
        .iter()
        .filter(|r| r.splat_reason == SplatReason::StopPlane)
        .map(|r| r.tof_us)
        .collect();
    statistics(&values, true)
}

pub(super) fn csv(record: &Record) -> String {
    let mut text = String::from(
        "ion,tof_us,x_mm,y_mm,z_mm,ke_ev,reason,electrode_number,vx_mm_per_us,vy_mm_per_us,vz_mm_per_us\n",
    );
    for (i, (particle, result)) in record.particles.iter().zip(&record.results).enumerate() {
        let p = result.final_state.position_mm;
        let v = result.final_state.velocity_mm_per_us;
        let number = match result.splat_reason {
            SplatReason::SurfaceElectrode { number } => number.to_string(),
            _ => String::new(),
        };
        writeln!(
            text,
            "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{},{},{:.15e},{:.15e},{:.15e}",
            i + 1,
            result.tof_us,
            p[0],
            p[1],
            p[2],
            energy(particle.mass_amu, v, record.request.relativistic),
            reason(result.splat_reason),
            number,
            v[0],
            v[1],
            v[2]
        )
        .unwrap();
    }
    text
}

fn wall(request: &Request, file: &PaFile, position: Vector) -> &'static str {
    const FACES: [[&str; 2]; 3] = [["-x", "+x"], ["-y", "+y"], ["-z", "+z"]];
    let mut nearest = (f64::INFINITY, "+x");
    let mut consider = |distance: f64, face| {
        if distance < nearest.0 {
            nearest = (distance, face);
        }
    };
    if let Some(b) = request.bounds {
        for axis in 0..3 {
            consider((position[axis] - b[axis]).abs(), FACES[axis][0]);
            consider((position[axis] - b[axis + 3]).abs(), FACES[axis][1]);
        }
        return nearest.1;
    }
    let p = request.placement.unwrap_or_default().local(position);
    let a = &file.array;
    let n = [a.nx, a.ny, a.nz];
    let spacing = [a.dx_mm, a.dy_mm, a.dz_mm];
    let mirrors = [a.mirrors.x, a.mirrors.y, a.mirrors.z];
    for axis in 0..3 {
        if n[axis] == 1 || (a.symmetry == Symmetry::Cylindrical && axis > 0) {
            continue;
        }
        let hi = (n[axis] - 1) as f64 * spacing[axis];
        consider(
            (p[axis] - if mirrors[axis] { -hi } else { 0. }).abs(),
            FACES[axis][0],
        );
        consider((p[axis] - hi).abs(), FACES[axis][1]);
    }
    if a.symmetry == Symmetry::Cylindrical {
        consider((p[1].hypot(p[2]) - (a.ny - 1) as f64 * a.dy_mm).abs(), "r");
    }
    nearest.1
}

pub(super) fn surface(
    request: &Request,
    file: &PaFile,
    labels: &[u16],
    result: &FlightResult,
) -> Value {
    match result.splat_reason {
        SplatReason::SurfaceElectrode { number } => {
            json!({"kind":"electrode","number":number,"voltage":null})
        }
        SplatReason::Electrode { index } => {
            if file.pa0.is_some() {
                json!({"kind":"electrode","number":labels.get(index).filter(|&&n|n > 0),"voltage":null})
            } else {
                json!({"kind":"electrode","number":null,"voltage":file.array.potentials.get(index)})
            }
        }
        SplatReason::OutsideGrid | SplatReason::StopPlane => {
            json!({"kind":"wall","face":wall(request,file,result.final_state.position_mm)})
        }
        SplatReason::TimeLimit => json!({"kind":"timeLimit"}),
        _ => json!({"kind":"stalled"}),
    }
}

pub(super) fn flight_packet(record: &Record) -> Vec<u8> {
    let mut groups: Vec<(Value, usize, f64)> = Vec::new();
    let mut surface_indices = Vec::new();
    let mut energy_values = Vec::new();
    let mut ended = Vec::new();
    for (particle, result) in record.particles.iter().zip(&record.results) {
        let surface = surface(&record.request, &record.file, &record.labels, result);
        let index = groups
            .iter()
            .position(|g| g.0 == surface)
            .unwrap_or_else(|| {
                groups.push((surface, 0, 0.));
                groups.len() - 1
            });
        groups[index].1 += 1;
        groups[index].2 += result.tof_us;
        surface_indices.push(index as u32);
        energy_values.push(energy(
            particle.mass_amu,
            result.final_state.velocity_mm_per_us,
            record.request.relativistic,
        ));
        if matches!(
            result.splat_reason,
            SplatReason::Electrode { .. }
                | SplatReason::SurfaceElectrode { .. }
                | SplatReason::OutsideGrid
                | SplatReason::StopPlane
        ) {
            ended.push(result.tof_us);
        }
    }
    let width = if groups.len() <= 256 {
        1
    } else if groups.len() <= 65536 {
        2
    } else {
        4
    };
    let mut points = Vec::new();
    let mut offsets = vec![0u32];
    let mut picks = Vec::new();
    let mut thinned = false;
    let limit = (3_000_000 / record.drawn.len().max(1)).clamp(2, 1500);
    for (ion, flight) in &record.drawn {
        picks.push(*ion as u32);
        if let Some(samples) = &flight.trajectory {
            let keep = samples.len().min(limit);
            thinned |= keep < samples.len();
            for i in 0..keep {
                let index = if keep <= 1 {
                    0
                } else {
                    i * (samples.len() - 1) / (keep - 1)
                };
                points.extend(samples[index].position_mm.map(|v| v as f32));
            }
        }
        offsets.push((points.len() / 3) as u32);
    }
    let device = json!({"kind":"cpu","name":"CPU","threads":rayon::current_num_threads()});
    let header = json!({"ions":record.results.len(),"drawn":picks.len(),"points":points.len()/3,
        "surfaces":groups.into_iter().map(|(surface,count,tof)|json!({"surface":surface,"count":count,"tofMean":tof/count as f64})).collect::<Vec<_>>(),
        "tof":statistics(&ended,false),"keMean":energy_values.iter().sum::<f64>()/energy_values.len() as f64,
        "device":device,"precision":record.request.precision,"executed":{"device":"cpu","precision":"f64","surfaces":if record.surface_path.is_some(){"exact"}else{"grid"}},
        "fallback":if record.request.precision == "live" {json!({"code":if record.surface_path.is_some(){"exactSurfaces"}else{"noVulkan"}})} else {Value::Null},
        "surface":record.surface_path.as_ref().map(|path|json!({"file":std::path::Path::new(path).file_name().unwrap_or_default().to_string_lossy(),"accuracy":"source"})),
        "fieldMs":record.field_ms,"prepareMs":0.,"flyMs":record.fly_ms,"transferMs":0.,"pathsMs":record.paths_ms,"pathsGpu":false,
        "totalMs":record.total_ms,"thinned":thinned,"gpuBytes":0,"dispatchIons":0,"surfaceBytes":width,"token":record.token}).to_string();
    let padded = header.len().div_ceil(8) * 8;
    let end_at = (8 + padded + 4 * (picks.len() + offsets.len() + points.len())).div_ceil(8) * 8;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"STR4");
    bytes.extend_from_slice(&(padded as u32).to_le_bytes());
    bytes.extend_from_slice(header.as_bytes());
    bytes.resize(8 + padded, b' ');
    for n in picks.into_iter().chain(offsets) {
        bytes.extend_from_slice(&n.to_le_bytes());
    }
    for point in points {
        bytes.extend_from_slice(&point.to_le_bytes());
    }
    bytes.resize(end_at, 0);
    for result in &record.results {
        for value in result
            .final_state
            .position_mm
            .into_iter()
            .chain([result.tof_us])
        {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    for energy in energy_values {
        bytes.extend_from_slice(&energy.to_le_bytes());
    }
    for index in surface_indices {
        bytes.extend_from_slice(&index.to_le_bytes()[..width]);
    }
    bytes
}
