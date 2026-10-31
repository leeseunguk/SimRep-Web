use serde_json::json;
use simrep_fly::physics::magnetic::{Electromagnetic, PreparedMagneticField};
use simrep_fly::{Field, fly};
use wasm_bindgen::prelude::*;
use web_time::Instant;
use super::{Request, World, packet};
use crate::{WasmBackend, error};
#[wasm_bindgen]
impl WasmBackend {
    /// Byte accounting for retention-budget diagnostics; does not report wasm's high-water pages.
    pub fn retention_stats(&self) -> String {
        let sample_bytes: usize = self.flights.values().flat_map(|r| &r.drawn).map(|(_, r)| r.trajectory.as_ref().map_or(0, |t| t.capacity() * std::mem::size_of::<simrep_fly::ParticleState>())).sum();
        json!({"file_bytes":self.files.values().map(Vec::len).sum::<usize>(),"flight_bytes":self.flights.values().map(|r|r.resident_bytes()).sum::<usize>(),"sample_bytes":sample_bytes,"flight_records":self.flights.len(),"prepared_geometries":self.desktop_state.geometries.lock().unwrap().len()}).to_string()
    }
    pub fn ion_trace(&self, request: &str, ion: usize) -> Result<Vec<u8>, JsValue> {
        let started = Instant::now();
        let request: Request = serde_json::from_str(request).map_err(error)?;
        let World { file, electric, magnetic, particles, mut options, labels, surface_path, bounds, .. } = self.world(&request).map_err(error)?;
        let particle = particles.get(ion).ok_or_else(|| error("ion does not exist"))?;
        let prepared = if request.exact_coils { PreparedMagneticField::exact(&magnetic) } else { magnetic.prepare_coil_map(bounds).map_err(error)? };
        let field = Electromagnetic { electric, magnetic: prepared };
        let unsampled = fly(&field, particle, &options).map_err(error)?;
        let every = unsampled.accepted_steps.div_ceil(4998).max(1);
        options.sample_every = Some(every);
        let result = fly(&field, particle, &options).map_err(error)?;
        let samples = result.trajectory.as_deref().unwrap_or(&[]);
        let header = json!({"ion":ion,"massAmu":particle.mass_amu,"chargeE":particle.charge_e,"samples":samples.len(),"steps":result.accepted_steps,"thinned":every > 1,
            "surface":packet::surface(&request,&file,&labels,&result),"tofUs":result.tof_us,"field":if surface_path.is_some(){"exact"}else{"array"},"ms":started.elapsed().as_secs_f64()*1000.}).to_string();
        let padded = header.len().div_ceil(8) * 8;
        let mut bytes = Vec::new(); bytes.extend_from_slice(b"SIT1"); bytes.extend_from_slice(&(padded as u32).to_le_bytes()); bytes.extend_from_slice(header.as_bytes()); bytes.resize(8 + padded, b' ');
        for sample in samples {
            let position = sample.position_mm; let velocity = sample.velocity_mm_per_us;
            for value in [sample.time_us, position[0], position[1], position[2], velocity[0], velocity[1], velocity[2], packet::energy(particle.mass_amu, velocity, request.relativistic), field.sample(position, sample.time_us).potential_v] { bytes.extend_from_slice(&value.to_le_bytes()); }
        }
        Ok(bytes)
    }
}
