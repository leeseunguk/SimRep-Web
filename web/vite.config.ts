import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
const web = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf8")) as { version: string };
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
// Only wasm compilation needs an eval exception; React uses style attributes, not inline scripts.
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
function coiServiceWorker(): Plugin {
  const file = path.join(web, "node_modules/coi-serviceworker/coi-serviceworker.min.js");
  return {
    name: "simrep-web-coi",
    configureServer(server) {
      server.middlewares.use((req, res, next) => { delete req.headers["if-none-match"]; for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value); next(); });
      server.middlewares.use("/coi-serviceworker.min.js", (_req, res) => { res.setHeader("Content-Type", "text/javascript"); res.end(fs.readFileSync(file)); });
    },
    generateBundle() { this.emitFile({ type: "asset", fileName: "coi-serviceworker.min.js", source: fs.readFileSync(file) }); },
  };
}
export default defineConfig({
  plugins: [react(), coiServiceWorker()], base: "./", clearScreen: false,
  define: { __SIMREP_WEB_VERSION__: JSON.stringify(pkg.version) }, resolve: { preserveSymlinks: true },
  server: { host: "127.0.0.1", port: 1440, strictPort: true, headers: isolation, fs: { allow: [web, path.resolve(web, "..")] } },
  preview: { host: "127.0.0.1", headers: { ...isolation, "Cache-Control": "no-store", "Content-Security-Policy": csp } },
  worker: { format: "es" },
  build: {
    outDir: "dist-web", emptyOutDir: true, target: "es2022", sourcemap: true,
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }] } } },
  },
});
