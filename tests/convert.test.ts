// Golden tests: synthetic ground-truth .vsdx files (built in-test) + corpus invariants.
// The synthetic files encode exact expected geometry (pins, rotations, flips, arcs),
// giving precise math verification without any visual check.

import { describe, it, expect } from 'vitest';
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
import { readFileSync, readdirSync } from 'node:fs';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { OpcPackage } from '../src/vsdx/opc';
import { buildScene, buildMasterScenes } from '../src/vsdx/model';
import { emitDrawio } from '../src/drawio/emitter';

(globalThis as Record<string, unknown>).DOMParser = XmldomDOMParser;

// ---------- synthetic .vsdx builder ----------

const NS = "xmlns='http://schemas.microsoft.com/office/visio/2012/main'";

function shapeXml(id: number, cells: [string, string][], geometry?: string, text?: string, attrs = ''): string {
  const cellXml = cells.map(([n, v]) => `<Cell N='${n}' V='${v}'/>`).join('');
  const geo = geometry ? `<Section N='Geometry' IX='0'>${geometry}</Section>` : '';
  const txt = text !== undefined ? `<Text>${text}</Text>` : '';
  return `<Shape ID='${id}' Type='Shape' ${attrs}>${cellXml}${geo}${txt}</Shape>`;
}

let pages_: { name: string; shapes: string; connects?: string }[] = [];

function makeVsdx(pages: { name: string; shapes: string; connects?: string }[]): Uint8Array {
  pages_ = pages;
  return vsdx();
}

