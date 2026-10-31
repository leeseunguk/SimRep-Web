/** Browser input budgets, shared by picker, drop, archive and worker registration. */
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 2048;
export const MAX_COMPRESSION_RATIO = 200;

export function checkFileSize(size: number, name = "input"): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES)
    throw new Error(`${name} exceeds the 128 MiB input limit`);
}

export async function readInput(file: File): Promise<Uint8Array> {
  checkFileSize(file.size, file.name);
  return new Uint8Array(await file.arrayBuffer());
}

export function safePath(path: string): boolean {
  return !!path && !/[\\:\x00-\x1f]/.test(path) && path.split("/").every(s => s !== "" && s !== "." && s !== "..");
}
