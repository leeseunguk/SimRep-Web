//! The native pre-solve gap policy, including certified conservative GEM brackets.
use super::{GapSource, Part, Result};
use serde_json::{Value, json};
use simrep_geom::{Point, SignedDistance};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap};

#[derive(Clone, Copy)]
struct Measurement {
    lower: f64,
    upper: f64,
    points: Option<[Point; 2]>,
    bounded: bool,
    resolved: bool,
}

pub(super) fn check(
    mode: &str,
    parts: &[Part],
    dims: [usize; 3],
    origin: Point,
    spacing: Point,
) -> Result<Value> {
    if !["off", "warn", "error"].contains(&mode) {
        return Err("gap-check must be off, warn or error".into());
    }
    let mut pairs = Vec::new();
    let mut recommended: Option<f64> = None;
    if mode != "off" {
        let h = (0..3)
            .filter(|&a| dims[a] > 1)
            .map(|a| spacing[a])
            .fold(0.0, f64::max);
        let tolerance = (h / 10.0).min(1e-3);
        let domain = [
            origin,
            std::array::from_fn(|a| origin[a] + (dims[a] - 1) as f64 * spacing[a]),
        ];
        let mut measurements: BTreeMap<[usize; 2], Measurement> = BTreeMap::new();
        for (i, a) in parts.iter().enumerate() {
            for b in &parts[i + 1..] {
                if a.assignment.number == b.assignment.number {
                    continue;
                }
                let mut numbers = [a.assignment.number, b.assignment.number];
                let mut m = match (&a.gap_source, &b.gap_source) {
                    (GapSource::Mesh(a), GapSource::Mesh(b)) => {
                        let gap = a.surface_gap(b);
                        Measurement {
                            lower: gap.distance_mm,
                            upper: gap.distance_mm,
                            points: Some(gap.points_mm),
                            bounded: false,
                            resolved: true,
                        }
                    }
                    (GapSource::Gem(left), GapSource::Gem(right)) => bounded(
                        a.shape.as_ref(),
                        b.shape.as_ref(),
                        *left,
                        *right,
                        domain,
                        tolerance,
                        32_768,
                    ),
                    _ => unreachable!("one input has one geometry kind"),
                };
                if numbers[0] > numbers[1] {
                    numbers.swap(0, 1);
                    if let Some(points) = &mut m.points {
                        points.swap(0, 1);
                    }
                }
                measurements
                    .entry(numbers)
                    .and_modify(|current| {
                        let lower = current.lower.min(m.lower);
                        if m.upper < current.upper {
                            current.points = m.points;
                        }
                        current.upper = current.upper.min(m.upper);
                        current.lower = lower;
                        current.resolved = current.upper - current.lower <= tolerance;
                    })
                    .or_insert(m);
            }
        }
        for (electrodes, m) in measurements {
            let cells = m.lower / h;
            let status = if !m.resolved {
                "unresolved"
            } else if cells < 2.5 {
                "warn"
            } else {
                "ok"
            };
            let next = m.lower / 10.0;
            recommended = Some(recommended.map_or(next, |p| p.min(next)));
            let mut pair = json!({"electrodes":electrodes,"method":if m.bounded {"bounded"} else {"exact"},"cells_across":cells,"location_mm":m.points,"status":status});
            if m.bounded {
                pair["gap_bracket_mm"] =
                    json!([Some(m.lower), m.upper.is_finite().then_some(m.upper)]);
            } else {
                pair["gap_mm"] = json!(m.lower);
            }
            pairs.push(pair);
        }
        if mode == "error" && pairs.iter().any(|p| p["status"] != "ok") {
            return Err("gap check failed: fewer than 2.5 cells across an electrode gap or an unresolved GEM gap; refine --spacing or use --gap-check warn/off".into());
        }
    }
    Ok(
        json!({"mode":mode,"threshold_cells":2.5,"recommended_cells":10.0,"pairs":pairs,"recommended_spacing_mm":recommended}),
    )
}

