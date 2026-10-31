//! Native desktop algorithm oracle (real filesystem I/O, without a Tauri window).
use simrep_wasm::desktop::{AppState, geometry_native, hash_native, iob_native, templates};
use std::io::{self, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = &args[1];
    match command.as_str() {
        "template" => {
            let (_, bytes) = templates::bytes(&args[2]).unwrap();
            io::stdout().write_all(&bytes).unwrap();
        }
        "inspect_geometry" => {
            let request = serde_json::from_str(&args[2]).unwrap();
            io::stdout()
                .write_all(&geometry_native::inspect_geometry(request).unwrap())
                .unwrap();
        }
        "build_geometry" => {
            let request = serde_json::from_str(&args[2]).unwrap();
            let result = geometry_native::build(&AppState::default(), request).unwrap();
            println!("{}", serde_json::to_string(&result).unwrap());
        }
        "open_iob" => println!(
            "{}",
            serde_json::to_string(&iob_native::open_iob(args[2].clone()).unwrap()).unwrap()
        ),
        "file_sha256" => println!(
            "{}",
            hash_native::sha256_file(std::path::Path::new(&args[2])).unwrap()
        ),
        _ => panic!("unknown oracle command {command}"),
    }
}
