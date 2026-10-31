import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const { WasmBackend } = createRequire(import.meta.url)('../target/node-pkg/simrep_wasm.js');
function zipModel(xml, relationships = '<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/model.model"/></Relationships>') {
  const chunks = [], central = []; let offset = 0;
  for (const [filename, text] of [['_rels/.rels', relationships], ['3D/model.model', xml]]) {
    const name = Buffer.from(filename), bytes = Buffer.from(text), crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(bytes.length, 20); cd.writeUInt32LE(bytes.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    chunks.push(local, name, bytes); central.push(cd, name); offset += 30 + name.length + bytes.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}
const object = '<object id="1"><mesh><vertices count="3"><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles count="1"><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>';
const valid = `<model><resources>${object}</resources><build><item objectid="1"/></build></model>`;
function branch(extraFirst, itemAlias = false) {
  let xml = `<model><resources>${object}`;
  for (let n = 2; n <= 13; n++) { const attrs = extraFirst ? `id="1" objectid="${n - 1}"` : `objectid="${n - 1}" id="1"`; xml += `<object id="${n}"><components><component ${attrs}/><component ${attrs}/></components></object>`; }
  return `${xml}</resources><build><item objectid="13"${itemAlias ? ' id="1"' : ''}/></build></model>`;
}
function deepComponents() {
  let xml = `<model><resources>${object}`;
  for (let n = 2; n <= 129; n++) xml += `<object id="${n}"><components><component objectid="${n - 1}"/></components></object>`;
  return `${xml}</resources><build><item objectid="1"/><item objectid="129"/></build></model>`;
}
function expandedNames() {
  const name = 'x'.repeat(4096);
  let xml = `<model><resources>${object.replace('<object id="1">', `<object id="1" name="${name}">`)}`;
  xml += `<object id="2" name="${name}"><components>${'<component objectid="1"/>'.repeat(1024)}</components></object>`;
  for (let n = 3; n <= 65; n++) xml += `<object id="${n}" name="${name}"><components><component objectid="${n - 1}"/></components></object>`;
  return `${xml}</resources><build><item objectid="65"/></build></model>`;
}
const cases = [
  ['component-alias-last', branch(false), /instantiated/],
  ['component-alias-first', branch(true), /instantiated/],
  ['item-alias', branch(false, true), /instantiated/],
  ['huge-attribute', valid.replace('<model>', `<model name="${'x'.repeat(4097)}">`), /attribute/],
  ['many-attributes', valid.replace('<model>', `<model ${Array.from({length:65}, (_, i) => `a${i}="x"`).join(' ')}>`), /attribute/],
  ['entities', '<!DOCTYPE model [<!ENTITY a "abc"><!ENTITY b "&a;&a;">]>' + valid, /DTD|entities/],
  ['external-entity', '<!DOCTYPE model SYSTEM "file:///etc/passwd">' + valid, /DTD|entities/],
  ['attribute-entity', valid.replace('<model>', '<model name="&unknown;">'), /entity/],
  ['count-mismatch', valid.replace('count="3"', 'count="4"'), /count/],
  ['triangle-count-mismatch', valid.replace('count="1"', 'count="2"'), /count/],
  ['count-limit', valid.replace('count="3"', 'count="1000001"'), /count|budget/],
  ['actual-vertex-limit', `<model><object id="1">${'<vertex/>'.repeat(1000001)}</object></model>`, /geometry budget/],
  ['actual-triangle-limit', `<model><object id="1">${'<triangle/>'.repeat(1000001)}</object></model>`, /geometry budget/],
  ['deep-nesting', '<x>'.repeat(129) + valid + '</x>'.repeat(129), /nesting/],
  ['memoized-component-depth', deepComponents(), /nesting/],
  ['expanded-name-bytes', expandedNames(), /instantiated/],
  ['xml-size', ' '.repeat(32 * 1024 * 1024 + 1), /budget|size/],
];
console.log('Surface: Node real wasm registration and desktop_inspect. Invocation: node tests/threemf-limits.mjs');
const backend = new WasmBackend(), results = [];
try {
  for (const [id, xml, expected] of cases) {
    const before = backend.list_files(); let error;
    try { backend.put_file(`${id}.3mf`, zipModel(xml)); } catch (e) { error = String(e); }
    assert.match(error ?? '', expected, id); assert.equal(backend.list_files(), before, `${id}: mutated registry`);
    results.push({ id, verdict: 'PASS', error });
  }
  const rel = '<!DOCTYPE Relationships><Relationships/>';
  assert.throws(() => backend.put_file('rels.3mf', zipModel(valid, rel)), /DTD|entities/);
  results.push({ id: 'relationship-dtd', verdict: 'PASS' });
  for (const [id, xml] of [
    ['valid-recovery', valid],
    ['attribute-boundaries', valid.replace('<model>', `<model ${Array.from({length:64}, (_, i) => `a${i}="${i === 0 ? 'x'.repeat(4096) : 'x'}"`).join(' ')}>`)],
    ['escaped-attribute', valid.replace('<model>', '<model name="a&amp;b">')],
  ]) {
    backend.put_file(`${id}.3mf`, zipModel(xml));
    const packet = backend.desktop_inspect(JSON.stringify({path:`${id}.3mf`, units:null, repair:false}));
    assert.ok(packet.length > 8); results.push({id, verdict:'PASS', packetBytes:packet.length});
  }
} finally {
  backend.free(); await mkdir('evidence/3mf', {recursive:true}); await writeFile('evidence/3mf/adversarial.json', JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
