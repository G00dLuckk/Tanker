import type { PlanPoint } from './types';

/**
 * Plan polygons (mm): area, orientation, point tests, offsets and a triangulation.
 * Everything here works on any simple polygon, convex or not, so a concrete
 * storage can be any outline the drawing shows (L-shape, cut corners, …).
 */

export type Pt = PlanPoint;

/** Signed area by the shoelace formula: positive for a counter-clockwise outline. */
export function signedArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function area(p: Pt[]): number {
  return Math.abs(signedArea(p));
}

export function perimeter(p: Pt[]): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) s += Math.hypot(p[(i + 1) % n].x - p[i].x, p[(i + 1) % n].y - p[i].y);
  return s;
}

export function bbox(p: Pt[]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const q of p) {
    if (q.x < x0) x0 = q.x;
    if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, x1, y0, y1 };
}

/** Centroid of the area (not of the vertices). */
export function centroid(p: Pt[]): Pt {
  const A = signedArea(p);
  if (Math.abs(A) < 1e-12) {
    const n = p.length || 1;
    return { x: p.reduce((s, q) => s + q.x, 0) / n, y: p.reduce((s, q) => s + q.y, 0) / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const k = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * k;
    cy += (a.y + b.y) * k;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

/**
 * Indices of the vertices that make the outline, counter-clockwise, with repeated and
 * collinear points left out (points closer than `tol` to the previous one are dropped).
 * Values given per vertex (floor heights) follow the same indices.
 */
export function cleanIndices(p: Pt[], tol = 0.01, keepCollinear = false): number[] {
  const out: number[] = [];
  const at = (i: number) => p[out[i]];
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
    const last = out.length ? at(out.length - 1) : null;
    if (last && Math.hypot(q.x - last.x, q.y - last.y) <= tol) continue;
    out.push(i);
  }
  while (out.length > 1 && Math.hypot(at(0).x - at(out.length - 1).x, at(0).y - at(out.length - 1).y) <= tol) out.pop();
  for (let i = out.length - 1; i >= 0 && out.length > 3 && !keepCollinear; i--) {
    const a = at((i + out.length - 1) % out.length);
    const b = at(i);
    const c = at((i + 1) % out.length);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    if (len > 0 && Math.abs(cross) / len <= tol) out.splice(i, 1);
  }
  if (signedArea(out.map((i) => p[i])) < 0) out.reverse();
  return out;
}

/** The outline with repeated and collinear points removed, counter-clockwise. */
export function clean(p: Pt[], tol = 0.01): Pt[] {
  return cleanIndices(p, tol).map((i) => ({ x: p[i].x, y: p[i].y }));
}

/** Point inside the polygon (ray casting; points on the edge count as inside). */
export function contains(p: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i].x;
    const yi = p[i].y;
    const xj = p[j].x;
    const yj = p[j].y;
    // On the edge.
    const dx = xj - xi;
    const dy = yj - yi;
    const l2 = dx * dx + dy * dy;
    if (l2 > 0) {
      const t = ((x - xi) * dx + (y - yi) * dy) / l2;
      if (t >= 0 && t <= 1) {
        const ex = xi + t * dx - x;
        const ey = yi + t * dy - y;
        if (ex * ex + ey * ey <= 1e-12 * Math.max(1, l2)) return true;
      }
    }
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest point of the outline to (x, y): its distance, position, edge index and position along that edge (0–1). */
export function nearestOnOutline(p: Pt[], x: number, y: number): { d: number; x: number; y: number; edge: number; t: number } {
  let best = { d: Infinity, x, y, edge: 0, t: 0 };
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, x: px, y: py, edge: i, t };
  }
  return best;
}

/** Signed distance to the outline: negative inside, positive outside. */
export function signedDistance(p: Pt[], x: number, y: number): number {
  const d = nearestOnOutline(p, x, y).d;
  return contains(p, x, y) ? -d : d;
}

