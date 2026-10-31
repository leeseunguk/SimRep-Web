import { checkFileSize, MAX_COMPRESSION_RATIO, MAX_ENTRIES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, safePath } from "./limits";

export interface ZipEntry { path: string; bytes: Uint8Array }
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function through(bytes: Uint8Array, stream: ReadableWritablePair<Uint8Array, BufferSource>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function writeZip(entries: ZipEntry[], deflate = typeof CompressionStream === "function"): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path), crc = crc32(e.bytes);
    let data = e.bytes, method = 0;
    if (deflate && e.bytes.length > 0) {
      const packed = await through(e.bytes, new CompressionStream("deflate-raw"));
      // Never generate an archive our own ratio policy would refuse.
      if (packed.length < e.bytes.length && e.bytes.length <= packed.length * MAX_COMPRESSION_RATIO) { data = packed; method = 8; }
    }
    const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, method, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, e.bytes.length, true); h.setUint16(26, name.length, true);
    head.set(name, 30); local.push(head, data);
    const dir = new Uint8Array(46 + name.length), d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true);
    d.setUint16(10, method, true); d.setUint16(14, 0x21, true); d.setUint32(16, crc, true);
    d.setUint32(20, data.length, true); d.setUint32(24, e.bytes.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true);
    dir.set(name, 46); central.push(dir); offset += head.length + data.length;
  }
  const end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
  v.setUint32(12, central.reduce((n, c) => n + c.length, 0), true); v.setUint32(16, offset, true);
  const parts = [...local, ...central, end], out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Validate the entire directory before inflating anything. Actual output is independently bounded. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  checkFileSize(bytes.length, "ZIP archive");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, length: number) => { if (at < 0 || length < 0 || at + length > bytes.length) throw new Error("truncated ZIP archive"); };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = v.getUint16(end + 10, true), centralStart = v.getUint32(end + 16, true), centralSize = v.getUint32(end + 12, true);
  if (count > MAX_ENTRIES) throw new Error(`ZIP exceeds ${MAX_ENTRIES} entries`);
  if (v.getUint16(end + 4, true) || v.getUint16(end + 6, true) || v.getUint16(end + 8, true) !== count || centralStart + centralSize !== end)
    throw new Error("unsupported multipart, ZIP64 or damaged ZIP directory");
  const dec = new TextDecoder("utf-8", { fatal: true }), names = new Set<string>();
  const directory: { path: string; start: number; size: number; unpacked: number; crc: number; method: number; folder: boolean }[] = [];
  let p = centralStart, declaredTotal = 0, previousEnd = 0;
  for (let i = 0; i < count; i++) {
    need(p, 46);
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("damaged ZIP directory");
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true), unpacked = v.getUint32(p + 24, true), nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true), at = v.getUint32(p + 42, true);
    need(p + 46, nameLen + extra + comment);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)), folder = name.endsWith("/"), path = folder ? name.slice(0, -1) : name;
    if (!safePath(path)) throw new Error(`unsafe path in ZIP: ${name}`);
    if (names.has(path)) throw new Error(`duplicate ZIP entry: ${path}`);
    names.add(path);
    const mode = v.getUint32(p + 38, true) >>> 16;
    if ((mode & 0xf000) === 0xa000) throw new Error(`ZIP symlink is not allowed: ${path}`);
    if (flags & ~0x0808 || ![0, 8].includes(method) || v.getUint16(p + 34, true)) throw new Error(`unsupported ZIP entry: ${path}`);
    if (unpacked > MAX_FILE_BYTES || (size === 0 ? unpacked !== 0 : unpacked > size * MAX_COMPRESSION_RATIO)) throw new Error(`ZIP expansion limit exceeded: ${path}`);
    declaredTotal += unpacked;
    if (declaredTotal > MAX_TOTAL_BYTES) throw new Error("ZIP total expanded-byte budget exceeded");
    need(at, 30);
    if (v.getUint32(at, true) !== 0x04034b50 || v.getUint16(at + 6, true) !== flags || v.getUint16(at + 8, true) !== method) throw new Error(`ZIP local header mismatch: ${path}`);
    const localName = v.getUint16(at + 26, true), localExtra = v.getUint16(at + 28, true), start = at + 30 + localName + localExtra;
    need(at + 30, localName + localExtra); need(start, size);
    if (dec.decode(bytes.subarray(at + 30, at + 30 + localName)) !== name || (!(flags & 8) && (v.getUint32(at + 14, true) !== crc || v.getUint32(at + 18, true) !== size || v.getUint32(at + 22, true) !== unpacked))) throw new Error(`ZIP local header mismatch: ${path}`);
    if (at < previousEnd || start + size > centralStart) throw new Error("overlapping ZIP entries");
    previousEnd = start + size;
    directory.push({ path, start, size, unpacked, crc, method, folder });
    p += 46 + nameLen + extra + comment;
  }
  if (p !== end) throw new Error("damaged ZIP directory size");
  let total = 0;
  const out: ZipEntry[] = [];
  for (const e of directory) {
    const raw = bytes.subarray(e.start, e.start + e.size);
    let data: Uint8Array;
    if (e.method === 0) {
      if (e.size !== e.unpacked) throw new Error(`ZIP size mismatch: ${e.path}`);
      total += e.size;
      data = raw.slice();
    } else {
      const reader = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const chunks: Uint8Array[] = [];
      let actual = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          actual += value.byteLength; total += value.byteLength;
          if (actual > e.unpacked || actual > MAX_FILE_BYTES || actual > e.size * MAX_COMPRESSION_RATIO || total > MAX_TOTAL_BYTES) throw new Error(`ZIP expansion budget exceeded: ${e.path}`);
          chunks.push(value);
        }
      } catch (error) { await reader.cancel(error); throw error; } finally { reader.releaseLock(); }
      data = new Uint8Array(actual);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    }
    if (data.length !== e.unpacked) throw new Error(`ZIP size mismatch: ${e.path}`);
    if (crc32(data) !== e.crc) throw new Error(`ZIP entry ${e.path} is damaged (checksum)`);
    if (!e.folder) out.push({ path: e.path, bytes: data });
  }
  return out;
}
