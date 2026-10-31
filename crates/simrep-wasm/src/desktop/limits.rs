//! Resource checks at the browser byte-registry boundary, before native parsers allocate.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};
use std::path::Path;
use quick_xml::{Reader, events::Event};
fn invalid(s: impl Into<String>) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, s.into()) }
pub fn validate_input(path: &str, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > 128 * 1024 * 1024 { return Err(invalid("input exceeds 128 MiB")); }
    match Path::new(path).extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase().as_str() {
        "fly2" => fly2(std::str::from_utf8(bytes).map_err(|_| invalid("invalid UTF-8"))?)?,
        "ion" => { if bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty() && !l.starts_with(b";")).count() > 1_000_000 { return Err(invalid("particle limit exceeded (1000000)")); } },
        "3mf" => threemf(bytes)?,
        _ => {}
    }
    Ok(())
}
fn skip(b: &[u8], i: &mut usize) {
    loop {
        while *i < b.len() && b[*i].is_ascii_whitespace() { *i += 1; }
        if b.get(*i..*i+2) != Some(b"--") { break; }
        *i += 2;
        if b.get(*i..*i+2) == Some(b"[[") { *i += 2; while *i < b.len() && b.get(*i..*i+2) != Some(b"]]") { *i += 1; } *i = (*i + 2).min(b.len()); }
        else { while *i < b.len() && b[*i] != b'\n' { *i += 1; } }
    }
}
fn fly2(source: &str) -> io::Result<()> {
    let b = source.as_bytes(); let mut i = 0; let mut count: usize = 0;
    while i < b.len() {
        skip(b, &mut i); if i >= b.len() { break; }
        if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let start = i; i += 1; while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') { i += 1; }
            let word = &source[start..i];
            if word == "standard_beam" || word == "standard_beam_define" { count = count.saturating_add(1); }
            if word == "n" {
                skip(b, &mut i); if b.get(i) != Some(&b'=') { return Err(invalid("invalid literal FLY2 count")); } i += 1; skip(b, &mut i);
                let start = i; while i < b.len() && (b[i].is_ascii_digit() || b".eE+-".contains(&b[i])) { i += 1; }
                let n: f64 = source[start..i].parse().map_err(|_| invalid("invalid literal FLY2 count"))?;
                if !(1. ..=1_000_000.).contains(&n) || n.fract() != 0. { return Err(invalid("FLY2 particle limit exceeded (1000000)")); }
                count = count.saturating_add(n as usize - 1);
            }
            if count > 1_000_000 { return Err(invalid("FLY2 particle limit exceeded (1000000)")); }
        } else { i += 1; }
    }
    Ok(())
}
fn inflated(reader: &mut impl Read, compressed: u64, total: &mut usize) -> io::Result<Vec<u8>> {
    let mut data = Vec::new(); let mut chunk = [0u8; 16384];
    loop {
        let n = reader.read(&mut chunk)?; if n == 0 { break; } *total += n;
        if data.len() + n > 32 * 1024 * 1024 || *total > 64 * 1024 * 1024 || (data.len() + n) as u64 > compressed.saturating_mul(200) { return Err(invalid("3MF actual expansion budget exceeded")); }
        data.extend_from_slice(&chunk[..n]);
    }
    Ok(data)
}
fn threemf(bytes: &[u8]) -> io::Result<()> {
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes)).map_err(|e| invalid(e.to_string()))?;
    if archive.len() > 2048 { return Err(invalid("3MF entry limit exceeded")); }
    let mut declared = 0u64; let mut names = BTreeSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = entry.name().map_err(|e| invalid(e.to_string()))?.into_owned();
        if name.starts_with('/') || name.contains('\\') || name.contains(':') || name.trim_end_matches('/').split('/').any(|s| s == ".." || s == "." || s.is_empty()) || !names.insert(name) || entry.unix_mode().is_some_and(|m| m & 0xf000 == 0xa000) { return Err(invalid("unsafe or duplicate 3MF path")); }
        declared = declared.saturating_add(entry.size());
        if entry.size() > 32 * 1024 * 1024 || declared > 64 * 1024 * 1024 || entry.size() > entry.compressed_size().saturating_mul(200) { return Err(invalid("3MF expansion budget exceeded")); }
    }
    let mut total = 0;
    let relationships = {
        let mut entry = archive.by_name("_rels/.rels").map_err(|e| invalid(e.to_string()))?;
        let compressed = entry.compressed_size(); inflated(&mut entry, compressed, &mut total)?
    };
    let relationships_xml = std::str::from_utf8(&relationships).map_err(|_| invalid("invalid 3MF relationship UTF-8"))?;
    let mut reader = Reader::from_str(relationships_xml); let mut target = None;
    loop {
        match reader.read_event().map_err(|e| invalid(e.to_string()))? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "Relationship" => {
                let mut kind = None; let mut path = None;
                for a in e.attributes() {
                    let a = a.map_err(|e| invalid(e.to_string()))?;
                    let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| invalid(e.to_string()))?.into_owned();
                    match a.key.as_ref() { "Type" => kind = Some(value), "Target" => path = Some(value), _ => {} }
                }
                if kind.is_some_and(|s| s.ends_with("/3dmodel")) { target = path; break; }
            },
            Event::Eof => break,
            _ => {}
        }
    }
    let target = target.ok_or_else(|| invalid("3MF package has no primary model relationship"))?;
    let target = target.trim_start_matches('/');
    if !names.contains(target) { return Err(invalid("3MF primary model is missing")); }
    // The native parser follows this relationship, regardless of file extension or case.
    if target == "_rels/.rels" { model(relationships_xml)?; }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = entry.name().map_err(|e| invalid(e.to_string()))?.into_owned();
        if name == "_rels/.rels" { continue; }
        let compressed = entry.compressed_size(); let data = inflated(&mut entry, compressed, &mut total)?;
        if name == target { model(std::str::from_utf8(&data).map_err(|_| invalid("invalid 3MF UTF-8"))?)?; }
    }
    Ok(())
}
#[derive(Default)]
struct Object { vertices: usize, faces: usize, children: Vec<u32> }
fn model(xml: &str) -> io::Result<()> {
    let mut reader = Reader::from_str(xml); let mut current = None;
    let mut objects: BTreeMap<u32, Object> = BTreeMap::new(); let mut roots = Vec::new(); let mut source_counts = [0usize; 2];
    loop {
        match reader.read_event().map_err(|e| invalid(e.to_string()))? {
            Event::Start(e) | Event::Empty(e) => {
                let mut id = None;
                for a in e.attributes() {
                    let a = a.map_err(|e| invalid(e.to_string()))?;
                    if a.key.as_ref() == "id" || a.key.as_ref() == "objectid" { id = Some(a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| invalid(e.to_string()))?.parse::<u32>().map_err(|_| invalid("invalid 3MF id"))?); }
                }
                match e.local_name().as_ref() {
                    "object" => { let id = id.ok_or_else(|| invalid("missing 3MF id"))?; if objects.len() >= 2048 || objects.insert(id, Object::default()).is_some() { return Err(invalid("duplicate or excessive 3MF objects")); } current = Some(id); },
                    "vertex" | "triangle" | "component" => {
                        let object = objects.get_mut(&current.ok_or_else(|| invalid("3MF data outside object"))?).unwrap();
                        match e.local_name().as_ref() {
                            "vertex" => { object.vertices += 1; source_counts[0] += 1; },
                            "triangle" => { object.faces += 1; source_counts[1] += 1; },
                            _ => object.children.push(id.ok_or_else(|| invalid("missing component id"))?)
                        }
                        if source_counts.iter().any(|n| *n > 1_000_000) || object.children.len() > 2048 { return Err(invalid("3MF geometry budget exceeded")); }
                    },
                    "item" => { if roots.len() >= 2048 { return Err(invalid("3MF build item budget exceeded")); } roots.push(id.ok_or_else(|| invalid("missing item id"))?); },
                    _ => {}
                }
            },
            Event::End(e) if e.local_name().as_ref() == "object" => current = None,
            Event::Eof => break,
            _ => {}
        }
    }
    fn expanded(id: u32, objects: &BTreeMap<u32, Object>, active: &mut BTreeSet<u32>, memo: &mut BTreeMap<u32, [usize; 3]>) -> io::Result<[usize; 3]> {
        if let Some(n) = memo.get(&id) { return Ok(*n); }
        if active.len() >= 128 || !active.insert(id) { return Err(invalid("cyclic or excessive 3MF nesting")); }
        let o = objects.get(&id).ok_or_else(|| invalid("unknown 3MF object"))?;
        let mut n = [1usize, o.vertices, o.faces];
        for child in &o.children { let v = expanded(*child, objects, active, memo)?; for k in 0..3 { n[k] = n[k].saturating_add(v[k]); } if n[0] > 2048 || n[1] > 1_000_000 || n[2] > 1_000_000 { return Err(invalid("3MF instantiated geometry budget exceeded")); } }
        active.remove(&id); memo.insert(id, n); Ok(n)
    }
    let mut n = [0usize; 3]; let mut memo = BTreeMap::new();
    for root in roots { let v = expanded(root, &objects, &mut BTreeSet::new(), &mut memo)?; for k in 0..3 { n[k] = n[k].saturating_add(v[k]); } if n[0] > 2048 || n[1] > 1_000_000 || n[2] > 1_000_000 { return Err(invalid("3MF instantiated geometry budget exceeded")); } }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn zipped(xml: &[u8], compressed: bool, name: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        writer.start_file("_rels/.rels", zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(format!("<Relationships><Relationship Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" Target=\"/{name}\"/></Relationships>").as_bytes()).unwrap();
        writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(if compressed { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored })).unwrap();
        writer.write_all(xml).unwrap(); writer.finish().unwrap().into_inner()
    }
    #[test]
    fn fly2_counts_precede_expansion() {
        assert!(fly2("particles {standard_beam {n=1000001}}").is_err());
        assert!(fly2("particles {standard_beam {n=600000},standard_beam {n=600000}}").is_err());
        assert!(fly2("-- n=10000000\nparticles {standard_beam {n --comment\n = 2}}").is_ok());
    }
    #[test]
    fn threemf_bomb_and_relationship_selected_branching_are_bounded() {
        assert!(threemf(&zipped(&vec![b' '; 1024 * 1024], true, "3D/model.model")).unwrap_err().to_string().contains("budget"));
        let mut xml = String::from("<model><resources><object id=\"1\"></object>");
        for n in 2..16 { xml.push_str(&format!("<object id=\"{n}\"><components><component objectid=\"{}\"/><component objectid=\"{}\"/></components></object>", n - 1, n - 1)); }
        xml.push_str("</resources><build><item objectid=\"15\"/></build></model>");
        for name in ["3D/model.model", "3D/branch.XML", "3D/branch"] { assert!(threemf(&zipped(xml.as_bytes(), false, name)).unwrap_err().to_string().contains("instantiated")); }
    }
}
