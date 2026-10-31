import { checkFileSize, MAX_TOTAL_BYTES } from "../web/src/limits";
interface Backend {
  desktop_command(command: string, args: string): string;
  desktop_inspect(request: string): Uint8Array;
  list_files(): string;
  put_file(path: string, bytes: Uint8Array): void;
  read_file(path: string): Uint8Array;
}
type Register = (command: string, handler: (args: Record<string, unknown>) => unknown) => void;
export function registerDesktop(register: Register, backend: Backend): void {
  const command = (name: string) => (args: Record<string, unknown>) => JSON.parse(backend.desktop_command(name, JSON.stringify(args)));
  // Return only actual mutations from the generated-family operation, not a directory-wide guess.
  let deleted: string[] = [];
  register("web_list_files", () => JSON.parse(backend.list_files()));
  register("web_deleted_files", () => deleted);
  register("web_register_files", args => {
    const files = args.files as { path: string; bytes: Uint8Array }[];
    const sizes = new Map((JSON.parse(backend.list_files()) as { path: string; size: number }[]).map(f => [f.path, f.size]));
    for (const f of files) { checkFileSize(f.bytes.length, f.path); sizes.set(f.path, f.bytes.length); }
    if ([...sizes.values()].reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new Error("worker resident-byte budget exceeded (256 MiB); close unused projects and reload");
    const existing = new Set((JSON.parse(backend.list_files()) as { path: string }[]).map(f => f.path));
    for (const f of files) {
      // Re-registering identical bytes must not invalidate a prepared exact geometry.
      if (existing.has(f.path)) { const old = backend.read_file(f.path); if (old.length === f.bytes.length && old.every((v, i) => v === f.bytes[i])) continue; }
      backend.put_file(f.path, f.bytes);
    }
    return null;
  });
  register("open_iob", command("open_iob"));
  register("inspect_geometry", args => {
    const packet = backend.desktop_inspect(JSON.stringify(args.request ?? args));
    return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
  });
  register("build_geometry", args => {
    const before = JSON.parse(backend.list_files()) as { path: string }[];
    const result = command("build_geometry")(args);
    const after = new Set((JSON.parse(backend.list_files()) as { path: string }[]).map(f => f.path));
    deleted = before.map(f => f.path).filter(p => !after.has(p));
    return result;
  });
  register("create_template", command("create_template"));
  register("read_text", command("read_text"));
  register("write_text", command("write_text"));
  register("write_bytes", args => command("write_bytes")({ ...args, bytes: Array.from(args.bytes as ArrayLike<number>) }));
  register("remove_file", command("remove_file"));
  register("recovery_path", command("recovery_path"));
  register("file_sha256", command("file_sha256"));
}
