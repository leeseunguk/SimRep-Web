# Browser computation contract

Historical API baseline: public SimRep `6d2dd8c813541a012afa21023a4c555fd991d25a`.
Current gitlink: `2705fec645038a4aa6b8f1975aec382fdff01584`. CPU f64 geometry,
cooperative refinement, flight and exports run inside a WebAssembly module worker.
Inputs and outputs are caller-owned bytes; there is no computation server.
Historical backend identity results are described in `web-performance.md`; current
release verdicts require current evidence.

## Client and storage

`web/src/web/client.ts` exports `createWebBackend({threads?})`, resolving to
`{invoke,listen,capabilities,putFiles,dispose}`. `invoke(cmd,args?)` returns a
Promise. Register inputs and companions using `putFiles([{path,bytes:Uint8Array}])`.
Paths identify virtual byte-registry entries, not native filesystem locations.
`dispose()` terminates the worker and rejects outstanding calls.

`listen(event,callback)` returns an unsubscribe function. Refinement uses a
Channel callback. SPA1/SPQ1/STR4/SIT1 packets preserve desktop layouts; f32 or
quantized display values do not replace resident CPU f64 state.

The product shim treats the persisted manifest as authoritative, recursively
registering a bounded companion tree. Immutable OPFS/IndexedDB objects become
visible only through atomic manifest publication. Failed publication leaves the
old manifest usable; orphan objects are ignored. Deletions are propagated to the
worker, with no worker read fallback for removed persisted paths. Generated family
changes include tombstones. SHA-256 identities bind cuts sidecars to their PA
family; missing/mismatched identities cause a warning and omission from the worker.
See `RELEASE.md` for input, archive, registry and flight-retention budgets.

## Core commands

| Command | Arguments | Result |
| --- | --- | --- |
| `backend_info` | none | `{appName,appVersion,coreCrate}` |
| `compute_device` | none | `{kind:'cpu',name,threads,initMs,reason}` |
| `open_pa` | `{id,path}` | SPA1 ArrayBuffer |
| `read_file` | `{path}` | ArrayBuffer |
| `path_info` | `{paths:string[]}` | `{path,name,size}[]`, missing entries omitted |
| `close_session` | `{id}` | null, expires flights and unshared owned PA family |
| `fast_adjust` | `{id,voltages:[number,volts][]}` | SPQ1 ArrayBuffer |
| `electrode_labels` | `{id}` | little-endian Uint16 labels |
| `refine_targets` | `{id,outputDir?}` | `{dir,files:[{name,exists}],cutcell}` |
| `refine_start` | `{request,channel}` | job id; progress and terminal callbacks |
| `refine_cancel` | `{job}` | null |
| `fly` | `{request}` | STR4 ArrayBuffer |
| `ion_trace` | `{request,ion}` | SIT1, zero-based ion |
| `flight_velocities` | `{id,token}` | little-endian f64 triples |
| `export_array` | `{request}` | basenames; retrieve via `read_file` |
| `export_trajectories` | `{request,path}` | trajectory count |

Internal commands include `web_register_files({files})`, `web_list_files`,
`web_deleted_files`, `web_refine_summary({job})`, `web_flight_summary({id,token})`
and `web_flight_csv({id,token})`. Summaries report actual CPU threads/f64 execution
and separate prep/compute time. The last four completed refine summaries and at
most four flight records per session are retained, also subject to a global byte
budget. Re-registering identical file bytes preserves prepared geometry.

## Desktop commands

The production worker registers `app/browser-desktop.ts` before reporting
capabilities. The adapter shares `WasmBackend.files` with the core commands.

| Command | Arguments | Result |
| --- | --- | --- |
| `create_template` | `{kind:'einzel'|'quadrupole'|'reflectron'|'trap'}` | `{path,name,size,dir}` |
| `inspect_geometry` | `{request:{path,units,repair}}` | SGP1 header and f32 triangles/normals |
| `build_geometry` | `{request:{path,units,repair,method,parts,dims,spacing,origin,outputDir,stem,sidecar,cadSurface?}}` | `{paHash,files,points,electrodePoints,cutNodes,ms}` |
| `open_iob` | `{path}` | `{path,fileName,bounds,instances}` |
| `read_text` | `{path}` | UTF-8 string, rejects invalid UTF-8 |
| `write_text` | `{path,contents}` | null, atomic registry replacement |
| `write_bytes` | `{path,bytes:Uint8Array|number[]}` | null, atomic replacement |
| `remove_file` | `{path}` | null, idempotent |
| `recovery_path` | none | virtual `recovery.simrep` |
| `file_sha256` | `{path}` | lowercase SHA-256 |

