//! Browser-local CPU f64 computation over a caller-owned byte registry.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::Path;
use serde_json::{Value, json};
use simrep_core::{FieldType, PotentialArray, Symmetry};
use simrep_io::fast_adjust::read_fast_adjust_with;
use simrep_io::{FastScalable, PaFile};
use wasm_bindgen::prelude::*;
pub mod desktop;
mod flight;
mod geom;
#[cfg(feature = "webgpu")]
pub mod gpu;
mod refine;
pub use refine::RefineJob;
#[cfg(all(target_arch = "wasm32", feature = "threads"))]
pub use wasm_bindgen_rayon::init_thread_pool;
fn error(error: impl std::fmt::Display) -> JsValue { JsValue::from_str(&error.to_string()) }
fn decode(files: &BTreeMap<String, Vec<u8>>, path: &Path) -> io::Result<PaFile> {
    let bytes = files.get(&path.to_string_lossy().into_owned()).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.display().to_string()))?;
    if bytes.len() >= 28 {
        let number = |at| i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        if matches!(number(0), -1 | -2) {
            let points = [16, 20, 24].into_iter().try_fold(1u64, |n, at| n.checked_mul(number(at).max(0) as u64));
            if points.is_none_or(|n| n > 40_000_000) { return Err(io::Error::new(io::ErrorKind::InvalidData, "PA exceeds 40000000 points")); }
        }
    }
    PaFile::read(bytes.as_slice())
}
fn encode(file: &PaFile) -> io::Result<Vec<u8>> { let mut bytes = Vec::new(); file.write(&mut bytes)?; Ok(bytes) }
fn electrode_number(value: f64) -> Option<usize> { ((1. ..=1000.).contains(&value) && value.fract() == 0.).then_some(value as usize) }
fn transpose<T: Copy>(values: &[T], nx: usize, ny: usize) -> Vec<T> { (0..values.len()).map(|i| values[i / ny + nx * (i % ny)]).collect() }
fn anti_mirror(a: &PotentialArray, i: usize) -> bool { (a.anti_mirrors.x && i.is_multiple_of(a.nx)) || (a.anti_mirrors.y && (i / a.nx).is_multiple_of(a.ny)) || (a.anti_mirrors.z && i / (a.nx * a.ny) == 0) }
fn packet(file: &PaFile, path: &str, size: usize, fast: Value, quantized: bool) -> Vec<u8> {
    let a = &file.array;
    let mut distinct = BTreeSet::new(); let mut electrodes = Vec::new();
    for (&v, &e) in a.potentials.iter().zip(&a.electrodes) { if e { electrodes.push(v); if distinct.len() < 1001 { distinct.insert((v + 0.).to_bits()); } } }
    let mut listed: Vec<_> = distinct.iter().map(|&v| f64::from_bits(v)).collect(); listed.sort_by(f64::total_cmp); listed.truncate(64);
    let low = a.potentials.iter().copied().fold(f64::INFINITY, f64::min);
    let high = a.potentials.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let header = json!({
        "mode":file.mode.value(),"symmetry":if a.symmetry == Symmetry::Planar {"planar"} else {"cylindrical"},
        "nx":a.nx,"ny":a.ny,"nz":a.nz,"dx":a.dx_mm,"dy":a.dy_mm,"dz":a.dz_mm,
        "mirror":{"x":a.mirrors.x,"y":a.mirrors.y,"z":a.mirrors.z},
        "antiMirror":{"x":a.anti_mirrors.x,"y":a.anti_mirrors.y,"z":a.anti_mirrors.z},
        "field":if a.field_type == FieldType::Electrostatic {"electrostatic"} else {"magnetic"},
        "refinable":a.refinable,"maxVoltage":file.max_voltage,"ng":file.ng,"points":a.potentials.len(),
        "electrodePoints":electrodes.len(),"potentialMin":low,"potentialMax":high,
        "electrodeMin":electrodes.iter().copied().reduce(f64::min),"electrodeMax":electrodes.iter().copied().reduce(f64::max),
        "electrodeValues":listed,"distinctElectrodeValues":distinct.len(),
        "pa0":file.pa0.as_ref().map(|m| json!({"adjustable":m.electrode_indices.iter().filter(|&&i|i != -1).count(),
            "electrodeNumbers":m.electrode_indices.iter().enumerate().filter_map(|(i,&v)|(v != -1).then_some(i)).collect::<Vec<_>>(),
            "referenceVoltage":m.reference_voltage,"fastScalable":matches!(m.scalable,Some(FastScalable::Voltages(_)))})),
        "path":path,"fileName":Path::new(path).file_name().unwrap_or_default().to_string_lossy(),"fileSize":size,"fast":fast,"cuts":null
    }).to_string();
    let alignment = if quantized { 8 } else { 4 }; let padded = header.len().div_ceil(alignment) * alignment;
    let mut out = Vec::new(); out.extend_from_slice(if quantized { b"SPQ1" } else { b"SPA1" }); out.extend_from_slice(&(padded as u32).to_le_bytes()); out.extend_from_slice(header.as_bytes()); out.resize(8 + padded, b' ');
    if quantized {
        let step = if high > low { (high - low) / f64::from(u16::MAX) } else { 0. };
        out.extend_from_slice(&low.to_le_bytes()); out.extend_from_slice(&step.to_le_bytes());
        for &v in &a.potentials { let code = if step > 0. { ((v - low) / step).round() as u16 } else { 0 }; out.extend_from_slice(&code.to_le_bytes()); }
    } else { for &v in &a.potentials { out.extend_from_slice(&(v as f32).to_le_bytes()); } out.extend(a.electrodes.iter().map(|&e| u8::from(e))); }
    out
}
fn packet_at(files: &BTreeMap<String, Vec<u8>>, file: &PaFile, path: &str, size: usize, fast: Value, quantized: bool) -> Vec<u8> {
    let bytes = packet(file, path, size, fast, quantized); let sidecar = Path::new(path).with_extension("cuts.json");
    if !files.contains_key(&sidecar.to_string_lossy().into_owned()) { return bytes; }
    let length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut header: Value = serde_json::from_slice(&bytes[8..8 + length]).unwrap(); header["cuts"] = json!(sidecar.file_name().unwrap_or_default().to_string_lossy());
    let header = header.to_string(); let alignment = if quantized { 8 } else { 4 }; let padded = header.len().div_ceil(alignment) * alignment;
    let mut result = Vec::with_capacity(bytes.len() - length + padded); result.extend_from_slice(&bytes[..4]); result.extend_from_slice(&(padded as u32).to_le_bytes()); result.extend_from_slice(header.as_bytes()); result.resize(8 + padded, b' '); result.extend_from_slice(&bytes[8 + length..]); result
}
fn fast_status(files: &BTreeMap<String, Vec<u8>>, path: &str, file: &PaFile, overrides: &[(usize, f64)]) -> Value {
    let Some(metadata) = &file.pa0 else { return Value::Null; };
    if let Err(e) = read_fast_adjust_with(path, &[], |p| decode(files, p)) { return json!({"state":"missing","detail":e.to_string()}); }
    json!({"state":"ready","electrodes":metadata.electrode_indices.iter().enumerate().filter(|(_,i)|**i != -1).map(|(number,&index)| {
        let current = match &metadata.scalable { Some(FastScalable::Voltages(v)) => v[number], _ => file.array.potentials[index as usize] };
        let voltage = overrides.iter().find(|v|v.0 == number).map_or(current,|v|v.1); json!({"number":number,"voltage":voltage})
    }).collect::<Vec<_>>()})
}
#[wasm_bindgen]
#[derive(Default)]
pub struct WasmBackend {
    files: BTreeMap<String, Vec<u8>>, sessions: BTreeMap<String, String>, flights: BTreeMap<u32, flight::Record>, next_token: u32, desktop_state: desktop::AppState,
}
#[wasm_bindgen]
impl WasmBackend {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self::default() }
    pub fn current_threads(&self) -> usize { rayon::current_num_threads() }
    pub fn put_file(&mut self, path: String, bytes: Vec<u8>) -> Result<(), JsValue> {
        if self.files.get(&path) == Some(&bytes) { return Ok(()); }
        desktop::vfs::limits::validate_input(&path, &bytes).map_err(error)?;
        let size: usize = self.files.iter().filter(|(p, _)| **p != path).map(|(_, b)| b.len()).sum();
        if size.saturating_add(bytes.len()) > 256 * 1024 * 1024 { return Err(error("worker resident-byte budget exceeded (256 MiB)")); }
        self.desktop_state.geometries.lock().unwrap().remove(Path::new(&path));
        self.files.insert(path, bytes); Ok(())
    }
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>, JsValue> { self.files.get(path).cloned().ok_or_else(|| error(format!("file not found: {path}"))) }
    pub fn list_files(&self) -> String { json!(self.files.iter().map(|(path,bytes)|json!({"path":path,"name":Path::new(path).file_name().unwrap_or_default().to_string_lossy(),"size":bytes.len()})).collect::<Vec<_>>()).to_string() }
    pub fn open_pa(&mut self, id: String, path: String) -> Result<Vec<u8>, JsValue> {
        let file = decode(&self.files, Path::new(&path)).map_err(error)?;
        let bytes = packet_at(&self.files, &file, &path, self.files[&path].len(), fast_status(&self.files, &path, &file, &[]), false);
        self.sessions.insert(id, path); Ok(bytes)
    }
    pub fn close_session(&mut self, id: &str) {
        let Some(path) = self.sessions.remove(id) else { return; };
        self.flights.retain(|_, record| record.request.id != id);
        let stem = Path::new(&path).with_extension("");
        if self.sessions.values().any(|p| Path::new(p).with_extension("") == stem) { return; }
        let cuts = Path::new(&path).with_extension("cuts.json");
        // Evict the closed family only. Unrelated newly registered files may be awaiting open_pa.
        self.files.retain(|p, _| {
            let candidate = Path::new(p);
            let ext = candidate.extension().and_then(|s| s.to_str()).unwrap_or_default();
            let family = matches!(ext, "pa" | "pa#" | "pa_" | "pa-surf") || ext.strip_prefix("pa").is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
            candidate != Path::new(&path) && candidate != cuts && !(candidate.with_extension("") == stem && family)
        });
        self.desktop_state.geometries.lock().unwrap().retain(|p, _| p.with_extension("") != stem);
    }
    pub fn fast_adjust(&self, id: &str, voltages: &str) -> Result<Vec<u8>, JsValue> { self.adjusted_packet(id, voltages, true) }
    pub fn adjusted_pa(&self, id: &str, voltages: &str) -> Result<Vec<u8>, JsValue> { self.adjusted_packet(id, voltages, false) }
    pub fn electrode_labels(&self, id: &str) -> Result<Vec<u8>, JsValue> {
        let path = self.sessions.get(id).ok_or_else(|| error("noSession"))?; let file = decode(&self.files, Path::new(path)).map_err(error)?;
        let Some(metadata) = &file.pa0 else { return Ok(Vec::new()); };
        if read_fast_adjust_with(path, &[], |p| decode(&self.files, p)).is_err() { return Ok(Vec::new()); }
        let prefix = Path::new(path).extension().unwrap().to_string_lossy(); let mut labels = vec![0u16; file.array.potentials.len()];
        for (number, &index) in metadata.electrode_indices.iter().enumerate().skip(1) {
            if index == -1 { continue; }
            let basis = decode(&self.files, &Path::new(path).with_extension(format!("{}{number}", &prefix[..2]))).map_err(error)?;
            let peak = basis.array.potentials.iter().zip(&basis.array.electrodes).filter(|(_, e)| **e).map(|(v, _)| v.abs()).fold(0., f64::max);
            for (i, label) in labels.iter_mut().enumerate() { if *label == 0 && file.array.electrodes[i] && basis.array.potentials[i].abs() >= 0.5 * peak { *label = number as u16; } }
        }
        Ok(labels.into_iter().flat_map(u16::to_le_bytes).collect())
    }
    pub fn refine_pa(&mut self, id: &str, tolerance: f64, max_cycles: usize) -> Result<String, JsValue> {
        let mut job = self.refine_begin(&json!({"id":id,"device":"cpu","tolerance":tolerance,"maxCycles":max_cycles}).to_string())?;
        loop { let state: Value = serde_json::from_str(&job.step()?).map_err(error)?; if state["terminal"] == true { break; } }
        self.refine_commit(&job)?; Ok(job.summary())
    }
}
impl WasmBackend {
    fn adjusted_packet(&self, id: &str, voltages: &str, quantized: bool) -> Result<Vec<u8>, JsValue> {
        let voltages: Vec<(usize, f64)> = serde_json::from_str(voltages).map_err(error)?;
        let path = self.sessions.get(id).ok_or_else(|| error("noSession"))?;
        let mut file = decode(&self.files, Path::new(path)).map_err(error)?;
        file.array = read_fast_adjust_with(path, &voltages, |p| decode(&self.files, p)).map_err(error)?;
        Ok(packet_at(&self.files, &file, path, self.files[path].len(), fast_status(&self.files, path, &file, &voltages), quantized))
    }
}
