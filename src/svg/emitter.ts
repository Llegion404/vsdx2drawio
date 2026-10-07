// Emits SVG from the intermediate Scene model — used for the web app preview.
// Same layout pass as the draw.io emitter; visually equivalent output.

import type { PageScene, Scene, ShapeNode } from '../vsdx/model';
import {
  S,
  IDENTITY,
  classify,
  layout,
  apply,
  resolveEdges,
  type GeoKind,
  type LayoutNode,
} from '../layout';

const f2 = (n: number) => String(Math.round(n * 100) / 100);

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SVG transform matrix from a world (Y-up) matrix on a page.
 *  screen = (a·x + c·y + e, −(b·x + d·y) + H − f), all ×S — note −d: the Y flip
 *  must apply to the diagonal too, or unrotated shapes render mirrored. */
function svgMatrix(m: { a: number; b: number; c: number; d: number; e: number; f: number }, page: PageScene): string {
  return `matrix(${m.a} ${-m.b} ${-m.c} ${-m.d} ${f2(m.e * S)} ${f2((page.height - m.f) * S)})`;
}

/** Local geometry path in NATIVE local coords (inches, Y-up) — the g matrix flips Y. */
function localPathD(v: ShapeNode): string {
  const X = (x: number) => f2(x * S);
  const Y = (y: number) => f2(y * S);
  const d: string[] = [];
  for (const sec of v.paths) {
    if (sec.noShow) continue;
    let prev: { x: number; y: number } = { x: 0, y: 0 };
    let started = false;
    for (const r of sec.rows) {
      switch (r.t) {
        case 'MoveTo':
          d.push(`M ${X(r.x)} ${Y(r.y)}`);
          started = true;
          break;
        case 'LineTo':
        case 'SplineStart':
        case 'SplineKnot':
        case 'NURBSTo':
        case 'PolylineTo':
          d.push(`L ${X(r.x)} ${Y(r.y)}`);
          started = true;
          break;
        case 'ArcTo':
          d.push(arcSvg(prev, r, started));
          started = true;
          break;
        case 'EllipticalArcTo':
          d.push(`L ${X(r.x)} ${Y(r.y)}`); // v0 preview: chord
          started = true;
          break;
        case 'CubBezTo':
          d.push(`C ${X(r.a)} ${Y(r.b)} ${X(r.c)} ${Y(r.d)} ${X(r.x)} ${Y(r.y)}`);
          started = true;
          break;
        case 'QuadBezTo':
          d.push(`Q ${X(r.a)} ${Y(r.b)} ${X(r.x)} ${Y(r.y)}`);
          started = true;
          break;
        case 'Ellipse': {
          const rx = Math.abs(r.a - r.x);
          const ry = Math.abs(r.d - r.y);
          const w = f2(2 * rx * S);
          const h = f2(2 * ry * S);
          d.push(
            `M ${X(r.x - rx)} ${Y(r.y + ry)} a ${w} ${h} 0 1 0 0 ${h} a ${w} ${h} 0 1 0 0 -${h}`,
          );
          started = true;
          break;
        }
        default:
          break;
      }
      prev = { x: r.x, y: r.y };
    }
    if (started && !sec.noFill) d.push('Z');
  }
  return d.join(' ');
}

/** Bulge arc -> SVG arc in the local Y-up frame (the g matrix applies the flip).
 *  Bulge is signed: positive = left of travel in Y-up = counterclockwise = sweep 0. */
function arcSvg(
  prev: { x: number; y: number },
  r: { x: number; y: number; a: number },
  started: boolean,
): string {
  const sx = prev.x * S;
  const sy = prev.y * S;
  const ex = r.x * S;
  const ey = r.y * S;
  const dx = ex - sx;
  const dy = ey - sy;
  const chord = Math.hypot(dx, dy);
  if (!started || Math.abs(r.a) < 1e-9 || chord < 1e-9) return `L ${f2(ex)} ${f2(ey)}`;
  const rr = (r.a * r.a + (chord / 2) ** 2) / (2 * Math.abs(r.a));
  const laf = Math.abs(r.a) > chord / 2 ? 1 : 0;
  const sf = r.a > 0 ? 0 : 1;
  return `A ${f2(rr)} ${f2(rr)} 0 ${laf} ${sf} ${f2(ex)} ${f2(ey)}`;
}

class SvgEmitter {
  private parts: string[] = [];
  private edgeMap = new Map<number, LayoutNode>(); // visio edge id -> its layout node
  private glued = new Map<number, { source?: LayoutNode; target?: LayoutNode }>();

  constructor(private page: PageScene) {}

