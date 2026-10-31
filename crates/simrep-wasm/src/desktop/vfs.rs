//! Scoped access to the same byte map used by PA, refinement, flight and exports.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

thread_local! {
    static FILES: RefCell<BTreeMap<String, Vec<u8>>> = const { RefCell::new(BTreeMap::new()) };
}

pub fn with_files<T>(files: &mut BTreeMap<String, Vec<u8>>, call: impl FnOnce() -> T) -> T {
    FILES.with(|active| active.replace(std::mem::take(files)));
    let result = call();
    *files = FILES.with(|active| active.take());
    result
}

pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let path = path.as_ref().to_string_lossy();
    FILES
        .with(|files| files.borrow().get(path.as_ref()).cloned())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("file not found: {path}")))
}

pub fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    FILES.with(|files| {
        files.borrow_mut().insert(
            path.as_ref().to_string_lossy().into_owned(),
            bytes.as_ref().to_vec(),
        )
    });
    Ok(())
}

pub fn is_file(path: impl AsRef<Path>) -> bool {
    FILES.with(|files| {
        files
            .borrow()
            .contains_key(path.as_ref().to_string_lossy().as_ref())
    })
}

pub fn contains_dir(path: &str) -> bool {
    let prefix = format!("{path}/");
    FILES.with(|files| files.borrow().keys().any(|p| p.starts_with(&prefix)))
}

pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    FILES.with(|files| {
        files
            .borrow_mut()
            .remove(path.as_ref().to_string_lossy().as_ref())
    });
    Ok(())
}

pub fn create_dir_all(_: impl AsRef<Path>) -> io::Result<()> {
    // Virtual directories are implicit in registered names.
    Ok(())
}

pub fn resolve(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if is_file(&exact) {
        return Some(exact);
    }
    FILES.with(|files| {
        files.borrow().keys().map(PathBuf::from).find(|path| {
            path.parent() == Some(dir)
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
        })
    })
}

pub fn write_pa(path: impl AsRef<Path>, pa: &simrep_io::PaFile) -> io::Result<()> {
    write(path, crate::encode(pa)?)
}

pub fn read_gem(path: impl AsRef<Path>) -> Result<simrep_gem::Gem, simrep_gem::Error> {
    simrep_gem::read_gem_with(path, |p| {
        read(p).map_err(|e| simrep_gem::Error(e.to_string()))
    })
}

pub fn read_mesh(
    path: impl AsRef<Path>,
    options: simrep_mesh::ImportOptions,
) -> io::Result<simrep_mesh::Mesh> {
    simrep_mesh::read_mesh_with(path, options, |p| read(p))
}