fn distance(a: Point, b: Point) -> f64 {
    (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt()
}
fn box_gap(a: [Point; 2], b: [Point; 2]) -> f64 {
    (0..3)
        .map(|i| (a[0][i] - b[1][i]).max(b[0][i] - a[1][i]).max(0.0).powi(2))
        .sum::<f64>()
        .sqrt()
}

#[derive(Clone, Copy)]
struct Cell {
    bounds: [Point; 2],
    lower: f64,
}
impl PartialEq for Cell {
    fn eq(&self, other: &Self) -> bool {
        self.lower == other.lower
    }
}
impl Eq for Cell {}
impl PartialOrd for Cell {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Cell {
    fn cmp(&self, other: &Self) -> Ordering {
        other.lower.total_cmp(&self.lower)
    }
}
impl Cell {
    fn center(self) -> Point {
        std::array::from_fn(|i| self.bounds[0][i] / 2.0 + self.bounds[1][i] / 2.0)
    }
    fn new(bounds: [Point; 2], a: &dyn SignedDistance, b: &dyn SignedDistance) -> Self {
        let mut cell = Self { bounds, lower: 0.0 };
        let center = cell.center();
        let safety = 128.0 * f64::EPSILON * center.into_iter().map(f64::abs).fold(1.0, f64::max);
        cell.lower = (a.distance(center).abs() + b.distance(center).abs()
            - distance(bounds[0], bounds[1])
            - safety)
            .max(0.0);
        cell
    }
}

fn project(shape: &dyn SignedDistance, mut p: Point, tolerance: f64) -> Option<(Point, f64)> {
    for _ in 0..48 {
        let d = shape.distance(p);
        if !d.is_finite() {
            return None;
        }
        if d == 0.0 {
            return Some((p, 0.0));
        }
        let step = tolerance.max(1e-7);
        let gradient: Point = std::array::from_fn(|i| {
            let mut lo = p;
            let mut hi = p;
            lo[i] -= step;
            hi[i] += step;
            (shape.distance(hi) - shape.distance(lo)) / (2.0 * step)
        });
        let norm2 = gradient.iter().map(|v| v * v).sum::<f64>();
        if !norm2.is_finite() || norm2 < 1e-24 {
            return None;
        }
        let next = std::array::from_fn(|i| p[i] - 1.25 * d * gradient[i] / norm2);
        let next_d = shape.distance(next);
        if !next_d.is_finite() {
            return None;
        }
        if next_d == 0.0 {
            return Some((next, 0.0));
        }
        if d.is_sign_positive() != next_d.is_sign_positive() {
            let (mut outside, mut inside) = if d > 0.0 { (p, next) } else { (next, p) };
            for _ in 0..64 {
                let width = distance(outside, inside);
                if width <= tolerance {
                    return Some((outside, width));
                }
                let mid = std::array::from_fn(|i| outside[i] / 2.0 + inside[i] / 2.0);
                if shape.distance(mid) > 0.0 {
                    outside = mid;
                } else {
                    inside = mid;
                }
            }
            return None;
        }
        p = next;
    }
    None
}

fn upper_bound(
    a: &dyn SignedDistance,
    b: &dyn SignedDistance,
    seed: Point,
    tolerance: f64,
    best: &mut Measurement,
) {
    let Some((mut left, mut left_error)) = project(a, seed, tolerance) else {
        return;
    };
    for _ in 0..4 {
        let Some((right, right_error)) = project(b, left, tolerance) else {
            return;
        };
        let upper = distance(left, right) + left_error + right_error;
        if upper < best.upper {
            best.upper = upper;
            best.points = Some([left, right]);
        }
        let Some(projected) = project(a, right, tolerance) else {
            return;
        };
        (left, left_error) = projected;
    }
}

fn bounded(
    a: &dyn SignedDistance,
    b: &dyn SignedDistance,
    left: [Point; 2],
    right: [Point; 2],
    fallback: [Point; 2],
    tolerance: f64,
    budget: usize,
) -> Measurement {
    let finite = left.iter().chain(&right).flatten().all(|v| v.is_finite());
    let domain = std::array::from_fn(|end| {
        std::array::from_fn(|i| {
            let value = if end == 0 {
                left[0][i].min(right[0][i])
            } else {
                left[1][i].max(right[1][i])
            };
            if value.is_finite() {
                value
            } else {
                fallback[end][i]
            }
        })
    });
    let separation = box_gap(left, right);
    let baseline = if separation.is_finite() {
        separation
    } else {
        0.0
    };
    let mut best = Measurement {
        lower: baseline,
        upper: f64::INFINITY,
        points: None,
        bounded: true,
        resolved: false,
    };
    for bounds in [domain, left, right] {
        if bounds.iter().flatten().all(|v| v.is_finite()) {
            for bits in 0..9 {
                let seed = if bits == 8 {
                    std::array::from_fn(|i| bounds[0][i] / 2.0 + bounds[1][i] / 2.0)
                } else {
                    std::array::from_fn(|i| bounds[(bits >> i) & 1][i])
                };
                upper_bound(a, b, seed, tolerance * 1e-4, &mut best);
            }
        }
    }
    let mut queue = BinaryHeap::from([Cell::new(domain, a, b)]);
    for iteration in 0..budget {
        let Some(cell) = queue.pop() else {
            break;
        };
        best.lower = if finite {
            baseline.max(cell.lower).min(best.upper)
        } else {
            baseline
        };
        if best.upper - best.lower <= tolerance {
            best.resolved = true;
            return best;
        }
        if cell.lower > best.upper {
            continue;
        }
        if iteration % 64 == 0 {
            upper_bound(a, b, cell.center(), tolerance * 1e-4, &mut best);
        }
        let axis = (0..3)
            .max_by(|&i, &j| {
                (cell.bounds[1][i] - cell.bounds[0][i])
                    .total_cmp(&(cell.bounds[1][j] - cell.bounds[0][j]))
            })
            .unwrap();
        let middle = cell.center()[axis];
        for end in 0..2 {
            let mut bounds = cell.bounds;
            bounds[1 - end][axis] = middle;
            queue.push(Cell::new(bounds, a, b));
        }
    }
    if let Some(cell) = queue.peek() {
        best.lower = if finite {
            baseline.max(cell.lower).min(best.upper)
        } else {
            baseline
        };
    }
    best.resolved = best.upper - best.lower <= tolerance;
    best
}
