import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// SimRep-Web: the SimRep UI (linked as .app-src, see scripts/link-app.mjs; set SIMREP_APP_SRC to
// point elsewhere) on the browser host in src/. The app's own dependencies resolve from this
// folder's node_modules (preserveSymlinks), so a SimRep checkout needs no npm install of its own.
const web = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf8")) as { version: string };

// Cross-origin isolation (SharedArrayBuffer for the multi-threaded wasm pool). Static hosts that
// cannot send headers get the same through coi-serviceworker (index.html).
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

/** Ships coi-serviceworker (MIT) next to index.html. */
function coiServiceWorker(): Plugin {
  const file = path.join(web, "node_modules/coi-serviceworker/coi-serviceworker.min.js");
  return {
    name: "simrep-web-coi",
    configureServer(server) {
      // Every dev response, including Vite's own client modules that workers import: WebKit refuses
      // a worker script under COEP unless the script itself carries the policy.
      server.middlewares.use((req, res, next) => {
        // WebKit module workers can stall on conditional-cache revalidation after reload.
        delete req.headers["if-none-match"];
        for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value);
        next();
      });
      server.middlewares.use("/coi-serviceworker.min.js", (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(fs.readFileSync(file));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "coi-serviceworker.min.js", source: fs.readFileSync(file) });
    },
  };
}

export default defineConfig({
  plugins: [react(), coiServiceWorker()],
  base: "./",
  clearScreen: false,
  define: { __SIMREP_WEB_VERSION__: JSON.stringify(pkg.version) },
  resolve: { preserveSymlinks: true },
  server: { host: "127.0.0.1", port: 1440, strictPort: true, headers: isolation, fs: { allow: [web, path.resolve(web, "..")] } },
  preview: { host: "127.0.0.1", headers: { ...isolation, "Cache-Control": "no-store" } },
  worker: { format: "es" },
  build: {
    outDir: "dist-web",
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }] } },
    },
  },
});
