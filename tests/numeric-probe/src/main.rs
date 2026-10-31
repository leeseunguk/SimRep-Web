fn main() {
    let mut args = std::env::args().skip(1);
    let pa = std::fs::read(args.next().expect("PA path")).unwrap();
    let cuts = args.next().map_or_else(Vec::new, |p| std::fs::read(p).unwrap());
    println!("{}", simrep_numeric_probe::evaluate(&pa, &cuts));
}
