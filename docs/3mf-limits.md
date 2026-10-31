# Browser 3MF input limits

`crates/simrep-wasm/src/desktop/threemf_limits.rs` runs at the byte-registry
boundary, before the native `simrep-mesh` reader. The TypeScript IPC path and
direct wasm API use this same boundary. The native reader and SimRep pin remain
unchanged, so accepted geometry uses the original parser and numerical path.

| Resource | Limit |
| --- | --- |
| Input ZIP | 128 MiB (shared input limit) |
| ZIP entries / object definitions / build items | 2,048 each |
| Declared and streamed ZIP part size / XML size | 32 MiB each |
| Declared and streamed total ZIP output | 64 MiB |
| ZIP expansion ratio | 200:1 per part |
| XML attributes per element | 64 |
| Raw attribute value and key length | 4,096 bytes each |
| Total normalized attribute bytes | 64 MiB across relationship and model XML |
| XML and component nesting | 128 |
| Source and instantiated vertices / triangles | 1,000,000 each |
| Instantiated object visits | 2,048 |
| Instantiated vertex/triangle storage plus generated path names | 64 MiB |

Raw XML attributes are bounded before normalization allocates strings. DTDs,
external entities and general entity references are rejected; attribute decoding
uses only the XML library's predefined/numeric escape handling, without an entity
resolver. Both the complete relationship XML and selected model XML are checked.
Optional `count` attributes on `vertices` and `triangles` must match actual child
counts and cannot exceed the geometry limit. Ordinary 3MF has no required count
attributes; actual element counts are always checked.

Graph accounting reads `id` only on object definitions and `objectid` only on
components/build items, matching the native consumer regardless of extra attribute
order. The graph memo includes height, so cached shallow roots cannot hide a deep
component chain. Generated path-name bytes are budgeted as well as geometry;
component-only visits count conservatively toward this budget. Totals are checked
before native instantiation or mesh vector allocation. Rejected registration leaves
the byte registry unchanged.

Run `bash scripts/build-wasm.sh nodejs` before `cd web && npm test`. The Vitest
3MF cases execute `node tests/threemf-limits.mjs` against that real wasm package;
no parser mock is used. `cargo test --locked -p simrep-wasm --lib` also exercises
the browser guard natively. `node tests/geometry-identity.mjs` compares Chromium
worker outputs, including 3MF mesh import, byte-for-byte with the pinned native CLI.
