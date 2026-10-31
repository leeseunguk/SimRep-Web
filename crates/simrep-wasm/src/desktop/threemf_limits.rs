//! Browser-only limits, checked before the native reader owns XML attributes or
//! allocates mesh vectors. IDs use the native reader's exact attribute keys.
use super::invalid;
use quick_xml::{Reader, events::{BytesStart, Event}};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};

const PART_BYTES: usize = 32 * 1024 * 1024;
const TOTAL_BYTES: usize = 64 * 1024 * 1024;
const GEOMETRY: usize = 1_000_000;
const OBJECTS: usize = 2048;
const DEPTH: usize = 128;
const ATTRIBUTES: usize = 64;
const ATTRIBUTE_BYTES: usize = 4096;

fn inflated(reader: &mut impl Read, compressed: u64, total: &mut usize) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 { break; }
        if data.len() + n > PART_BYTES || *total + n > TOTAL_BYTES
            || (data.len() + n) as u64 > compressed.saturating_mul(200)
        { return Err(invalid("3MF actual expansion budget exceeded")); }
        *total += n;
        data.extend_from_slice(&chunk[..n]);
    }
    Ok(data)
}

// Events/attributes borrow the bounded input. Check raw bounds before
// normalized_value can allocate. No DTD reaches relationship or model parsing.
fn xml_limits(xml: &str, decoded: &mut usize) -> io::Result<()> {
    if xml.len() > PART_BYTES { return Err(invalid("3MF XML size budget exceeded")); }
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    loop {
        let event = reader.read_event().map_err(|e| invalid(e.to_string()))?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::DocType(_) | Event::GeneralRef(_) => return Err(invalid("3MF DTD and entities are forbidden")),
            Event::Start(e) | Event::Empty(e) => {
                if depth >= DEPTH { return Err(invalid("3MF XML nesting budget exceeded")); }
                if !empty { depth += 1; }
                for (i, a) in e.attributes().enumerate() {
                    if i >= ATTRIBUTES { return Err(invalid("3MF attribute count limit exceeded (64)")); }
                    let a = a.map_err(|e| invalid(e.to_string()))?;
                    if a.value.len() > ATTRIBUTE_BYTES || a.key.as_ref().len() > ATTRIBUTE_BYTES {
                        return Err(invalid("3MF attribute length limit exceeded (4096 bytes)"));
                    }
                    // Predefined/numeric XML escapes cannot grow beyond the raw
                    // bytes. Unknown entities fail: no custom resolver is used.
                    let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|e| invalid(format!("3MF invalid attribute or entity: {e}")))?;
                    *decoded = decoded.saturating_add(value.len());
                    if *decoded > TOTAL_BYTES { return Err(invalid("3MF decoded byte budget exceeded")); }
                }
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 { return Err(invalid("unclosed 3MF XML element")); }
    Ok(())
}

pub(super) fn validate(bytes: &[u8]) -> io::Result<()> {
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes)).map_err(|e| invalid(e.to_string()))?;
    if archive.len() > OBJECTS { return Err(invalid("3MF entry limit exceeded")); }
    let mut declared = 0u64;
    let mut names = BTreeSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = entry.name().map_err(|e| invalid(e.to_string()))?.into_owned();
        if name.starts_with('/') || name.contains('\\') || name.contains(':')
            || name.trim_end_matches('/').split('/').any(|s| s == ".." || s == "." || s.is_empty())
            || !names.insert(name) || entry.unix_mode().is_some_and(|m| m & 0xf000 == 0xa000)
        { return Err(invalid("unsafe or duplicate 3MF path")); }
        declared = declared.saturating_add(entry.size());
        if entry.size() > PART_BYTES as u64 || declared > TOTAL_BYTES as u64
            || entry.size() > entry.compressed_size().saturating_mul(200)
        { return Err(invalid("3MF expansion budget exceeded")); }
    }
    let mut total = 0;
    let relationships = {
        let mut entry = archive.by_name("_rels/.rels").map_err(|e| invalid(e.to_string()))?;
        let compressed = entry.compressed_size();
        inflated(&mut entry, compressed, &mut total)?
    };
    let relationships = std::str::from_utf8(&relationships).map_err(|_| invalid("invalid 3MF relationship UTF-8"))?;
    let mut decoded = 0;
    xml_limits(relationships, &mut decoded)?;
    let mut reader = Reader::from_str(relationships);
    let mut target = None;
    loop {
        match reader.read_event().map_err(|e| invalid(e.to_string()))? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "Relationship" => {
                let mut kind = None;
                let mut path = None;
                for a in e.attributes() {
                    let a = a.map_err(|e| invalid(e.to_string()))?;
                    let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| invalid(e.to_string()))?.into_owned();
                    match a.key.as_ref() { "Type" => kind = Some(value), "Target" => path = Some(value), _ => {} }
                }
                if kind.is_some_and(|s| s.ends_with("/3dmodel")) { target = path; break; }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let target = target.ok_or_else(|| invalid("3MF package has no primary model relationship"))?;
    let target = target.trim_start_matches('/');
    if !names.contains(target) { return Err(invalid("3MF primary model is missing")); }
    if target == "_rels/.rels" { model(relationships)?; }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = entry.name().map_err(|e| invalid(e.to_string()))?.into_owned();
        if name == "_rels/.rels" { continue; }
        let compressed = entry.compressed_size();
        let data = inflated(&mut entry, compressed, &mut total)?;
        if name == target {
            let xml = std::str::from_utf8(&data).map_err(|_| invalid("invalid 3MF UTF-8"))?;
            xml_limits(xml, &mut decoded)?;
            model(xml)?;
        }
    }
    Ok(())
}