  emit(): string {
    const W = f2(this.page.width * S);
    const H = f2(this.page.height * S);
    this.parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica">`,
    );
    this.parts.push(
      `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000000"/></marker></defs>`,
    );
    this.parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
    const roots: LayoutNode[] = [];
    for (const s of this.page.shapes) {
      const ln = layout(s, IDENTITY, this.page);
      if (ln) {
        roots.push(ln);
        if (ln.node.isEdge) this.edgeMap.set(ln.node.id, ln);
      }
    }
    for (const e of resolveEdges(this.page, roots)) {
      this.glued.set(e.edge.node.id, { source: e.source, target: e.target });
    }
    const emitWalk = (ln: LayoutNode): void => {
      this.emitLayout(ln);
      for (const c of ln.children) emitWalk(c);
    };
    for (const ln of roots) emitWalk(ln);
    this.parts.push('</svg>');
    return this.parts.join('\n');
  }

  private emitLayout(ln: LayoutNode): void {
    const v = ln.node;
    if (v.type === 'guide') return;

    // Foreign bitmaps: absolute-positioned <image> (content needs no local transform).
    if (v.type === 'foreign' && v.foreign) {
      const cx = ln.rect.x + ln.rect.w / 2;
      const cy = ln.rect.y + ln.rect.h / 2;
      const rot =
        ln.rotation !== 0 ? ` transform="rotate(${ln.rotation} ${f2(cx)} ${f2(cy)})"` : '';
      this.parts.push(
        `<image x="${f2(ln.rect.x)}" y="${f2(ln.rect.y)}" width="${f2(ln.rect.w)}" height="${f2(
          ln.rect.h,
        )}" preserveAspectRatio="none" href="${v.foreign.dataUrl}"${rot}/>`,
      );
      return;
    }
    if (v.type === 'foreign') return;

    if (v.isEdge && ln.children.length === 0) {
      const glue = this.glued.get(v.id) ?? {};
      // Center-to-center between glued shapes (the connector's cached endpoints
      // are stale whenever the shapes moved after gluing).
      const pt = (n?: LayoutNode, fallback: { x: number; y: number } = { x: 0, y: 0 }) =>
        n ? { x: n.rect.x + n.rect.w / 2, y: n.rect.y + n.rect.h / 2 } : fallback;
      const beginS = apply(ln.m, { x: 0, y: 0 });
      const endS = apply(ln.m, { x: v.width, y: 0 });
      const from = pt(glue.source, { x: beginS.x * S, y: (this.page.height - beginS.y) * S });
      const to = pt(glue.target, { x: endS.x * S, y: (this.page.height - endS.y) * S });
      this.parts.push(
        `<line x1="${f2(from.x)}" y1="${f2(from.y)}" x2="${f2(to.x)}" y2="${f2(to.y)}" stroke="${
          v.line?.color ?? '#000000'
        }" stroke-width="1" marker-end="url(#arrow)"/>`,
      );
      return;
    }

    const g: string[] = [];
    g.push(`<g transform="${svgMatrix(ln.m, this.page)}">`);

    const kind: GeoKind = classify(v);
    const fill = v.fill ? v.fill.color : 'none';
    const stroke = v.line ? v.line.color : 'none';
    const sw = Math.max(1, Math.round((v.line?.weightIn ?? 0.01) * S));
    const dash = v.line && v.line.pattern > 1 ? ' stroke-dasharray="4 3"' : '';

    if (kind === 'rect') {
      g.push(`<rect x="0" y="0" width="${f2(v.width * S)}" height="${f2(v.height * S)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);
    } else if (kind === 'ellipse') {
      g.push(`<ellipse cx="${f2((v.width / 2) * S)}" cy="${f2((v.height / 2) * S)}" rx="${f2((v.width / 2) * S)}" ry="${f2((v.height / 2) * S)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);
    } else {
      const dstr = localPathD(v);
      if (dstr) g.push(`<path d="${dstr}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" fill-rule="evenodd"${dash}/>`);
    }

    if (v.text?.plain) {
      // Labels are emitted in absolute screen space (outside the flipped g) so
      // glyph rendering stays upright; rotation re-applied around the bbox center.
      const t = v.text;
      const cx = ln.rect.x + ln.rect.w / 2;
      const cy = ln.rect.y + ln.rect.h / 2;
      const anchor = t.style.align === 'left' ? 'start' : t.style.align === 'right' ? 'end' : 'middle';
      const ox = t.style.align === 'left' ? 4 : t.style.align === 'right' ? ln.rect.w - 4 : 0;
      const oy = t.style.valign === 'top' ? 12 : t.style.valign === 'bottom' ? -6 : 4;
      const rot =
        ln.rotation !== 0 ? ` transform="rotate(${ln.rotation} ${f2(cx)} ${f2(cy)})"` : '';
      const style = `font-size="${Math.round(t.style.sizePt ?? 12)}" fill="${t.style.color ?? '#000000'}" text-anchor="${anchor}"`;
      const weight = t.style.bold ? ' font-weight="bold"' : '';
      const italic = t.style.italic ? ' font-style="italic"' : '';
      this.parts.push(
        `<text x="${f2(cx + ox)}" y="${f2(cy + oy)}" ${style}${weight}${italic}${rot}>${esc(t.plain)}</text>`,
      );
    }

    g.push('</g>');
    this.parts.push(g.join('\n'));
    // Children are visited by emitWalk — no recursion here.
  }
}

export function emitSvg(page: PageScene): string {
  return new SvgEmitter(page).emit();
}

export function emitSvgMulti(scene: Scene): string {
  return scene.pages.map((p) => emitSvg(p)).join('\n');
}

// keep ShapeNode import used for types
export type { ShapeNode };
