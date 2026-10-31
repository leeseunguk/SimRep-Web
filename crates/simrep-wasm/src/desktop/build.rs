// Compile the pinned desktop algorithms, replacing only their Tauri and filesystem adapters.
// Exact delimiters make a desktop contract change fail the build rather than drift silently.
use std::{env, fs, path::PathBuf};

fn replace(source: &mut String, from: &str, to: &str) {
    assert!(source.contains(from), "desktop adapter delimiter changed: {from}");
    *source = source.replace(from, to);
}

fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source.split_once(start).unwrap().1.split_once(end).unwrap().0
}

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../simrep/app/src-tauri/src");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let read = |name: &str| {
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        fs::read_to_string(path).unwrap()
    };
    let pa = read("pa.rs");
    let errors = between(&pa, "#[derive(Debug, Clone, Serialize)]", "#[derive(Serialize)]\nstruct Flags");
    let errors = format!("use serde::Serialize;\nuse std::io;\n#[derive(Debug, Clone, Serialize)]{errors}");
    let begin = errors.find("    #[cfg(test)]\n    pub fn code").unwrap();
    let end = errors[begin..].find("\n}\n\nimpl From<io::Error>").unwrap() + begin;
    let errors = format!("{}{}", &errors[..begin], &errors[end..]);
    fs::write(out.join("desktop_errors.rs"), errors).unwrap();
    let hash = read("projectdir.rs");
    let hash = between(&hash, "pub fn sha256_file", "async fn blocking");
    fs::write(out.join("desktop_hash.rs"), format!("use std::path::Path;\nuse std::io::Read;\nuse sha2::{{Digest, Sha256}};\nuse super::PaError;\npub fn sha256_file{hash}")).unwrap();

    // The pinned mesh voxelizer's native clock traps on wasm32. Its accelerated
    // row method is private; use Solid's public robust classifier at the same
    // sample points (the native row method's own degenerate-ray fallback).
    let grid_path = root.join("../../../crates/simrep-mesh/src/grid.rs");
    println!("cargo:rerun-if-changed={}", grid_path.display());
    let grid = fs::read_to_string(grid_path).unwrap();
    let mut voxelize = between(&grid, "pub fn voxelize(", "#[derive(Clone, Debug)]\npub struct SignedDistanceGrid").to_owned();
    replace(&mut voxelize, "let inside = solid.row(start, grid.spacing_mm[0], nx);", "let inside: Vec<bool> = (0..nx).map(|x| solid.contains([start[0] + x as f64 * grid.spacing_mm[0], start[1], start[2]])).collect();");
    fs::write(out.join("desktop_voxelize.rs"), format!("use simrep_mesh::{{Mesh, GridSpec, Solid, Voxelization}};\nuse simrep_core::PotentialArray;\nuse rayon::prelude::*;\nuse std::io;\nuse web_time::Instant;\nfn invalid(message: impl Into<String>) -> io::Error {{ io::Error::new(io::ErrorKind::InvalidData, message.into()) }}\npub fn voxelize({voxelize}")).unwrap();

    let templates = read("templates.rs");
    let mut templates = templates.split_once("/// First free").unwrap().0.to_owned();
    replace(&mut templates, "//!", "//");
    replace(&mut templates, "use simrep_io::{PaFile, write_pa};", "use simrep_io::PaFile;");
    replace(&mut templates, "use std::path::{Path, PathBuf};\n", "");
    replace(&mut templates, "use tauri::{AppHandle, Manager};\n", "");
    replace(&mut templates, "use serde::Serialize;\n", "");
    replace(&mut templates, "use crate::pa::{PaError, file_name};\n", "");
    templates.push_str("\npub fn bytes(kind: &str) -> Result<(&'static str, Vec<u8>), super::PaError> {\nlet t = template(kind).ok_or_else(|| super::PaError::new(\"unexpected\", format!(\"unknown template {kind}\")))?;\nlet mut bytes = Vec::new(); build(&t).write(&mut bytes)?; Ok((t.file, bytes))\n}\n");
    fs::write(out.join("desktop_templates.rs"), templates).unwrap();

    let mut geometry = read("geometry.rs");
    replace(&mut geometry, "//!", "//");
    replace(&mut geometry, "use tauri::State;\n", "");
    replace(&mut geometry, "use tauri::ipc::Response;", "type Response = Vec<u8>;");
    replace(&mut geometry, "use crate::pa::{PaError, Reason, file_name};", "use super::{PaError, Reason, file_name};");
    replace(&mut geometry, "use crate::session::AppState;", "use super::AppState;");
    replace(&mut geometry, "#[tauri::command]\npub async fn inspect_geometry(request: InspectRequest) -> Result<Response, PaError> {\n    tauri::async_runtime::spawn_blocking(move || {", "pub fn inspect_geometry(request: InspectRequest) -> Result<Response, PaError> {");
    replace(&mut geometry, "        Ok(Response::new(out))\n    })\n    .await\n    .map_err(|e| PaError::new(\"unexpected\", e.to_string()))?", "        Ok(out)");
    let wrapper = geometry.find("#[tauri::command]\npub async fn build_geometry(").unwrap();
    let build = geometry[wrapper..].find("fn build(state:").unwrap() + wrapper;
    geometry.replace_range(wrapper..build, "");
    replace(&mut geometry, "fn build(state:", "pub fn build(state:");
    let cad_begin = geometry.find("/// Preview grid points along").unwrap();
    let cad_end = geometry[cad_begin..].find("// ------------------------------------------------------------------------------- build").unwrap() + cad_begin;
    geometry.replace_range(cad_begin..cad_end, "type CadSource = (String, Arc<dyn SignedDistance>, SourceGeometry);\ntype Source = (String, usize, Arc<dyn SignedDistance>, SourceGeometry);\nfn inspect_cad(_: &Path, _: Option<Unit>, _: &mut Vec<f32>, _: &mut Vec<PartInfo>, _: &mut Option<[[f64; 3]; 2]>) -> Result<(Suggestion, usize), PaError> { Err(PaError::new(\"geometry\", \"unsupported in browser: STEP/IGES CAD\")) }\nfn cad_sources(_: &Path, _: Option<Unit>, _: CadSurface, _: [f64; 3]) -> Result<Vec<CadSource>, PaError> { Err(PaError::new(\"geometry\", \"unsupported in browser: STEP/IGES CAD\")) }\n");
    fs::write(out.join("desktop_geometry_native.rs"), &geometry).unwrap();
    replace(&mut geometry, "use std::time::Instant;", "use web_time::Instant;");
    replace(&mut geometry, "use std::fs::File;\n", "");
    replace(&mut geometry, "use std::io::{BufWriter, Write};\n", "");
    replace(&mut geometry, "use simrep_io::{PaFile, write_pa};", "use simrep_io::PaFile;\nuse super::vfs::{write_pa, read_gem};\nuse super::vfs;\nuse super::voxelize::voxelize;");
    replace(&mut geometry, "simrep_gem::read_gem(&path)", "read_gem(&path)");
    replace(&mut geometry, "inspect, read_mesh, repair, voxelize,", "inspect, repair,");
    replace(&mut geometry, "let mut mesh = read_mesh(", "let mut mesh = vfs::read_mesh(");
    replace(&mut geometry, "std::fs::create_dir_all", "vfs::create_dir_all");
    replace(&mut geometry, "std::fs::remove_file", "vfs::remove_file");
    replace(&mut geometry, "side.is_file()", "vfs::is_file(&side)");
    replace(&mut geometry, "        let mut writer = BufWriter::new(\n            File::create(&side).map_err(|e| fail(format!(\"{}: {e}\", side.display())))?,\n        );\n        serde_json::to_writer(&mut writer, &sidecar).map_err(|e| fail(e.to_string()))?;\n        writer.flush().map_err(|e| fail(e.to_string()))?;", "        let bytes = serde_json::to_vec(&sidecar).map_err(|e| fail(e.to_string()))?;\n        vfs::write(&side, bytes)?;");
    fs::write(out.join("desktop_geometry.rs"), geometry).unwrap();

    let mut iob = read("iob.rs");
    replace(&mut iob, "//!", "//");
    replace(&mut iob, "use crate::pa::{PaError, Reason};", "use super::{PaError, Reason};");
    replace(&mut iob, "#[tauri::command]\npub async fn open_iob(path: String) -> Result<IobInfo, PaError> {\n    tauri::async_runtime::spawn_blocking(move || {", "pub fn open_iob(path: String) -> Result<IobInfo, PaError> {");
    replace(&mut iob, "    })\n    .await\n    .map_err(|e| PaError::new(\"unexpected\", e.to_string()))?", "");
    replace(&mut iob, "crate::pa::file_name", "super::file_name");
    fs::write(out.join("desktop_iob_native.rs"), &iob).unwrap();
    replace(&mut iob, "std::fs::read(&path)", "super::vfs::read(&path)");
    let begin = iob.find("fn resolve(dir:").unwrap();
    let end = iob[begin..].find("pub fn open_iob").unwrap() + begin;
    iob.replace_range(begin..end, "fn resolve(dir: &Path, name: &str) -> Option<PathBuf> { super::vfs::resolve(dir, name) }\n\n");
    fs::write(out.join("desktop_iob.rs"), iob).unwrap();
}