Build methods are `aligned` and `cutcell`; parts are `{index,number,voltage}`.
Desktop raw-byte IPC with a percent-encoded path header is normalized to
`{path,bytes}` by the browser bridge. Rust errors preserve desktop JSON strings
with `code`, `detail` and optional `reason`.

Templates, inspection, builds and IOB parsing compile pinned desktop algorithms
through `crates/simrep-wasm/src/desktop/build.rs`, adapting Tauri, filesystem,
clock and OCCT entry points. Source delimiters fail the build when upstream
implementations change. The native oracle uses real-filesystem reads and writes,
independently of the virtual-filesystem adapter. Browser allocation limits apply
before GEM rasterization and literal particle/compressed mesh expansion.

Templates produce PA# files in fresh virtual directories. Identity tests compare
templates, GEM/mesh SGP1, aligned/cut-cell PA#/cuts, IOB and SHA-256; runtime `ms`
is excluded. Cache tests verify sidecar-free exact solves and aligned rebuilds.
IOB reads classic/SIMIOB bounds and placements with case-insensitive sibling PA
resolution, without executing Lua. STEP/IGES and executable GEM Lua reject.

## Geometry and refinement

`gem2pa`, `mesh_import` / `mesh-import`, and `refine_geometry` / `refine-geometry`
accept direct arguments or `{request}`. See `crates/simrep-wasm/src/geom/README.md`.
`refine_geometry` prepares cuts-v3 and physical-mask PA# with `solve_pending:true`.
Open the PA# and invoke `refine_start` to solve using exact cut-cell geometry.

Refine requests include `id`, optional `outputDir`, `device:'cpu'|'auto'`,
`voltages`, `tolerance` (default 1e-10), and `maxCycles` (default 200). PA# creates
the native PA0/basis family; plain PA produces refined PA. Publish only on success.
Channels receive `start`, `progress`, `stageDone`, `done`, `cancelled`, `error`,
SPV1 previews and a final SPA1 before `done`. The job response precedes callbacks.
Backpressure permits cancellation before the next V-cycle. Cancellation preserves
source bytes, emits one terminal and never publishes a partial basis family.
Completed-job cancellation is harmless. See `tests/refine-channel.mjs`.

## Flight, exports and hosting

Flight requests include `id`, `source`, `durationUs`, `relativistic` and optional
voltages, placement, bounds, precision, collision, draw, surfaces, plane,
tolerance, step controls, integrator and magnetic field/PA/coils. File sources
accept ION and declarative FLY2; beams describe count, mass, charge, energy,
position and direction. Computation stays CPU f64. `surfaces:true` loads sibling
or explicit cuts; false selects staircase collisions. Magnetic fields use gauss.
CSV formatting follows the native CLI; `web_flight_csv` returns full-f64 bytes.
Displayed trajectories are sampled within a byte budget during integration,
using the deterministic unsampled run's step counts, rather than retaining all
steps and thinning only the output packet.

Array exports cover geometry, grid, isosurface and PA; formats include
STL/OBJ/glTF/GLB, VTI/VTS, PA/PA#/PA0 families. Trajectories export CSV/VTP.
Outputs remain virtual bytes until downloaded or persisted.

Serial builds use Rust 1.95.0. Threaded builds use wasm-bindgen-rayon,
nightly-2025-11-15 and bindgen 0.2.129. Shared memory requires isolation and
SharedArrayBuffer; otherwise select serial with a reason. The pool caps at four.
Capabilities and compute-device thread counts describe initialized workers.
Initialization errors reject rather than claim success.

Serve HTTPS/localhost with the COOP/COEP and CSP in `web/public/_headers`, or
configure equivalent headers on the host. The preview server sends these policies.
The shipped coi-serviceworker supplies isolation on compatible headerless hosts,
not a replacement for CSP. GPU compute remains gated off; WebGPU rendering is
separate from CPU computation. The pinned UI supplies responsive phone/tablet
layouts and touch controls; browser E2E checks the 390x844 real-worker scene.

The worker rejects `project_dir_write`, `project_dir_read`, `project_dir_list`,
`project_dir_delete` and `ai_request`; the product shim implements project storage.
Unknown commands reject `unsupported in browser: <cmd>`. Executable Lua, CAD,
native filesystem/AI and mbmr.dat-dependent collisions are outside this backend.
Generated packages and evidence are ignored.