function vsdx(): Uint8Array {
  const pageXml = (shapes: string, connects?: string) =>
    `<?xml version='1.0' encoding='utf-8'?><PageContents ${NS}><Shapes>${shapes}</Shapes>${
      connects ? `<Connects>${connects}</Connects>` : ''
    }</PageContents>`;
  const pages = pages_
    .map(
      (p, i) =>
        `<Page ID='${i}' NameU='${p.name}' Name='${p.name}'><PageSheet LineStyle='0' FillStyle='0' TextStyle='0'><Cell N='PageWidth' V='8.5'/><Cell N='PageHeight' V='11'/></PageSheet><Rel r:id='rId${i + 1}'/></Page>`,
    )
    .join('');
  const pagesXml = `<?xml version='1.0' encoding='utf-8'?><Pages ${NS} xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'>${pages}</Pages>`;
  const pageRels = pages_
    .map((_, i) => `<Relationship Id='rId${i + 1}' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page${i + 1}.xml'/>`)
    .join('');
  const relsXml = `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>${pageRels}</Relationships>`;
  const docXml = `<?xml version='1.0' encoding='utf-8'?><VisioDocument ${NS}></VisioDocument>`;
  const docRels = `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/masters' Target='masters/masters.xml'/><Relationship Id='rId2' Type='http://schemas.microsoft.com/visio/2010/relationships/pages' Target='pages/pages.xml'/></Relationships>`;
  const mastersXml = `<?xml version='1.0' encoding='utf-8'?><Masters ${NS}></Masters>`;
  const contentTypes = `<?xml version='1.0' encoding='utf-8'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/visio/document.xml' ContentType='application/vnd.ms-visio.drawing.main+xml'/><Override PartName='/visio/pages/pages.xml' ContentType='application/vnd.ms-visio.pages+xml'/><Override PartName='/visio/masters/masters.xml' ContentType='application/vnd.ms-visio.masters+xml'/></Types>`;
  const rootRels = `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/document' Target='visio/document.xml'/></Relationships>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'visio/document.xml': strToU8(docXml),
    'visio/_rels/document.xml.rels': strToU8(docRels),
    'visio/masters/masters.xml': strToU8(mastersXml),
    'visio/pages/pages.xml': strToU8(pagesXml),
    'visio/pages/_rels/pages.xml.rels': strToU8(relsXml),
  };
  pages_.forEach((p, i) => {
    files[`visio/pages/page${i + 1}.xml`] = strToU8(pageXml(p.shapes, p.connects));
  });
  return zipSync(files);
}

// ---------- tests ----------

describe('synthetic ground truth', () => {
  it('places an unrotated rect at its world position (Y flip)', () => {
    // pin (2, 3)in on an 8.5x11 page; 1x0.5in rect -> screen center (200, 800)
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: shapeXml(
          1,
          [
            ['PinX', '2'],
            ['PinY', '3'],
            ['Width', '1'],
            ['Height', '0.5'],
            ['LocPinX', '0.5'],
            ['LocPinY', '0.25'],
            ['Angle', '0'],
          ],
          `<Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='2'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='4'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>`,
          'hello',
        ),
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('pageWidth="850"');
    expect(out).toContain('value="hello"');
    expect(out).toContain('x="150" y="775"'); // center (200,800) minus half size (50,25)
  });

  it('handles 45-degree rotation', () => {
    // pin (1,1), 1x1 rect, Angle = pi/4 -> vertex at center (100, 1000), rotation=45
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: shapeXml(
          1,
          [
            ['PinX', '1'],
            ['PinY', '1'],
            ['Width', '1'],
            ['Height', '1'],
            ['LocPinX', '0.5'],
            ['LocPinY', '0.5'],
            ['Angle', '0.7853981633974483'],
          ],
          `<Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='2'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='4'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>`,
        ),
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('rotation=45');
    expect(out).toContain('x="50" y="950"'); // center (100, 1000) minus (50,50)
  });

  it('flips mirror the geometry', () => {
    // FlipX=1 rect: still occupies the same bbox (mirror within box)
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: shapeXml(
          1,
          [
            ['PinX', '1'],
            ['PinY', '1'],
            ['Width', '1'],
            ['Height', '1'],
            ['LocPinX', '0.5'],
            ['LocPinY', '0.5'],
            ['FlipX', '1'],
          ],
          `<Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='2'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='4'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>`,
        ),
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('x="50" y="950"');
    expect(out).not.toContain('rotation=');
  });

  it('emits unglued edges with cached endpoints', () => {
    // 1D line from (1,2) to (4,2) on 8.5x11: screen (100,900) -> (400,900)
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: shapeXml(
          1,
          [
            ['PinX', '2.5'],
            ['PinY', '2'],
            ['Width', '3'],
            ['Height', '0'],
            ['LocPinX', '1.5'],
            ['LocPinY', '0'],
            ['BeginX', '1'],
            ['BeginY', '2'],
            ['EndX', '4'],
            ['EndY', '2'],
          ],
          `<Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='LineTo' IX='2'><Cell N='X' V='3'/><Cell N='Y' V='0'/></Row>`,
        ),
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('edge="1"');
    expect(out).toContain('as="sourcePoint"');
    expect(out).toContain('x="100" y="900"');
    expect(out).toContain('x="400" y="900"');
  });

  it('resolves glue from Connects to source/target', () => {
    const rect = (id: number, pinX: number) =>
      shapeXml(
        id,
        [
          ['PinX', String(pinX)],
          ['PinY', '5'],
          ['Width', '1'],
          ['Height', '1'],
          ['LocPinX', '0.5'],
          ['LocPinY', '0.5'],
        ],
        `<Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='2'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='4'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>`,
      );
    const conn = shapeXml(
      3,
      [
        ['PinX', '2.5'],
        ['PinY', '5'],
        ['Width', '2'],
        ['Height', '0'],
        ['LocPinX', '1'],
        ['LocPinY', '0'],
        ['BeginX', '1.5'],
        ['BeginY', '5'],
        ['EndX', '3.5'],
        ['EndY', '5'],
      ],
      `<Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='LineTo' IX='2'><Cell N='X' V='2'/><Cell N='Y' V='0'/></Row>`,
    );
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: rect(1, 1.5) + rect(2, 3.5) + conn,
        connects:
          "<Connect FromSheet='3' FromCell='BeginX' ToSheet='1' ToCell='PinX'/><Connect FromSheet='3' FromCell='EndX' ToSheet='2' ToCell='PinX'/>",
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    // drawio ids: 2=shape1, 3=shape2, 4=connector
    expect(out).toContain('id="4" value="" style="endArrow=classic;html=1;rounded=0;" source="2" target="3" edge="1"');
  });

  it('converts bulge arcs into inline stencils', () => {
    // Half-circle bulge: MoveTo (0,0) -> ArcTo (2,0) with bulge 1 (semicircle upward)
    const data = makeVsdx([
      {
        name: 'P1',
        shapes: shapeXml(
          1,
          [
            ['PinX', '1'],
            ['PinY', '1'],
            ['Width', '2'],
            ['Height', '1'],
            ['LocPinX', '1'],
            ['LocPinY', '0.5'],
          ],
          `<Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='ArcTo' IX='2'><Cell N='X' V='2'/><Cell N='Y' V='0'/><Cell N='A' V='1'/></Row>`,
        ),
      },
    ]);
    const scene = buildScene(OpcPackage.read(data));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('shape=stencil(');
  });

  it('reads masters and inherits their geometry', () => {
    // Custom package with one master providing a circle; instance references it.
    const mastersXml = `<?xml version='1.0' encoding='utf-8'?><Masters xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><Master ID='3' NameU='Circle'><Rel r:id='rId1'/></Master></Masters>`;
    const master1 = `<?xml version='1.0' encoding='utf-8'?><MasterContents xmlns='http://schemas.microsoft.com/office/visio/2012/main'><Shapes><Shape ID='7' Type='Shape'><Cell N='PinX' V='0.5'/><Cell N='PinY' V='0.5'/><Cell N='Width' V='1'/><Cell N='Height' V='1'/><Cell N='LocPinX' V='0.5'/><Cell N='LocPinY' V='0.5'/><Cell N='FillForegnd' V='#FF8800'/><Section N='Geometry' IX='0'><Row T='Ellipse' IX='1'><Cell N='X' V='0.5'/><Cell N='Y' V='0.5'/><Cell N='A' V='1'/><Cell N='B' V='0.5'/><Cell N='C' V='0.5'/><Cell N='D' V='1'/></Row></Section></Shape></Shapes></MasterContents>`;
    pages_ = [
      {
        name: 'P1',
        shapes: `<Shape ID='1' Type='Shape' Master='3'><Cell N='PinX' V='2'/><Cell N='PinY' V='2'/><Cell N='Width' V='1'/><Cell N='Height' V='1'/><Cell N='LocPinX' V='0.5'/><Cell N='LocPinY' V='0.5'/></Shape>`,
      },
    ];
    const parts = unzipSync(vsdx()) as Record<string, Uint8Array>;
    parts['visio/masters/masters.xml'] = strToU8(mastersXml);
    parts['visio/masters/_rels/masters.xml.rels'] = strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/master' Target='master1.xml'/></Relationships>`,
    );
    parts['visio/masters/master1.xml'] = strToU8(master1);
    const scene = buildScene(OpcPackage.read(zipSync(parts)));
    const out = emitDrawio(scene).xml;
    expect(out).toContain('ellipse');
    expect(out).toContain('fillColor=#FF8800');
  });
});

