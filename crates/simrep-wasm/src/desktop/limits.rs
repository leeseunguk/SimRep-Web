//! Resource checks at the browser byte-registry boundary, before native parsers allocate.
use std::io;
use std::path::Path;
#[path = "threemf_limits.rs"]
mod threemf_limits;
fn invalid(s: impl Into<String>) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, s.into()) }
pub fn validate_input(path: &str, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > 128 * 1024 * 1024 { return Err(invalid("input exceeds 128 MiB")); }
    match Path::new(path).extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase().as_str() {
        "fly2" => fly2(std::str::from_utf8(bytes).map_err(|_| invalid("invalid UTF-8"))?)?,
        "ion" => { if bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty() && !l.starts_with(b";")).count() > 1_000_000 { return Err(invalid("particle limit exceeded (1000000)")); } },
        "3mf" => threemf_limits::validate(bytes)?,
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fly2_counts_precede_expansion() {
        assert!(fly2("particles {standard_beam {n=1000001}}").is_err());
        assert!(fly2("particles {standard_beam {n=600000},standard_beam {n=600000}}").is_err());
        assert!(fly2("-- n=10000000\nparticles {standard_beam {n --comment\n = 2}}").is_ok());
    }
}
