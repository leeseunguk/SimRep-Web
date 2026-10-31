//! Desktop command contracts over the worker's existing virtual byte registry.
//!
//! The build adapter compiles algorithms from the pinned desktop tree. Tauri entry points and
//! OS I/O alone are replaced; native oracle modules retain their original OS I/O.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

use crate::WasmBackend;

mod errors {
    include!(concat!(env!("OUT_DIR"), "/desktop_errors.rs"));
}
pub use errors::{PaError, Reason};
pub mod geometry {
    include!(concat!(env!("OUT_DIR"), "/desktop_geometry.rs"));
}
pub mod iob {
    include!(concat!(env!("OUT_DIR"), "/desktop_iob.rs"));
}
pub mod templates {
    include!(concat!(env!("OUT_DIR"), "/desktop_templates.rs"));
}
pub mod voxelize {
    include!(concat!(env!("OUT_DIR"), "/desktop_voxelize.rs"));
}
pub mod vfs;

#[cfg(not(target_arch = "wasm32"))]
pub mod geometry_native {
    include!(concat!(env!("OUT_DIR"), "/desktop_geometry_native.rs"));
}
#[cfg(not(target_arch = "wasm32"))]
pub mod iob_native {
    include!(concat!(env!("OUT_DIR"), "/desktop_iob_native.rs"));
}
#[cfg(not(target_arch = "wasm32"))]
pub mod hash_native {
    include!(concat!(env!("OUT_DIR"), "/desktop_hash.rs"));
}

#[derive(Default)]
pub struct AppState {
    pub geometries: Mutex<BTreeMap<PathBuf, Arc<dyn std::any::Any + Send + Sync>>>,
    template_dirs: Mutex<BTreeSet<String>>,
}

impl AppState {
    pub fn prepared(&self, path: &Path) -> Option<Arc<geometry::Prepared>> {
        Arc::clone(self.geometries.lock().unwrap().get(path)?)
            .downcast()
            .ok()
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

impl PaError {
    fn js(self) -> JsValue {
        JsValue::from_str(&serde_json::to_string(&self).unwrap())
    }
}

fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str, PaError> {
    args[key]
        .as_str()
        .ok_or_else(|| PaError::new("unexpected", format!("missing {key}")))
}

#[wasm_bindgen]
impl WasmBackend {
    /// JSON-valued desktop commands. SGP1 inspection is returned by desktop_inspect.
    pub fn desktop_command(&mut self, command: &str, args: &str) -> Result<String, JsValue> {
        let args: Value = serde_json::from_str(args)
            .map_err(|e| PaError::new("unexpected", e.to_string()).js())?;
        let result = vfs::with_files(&mut self.files, || {
            execute(&self.desktop_state, command, &args)
        });
        if result.is_ok()
            && ["write_text", "write_bytes", "remove_file"].contains(&command)
            && let Some(path) = args["path"].as_str()
        {
            self.desktop_state
                .geometries
                .lock()
                .unwrap()
                .remove(Path::new(path));
        }
        result.map(|v| v.to_string()).map_err(PaError::js)
    }

    pub fn desktop_inspect(&mut self, request: &str) -> Result<Vec<u8>, JsValue> {
        let request = serde_json::from_str(request)
            .map_err(|e| PaError::new("geometry", e.to_string()).js())?;
        vfs::with_files(&mut self.files, || geometry::inspect_geometry(request))
            .map_err(PaError::js)
    }
}

fn execute(state: &AppState, command: &str, args: &Value) -> Result<Value, PaError> {
    let json_error = |e: serde_json::Error| PaError::new("unexpected", e.to_string());
    match command {
        "read_text" => Ok(json!(
            String::from_utf8(vfs::read(argument(args, "path")?)?)
                .map_err(|e| PaError::new("badHeader", e.to_string()))?
        )),
        "write_text" => {
            vfs::write(
                argument(args, "path")?,
                argument(args, "contents")?.as_bytes(),
            )?;
            Ok(Value::Null)
        }
        "write_bytes" => {
            let bytes: Vec<u8> =
                serde_json::from_value(args["bytes"].clone()).map_err(json_error)?;
            vfs::write(argument(args, "path")?, bytes)?;
            Ok(Value::Null)
        }
        "remove_file" => {
            vfs::remove_file(argument(args, "path")?)?;
            Ok(Value::Null)
        }
        "recovery_path" => Ok(json!("recovery.simrep")),
        "file_sha256" => Ok(json!(format!(
            "{:x}",
            Sha256::digest(vfs::read(argument(args, "path")?)?)
        ))),
        "open_iob" => {
            serde_json::to_value(iob::open_iob(argument(args, "path")?.into())?).map_err(json_error)
        }
        "build_geometry" => {
            let request = serde_json::from_value(args.get("request").unwrap_or(args).clone())
                .map_err(json_error)?;
            serde_json::to_value(geometry::build(state, request)?).map_err(json_error)
        }
        "create_template" => {
            let kind = argument(args, "kind")?;
            let (name, bytes) = templates::bytes(kind)?;
            let mut dirs = state.template_dirs.lock().unwrap();
            let dir = (1..)
                .map(|n| {
                    if n == 1 {
                        format!("SimRep/{kind}")
                    } else {
                        format!("SimRep/{kind}-{n}")
                    }
                })
                .find(|dir| !dirs.contains(dir) && !vfs::contains_dir(dir))
                .unwrap();
            let path = format!("{dir}/{name}");
            let size = bytes.len();
            vfs::write(&path, bytes)?;
            dirs.insert(dir.clone());
            Ok(json!({"path":path,"name":name,"size":size,"dir":dir}))
        }
        _ => Err(PaError::new(
            "unexpected",
            format!("unsupported in browser: {command}"),
        )),
    }
}
