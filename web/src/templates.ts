/**
 * Gallery templates for the browser: the same small .pa# arrays the desktop core writes
 * (simrep app/src-tauri/src/templates.rs, `create_template`), encoded here as SIMION PA bytes so no
 * native code is needed. Parts are painted in order (later parts win, electrode 0 clears points);
 * coordinates are mm from grid point (0, 0, 0); cylindrical arrays are 2D in (x, r).
 */

type Shape =
  | { box: [number, number, number]; to: [number, number, number] }
  | { rod: { y: number; z: number; radius: number; x0: number; x1: number } };

interface Part {
  electrode: number;
  shape: Shape;
}

export interface Template {
  file: string;
  cylindrical: boolean;
  dims: [number, number, number];
  cell: number;
  mirror: { x: boolean; y: boolean; z: boolean };
  parts: Part[];
}

const BIG = 1e6;
const part = (electrode: number, shape: Shape): Part => ({ electrode, shape });
const annulus = (x0: number, x1: number, r0: number, r1: number): Shape => ({ box: [x0, r0, -BIG], to: [x1, r1, BIG] });
const radial = { x: false, y: true, z: false };

export function template(kind: string): Template | null {
  switch (kind) {
    case "einzel":
      return {
        file: "einzel.pa#",
        cylindrical: true,
        dims: [201, 41, 1],
        cell: 0.5,
        mirror: radial,
        parts: [part(1, annulus(14, 38, 10, 12)), part(2, annulus(42, 58, 10, 12)), part(3, annulus(62, 86, 10, 12))],
      };
    case "quadrupole": {
      const rod = 5.75;
      const at = 5 + rod;
      return {
        file: "quadrupole.pa#",
        cylindrical: false,
        dims: [121, 37, 37],
        cell: 0.5,
        mirror: { x: false, y: true, z: true },
        parts: [
          part(1, { rod: { y: at, z: 0, radius: rod, x0: 12, x1: 48 } }),
          part(2, { rod: { y: 0, z: at, radius: rod, x0: 12, x1: 48 } }),
          part(3, { box: [6, -BIG, -BIG], to: [7, BIG, BIG] }),
          part(3, { box: [53, -BIG, -BIG], to: [54, BIG, BIG] }),
          part(0, { rod: { y: 0, z: 0, radius: 4, x0: 5, x1: 55 } }),
        ],
      };
    }
    case "reflectron": {
      const parts = [part(1, annulus(30, 32, 18, 22))];
      for (let k = 0; k < 5; k++) {
        const x = 42 + 10 * k;
        parts.push(part(2 + k, annulus(x, x + 2, 18, 22)));
      }
      parts.push(part(7, annulus(100, 102, 0, 22)));
      return { file: "reflectron.pa#", cylindrical: true, dims: [241, 61, 1], cell: 0.5, mirror: radial, parts };
    }
    case "trap":
      return {
        file: "trap.pa#",
        cylindrical: true,
        dims: [161, 81, 1],
        cell: 0.25,
        mirror: radial,
        parts: [part(1, annulus(14, 26, 9, 12)), part(2, annulus(9, 11, 2, 12)), part(2, annulus(29, 31, 2, 12))],
      };
    default:
      return null;
  }
}

function contains(s: Shape, p: [number, number, number], cylindrical: boolean): boolean {
  if ("box" in s) {
    for (let a = 0; a < (cylindrical ? 2 : 3); a++) if (!(p[a]! >= s.box[a]! - 1e-9 && p[a]! <= s.to[a]! + 1e-9)) return false;
    return true;
  }
  const r = s.rod;
  return p[0] >= r.x0 - 1e-9 && p[0] <= r.x1 + 1e-9 && Math.hypot(p[1] - r.y, p[2] - r.z) <= r.radius + 1e-9;
}

const MAX_VOLTAGE = 100_000;
const NG = 100;

/**
 * The template as PA# bytes, laid out like simrep-io's `PaFile::write`: mode -2 header (56 bytes,
 * explicit spacing) unless the cells are 1 mm (mode -1, 32 bytes), then x-fastest f64 points with
 * electrode points stored as `number + 2 * max_voltage`.
 */
export function buildTemplate(t: Template): Uint8Array<ArrayBuffer> {
  const [nx, ny, nz] = t.dims;
  const extended = t.cell !== 1;
  const header = extended ? 56 : 32;
  const out = new DataView(new ArrayBuffer(header + nx * ny * nz * 8));
  out.setInt32(0, extended ? -2 : -1, true);
  out.setInt32(4, t.cylindrical ? 0 : 1, true);
  out.setFloat64(8, MAX_VOLTAGE, true);
  out.setInt32(16, nx, true);
  out.setInt32(20, ny, true);
  out.setInt32(24, nz, true);
  out.setUint32(28, (Number(t.mirror.x) | (Number(t.mirror.y) << 1) | (Number(t.mirror.z) << 2) | (NG << 4)) >>> 0, true);
  if (extended) for (let a = 0; a < 3; a++) out.setFloat64(32 + 8 * a, t.cell, true);
  let at = header;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, at += 8) {
        const p: [number, number, number] = [i * t.cell, j * t.cell, k * t.cell];
        let owner: Part | undefined;
        for (let n = t.parts.length - 1; n >= 0; n--)
          if (contains(t.parts[n]!.shape, p, t.cylindrical)) {
            owner = t.parts[n];
            break;
          }
        out.setFloat64(at, owner && owner.electrode !== 0 ? owner.electrode + 2 * MAX_VOLTAGE : 0, true);
      }
  return new Uint8Array(out.buffer);
}
