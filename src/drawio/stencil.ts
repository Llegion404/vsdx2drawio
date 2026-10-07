// Converts Visio geometry rows into draw.io inline stencils:
//   shape=stencil(<base64(raw-deflate(mxStencil XML))>)
// This is draw.io's own custom-shape mechanism (EditorUi.defaultCustomShapeStyle),
// so converted shapes stay vector AND editable ("Edit Shape" in draw.io).

import { deflateSync, strToU8 } from 'fflate';
import type { GeoRow, PathSection, ShapeNode } from '../vsdx/model';

const S = 100; // stencil units per inch (matches emitter scale)

function b64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function encodeStencil(xml: string): string {
  // fflate supports raw-deflate at runtime but its type defs omit `raw`.
  const opts = { level: 9, raw: true } as unknown as Parameters<typeof deflateSync>[1];
  return b64(deflateSync(strToU8(xml), opts));
}

interface Pt {
  x: number;
  y: number;
}

const f2 = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Converts geometry sections to mxStencil XML.
 * Local Visio space: inches, Y-up, box [0..w]x[0..h] -> stencil units, Y-down.
 */
export function rowsToStencilXml(sections: PathSection[], w: number, h: number): string {
  const X = (x: number) => f2(x * S);
  const Y = (y: number) => f2((h - y) * S);
  const body: string[] = [];

  for (const sec of sections) {
    if (sec.noShow || sec.rows.length === 0) continue;
    const cmds: string[] = [];
    let cur: Pt | null = null;

    const ensureStart = () => {
      if (!cur) {
        cmds.push(`<move x="${X(0)}" y="${Y(0)}"/>`);
        cur = { x: 0, y: 0 };
      }
    };

    for (const r of sec.rows) {
      const p: Pt = { x: r.x, y: r.y };
      switch (r.t) {
        case 'MoveTo':
          cmds.push(`<move x="${X(p.x)}" y="${Y(p.y)}"/>`);
          cur = p;
          break;
        case 'LineTo':
          ensureStart();
          cmds.push(`<line x="${X(p.x)}" y="${Y(p.y)}"/>`);
          cur = p;
          break;
        case 'PolylineTo':
          ensureStart();
          // The remaining points live in the Polyline cell formula; endpoint only for now.
          cmds.push(`<line x="${X(p.x)}" y="${Y(p.y)}"/>`);
          cur = p;
          break;
        case 'ArcTo':
          ensureStart();
          cmds.push(arcFromBulge(cur!, p, r.a, h));
          cur = p;
          break;
        case 'EllipticalArcTo':
          ensureStart();
          cmds.push(ellipticalArc(cur!, p, r, h));
          cur = p;
          break;
        case 'CubBezTo':
          ensureStart();
          cmds.push(
            `<curve x1="${X(r.a)}" y1="${Y(r.b)}" x2="${X(r.c)}" y2="${Y(r.d)}" x3="${X(p.x)}" y3="${Y(p.y)}"/>`,
          );
          cur = p;
          break;
        case 'QuadBezTo': {
          ensureStart();
          // Quadratic -> cubic control points (2/3 rule).
          const c1x = cur!.x + (2 / 3) * (r.a - cur!.x);
          const c1y = cur!.y + (2 / 3) * (r.b - cur!.y);
          const c2x = p.x + (2 / 3) * (r.a - p.x);
          const c2y = p.y + (2 / 3) * (r.b - p.y);
          cmds.push(
            `<curve x1="${X(c1x)}" y1="${Y(c1y)}" x2="${X(c2x)}" y2="${Y(c2y)}" x3="${X(p.x)}" y3="${Y(p.y)}"/>`,
          );
          cur = p;
          break;
        }
        case 'SplineStart':
        case 'SplineKnot':
          ensureStart();
          cmds.push(`<line x="${X(p.x)}" y="${Y(p.y)}"/>`); // v0: polyline through knots
          cur = p;
          break;
        case 'NURBSTo':
          ensureStart();
          cmds.push(`<line x="${X(p.x)}" y="${Y(p.y)}"/>`); // v0: chord approximation
          cur = p;
          break;
        case 'Ellipse': {
          // Standalone ellipse: center (x,y); points (a,b),(c,d) on the ellipse.
          const rx = Math.abs(r.a - r.x);
          const ry = Math.abs(r.d - r.y);
          cmds.push(`<ellipse x="${X(r.x - rx)}" y="${Y(r.y + ry)}" w="${X(2 * rx)}" h="${X(2 * ry)}"/>`);
          cur = p;
          break;
        }
        case 'InfiniteLine':
          // Unbounded line — not representable; skip.
          break;
        default:
          break;
      }
    }

    if (cmds.length === 0) continue;
    const paint = sec.noFill ? '<stroke/>' : sec.noLine ? '<fill/>' : '<fillstroke/>';
    body.push(`<foreground><path>${cmds.join('')}</path>${paint}</foreground>`);
  }

  return `<shape h="${f2(h * S)}" w="${f2(w * S)}" aspect="variable" strokewidth="inherit">${body.join(
    '',
  )}</shape>`;
}

