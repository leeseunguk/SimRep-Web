export interface BrowserCapabilities {
  supportedCommands: readonly string[];
  unsupportedCommands: readonly string[];
  threads: number;
  device: "cpu";
  precision: "f64";
  geometry: boolean;
  flight: boolean;
  multicore: boolean;
}
