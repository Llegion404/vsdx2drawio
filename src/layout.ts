// Shared world-transform + layout pass used by both the draw.io and SVG emitters.
// Visio frame: inches, Y-up. Screen frame: units (100/in), Y-down.

import type { PageScene, ShapeNode } from './vsdx/model';

export const S = 100; // units per inch

export interface Pt {
  x: number;
  y: number;
}

/** Affine world transform in Y-up inches: world = M * local. */
export interface M {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function compose(m: M, n: M): M {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function apply(m: M, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function shapeMatrix(s: ShapeNode, parent: M): M {
  // Flip mirrors the local coordinate system: x -> W - x, y -> H - y.
  const fx: M = s.flipX ? { a: -1, b: 0, c: 0, d: 1, e: s.width, f: 0 } : IDENTITY;
  const fy: M = s.flipY ? { a: 1, b: 0, c: 0, d: -1, e: 0, f: s.height } : IDENTITY;
  const flip = compose(fx, fy);
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  // Screen-clockwise rotation in a Y-up frame:
  //   x' = cos*dx + sin*dy ; y' = -sin*dx + cos*dy
  const rot: M = { a: cos, b: -sin, c: sin, d: cos, e: 0, f: 0 };
  // Full chain: world = T(pin) . R . T(-locPin) . F . local
  // (rotation is about the pin, so the pin shift must be applied last — a single
  // pre-computed (pin - locPin) shift is only correct when Angle = 0)
  const tNeg: M = { a: 1, b: 0, c: 0, d: 1, e: -s.locPinX, f: -s.locPinY };
  const tPos: M = { a: 1, b: 0, c: 0, d: 1, e: s.pinX, f: s.pinY };
  return compose(parent, compose(tPos, compose(rot, compose(tNeg, flip))));
}

/** World rotation in radians (screen-clockwise), valid for pure rotations. */
export function worldAngle(m: M): number {
  return Math.atan2(-m.b, m.a);
}

export function toScreen(p: Pt, page: PageScene): Pt {
  return { x: p.x * S, y: (page.height - p.y) * S };
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutNode {
  node: ShapeNode;
  m: M;
  rect: ScreenRect;
  /** Net rotation in degrees (screen-clockwise), independent of flips. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  children: LayoutNode[];
  /** World-frame begin/end points for 1D shapes. */
  begin?: Pt;
  end?: Pt;
}

export function layout(
  node: ShapeNode,
  parentM: M,
  page: PageScene,
  depth = 0,
  parentRot = 0,
  parentSx = 1,
  parentSy = 1,
): LayoutNode | null {
  if (node.type === 'guide' || depth > 20) return null;
  const m = shapeMatrix(node, parentM);
  const center = apply(m, { x: node.width / 2, y: node.height / 2 });
  const sc = toScreen(center, page);
  const w = node.width * S;
  const h = node.height * S;
  // Canonical form: M = R(netRot) . diag(sx, sy). Rotations compose additively,
  // but a parent reflection conjugates the child's rotation to its opposite:
  //   diag(sxp,syp) . R(t) = R(t . sxp/syp) . diag(sxp,syp)   (sx,sy = +-1)
  // Never extract rotation from the composed matrix — a reflection flips atan2 by pi.
  const sxi = node.flipX ? -1 : 1;
  const syi = node.flipY ? -1 : 1;
  const rot = parentRot + (parentSx === parentSy ? node.angle : -node.angle);
  const sx = parentSx * sxi;
  const sy = parentSy * syi;
  const ln: LayoutNode = {
    node,
    m,
    rect: { x: sc.x - w / 2, y: sc.y - h / 2, w, h },
    rotation: Math.round(((rot * 180) / Math.PI) % 360),
    flipH: sx === -1,
    flipV: sy === -1,
    children: [],
  };
  if (node.isEdge) {
    ln.begin = apply(m, { x: 0, y: 0 });
    ln.end = apply(m, { x: node.width, y: 0 });
  }
  for (const c of node.children) {
    const cl = layout(c, m, page, depth + 1, rot, sx, sy);
    if (cl) ln.children.push(cl);
  }
  return ln;
}

export function unionRect(rects: ScreenRect[]): ScreenRect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
  return { x, y, w, h };
}

// ---------- glue resolution ----------

export interface ResolvedEdge {
  edge: LayoutNode;
  source?: LayoutNode;
  target?: LayoutNode;
}

/**
 * Resolves page-level Connects (glue) into source/target LayoutNodes.
 * Glued connectors have stale cached BeginX/EndX — the glue is the truth.
 */
export function resolveEdges(page: PageScene, roots: LayoutNode[]): ResolvedEdge[] {
  const byVisioId = new Map<number, LayoutNode>();
  const walk = (ln: LayoutNode): void => {
    byVisioId.set(ln.node.id, ln);
    for (const c of ln.children) walk(c);
  };
  for (const r of roots) walk(r);

  const map = new Map<number, ResolvedEdge>();
  for (const conn of page.connects) {
    if (conn.fromCell !== 'BeginX' && conn.fromCell !== 'EndX') continue;
    const edge = byVisioId.get(conn.from);
    const target = byVisioId.get(conn.to);
    if (!edge || !target) continue;
    let e = map.get(conn.from);
    if (!e) {
      e = { edge };
      map.set(conn.from, e);
    }
    if (conn.fromCell === 'BeginX') e.source = target;
    else e.target = target;
  }
  return [...map.values()];
}

// ---------- geometry classification ----------

export type GeoKind = 'rect' | 'ellipse' | 'other';

export function classify(v: ShapeNode): GeoKind {
  if (v.paths.length !== 1) return 'other';
  const rows = v.paths[0].rows;
  if (rows.length === 0) return 'other';
  if (rows.length === 1 && rows[0].t === 'Ellipse') {
    const r = rows[0];
    // Only use the primitive when the ellipse fills the shape box exactly.
    const rx = Math.abs(r.a - r.x);
    const ry = Math.abs(r.d - r.y);
    const tol = 0.02;
    if (Math.abs(2 * rx - v.width) < tol && Math.abs(2 * ry - v.height) < tol) return 'ellipse';
    return 'other';
  }
  if (rows.length >= 4 && rows.length <= 5 && rows[0].t === 'MoveTo') {
    const rest = rows.slice(1);
    if (rest.every((r) => r.t === 'LineTo')) {
      const tol = 0.02;
      const corners: Pt[] = [
        { x: 0, y: 0 },
        { x: v.width, y: 0 },
        { x: v.width, y: v.height },
        { x: 0, y: v.height },
      ];
      const startIdx = corners.findIndex(
        (c) => Math.abs(c.x - rows[0].x) < tol && Math.abs(c.y - rows[0].y) < tol,
      );
      if (startIdx < 0) return 'other';
      for (let i = 0; i < rest.length; i++) {
        const c = corners[(startIdx + 1 + i) % 4];
        if (Math.abs(c.x - rest[i].x) > tol || Math.abs(c.y - rest[i].y) > tol) return 'other';
      }
      return 'rect';
    }
  }
  return 'other';
}