/**
 * Visio ArcTo (endpoint + signed bulge) -> SVG-style circular arc in screen space.
 * Bulge: signed distance of arc midpoint from chord midpoint; positive bends to the
 * left of travel in Y-up (verified against synthetic ground-truth files).
 */
function arcFromBulge(start: Pt, end: Pt, bulge: number, h: number): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (Math.abs(bulge) < 1e-9 || chord < 1e-9) return `<line x="${f2(end.x * S)}" y="${f2((h - end.y) * S)}"/>`;

  // Arc midpoint in Y-up: chord midpoint + perpendicular (left of travel) * bulge.
  const mid: Pt = {
    x: (start.x + end.x) / 2 - (dy / chord) * bulge,
    y: (start.y + end.y) / 2 + (dx / chord) * bulge,
  };

  // Circle through start, mid, end in SCREEN space (y-down).
  const sy = (p: Pt) => ({ x: p.x * S, y: (h - p.y) * S });
  const a = sy(start);
  const m = sy(mid);
  const b = sy(end);
  const det = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(det) < 1e-9) return `<line x="${f2(end.x * S)}" y="${f2((h - end.y) * S)}"/>`;
  const sq = (p: Pt) => p.x * p.x + p.y * p.y;
  const ux =
    (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / det;
  const uy =
    (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / det;
  const r = Math.hypot(a.x - ux, a.y - uy);

  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = norm(Math.atan2(a.y - uy, a.x - ux));
  const a1 = norm(Math.atan2(b.y - uy, b.x - ux));
  const am = norm(Math.atan2(m.y - uy, m.x - ux));
  const spanCW = norm(a1 - a0);
  const midCW = norm(am - a0);
  let laf: number;
  let sf: number;
  if (midCW <= spanCW) {
    sf = 1; // increasing screen angle = clockwise on screen = SVG sweep 1
    laf = spanCW > Math.PI ? 1 : 0;
  } else {
    sf = 0;
    laf = 2 * Math.PI - spanCW > Math.PI ? 1 : 0;
  }
  return `<arc rx="${f2(r)}" ry="${f2(r)}" x-axis-rotation="0" large-arc-flag="${laf}" sweep-flag="${sf}" x="${f2(
    b.x,
  )}" y="${f2(b.y)}"/>`;
}

/**
 * Visio EllipticalArcTo -> SVG-style elliptical arc.
 * Row cells: X,Y endpoint; A major-axis angle; B minor/major ratio; C start param; D end param.
 * Derivation: start=P0, end=P1 lie on the ellipse centered at Cc:
 *   P0 = Cc + rx cos(C) u + ry sin(C) v ; P1 = Cc + rx cos(D) u + ry sin(D) v
 * with u=(cos A, sin A), v=(-sin A, cos A), ry = B*rx.
 * Subtracting gives rx = |P1-P0| / |(cosC-cosD)u + B(sinC-sinD)v|.
 */
function ellipticalArc(start: Pt, end: Pt, r: GeoRow, h: number): string {
  const phi = r.a;
  const k = r.b;
  const c = r.c;
  const d = r.d;
  const ux = Math.cos(phi);
  const uy = Math.sin(phi);
  const vx = -Math.sin(phi);
  const vy = Math.cos(phi);

  const dc = Math.cos(c) - Math.cos(d);
  const ds = Math.sin(c) - Math.sin(d);
  const wpx = dc * ux + k * ds * vx;
  const wpy = dc * uy + k * ds * vy;
  const wlen = Math.hypot(wpx, wpy);
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  const line = `<line x="${f2(end.x * S)}" y="${f2((h - end.y) * S)}"/>`;
  if (wlen < 1e-9 || !Number.isFinite(wlen)) return line;

  const rx = chord / wlen;
  const ry = k * rx;
  if (!Number.isFinite(rx) || rx < 1e-9) return line;

  const span = d - c;
  const laf = Math.abs(span) > Math.PI ? 1 : 0;
  // Y-flip negates angles: screen-space axis rotation = -phi; sweep direction flips.
  const sf = span > 0 ? 0 : 1;
  const rotDeg = f2((-phi * 180) / Math.PI);
  return `<arc rx="${f2(rx * S)}" ry="${f2(ry * S)}" x-axis-rotation="${rotDeg}" large-arc-flag="${laf}" sweep-flag="${sf}" x="${f2(
    end.x * S,
  )}" y="${f2((h - end.y) * S)}"/>`;
}

// ---------- public entry ----------

export function stencilStyleFragment(v: ShapeNode): string | null {
  if (v.paths.length === 0) return null;
  const xml = rowsToStencilXml(v.paths, v.width, v.height);
  if (!xml.includes('<path') && !xml.includes('<ellipse')) return null;
  return `shape=stencil(${encodeStencil(xml)})`;
}
