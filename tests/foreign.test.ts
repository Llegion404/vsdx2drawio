// Synthetic ground-truth: a Foreign shape with a tiny PNG must become a
// draw.io image shape and an SVG <image>, with the correct box.

import { describe, it, expect } from 'vitest';
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
import { strToU8, zipSync } from 'fflate';
import { OpcPackage } from '../src/vsdx/opc';
import { buildScene } from '../src/vsdx/model';
import { emitDrawio } from '../src/drawio/emitter';
import { emitSvg } from '../src/svg/emitter';

(globalThis as Record<string, unknown>).DOMParser = XmldomDOMParser;

// 1x1 red PNG
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0));

function foreignVsdx(): Uint8Array {
  const NS = "xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'";
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Default Extension='png' ContentType='image/png'/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/document' Target='visio/document.xml'/></Relationships>`,
    ),
    'visio/document.xml': strToU8(`<?xml version='1.0' encoding='utf-8'?><VisioDocument ${NS}></VisioDocument>`),
    'visio/_rels/document.xml.rels': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId2' Type='http://schemas.microsoft.com/visio/2010/relationships/pages' Target='pages/pages.xml'/></Relationships>`,
    ),
    'visio/media/image1.png': PNG_1PX,
    'visio/pages/pages.xml': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Pages ${NS}><Page ID='0' NameU='P1' Name='P1'><PageSheet><Cell N='PageWidth' V='8.5'/><Cell N='PageHeight' V='11'/></PageSheet><Rel r:id='rId1'/></Page></Pages>`,
    ),
    'visio/pages/_rels/pages.xml.rels': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page1.xml'/></Relationships>`,
    ),
    'visio/pages/page1.xml': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><PageContents ${NS}><Shapes><Shape ID='1' Type='Foreign'><Cell N='PinX' V='2'/><Cell N='PinY' V='3'/><Cell N='Width' V='1.5'/><Cell N='Height' V='1'/><Cell N='LocPinX' V='0.75'/><Cell N='LocPinY' V='0.5'/><ForeignData ForeignType='Bitmap' CompressionType='PNG'><Rel r:id='rId1'/></ForeignData></Shape></Shapes></PageContents>`,
    ),
    'visio/pages/_rels/page1.xml.rels': strToU8(
      `<?xml version='1.0' encoding='utf-8'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' Target='../media/image1.png'/></Relationships>`,
    ),
  };
  return zipSync(files);
}

describe('foreign bitmaps', () => {
  it('extracts the image and emits a draw.io image shape at the right box', () => {
    const scene = buildScene(OpcPackage.read(foreignVsdx()));
    const s = scene.pages[0].shapes[0];
    expect(s.type).toBe('foreign');
    expect(s.foreign?.mime).toBe('image/png');
    expect(s.foreign?.dataUrl).toMatch(/^data:image\/png;base64,/);

    const { xml, stats } = emitDrawio(scene);
    expect(stats[0].foreign).toBe(1);
    expect(xml).toContain('shape=image;');
    expect(xml).toContain('data:image/png;base64,');
    // pin (2,3), 1.5x1 in on 8.5x11 -> center (200, 800), top-left (125, 750)
    expect(xml).toContain('x="125" y="750"');
    expect(xml).toContain('width="150" height="100"');
  });

  it('emits an SVG <image> element', () => {
    const scene = buildScene(OpcPackage.read(foreignVsdx()));
    const svg = emitSvg(scene.pages[0]);
    expect(svg).toContain('<image');
    expect(svg).toContain('href="data:image/png;base64,');
  });
});
