// Builds an intermediate Scene model from a .vsdx/.vssx OPC package.
// All linear values are in inches; Y is UP (Visio's native orientation).
// Angles are radians as stored by Visio (rotation about the pin).

import { OpcPackage } from './opc';
import {
  parseXml,
  children,
  child,
  childrenOf,
  attr,
  numAttr,
} from './xml';

// ---------- model ----------

export interface GeoRow {
  t: string; // MoveTo, LineTo, ArcTo, EllipticalArcTo, PolylineTo, SplineStart, SplineKnot, Ellipse, InfiniteLine, NURBSTo, Rel*
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
}

export interface PathSection {
  rows: GeoRow[];
  noFill: boolean;
  noLine: boolean;
  noShow: boolean;
}

export interface TextStyle {
  sizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'middle' | 'bottom';
}

export interface ShapeNode {
  id: number;
  name: string;
  type: 'shape' | 'group' | 'foreign' | 'guide';
  masterName?: string;
  // transform in parent space (inches, Y-up)
  pinX: number;
  pinY: number;
  locPinX: number;
  locPinY: number;
  width: number;
  height: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  paths: PathSection[];
  fill: { color: string } | null; // null = no fill
  line: { color: string; weightIn: number; pattern: number } | null;
  text?: { plain: string; style: TextStyle };
  /** Embedded bitmap for Type='Foreign' shapes (renderable images only). */
  foreign?: { mime: string; dataUrl: string };
  children: ShapeNode[];
  isEdge: boolean; // 1D shape (has BeginX/EndX)
}

export interface PageConnection {
  from: number;
  fromCell: string;
  to: number;
  toCell: string;
}

export interface PageScene {
  id: number;
  name: string;
  nameU: string;
  width: number;
  height: number;
  shapes: ShapeNode[];
  connects: PageConnection[];
}

export interface Scene {
  pages: PageScene[];
  warnings: string[];
}

// ---------- Visio default palette for numeric color indices ----------

const PALETTE: Record<string, string> = {
  '0': '#000000', '1': '#FFFFFF', '2': '#FF0000', '3': '#00FF00',
  '4': '#0000FF', '5': '#FFFF00', '6': '#FF00FF', '7': '#00FFFF',
  '8': '#800000', '9': '#008000', '10': '#000080', '11': '#808000',
  '12': '#800080', '13': '#008080', '14': '#C0C0C0', '15': '#808080',
  '16': '#9999FF', '17': '#993366', '18': '#FFFFCC', '19': '#CCFFFF',
  '20': '#660066', '21': '#FF8080', '22': '#0066CC', '23': '#CCCCFF',
};

function colorVal(v: string | undefined, dflt: string): string {
  if (!v) return dflt;
  const t = v.trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(t)) return t.startsWith('#') ? t.toUpperCase() : '#' + t.toUpperCase();
  if (PALETTE[t] !== undefined) return PALETTE[t];
  return dflt;
}

// ---------- cell extraction ----------

type Cells = Map<string, string>;

function readCells(el: Element, into: Cells = new Map()): Cells {
  for (const c of children(el)) {
    if (c.tagName === 'Cell') {
      const n = attr(c, 'N');
      if (n && !into.has(n)) into.set(n, attr(c, 'V') ?? '');
    }
  }
  return into;
}

