// Imported by the browser worker; kept outside web/ so it can be owned independently.
// Integration: import { registerDesktop } from "../../../app/browser-desktop";
//              registerDesktop(register, backend);
interface Backend {
  desktop_command(command: string, args: string): string;
  desktop_inspect(request: string): Uint8Array;
}
type Register = (command: string, handler: (args: Record<string, unknown>) => unknown) => void;
export function registerDesktop(register: Register, backend: Backend): void {
  const command = (name: string) => (args: Record<string, unknown>) => JSON.parse(backend.desktop_command(name, JSON.stringify(args)));
  register("open_iob", command("open_iob"));
  register("inspect_geometry", (args) => {
    const packet = backend.desktop_inspect(JSON.stringify(args.request ?? args));
    return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
  });
  register("build_geometry", command("build_geometry"));
  register("create_template", command("create_template"));
  register("read_text", command("read_text"));
  register("write_text", command("write_text"));
  register("write_bytes", (args) => command("write_bytes")({ ...args, bytes: Array.from(args.bytes as ArrayLike<number>) }));
  register("remove_file", command("remove_file"));
  register("recovery_path", command("recovery_path"));
  register("file_sha256", command("file_sha256"));
}
