// Emits draw.io (mxGraphModel) XML from the intermediate Scene model.
//
// Conventions:
//  - draw.io units: 100 per inch (their letter page is 850x1100 for 8.5x11in).
//  - draw.io Y axis points DOWN; Visio Y points UP (see src/layout.ts).
//  - draw.io `rotation` is clockwise-positive degrees, same as the screen-space
//    rotation produced by the shared layout pass.
//  - A rotated vertex is placed at worldCenter - (w/2, h/2): draw.io rotates
//    about the vertex center, Visio rotates about the pin; the world center of
//    the rotated rect is invariant under the rotation, so the two coincide.

import type { PageScene, Scene, ShapeNode } from '../vsdx/model';
import {
  S,
  IDENTITY,
  classify,
  layout,
  type GeoKind,
  type LayoutNode,
  type ScreenRect,
} from '../layout';
import { stencilStyleFragment } from './stencil';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function f2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ---------- styles ----------

function vertexStyle(v: ShapeNode, kind: GeoKind): string {
  const parts: string[] = [];
  if (kind === 'other') {
    // Arbitrary Visio geometry -> draw.io inline stencil (vector + editable).
    const stencil = stencilStyleFragment(v);
    parts.push(stencil ?? 'rounded=0');
  } else {
    parts.push(kind === 'ellipse' ? 'ellipse' : 'rounded=0');
  }
  parts.push(v.fill ? `fillColor=${v.fill.color}` : 'fillColor=none');
  if (v.line) {
    parts.push(`strokeColor=${v.line.color}`);
    parts.push(`strokeWidth=${Math.max(1, Math.round(v.line.weightIn * S))}`);
    if (v.line.pattern > 1) parts.push('dashed=1');
  } else {
    parts.push('strokeColor=none');
  }
  const t = v.text;
  if (t) {
    if (t.style.sizePt) parts.push(`fontSize=${Math.round(t.style.sizePt)}`);
    if (t.style.color) parts.push(`fontColor=${t.style.color}`);
    let fontStyle = 0;
    if (t.style.bold) fontStyle |= 1;
    if (t.style.italic) fontStyle |= 2;
    if (t.style.underline) fontStyle |= 4;
    if (fontStyle) parts.push(`fontStyle=${fontStyle}`);
    if (t.style.align) parts.push(`align=${t.style.align}`);
    if (t.style.valign) parts.push(`verticalAlign=${t.style.valign}`);
  }
  parts.push('whiteSpace=wrap');
  return parts.join(';') + ';';
}

// ---------- emission ----------

class PageEmitter {
  private lines: string[] = [];
  private idSeq = 2; // 0 and 1 are reserved by mxGraph (root cells)
  private idMap = new Map<number, string>(); // visio id -> drawio id
  private edgeLayouts: { id: string; ln: LayoutNode }[] = [];
  stats = { vertex: 0, group: 0, edge: 0, stencil: 0, foreign: 0, skipped: 0 };

  constructor(private page: PageScene) {}

  emit(): string {
    this.lines.push(
      `<mxGraphModel dx="800" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.round(
        this.page.width * S,
      )}" pageHeight="${Math.round(this.page.height * S)}" math="0" shadow="0">`,
    );
    this.lines.push('  <root>');
    this.lines.push('    <mxCell id="0"/>');
    this.lines.push('    <mxCell id="1" parent="0"/>');
    for (const s of this.page.shapes) {
      const ln = layout(s, IDENTITY, this.page);
      if (ln) this.emitLayout(ln, '1', { x: 0, y: 0 });
    }
    this.emitEdgeCells();
    this.lines.push('  </root>');
    this.lines.push('</mxGraphModel>');
    return this.lines.join('\n');
  }

  private registerId(v: ShapeNode): string {
    const id = String(this.idSeq++);
    this.idMap.set(v.id, id);
    return id;
  }

