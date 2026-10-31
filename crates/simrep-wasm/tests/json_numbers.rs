#[test]
fn physical_json_parameters_preserve_their_f64_bits() {
    for value in [1e-12, 1e-8, f64::MAX, 0.001, 0.1, 0.25, 60.] {
        let encoded = serde_json::to_string(&value).unwrap();
        let decoded: f64 = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.to_bits(), value.to_bits(), "{encoded}");
    }
}
