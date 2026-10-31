# Browser geometry commands

All commands run in the existing browser module worker. Register every input with `putFiles([{path,bytes}])`, call `invoke(command,args)`, and retrieve each `output_paths` entry with `invoke('read_file',{path})`. Output publication happens only after successful conversion. No computation service or native filesystem is used.

| Command | Request fields | Output |
| --- | --- | --- |
| `gem2pa` | `path`, optional `output` | Native PA# bytes; fractional GEM also emits the native `.pa-surf` companion. Relative GEM includes and embedded STL references resolve from registered bytes. Executable Lua rejects with `unsupported in browser: GEM Lua`. |
| `mesh_import` / `mesh-import` | `path`, `grid:[nx,ny,nz]`, optional `output`, `spacing`, `origin`, `units`, `transform` (row-major 3x4), `electrodes`, `repair`, `allowDefects` | Native PA# bytes for STL, OBJ, PLY, 3MF, glTF and GLB. glTF external buffer paths resolve from registered bytes. Defaults match mesh-import: spacing 1 mm, origin zero, identity transform, native units, electrodes 1..N. |
| `refine_geometry` / `refine-geometry` | `path`, `assignments:[{part,number,voltage}]`, optional `insulators:string[]`, `grid`, `spacing`, `origin`, `units`, `repair`, `gapCheck:'off'|'warn'|'error'`, `output` (stem) | Native exact-source v3 `.cuts.json` and physical-mask PA#. Returns `solve_pending:true`: no PA0 or solved basis is claimed. |

The same requests may be nested under `request`. GEM assignment selectors are source electrode values as strings; mesh selectors are names or zero-based part indices. Every source part must have exactly one electrode or insulator assignment. Collision-only numbers follow the native allocation order and never enter the physical PA# electrode mask. Shared electrode numbers require identical voltages. The gap policy uses the native 2.5-cell minimum and 10-cell recommendation, exact mesh surface gaps, and conservative GEM brackets with the same bounded work budget; unresolved brackets fail `error`, return diagnostics under `warn`, and are not measured under `off`.

Example:

```js
await backend.putFiles([{ path: 'einzel.gem', bytes }]);
const result = await backend.invoke('refine_geometry', {
  path: 'einzel.gem', output: 'einzel',
  assignments: [
    { part: '1', number: 1, voltage: 0 },
    { part: '2', number: 2, voltage: 60 },
    { part: '3', number: 3, voltage: 0 },
  ],
});
const cuts = await backend.invoke('read_file', { path: 'einzel.cuts.json' });
```

This module prepares geometry, not the desktop `inspect_geometry` / `build_geometry` SGP1 editor protocol. It does not implement CAD, Lua, adaptive refinement, dense fallback SDF emission, or aperture-check. Shared refinement owns the subsequent solve. A staircase solve of the PA# alone is not an exact cut-cell solve.

Real Chromium identity scenarios are in `tests/geometry-identity.mjs`, `tests/geometry-edges.mjs` and `tests/geometry-stl.mjs`; their JSON records include exact native/browser invocations, SHA256 values, byte comparisons, adversarial errors, and static-only request logs.