  private emitLayout(ln: LayoutNode, parentId: string, parentOrigin: { x: number; y: number }): void {
    const v = ln.node;

    if (v.type === 'guide') return;

    // Foreign bitmaps with renderable data -> draw.io image shape.
    if (v.type === 'foreign' && v.foreign) {
      const id = this.registerId(v);
      // draw.io image style: standard data URL works; aspect fixed to the shape box.
      const style = `shape=image;image=${v.foreign.dataUrl};aspect=fixed;`;
      const rotation = ((ln.rotation % 360) + 360) % 360;
      const styleStr = rotation !== 0 ? style + `rotation=${rotation};` : style;
      this.lines.push(
        `    <mxCell id="${id}" value="" style="${styleStr}" vertex="1" parent="${parentId}">`,
      );
      this.lines.push(
        `      <mxGeometry x="${f2(ln.rect.x - parentOrigin.x)}" y="${f2(ln.rect.y - parentOrigin.y)}" width="${f2(
          ln.rect.w,
        )}" height="${f2(ln.rect.h)}" as="geometry"/>`,
      );
      this.lines.push('    </mxCell>');
      this.stats.foreign++;
      return;
    }

    if (v.type === 'foreign') {
      this.stats.skipped++;
      return;
    }

    // 1D connector: register id, emit later as an edge.
    if (v.isEdge && ln.children.length === 0) {
      const id = this.registerId(v);
      this.edgeLayouts.push({ id, ln });
      this.stats.edge++;
      return;
    }

    const id = this.registerId(v);

    if (ln.children.length > 0) {
      // Group: children keep their absolute rotation; coordinates relative to group bbox.
      const bbox = this.childBBox(ln);
      this.lines.push(
        `    <mxCell id="${id}" value="" style="group" vertex="1" connectable="0" parent="${parentId}">`,
      );
      this.lines.push(
        `      <mxGeometry x="${f2(bbox.x - parentOrigin.x)}" y="${f2(bbox.y - parentOrigin.y)}" width="${f2(
          bbox.w,
        )}" height="${f2(bbox.h)}" as="geometry"/>`,
      );
      this.lines.push('    </mxCell>');
      this.stats.group++;
      for (const c of ln.children) {
        this.emitLayout(c, id, { x: bbox.x, y: bbox.y });
      }
      return;
    }

    const kind = classify(v);
    if (kind === 'other' && stencilStyleFragment(v)) this.stats.stencil++;
    const rotation = ((ln.rotation % 360) + 360) % 360;
    let styleStr = vertexStyle(v, kind);
    if (rotation !== 0) styleStr += `rotation=${rotation};`;
    if (ln.flipH) styleStr += 'flipH=1;';
    if (ln.flipV) styleStr += 'flipV=1;';
    this.lines.push(
      `    <mxCell id="${id}" value="${esc(v.text?.plain ?? '')}" style="${styleStr}" vertex="1" parent="${parentId}">`,
    );
    this.lines.push(
      `      <mxGeometry x="${f2(ln.rect.x - parentOrigin.x)}" y="${f2(ln.rect.y - parentOrigin.y)}" width="${f2(
        ln.rect.w,
      )}" height="${f2(ln.rect.h)}" as="geometry"/>`,
    );
    this.lines.push('    </mxCell>');
    this.stats.vertex++;
  }

  /** Bbox over a group's emitted children (those that become vertices). */
  private childBBox(ln: LayoutNode): { x: number; y: number; w: number; h: number } {
    const rects: ScreenRect[] = [];
    const collect = (n: LayoutNode): void => {
      if (n.node.type === 'foreign') return;
      if (n.node.isEdge && n.children.length === 0) return;
      rects.push(n.rect);
      for (const c of n.children) collect(c);
    };
    for (const c of ln.children) collect(c);
    if (rects.length === 0) return ln.rect;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((r) => r.x + r.w)) - x,
      h: Math.max(...rects.map((r) => r.y + r.h)) - y,
    };
  }

  private emitEdgeCells(): void {
    const byEdge = new Map<string, { ln: LayoutNode; source?: string; target?: string }>();
    for (const e of this.edgeLayouts) byEdge.set(e.id, { ln: e.ln });
    for (const conn of this.page.connects) {
      const edgeId = this.idMap.get(conn.from);
      if (!edgeId || !byEdge.has(edgeId)) continue;
      const targetId = this.idMap.get(conn.to);
      if (!targetId) continue;
      const cell = byEdge.get(edgeId)!;
      if (conn.fromCell === 'BeginX') cell.source = targetId;
      else if (conn.fromCell === 'EndX') cell.target = targetId;
    }
    for (const [id, { ln, source, target }] of byEdge) {
      const srcAttr = source ? ` source="${source}"` : '';
      const tgtAttr = target ? ` target="${target}"` : '';
      const begin = ln.begin ?? { x: 0, y: 0 };
      const end = ln.end ?? { x: 0, y: 0 };
      const points =
        source && target
          ? ''
          : `<mxPoint x="${f2(begin.x * S)}" y="${f2((this.page.height - begin.y) * S)}" as="sourcePoint"/><mxPoint x="${f2(
              end.x * S,
            )}" y="${f2((this.page.height - end.y) * S)}" as="targetPoint"/>`;
      const label = ln.node.text?.plain ?? '';
      this.lines.push(
        `    <mxCell id="${id}" value="${esc(label)}" style="endArrow=classic;html=1;rounded=0;"${srcAttr}${tgtAttr} edge="1" parent="1">`,
      );
      this.lines.push(`      <mxGeometry relative="1" as="geometry">${points}</mxGeometry>`);
      this.lines.push('    </mxCell>');
    }
  }
}

export interface DrawioStats {
  vertex: number;
  group: number;
  edge: number;
  stencil: number;
  foreign: number;
  skipped: number;
}

export interface DrawioResult {
  xml: string;
  stats: DrawioStats[];
}

export function emitDrawio(scene: Scene): DrawioResult {
  const parts: string[] = ['<mxfile host="vsdx2drawio">'];
  const stats: DrawioStats[] = [];
  for (const page of scene.pages) {
    const em = new PageEmitter(page);
    const xml = em.emit();
    parts.push(`  <diagram name="${esc(page.name)}" id="p${page.id}">`);
    parts.push(indent(xml, '    '));
    parts.push('  </diagram>');
    stats.push(em.stats);
  }
  parts.push('</mxfile>');
  return { xml: parts.join('\n'), stats };
}

function indent(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