/** True when two non-adjacent edges cross (the outline is not a simple polygon). */
export function selfIntersects(p: Pt[]): boolean {
  const n = p.length;
  if (n < 4) return false;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const crosses = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Triangulation by ear clipping: index triples into `p` (counter-clockwise outline).
 * Works for any simple polygon; the floor of a storage is interpolated over it.
 */
export function triangulate(p: Pt[]): number[] {
  const n = p.length;
  if (n < 3) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  if (signedArea(p) < 0) idx.reverse();
  const out: number[] = [];
  const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (a: Pt, b: Pt, c: Pt, q: Pt) => cross(a, b, q) >= -1e-9 && cross(b, c, q) >= -1e-9 && cross(c, a, q) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = p[i0];
      const b = p[i1];
      const c = p[i2];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or flat corner
      let ear = true;
      for (const k of idx) {
        if (k === i0 || k === i1 || k === i2) continue;
        if (inTri(a, b, c, p[k])) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate outline: leave the rest as a fan
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  else for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return delaunayFlips(p, out);
}

/**
 * Lawson edge flips: turns a triangulation into the (constrained) Delaunay one, so
 * heights given at the corners are interpolated over the fattest triangles and a ridge
 * drawn with two opposite corners gets its diagonal. Every flip stays inside the polygon.
 */
function delaunayFlips(p: Pt[], tris: number[]): number[] {
  const t = tris.slice();
  const nT = t.length / 3;
  const inCircle = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    // Positive when d is inside the circumcircle of the counter-clockwise triangle abc.
    const ax = a.x - d.x;
    const ay = a.y - d.y;
    const bx = b.x - d.x;
    const by = b.y - d.y;
    const cx = c.x - d.x;
    const cy = c.y - d.y;
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
    const scale = Math.max(1, Math.abs(ax * ax + ay * ay), Math.abs(bx * bx + by * by), Math.abs(cx * cx + cy * cy));
    return det / scale;
  };
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let pass = 0; pass < 50; pass++) {
    let flipped = false;
    for (let i = 0; i < nT && !flipped; i++) {
      for (let j = i + 1; j < nT && !flipped; j++) {
        const A = [t[3 * i], t[3 * i + 1], t[3 * i + 2]];
        const B = [t[3 * j], t[3 * j + 1], t[3 * j + 2]];
        const shared = A.filter((v) => B.includes(v));
        if (shared.length !== 2) continue;
        const a = A.find((v) => !shared.includes(v))!;
        const b = B.find((v) => !shared.includes(v))!;
        const [s0, s1] = shared;
        // The quad a-s0-b-s1 must be strictly convex for the flip to stay a valid triangulation.
        if (cross(p[a], p[s0], p[b]) >= -1e-9 || cross(p[b], p[s1], p[a]) >= -1e-9) continue;
        if (cross(p[s0], p[b], p[s1]) >= -1e-9 || cross(p[s1], p[a], p[s0]) >= -1e-9) continue;
        // Counter-clockwise copy of A for the circle test.
        const ccwA = cross(p[A[0]], p[A[1]], p[A[2]]) > 0 ? A : [A[0], A[2], A[1]];
        if (inCircle(p[ccwA[0]], p[ccwA[1]], p[ccwA[2]], p[b]) <= 1e-9) continue;
        // Flip: triangles (a, s0, b) and (b, s1, a), both counter-clockwise.
        const T1 = cross(p[a], p[s0], p[b]) > 0 ? [a, s0, b] : [a, b, s0];
        const T2 = cross(p[b], p[s1], p[a]) > 0 ? [b, s1, a] : [b, a, s1];
        t.splice(3 * i, 3, ...T1);
        t.splice(3 * j, 3, ...T2);
        flipped = true;
      }
    }
    if (!flipped) break;
  }
  return t;
}

/**
 * The outline moved outward by `d` (inward for negative d): each edge is shifted along
 * its outward normal and neighbouring edges are intersected (mitred corners). Right
 * for the small offsets a wall batter makes.
 */
export function offset(p: Pt[], d: number): Pt[] {
  const n = p.length;
  if (n < 3 || d === 0) return p.map((q) => ({ x: q.x, y: q.y }));
  const ccw = signedArea(p) >= 0;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n];
    const b = p[i];
    const c = p[(i + 1) % n];
    const e1 = norm(b.x - a.x, b.y - a.y);
    const e2 = norm(c.x - b.x, c.y - b.y);
    // Outward normals of the two edges at this corner.
    const n1 = ccw ? { x: e1.y, y: -e1.x } : { x: -e1.y, y: e1.x };
    const n2 = ccw ? { x: e2.y, y: -e2.x } : { x: -e2.y, y: e2.x };
    const bis = { x: n1.x + n2.x, y: n1.y + n2.y };
    const l = Math.hypot(bis.x, bis.y);
    if (l < 1e-9) {
      out.push({ x: b.x + n1.x * d, y: b.y + n1.y * d });
      continue;
    }
    const cosHalf = (bis.x / l) * n1.x + (bis.y / l) * n1.y;
    // Mitre length, capped at 4 × d for very sharp corners.
    const m = Math.min(Math.abs(d) / Math.max(cosHalf, 0.25), 4 * Math.abs(d)) * Math.sign(d);
    out.push({ x: b.x + (bis.x / l) * m, y: b.y + (bis.y / l) * m });
  }
  return out;
}

function norm(x: number, y: number): Pt {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** Where the line y = c (axis 'y') or x = c (axis 'x') crosses the outline, sorted. */
export function crossings(p: Pt[], axis: 'x' | 'y', c: number): number[] {
  const out: number[] = [];
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const a1 = axis === 'y' ? a.y : a.x;
    const b1 = axis === 'y' ? b.y : b.x;
    if (a1 > c === b1 > c) continue;
    const t = (c - a1) / (b1 - a1);
    out.push(axis === 'y' ? a.x + t * (b.x - a.x) : a.y + t * (b.y - a.y));
  }
  return out.sort((u, v) => u - v);
}

/** A rectangle of width (X) × length (Y) centred at (cx, cy), counter-clockwise. */
export function rectangle(width: number, length: number, cx = 0, cy = 0): Pt[] {
  const hx = width / 2;
  const hy = length / 2;
  return [
    { x: cx - hx, y: cy - hy },
    { x: cx + hx, y: cy - hy },
    { x: cx + hx, y: cy + hy },
    { x: cx - hx, y: cy + hy },
  ];
}

/** Barycentric interpolation of vertex values over the triangle containing (x, y); null when outside every triangle. */
export function interpolate(p: Pt[], tris: number[], values: number[], x: number, y: number): number | null {
  for (let t = 0; t < tris.length; t += 3) {
    const a = p[tris[t]];
    const b = p[tris[t + 1]];
    const c = p[tris[t + 2]];
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
    const l2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
    const l3 = 1 - l1 - l2;
    const eps = -1e-9;
    if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * values[tris[t]] + l2 * values[tris[t + 1]] + l3 * values[tris[t + 2]];
  }
  return null;
}
