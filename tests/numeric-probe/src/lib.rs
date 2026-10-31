use simrep_fly::surface::SurfaceModel;
use simrep_fly::{Field, GridField, InstanceField};
use simrep_io::PaFile;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

fn values(values: Vec<f64>) -> serde_json::Value {
    serde_json::json!({"bits":values.iter().map(|v|format!("{:016x}",v.to_bits())).collect::<Vec<_>>(),"values":values})
}

#[wasm_bindgen]
pub fn evaluate(pa: &[u8], cuts: &[u8]) -> String {
    let file = PaFile::read(pa).unwrap();
    let grid = GridField::new(file.array).unwrap();
    let mut field = InstanceField::new(grid, [0.; 3], [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], 1., None, None).unwrap();
    if !cuts.is_empty() {
        field = field.with_surface(Arc::new(SurfaceModel::from_reader(cuts).unwrap().with_tolerance(1e-12).unwrap())).unwrap();
    }
    let mut samples = Vec::new();
    for x in [1., 2., 4., 4.125, 8., 16., 20., 30., 40., 50., 58.] {
        for y in [0., 0.25, 0.375, 1., 2.] {
            let sample = field.sample([x, y, 0.], 0.);
            samples.push(serde_json::json!({"point":[x,y,0.],"data":values(vec![sample.potential_v,sample.electric_v_per_mm[0],sample.electric_v_per_mm[1],sample.electric_v_per_mm[2]])}));
        }
    }
    let mut math = Vec::new();
    let mut seed = 1u64;
    for _ in 0..256 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let x = std::hint::black_box(0.000001 + ((seed >> 11) as f64 / (1u64 << 53) as f64) * 100.);
        let (sine, cosine) = x.sin_cos();
        math.push(serde_json::json!({"x":x,"data":values(vec![x.powf(-0.2),x.hypot(0.123),x.sqrt(),x.mul_add(0.123,0.234),x.sin(),x.cos(),sine,cosine,x.ln()])}));
    }
    serde_json::json!({"samples":samples,"math":math}).to_string()
}
