import { defineConfig } from "vitest/config";

// Unit tests of the host's pure parts (ZIP, store, IPC path rules) in Node.
export default defineConfig({ test: { include: ["src/*.test.ts"], environment: "node" } });
