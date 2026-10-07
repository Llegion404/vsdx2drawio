// M0 spike: parse a .vsdx file, dump the part graph, build the scene model,
// and emit draw.io XML. Usage: npm run spike -- <file.vsdx> [out.drawio]

import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
import { readFileSync, writeFileSync } from 'node:fs';

(globalThis as Record<string, unknown>).DOMParser = XmldomDOMParser;

import { OpcPackage } from '../src/vsdx/opc';
import { buildScene, buildMasterScenes } from '../src/vsdx/model';
import type { ShapeNode } from '../src/vsdx/model';
import { emitDrawio } from '../src/drawio/emitter';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: tsx scripts/spike.ts <file.vsdx> [out.drawio]');
  process.exit(1);
}

const data = readFileSync(input);
const pkg = OpcPackage.read(new Uint8Array(data));

console.log('== OPC parts ==');
for (const p of pkg.partNames()) console.log(' ', p, `(${pkg.bytes(p).length}b)`);

console.log('\n== rels of visio/document.xml ==');
for (const r of pkg.rels('visio/document.xml')) console.log(' ', r.id, r.type, '->', r.target);

let scene;
try {
  scene = buildScene(pkg);
} catch (e) {
  if (String((e as Error).message).includes('No pages part')) {
    console.log('(no pages part — treating as stencil pack: one pseudo-page per master)');
    scene = buildMasterScenes(pkg);
  } else throw e;
}
{
  const total = scene.pages.reduce((a, p) => a + p.shapes.length, 0);
  if (total === 0) {
    console.log('(pages empty — falling back to master scenes)');
    scene = buildMasterScenes(pkg);
  }
}

console.log('\n== scene ==');
for (const page of scene.pages) {
  const count = (s: ShapeNode): number => 1 + s.children.reduce((a: number, c: ShapeNode) => a + count(c), 0);
  const shapeCount = page.shapes.reduce((a, s) => a + count(s), 0);
  console.log(
    `page ${page.id} "${page.name}" ${page.width}x${page.height}in: ${page.shapes.length} top shapes (${shapeCount} total), ${page.connects.length} connects`,
  );
}

if (scene.warnings.length) {
  console.log('\n== warnings ==');
  for (const w of scene.warnings.slice(0, 20)) console.log(' !', w);
  if (scene.warnings.length > 20) console.log(` ... +${scene.warnings.length - 20} more`);
}

const result = emitDrawio(scene);
console.log('\n== draw.io stats per page ==');
for (let i = 0; i < result.stats.length; i++) {
  console.log(` page ${i}:`, JSON.stringify(result.stats[i]));
}

if (output) {
  writeFileSync(output, result.xml);
  console.log(`\nwrote ${output} (${result.xml.length} bytes)`);
} else {
  console.log('\n== draw.io XML (first 3000 chars) ==');
  console.log(result.xml.slice(0, 3000));
}