fn number(e: &BytesStart<'_>, key: &str) -> io::Result<Option<usize>> {
    for a in e.attributes() {
        let a = a.map_err(|e| invalid(e.to_string()))?;
        if a.key.as_ref() == key {
            return a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| invalid(e.to_string()))?
                .parse().map(Some).map_err(|_| invalid(format!("invalid 3MF {key}")));
        }
    }
    Ok(None)
}
#[derive(Default)]
struct Object {
    vertices: usize,
    faces: usize,
    name_bytes: usize,
    children: Vec<u32>,
}
fn model(xml: &str) -> io::Result<()> {
    let mut reader = Reader::from_str(xml);
    let mut current = None;
    let mut objects: BTreeMap<u32, Object> = BTreeMap::new();
    let mut roots = Vec::new();
    let mut source = [0usize; 2];
    let mut counts: Vec<(bool, Option<usize>, usize)> = Vec::new();
    loop {
        let event = reader.read_event().map_err(|e| invalid(e.to_string()))?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                match e.local_name().as_ref() {
                    "object" => {
                        if current.is_some() { return Err(invalid("nested 3MF objects")); }
                        let id = number(&e, "id")?.and_then(|n| u32::try_from(n).ok()).ok_or_else(|| invalid("missing or invalid 3MF id"))?;
                        let mut object = Object { name_bytes: format!("object-{id}").len(), ..Object::default() };
                        for a in e.attributes() {
                            let a = a.map_err(|e| invalid(e.to_string()))?;
                            if a.key.as_ref() == "name" {
                                object.name_bytes = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| invalid(e.to_string()))?.len();
                            }
                        }
                        if objects.len() >= OBJECTS || objects.insert(id, object).is_some() { return Err(invalid("duplicate or excessive 3MF objects")); }
                        // Native objects finish only on an End event.
                        if empty { return Err(invalid("empty 3MF object is unsupported")); }
                        current = Some(id);
                    }
                    "vertices" | "triangles" => {
                        let count = number(&e, "count")?;
                        if count.is_some_and(|n| n > GEOMETRY) { return Err(invalid("3MF declared count budget exceeded")); }
                        if empty {
                            if count.is_some_and(|n| n != 0) { return Err(invalid("3MF declared count mismatch")); }
                        } else { counts.push((e.local_name().as_ref() == "triangles", count, 0)); }
                    }
                    "vertex" | "triangle" | "component" => {
                        let object = objects.get_mut(&current.ok_or_else(|| invalid("3MF data outside object"))?).unwrap();
                        match e.local_name().as_ref() {
                            "vertex" | "triangle" => {
                                let triangle = e.local_name().as_ref() == "triangle";
                                let k = usize::from(triangle);
                                if source[k] >= GEOMETRY { return Err(invalid("3MF geometry budget exceeded")); }
                                source[k] += 1;
                                if k == 0 { object.vertices += 1; } else { object.faces += 1; }
                                for (kind, _, actual) in &mut counts {
                                    if *kind == triangle { *actual += 1; }
                                }
                            }
                            _ => {
                                if object.children.len() >= OBJECTS { return Err(invalid("3MF component budget exceeded")); }
                                let id = number(&e, "objectid")?.and_then(|n| u32::try_from(n).ok()).ok_or_else(|| invalid("missing or invalid component objectid"))?;
                                object.children.push(id);
                            }
                        }
                    }
                    "item" => {
                        if roots.len() >= OBJECTS { return Err(invalid("3MF build item budget exceeded")); }
                        let id = number(&e, "objectid")?.and_then(|n| u32::try_from(n).ok()).ok_or_else(|| invalid("missing or invalid item objectid"))?;
                        roots.push(id);
                    }
                    _ => {}
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                "object" => current = None,
                "vertices" | "triangles" => {
                    let (_, declared, actual) = counts.pop().ok_or_else(|| invalid("invalid 3MF count container"))?;
                    if declared.is_some_and(|n| n != actual) { return Err(invalid("3MF declared count mismatch")); }
                }
                _ => {}
            }
            Event::Eof => break,
            _ => {}
        }
    }
    // visits, vertices, triangles, sum of generated path-name bytes, height.
    // Include component-only visits in the name budget, conservatively. Tracking
    // height in the memo also prevents cached shallow roots hiding a deep chain.
    fn expanded(id: u32, objects: &BTreeMap<u32, Object>, active: &mut BTreeSet<u32>, memo: &mut BTreeMap<u32, [usize; 5]>) -> io::Result<[usize; 5]> {
        if let Some(n) = memo.get(&id) { return Ok(*n); }
        if active.len() >= DEPTH || !active.insert(id) { return Err(invalid("cyclic or excessive 3MF nesting")); }
        let o = objects.get(&id).ok_or_else(|| invalid("unknown 3MF object"))?;
        let prefix = o.name_bytes + 1;
        let mut n = [1usize, o.vertices, o.faces, prefix, 1];
        for child in &o.children {
            let v = expanded(*child, objects, active, memo)?;
            for k in 0..3 { n[k] = n[k].saturating_add(v[k]); }
            n[3] = n[3].saturating_add(v[3]).saturating_add(v[0].saturating_mul(prefix));
            n[4] = n[4].max(v[4] + 1);
            budget(n)?;
        }
        active.remove(&id);
        memo.insert(id, n);
        Ok(n)
    }
    fn budget(n: [usize; 5]) -> io::Result<()> {
        if n[4] > DEPTH { return Err(invalid("excessive 3MF component nesting")); }
        if n[0] > OBJECTS || n[1] > GEOMETRY || n[2] > GEOMETRY
            || n[1].saturating_mul(24).saturating_add(n[2].saturating_mul(12)).saturating_add(n[3]) > TOTAL_BYTES
        { return Err(invalid("3MF instantiated geometry budget exceeded")); }
        Ok(())
    }
    let mut n = [0usize; 5];
    let mut memo = BTreeMap::new();
    for (i, root) in roots.into_iter().enumerate() {
        let mut v = expanded(root, &objects, &mut BTreeSet::new(), &mut memo)?;
        v[3] = v[3].saturating_add(v[0].saturating_mul(format!("build-{i}").len()));
        for k in 0..4 { n[k] = n[k].saturating_add(v[k]); }
        n[4] = n[4].max(v[4]);
        budget(n)?;
    }
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
    fn threemf_bomb_and_relationship_selected_branching_are_bounded() {
        assert!(validate(&zipped(&vec![b' '; 1024 * 1024], true, "3D/model.model")).unwrap_err().to_string().contains("budget"));
        for attrs in ["objectid=\"{}\" id=\"1\"", "id=\"1\" objectid=\"{}\""] {
            let mut xml = String::from("<model><resources><object id=\"1\"></object>");
            for n in 2..16 {
                let a = attrs.replace("{}", &(n - 1).to_string());
                xml.push_str(&format!("<object id=\"{n}\"><components><component {a}/><component {a}/></components></object>"));
            }
            xml.push_str("</resources><build><item objectid=\"15\" id=\"1\"/></build></model>");
            for name in ["3D/model.model", "3D/branch.XML", "3D/branch"] {
                assert!(validate(&zipped(xml.as_bytes(), false, name)).unwrap_err().to_string().contains("instantiated"));
            }
        }
    }
    #[test]
    fn xml_attributes_entities_depth_and_counts_are_bounded() {
        for xml in [
            format!("<model name=\"{}\"/>", "x".repeat(ATTRIBUTE_BYTES + 1)),
            format!("<model {}/>", (0..65).map(|i| format!("a{i}=\"x\"")).collect::<Vec<_>>().join(" ")),
            "<!DOCTYPE model [<!ENTITY a 'abc'>]><model/>".into(),
            "<!DOCTYPE model SYSTEM 'file:///etc/passwd'><model/>".into(),
            format!("{}{}", "<x>".repeat(129), "</x>".repeat(129)),
            "<model><resources><object id=\"1\"><vertices count=\"1\"></vertices></object></resources></model>".into(),
            "<model><resources><object id=\"1\"><triangles count=\"2\"><triangle/></triangles></object></resources></model>".into(),
        ] { assert!(validate(&zipped(xml.as_bytes(), false, "3D/model.model")).is_err(), "{xml}"); }
        assert!(validate(&zipped(b"<model/>", false, "3D/model.model")).is_ok());
    }
}