function cnum(cells: Cells, name: string, dflt: number): number {
  const v = cells.get(name);
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ---------- geometry ----------

const REL_ROW_MAP: Record<string, string> = {
  RelMoveTo: 'MoveTo',
  RelLineTo: 'LineTo',
  RelPolylineTo: 'PolylineTo',
  RelCubBezTo: 'CubBezTo',
  RelQuadBezTo: 'QuadBezTo',
  RelArcTo: 'ArcTo',
  RelEllipticalArcTo: 'EllipticalArcTo',
};

function readGeometry(shapeEl: Element, width: number, height: number): PathSection[] {
  const out: PathSection[] = [];
  for (const sec of children(shapeEl)) {
    if (sec.tagName !== 'Section' || attr(sec, 'N') !== 'Geometry') continue;
    const secCells = readCells(sec);
    const rows: GeoRow[] = [];
    for (const row of children(sec)) {
      if (row.tagName !== 'Row') continue;
      let t = attr(row, 'T');
      if (!t) continue;
      const rc = readCells(row);
      const r: GeoRow = {
        t,
        x: cnum(rc, 'X', NaN),
        y: cnum(rc, 'Y', NaN),
        a: cnum(rc, 'A', NaN),
        b: cnum(rc, 'B', NaN),
        c: cnum(rc, 'C', NaN),
        d: cnum(rc, 'D', NaN),
        e: cnum(rc, 'E', NaN),
      };
      // Relative rows use 0..1 fractions of width/height -> normalize to inches.
      // X-like cells scale by width, Y-like by height; angles/ratios stay as-is.
      const rel = REL_ROW_MAP[t];
      if (rel) {
        r.t = rel;
        r.x *= width;
        r.y *= height;
        if (rel === 'CubBezTo' || rel === 'QuadBezTo') {
          r.a *= width;
          r.b *= height;
          r.c *= width;
          r.d *= height;
        } else if (rel === 'EllipticalArcTo') {
          r.a *= width;
          r.b *= height;
        }
        // ArcTo: A is a unitless bulge — no scaling.
      }
      rows.push(r);
    }
    out.push({
      rows,
      noFill: (secCells.get('NoFill') ?? '0') === '1',
      noLine: (secCells.get('NoLine') ?? '0') === '1',
      noShow: (secCells.get('NoShow') ?? '0') === '1',
    });
  }
  return out;
}

// ---------- text ----------

function readText(shapeEl: Element, cells: Cells): { plain: string; style: TextStyle } | undefined {
  const textEl = child(shapeEl, 'Text');
  if (!textEl) return undefined;

  // Plain text: text nodes, skipping cp/pp/fld/tp markers but substituting cached field values.
  let plain = '';
  for (const n of Array.from(textEl.childNodes)) {
    if (n.nodeType === 3) plain += n.textContent ?? '';
    else if (n.nodeType === 1) {
      const t = (n as Element).tagName;
      if (t === 'fld') {
        // Field value cached in the Field section, keyed by IX.
        plain += fieldLookup(attr(n as Element, 'IX'), shapeEl);
      }
      // cp/pp/tp markers: formatting only, no text
    }
  }

  const style: TextStyle = {};

  const charSec = sectionByName(shapeEl, 'Character');
  if (charSec) {
    const row0 = children(charSec).find((r) => r.tagName === 'Row');
    if (row0) {
      const rc = readCells(row0);
      const size = cnum(rc, 'Size', NaN);
      if (Number.isFinite(size) && size > 0) style.sizePt = size;
      const color = rc.get('Color');
      if (color) style.color = colorVal(color, '#000000');
      const st = cnum(rc, 'Style', 0);
      style.bold = (st & 1) !== 0 ? true : undefined;
      style.italic = (st & 2) !== 0 ? true : undefined;
      style.underline = (st & 4) !== 0 ? true : undefined;
    }
  }
  const paraSec = sectionByName(shapeEl, 'Paragraph');
  if (paraSec) {
    const row0 = children(paraSec).find((r) => r.tagName === 'Row');
    if (row0) {
      const rc = readCells(row0);
      const ha = cnum(rc, 'HorzAlign', 1);
      style.align = ha === 0 ? 'left' : ha === 2 ? 'right' : ha === 3 ? 'justify' : 'center';
    }
  }
  const va = cnum(cells, 'VerticalAlign', 1);
  style.valign = va === 0 ? 'top' : va === 2 ? 'bottom' : 'middle';

  return { plain: plain.trim(), style };
}

function sectionByName(shapeEl: Element, name: string): Element | null {
  for (const sec of children(shapeEl)) {
    if (sec.tagName === 'Section' && attr(sec, 'N') === name) return sec;
  }
  return null;
}

function fieldLookup(ix: string | undefined, shapeEl: Element): string {
  const sec = sectionByName(shapeEl, 'Field');
  if (!sec || ix === undefined) return '';
  for (const row of children(sec)) {
    if (row.tagName === 'Row' && attr(row, 'IX') === ix) {
      const rc = readCells(row);
      return rc.get('Value') ?? '';
    }
  }
  return '';
}

// ---------- masters ----------

interface MasterDef {
  name: string;
  nameU: string;
  part: string; // OPC part path — ForeignData rels resolve against it
  contents: Element | null; // <MasterContents>
}

function readMasters(pkg: OpcPackage): Map<number, MasterDef> {
  const out = new Map<number, MasterDef>();
  // document.xml.rels → masters part
  const docRels = pkg.rels('visio/document.xml');
  const mastersPart = docRels.find((r) => r.type === 'masters')?.target;
  if (!mastersPart || !pkg.has(mastersPart)) return out;

  const doc = parseXml(pkg.text(mastersPart));
  for (const m of childrenOf(doc.documentElement, 'Master')) {
    const id = numAttr(m, 'ID', -1);
    const relEl = child(m, 'Rel');
    let part: string | undefined;
    let contents: Element | null = null;
    if (relEl) {
      part = pkg.relTarget(mastersPart, attr(relEl, 'r:id') ?? '');
      if (part && pkg.has(part)) {
        const mdoc = parseXml(pkg.text(part));
        const root = mdoc.documentElement;
        contents = root.tagName === 'MasterContents' ? root : child(root, 'MasterContents');
      }
    }
    out.set(id, {
      name: attr(m, 'Name') ?? '',
      nameU: attr(m, 'NameU') ?? '',
      part: part ?? '',
      contents,
    });
  }
  return out;
}

// ---------- shape building ----------

interface BuildCtx {
  pkg: OpcPackage;
  masters: Map<number, MasterDef>;
  warnings: string[];
  depth: number;
  /** OPC part whose rels resolve this shape's ForeignData references. */
  part: string;
}

const FOREIGN_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

function toB64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Extracts an embedded bitmap (Type='Foreign') as a data URL, if renderable. */
function readForeign(shapeEl: Element, ctx: BuildCtx): { mime: string; dataUrl: string } | undefined {
  const fd = child(shapeEl, 'ForeignData');
  if (!fd) return undefined;
  const ftype = attr(fd, 'ForeignType') ?? '';
  if (!/bitmap|image/i.test(ftype)) return undefined; // EnhMetafile / WMF: not renderable in browser
  const relEl = child(fd, 'Rel');
  const relId = relEl ? attr(relEl, 'r:id') : undefined;
  if (!relId) return undefined;
  const target = ctx.pkg.relTarget(ctx.part, relId);
  if (!target || !ctx.pkg.has(target)) return undefined;
  const ext = target.toLowerCase().split('.').pop() ?? '';
  const mime = FOREIGN_MIME[ext];
  if (!mime) return undefined;
  return { mime, dataUrl: `data:${mime};base64,${toB64(ctx.pkg.bytes(target))}` };
}

function buildShape(
  el: Element,
  ctx: BuildCtx,
  inheritedCells?: Cells,
  inheritedGeometry?: PathSection[],
): ShapeNode | null {
  if (attr(el, 'Del') === '1') return null;
  const typeAttr = attr(el, 'Type') ?? 'Shape';
  if (ctx.depth > 12) return null;

  const own = readCells(el);
  const masterId = numAttr(el, 'Master', -1);

  // Resolve master inheritance (own cells win over master cells).
  let masterTop: Element | null = null;
  let masterName: string | undefined;
  if (masterId >= 0) {
    const m = ctx.masters.get(masterId);
    if (m) {
      masterName = m.nameU || m.name;
      const mShapes = m.contents ? child(m.contents, 'Shapes') : null;
      if (mShapes) {
        // Prefer the sub-shape addressed by MasterShape, else the single top shape.
        const masterShapeRef = numAttr(el, 'MasterShape', -1);
        const tops = childrenOf(mShapes, 'Shape');
        masterTop =
          (masterShapeRef >= 0 ? tops.find((s) => numAttr(s, 'ID', -1) === masterShapeRef) : undefined) ??
          tops[0] ??
          null;
      }
    } else {
      ctx.warnings.push(`master ${masterId} not found`);
    }
  }

  const masterCells: Cells = masterTop ? readCells(masterTop) : new Map();
  if (inheritedCells) for (const [k, v] of inheritedCells) if (!masterCells.has(k)) masterCells.set(k, v);
  const cells: Cells = new Map(masterCells);
  for (const [k, v] of own) cells.set(k, v);

  const type: ShapeNode['type'] =
    typeAttr === 'Group' ? 'group' : typeAttr === 'Foreign' ? 'foreign' : typeAttr === 'Guide' ? 'guide' : 'shape';

  const width = cnum(cells, 'Width', 1);
  const height = cnum(cells, 'Height', 1);

  const geometry =
    sectionByName(el, 'Geometry') !== null
      ? readGeometry(el, width, height)
      : inheritedGeometry ?? (masterTop ? readGeometry(masterTop, width, height) : []);

  const node: ShapeNode = {
    id: numAttr(el, 'ID', -1),
    name: attr(el, 'Name') ?? attr(el, 'NameU') ?? '',
    type,
    masterName,
    pinX: cnum(cells, 'PinX', width / 2),
    pinY: cnum(cells, 'PinY', height / 2),
    locPinX: cnum(cells, 'LocPinX', width / 2),
    locPinY: cnum(cells, 'LocPinY', height / 2),
    width,
    height,
    angle: cnum(cells, 'Angle', 0),
    flipX: cnum(cells, 'FlipX', 0) === 1,
    flipY: cnum(cells, 'FlipY', 0) === 1,
    paths: type === 'foreign' || type === 'guide' ? [] : geometry,
    fill: null,
    line: null,
    children: [],
    isEdge: cells.has('BeginX') && cells.has('EndX'),
  };

  // Fill / line (Visio defaults: pattern 1 = solid white fill, black line)
  const fillPattern = cnum(cells, 'FillPattern', 1);
  node.fill =
    type === 'foreign'
      ? null
      : fillPattern === 0
        ? null
        : { color: colorVal(cells.get('FillForegnd'), '#FFFFFF') };

  const linePattern = cnum(cells, 'LinePattern', 1);
  node.line =
    linePattern === 0
      ? null
      : {
          color: colorVal(cells.get('LineColor'), '#000000'),
          weightIn: cnum(cells, 'LineWeight', 0.01),
          pattern: linePattern,
        };

  const txt = readText(el, cells);
  if (txt) node.text = txt;

  // Foreign bitmaps: instance's own ForeignData resolves against the page part;
  // inherited ones resolve against the master part.
  if (type === 'foreign') {
    node.foreign = readForeign(el, ctx);
    if (!node.foreign && masterTop && masterId >= 0) {
      const mdef = ctx.masters.get(masterId);
      if (mdef) node.foreign = readForeign(masterTop, { ...ctx, part: mdef.part });
    }
  }

  // Children: instance subshapes win; else adopt the master's subtree.
  // Sub-shapes live under a <Shapes> wrapper inside the parent Shape element.
  const ownShapes = childrenOf(child(el, 'Shapes') ?? el, 'Shape');
  if (ownShapes.length > 0) {
    ctx.depth++;
    for (const s of ownShapes) {
      const n = buildShape(s, ctx);
      if (n) node.children.push(n);
    }
    ctx.depth--;
  } else if (masterTop) {
    // The master top shape's own subtree; sub-shapes live under its Shapes wrapper.
    // The master part's rels own any ForeignData references inside the subtree.
    const masterChildren = childrenOf(child(masterTop, 'Shapes') ?? masterTop, 'Shape');
    const savedPart = ctx.part;
    const mdef = masterId >= 0 ? ctx.masters.get(masterId) : undefined;
    if (mdef) ctx.part = mdef.part;
    ctx.depth++;
    for (const s of masterChildren) {
      const n = buildShape(s, ctx);
      if (n) node.children.push(n);
    }
    ctx.depth--;
    ctx.part = savedPart;
  }

  return node;
}

// ---------- pages ----------

export function buildScene(pkg: OpcPackage): Scene {
  const warnings: string[] = [];
  const masters = readMasters(pkg);

  const docRels = pkg.rels('visio/document.xml');
  const pagesPart = docRels.find((r) => r.type === 'pages')?.target;
  if (!pagesPart || !pkg.has(pagesPart)) throw new Error('No pages part found');

  const pagesDoc = parseXml(pkg.text(pagesPart));
  const pages: PageScene[] = [];

  for (const pageEl of childrenOf(docPages(pagesDoc), 'Page')) {
    const id = numAttr(pageEl, 'ID', -1);
    const relEl = child(pageEl, 'Rel');
    const pagePart = relEl ? pkg.relTarget(pagesPart, attr(relEl, 'r:id') ?? '') : undefined;

    // Page size from PageSheet cells (default letter)
    let width = 8.5;
    let height = 11;
    const sheet = child(pageEl, 'PageSheet');
    if (sheet) {
      const pc = readCells(sheet);
      width = cnum(pc, 'PageWidth', width);
      height = cnum(pc, 'PageHeight', height);
    }

    const scene: PageScene = {
      id,
      name: attr(pageEl, 'Name') ?? `Page-${id + 1}`,
      nameU: attr(pageEl, 'NameU') ?? `Page-${id + 1}`,
      width,
      height,
      shapes: [],
      connects: [],
    };

    if (pagePart && pkg.has(pagePart)) {
      const pdoc = parseXml(pkg.text(pagePart));
      const contents = child(pdoc.documentElement, 'PageContents') ?? pdoc.documentElement;
      const shapesEl = child(contents, 'Shapes');
      const ctx: BuildCtx = { pkg, masters, warnings, depth: 0, part: pagePart };
      if (shapesEl) {
        for (const s of childrenOf(shapesEl, 'Shape')) {
          const n = buildShape(s, ctx);
          if (n) scene.shapes.push(n);
        }
      }
      const connectsEl = child(contents, 'Connects');
      if (connectsEl) {
        for (const c of childrenOf(connectsEl, 'Connect')) {
          scene.connects.push({
            from: numAttr(c, 'FromSheet', -1),
            fromCell: attr(c, 'FromCell') ?? '',
            to: numAttr(c, 'ToSheet', -1),
            toCell: attr(c, 'ToCell') ?? '',
          });
        }
      }
    } else {
      warnings.push(`page ${id} content part missing`);
    }

    pages.push(scene);
  }

  return { pages, warnings };
}

function docPages(doc: Document): Element {
  return doc.documentElement;
}

/**
 * Builds one pseudo-page per master — used for .vssx stencil packs, which have
 * masters but no pages. Each master's shapes are normalized to the page center:
 * stencil masters are authored at arbitrary sheet coordinates.
 */
export function buildMasterScenes(pkg: OpcPackage, limit = 60): Scene {
  const warnings: string[] = [];
  const masters = readMasters(pkg);
  const pages: PageScene[] = [];
  for (const [id, m] of masters) {
    if (pages.length >= limit) break;
    const shapesEl = m.contents ? child(m.contents, 'Shapes') : null;
    if (!shapesEl) continue;
    const ctx: BuildCtx = { pkg, masters, warnings, depth: 0, part: m.part };
    const shapes: ShapeNode[] = [];
    for (const s of childrenOf(shapesEl, 'Shape')) {
      const n = buildShape(s, ctx);
      if (n) shapes.push(n);
    }
    if (shapes.length === 0) continue;

    // Center the master's content: shift top-level pins so the world bbox
    // of the whole tree lands on the page center. Children are positioned
    // relative to their parents, so shifting roots shifts everything.
    const bb = worldBBoxInches(shapes);
    if (bb) {
      const dx = 4.25 - (bb.minX + bb.maxX) / 2;
      const dy = 5.5 - (bb.minY + bb.maxY) / 2;
      for (const s of shapes) {
        s.pinX += dx;
        s.pinY += dy;
      }
    }

    const name = m.nameU || m.name || `Master-${id}`;
    pages.push({ id, name, nameU: name, width: 8.5, height: 11, shapes, connects: [] });
  }
  return { pages, warnings };
}

/** World-space bbox (inches, Y-up) over a shape tree's transformed boxes. */
function worldBBoxInches(
  shapes: ShapeNode[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let bb: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  const expand = (x: number, y: number): void => {
    if (!bb) bb = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      bb.minX = Math.min(bb.minX, x);
      bb.minY = Math.min(bb.minY, y);
      bb.maxX = Math.max(bb.maxX, x);
      bb.maxY = Math.max(bb.maxY, y);
    }
  };
  const walk = (s: ShapeNode, parentM: M2): void => {
    const m = shapeMatrixM(s, parentM);
    for (const [cx, cy] of [
      [0, 0],
      [s.width, 0],
      [s.width, s.height],
      [0, s.height],
    ] as const) {
      const p = applyM(m, { x: cx, y: cy });
      expand(p.x, p.y);
    }
    for (const c of s.children) walk(c, m);
  };
  for (const s of shapes) walk(s, IDENTITY_M);
  return bb;
}

// Local copies of the transform primitives (layout.ts imports this module's
// types, so a value import would create a cycle).
type M2 = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY_M: M2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function composeM(m: M2, n: M2): M2 {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}
function applyM(m: M2, p: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}
function shapeMatrixM(s: ShapeNode, parent: M2): M2 {
  const fx: M2 = s.flipX ? { a: -1, b: 0, c: 0, d: 1, e: s.width, f: 0 } : IDENTITY_M;
  const fy: M2 = s.flipY ? { a: 1, b: 0, c: 0, d: -1, e: 0, f: s.height } : IDENTITY_M;
  const flip = composeM(fx, fy);
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const rot: M2 = { a: cos, b: -sin, c: sin, d: cos, e: 0, f: 0 };
  const tNeg: M2 = { a: 1, b: 0, c: 0, d: 1, e: -s.locPinX, f: -s.locPinY };
  const tPos: M2 = { a: 1, b: 0, c: 0, d: 1, e: s.pinX, f: s.pinY };
  return composeM(parent, composeM(tPos, composeM(rot, composeM(tNeg, flip))));
}