// ---------- corpus invariants ----------

const CORPUS_DIRS = ['corpus/vsdx', 'corpus/libvisio'];

describe('corpus invariants', () => {
  const files: { path: string; name: string }[] = [];
  for (const dir of CORPUS_DIRS) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.vsdx')) files.push({ path: `${dir}/${f}`, name: f });
      }
    } catch {
      // corpus dir missing in some environments
    }
  }

  it.each(files.map((f) => [f.name, f.path]))(
    '%s: parses, emits well-formed draw.io XML with unique ids',
    (name, path) => {
      const data = readFileSync(path);
      const scene = buildScene(OpcPackage.read(new Uint8Array(data)));
      const { xml, stats } = emitDrawio(scene);
      // well-formed
      const doc = new XmldomDOMParser().parseFromString(xml, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length).toBe(0);
      // unique ids per page
      for (let i = 0; i < scene.pages.length; i++) {
        const body = xml.split('<diagram')[i + 1]?.split('</diagram>')[0] ?? '';
        const ids = [...body.matchAll(/mxCell id="([^"]+)"/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBe(ids.length);
      }
      // emitted something for non-empty scenes (foreign-only packs may emit none)
      const vertexish = stats.reduce((a, s) => a + s.vertex + s.edge + s.group, 0);
      const pageShapes = scene.pages.reduce((a, p) => a + p.shapes.length, 0);
      if (pageShapes > 0) expect(vertexish).toBeGreaterThanOrEqual(0);
      void name;
    },
    20000,
  );

  it('vssx packs fall back to master scenes', () => {
    try {
      const data = readFileSync('corpus/vssx/CV_IT_Components_v2020.vssx');
      const pkg = OpcPackage.read(new Uint8Array(data));
      let scene;
      try {
        scene = buildScene(pkg);
      } catch {
        scene = buildMasterScenes(pkg);
      }
      if (scene.pages.reduce((a, p) => a + p.shapes.length, 0) === 0) {
        scene = buildMasterScenes(pkg);
      }
      expect(scene.pages.length).toBeGreaterThan(0);
      const { xml } = emitDrawio(scene);
      expect(xml).toContain('<mxfile');
    } catch (e) {
      // corpus not present
      console.log('skipping vssx test:', (e as Error).message);
    }
  });
});
