/**
 * Cross-section shapes. Every tank section is one of these base shapes, scaled
 * along its two axes (u, v) and shifted. Because the scaling is affine, partial
 * areas of a scaled section follow exactly from the base shape's closed forms.
 */

export type ShapeKind = 'ellipse' | 'roundrect' | 'polygon';

export interface BaseShape {
  kind: ShapeKind;
  /** Half size along u. */
  A: number;
  /** Half size along v. */
  B: number;
  /** Corner radius (roundrect only). */
  rho: number;
  /**
   * Polygon only: convex outline, counter-clockwise, mirror-symmetric in u (u → −u)
   * and filling the box [−A, A] × [−B, B]. Regular polygons are also symmetric in v;
   * `general` outlines (trapezoid, D-shape, box-oval, …) need not be, and may have
   * hundreds of points along their curves.
   */
  poly?: { u: number[]; v: number[]; general?: boolean; slabs?: [Slab, Slab] };
}

/**
 * Even-sided polygon with a flat side at −v (the bottom of a horizontal tank),
 * stretched to fill the box [−A, A] × [−B, B]. Even side counts keep it
 * symmetric about both axes, which the chord and volume code relies on.
 */
export function polygonShape(sides: number, A: number, B: number): BaseShape {
  const n = Math.max(6, Math.min(12, Math.round(sides / 2) * 2));
  const cu: number[] = [];
  const cv: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = -Math.PI / 2 + Math.PI / n + (2 * Math.PI * k) / n;
    cu.push(Math.cos(t));
    cv.push(Math.sin(t));
  }
  const mu = Math.max(...cu.map(Math.abs));
  const mv = Math.max(...cv.map(Math.abs));
  return { kind: 'polygon', A, B, rho: 0, poly: { u: cu.map((x) => (A * x) / mu), v: cv.map((y) => (B * y) / mv) } };
}

/** Number of sides of a polygon shape. */
export function polygonSides(s: BaseShape): number {
  return s.poly?.u.length ?? 0;
}

/** For n = 6 or 10 the width (u) runs across two corners; for 8 and 12 across two flat sides. */
export function polygonWidthAcrossCorners(sides: number): boolean {
  return Math.round(sides / 2) % 2 === 1;
}

/**
 * A convex polygon sliced across one axis. Between consecutive vertex coordinates
 * c[k] the chord [lo, hi] runs linearly, so the area below any line is exact:
 * F[k] (area up to c[k]) plus a trapezoid. A bucket index finds k in a step or two,
 * so outlines with thousands of points cost about as much as a circle.
 */
export interface Slab {
  c: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  F: Float64Array;
  /** bucket[b]: last k with c[k] at or below the start of bucket b. */
  bucket: Int32Array;
  /** Buckets per unit of c. */
  scale: number;
}

/** Slabs across u (index 0) and across v (index 1), built once per shape. */
function slabsOf(s: BaseShape): [Slab, Slab] {
  const P = s.poly!;
  if (!P.slabs) P.slabs = [buildSlab(P.u, P.v), buildSlab(P.v, P.u)];
  return P.slabs;
}

/** Points (c, o): lower and upper hull in c, evaluated at every hull coordinate. */
function buildSlab(cs: number[], os: number[]): Slab {
  const pts = cs.map((c, i) => [c, os[i]] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.reverse();
  const coords = [...new Set([...lower.map((p) => p[0]), ...upper.map((p) => p[0])])].sort((a, b) => a - b);
  const n = coords.length;
  const c = Float64Array.from(coords);
  const span = n > 1 ? c[n - 1] - c[0] : 1;
  const nb = 2 * n;
  const sl: Slab = {
    c,
    lo: sampleChain(lower, c, -1),
    hi: sampleChain(upper, c, 1),
    F: new Float64Array(n),
    bucket: new Int32Array(nb + 1),
    scale: span > 0 ? nb / span : 0,
  };
  for (let k = 1; k < n; k++) {
    const h = c[k] - c[k - 1];
    sl.F[k] = sl.F[k - 1] + (h * (sl.hi[k - 1] - sl.lo[k - 1] + sl.hi[k] - sl.lo[k])) / 2;
  }
  let k = 0;
  for (let b = 0; b <= nb; b++) {
    const x = c[0] + b / (sl.scale || 1);
    while (k < n - 2 && c[k + 1] <= x) k++;
    sl.bucket[b] = k;
  }
  return sl;
}

/**
 * A hull chain (sorted by c) sampled at sorted coordinates; where the chain is vertical,
 * its lowest (pick −1) or highest (+1) point.
 */
function sampleChain(chain: [number, number][], coords: Float64Array, pick: -1 | 1): Float64Array {
  const out = new Float64Array(coords.length);
  let j = 0;
  for (let k = 0; k < coords.length; k++) {
    const c = coords[k];
    while (j < chain.length - 1 && chain[j + 1][0] < c) j++;
    let best = NaN;
    for (let i = j; i < chain.length && chain[i][0] <= c; i++) {
      if (chain[i][0] === c) best = Number.isNaN(best) ? chain[i][1] : pick < 0 ? Math.min(best, chain[i][1]) : Math.max(best, chain[i][1]);
    }
    if (!Number.isNaN(best)) out[k] = best;
    else if (j < chain.length - 1) {
      const [c0, o0] = chain[j];
      const [c1, o1] = chain[j + 1];
      out[k] = o0 + ((o1 - o0) * (c - c0)) / (c1 - c0);
    } else out[k] = chain.length ? chain[chain.length - 1][1] : 0;
  }
  return out;
}

/** Index k with c[k] ≤ x < c[k + 1] (x inside the slab range). */
function slabIndex(sl: Slab, x: number): number {
  const c = sl.c;
  const last = c.length - 2;
  let k = sl.bucket[Math.min(sl.bucket.length - 1, Math.max(0, Math.floor((x - c[0]) * sl.scale)))];
  while (k < last && c[k + 1] <= x) k++;
  while (k > 0 && c[k] > x) k--;
  return k;
}

function slabBelow(sl: Slab, eta: number): number {
  const n = sl.c.length;
  if (n < 2 || eta <= sl.c[0]) return 0;
  if (eta >= sl.c[n - 1]) return sl.F[n - 1];
  const k = slabIndex(sl, eta);
  const h = sl.c[k + 1] - sl.c[k];
  const z = eta - sl.c[k];
  const w0 = sl.hi[k] - sl.lo[k];
  const w1 = sl.hi[k + 1] - sl.lo[k + 1];
  return sl.F[k] + w0 * z + ((w1 - w0) * z * z) / (2 * h);
}

/** Chord [lo, hi] of the slab at x, or null outside it. */
function slabChord(sl: Slab, x: number): [number, number] | null {
  const n = sl.c.length;
  if (n < 2 || x < sl.c[0] || x > sl.c[n - 1]) return null;
  if (x === sl.c[n - 1]) return [sl.lo[n - 1], sl.hi[n - 1]];
  const k = slabIndex(sl, x);
  const f = (x - sl.c[k]) / (sl.c[k + 1] - sl.c[k]);
  return [sl.lo[k] + f * (sl.lo[k + 1] - sl.lo[k]), sl.hi[k] + f * (sl.hi[k + 1] - sl.hi[k])];
}

const HALF_PI = Math.PI / 2;

/** Area of the unit circle below the horizontal line y = x. */
export function unitSeg(x: number): number {
  if (x <= -1) return 0;
  if (x >= 1) return Math.PI;
  return HALF_PI + x * Math.sqrt(1 - x * x) + Math.asin(x);
}

export function shapeArea(s: BaseShape): number {
  if (s.kind === 'ellipse') return Math.PI * s.A * s.B;
  if (s.kind === 'polygon') {
    // The slab total equals the shoelace area and is cached, which matters for long outlines.
    const F = slabsOf(s)[1].F;
    return F[F.length - 1];
  }
  const r = cornerRadius(s);
  return 4 * s.A * s.B - (4 - Math.PI) * r * r;
}

function cornerRadius(s: BaseShape): number {
  return Math.max(0, Math.min(s.rho, s.A, s.B));
}

/** Half extent of the shape along an axis (0 = u, 1 = v). */
export function halfExtent(s: BaseShape, axis: 0 | 1): number {
  return axis === 0 ? s.A : s.B;
}

/** Area of the part of the shape whose coordinate along `axis` is ≤ eta. */
export function segBelow(s: BaseShape, axis: 0 | 1, eta: number): number {
  const P = axis === 1 ? s.A : s.B; // half size parallel to the cut line
  const Q = axis === 1 ? s.B : s.A; // half size along the axis
  if (eta <= -Q) return 0;
  if (eta >= Q) return shapeArea(s);
  if (s.kind === 'ellipse') return P * Q * unitSeg(eta / Q);
  if (s.kind === 'polygon') return slabBelow(slabsOf(s)[axis], eta);
  const r = cornerRadius(s);
  if (r <= 0) return 2 * P * (eta + Q);
  const yb = -Q + r;
  const yt = Q - r;
  if (eta <= yb) return 2 * (P - r) * (eta + Q) + r * r * unitSeg((eta - yb) / r);
  const gb = 2 * (P - r) * r + r * r * HALF_PI;
  if (eta <= yt) return gb + 2 * P * (eta - yb);
  const gt = gb + 2 * P * (yt - yb);
  const z = eta - yt;
  return gt + 2 * (P - r) * z + r * r * (unitSeg(z / r) - HALF_PI);
}

/**
 * Half length of the chord where the coordinate along `axis` equals w.
 * axis = 1: the horizontal line v = w, returns the half width in u.
 * axis = 0: the vertical line u = w, returns the half height in v.
 */
export function halfChord(s: BaseShape, axis: 0 | 1, w: number): number {
  const P = axis === 1 ? s.A : s.B;
  const Q = axis === 1 ? s.B : s.A;
  const aw = Math.abs(w);
  if (aw >= Q) return 0;
  if (s.kind === 'ellipse') {
    const q = aw / Q;
    return P * Math.sqrt(1 - q * q);
  }
  if (s.kind === 'polygon') {
    // Half the chord length. Use chordRange where the shape is not symmetric across the line.
    const ch = slabChord(slabsOf(s)[axis], w);
    return ch ? (ch[1] - ch[0]) / 2 : 0;
  }
  const r = cornerRadius(s);
  const d = aw - (Q - r);
  if (d <= 0) return P;
  return P - r + Math.sqrt(Math.max(0, r * r - d * d));
}

/**
 * Ends of the chord where the coordinate along `axis` equals w: for axis = 1 the
 * u range on the line v = w, for axis = 0 the v range on the line u = w. Null
 * when the line misses the shape. Unlike halfChord this is right for shapes that
 * are not symmetric across the line (trapezoid, D-shape).
 */
export function chordRange(s: BaseShape, axis: 0 | 1, w: number): [number, number] | null {
  if (s.kind === 'polygon') {
    const ch = slabChord(slabsOf(s)[axis], w);
    return ch && ch[1] > ch[0] ? ch : null;
  }
  const hc = halfChord(s, axis, w);
  return hc > 0 ? [-hc, hc] : null;
}

export function contains(s: BaseShape, u: number, v: number): boolean {
  if (s.kind === 'ellipse') {
    const x = u / s.A;
    const y = v / s.B;
    return x * x + y * y <= 1;
  }
  if (s.kind === 'polygon') {
    const tol = 1e-12 * (s.A + s.B);
    const sl = slabsOf(s)[1];
    const ch = slabChord(sl, Math.min(Math.max(v, sl.c[0]), sl.c[sl.c.length - 1]));
    if (!ch || v < sl.c[0] - tol || v > sl.c[sl.c.length - 1] + tol) return false;
    return u >= ch[0] - tol && u <= ch[1] + tol;
  }
  return Math.abs(v) <= s.B && Math.abs(u) <= halfChord(s, 1, v);
}

/** Closed outline of a base shape, counter-clockwise, starting at (+A, 0). */
export interface Outline {
  n: number;
  u: Float64Array;
  v: Float64Array;
  /** Outward unit normals. Sharp corners appear as two points with different normals. */
  nu: Float64Array;
  nv: Float64Array;
  /** Indices of the points at (+A,0), (0,+B), (−A,0), (0,−B). */
  cardinal: [number, number, number, number];
}

export function makeOutline(s: BaseShape, segments = 96): Outline {
  if (s.kind === 'ellipse') {
    const n = Math.max(8, Math.round(segments / 4) * 4);
    const o = alloc(n);
    for (let j = 0; j < n; j++) {
      const f = (2 * Math.PI * j) / n;
      const c = Math.cos(f);
      const sn = Math.sin(f);
      o.u[j] = s.A * c;
      o.v[j] = s.B * sn;
      const gx = c / s.A;
      const gy = sn / s.B;
      const l = Math.hypot(gx, gy);
      o.nu[j] = gx / l;
      o.nv[j] = gy / l;
    }
    o.cardinal = [0, n / 4, n / 2, (3 * n) / 4];
    return o;
  }

  if (s.kind === 'polygon') return s.poly!.general ? generalOutline(s, segments) : polygonOutline(s);

  // Quadrant 1, from (A,0) toward (0,B), end point excluded.
  const r = cornerRadius(s);
  const q: [number, number, number, number][] = [];
  const edge1 = 2;
  for (let i = 0; i < edge1; i++) q.push([s.A, ((s.B - r) * i) / edge1, 1, 0]);
  if (r > 0) {
    const arc = Math.max(4, Math.round(segments / 8));
    for (let i = 0; i < arc; i++) {
      const t = (HALF_PI * i) / arc;
      q.push([s.A - r + r * Math.cos(t), s.B - r + r * Math.sin(t), Math.cos(t), Math.sin(t)]);
    }
  } else {
    // Sharp corner: this point carries the side normal, the first top-edge point the top normal.
    q.push([s.A, s.B, 1, 0]);
  }
  const edge3 = 2;
  for (let i = 0; i < edge3; i++) q.push([(s.A - r) * (1 - i / edge3), s.B, 0, 1]);

  const k = q.length;
  const full = [...q, [0, s.B, 0, 1] as [number, number, number, number]];
  // Quadrant 2: mirror u → −u and reverse, dropping the shared end point.
  const q2 = full
    .map(([u, v, nu, nv]) => [-u, v, -nu, nv] as [number, number, number, number])
    .reverse()
    .slice(0, k);
  const q3 = q.map(([u, v, nu, nv]) => [-u, -v, -nu, -nv] as [number, number, number, number]);
  const q4 = q2.map(([u, v, nu, nv]) => [-u, -v, -nu, -nv] as [number, number, number, number]);
  const pts = [...q, ...q2, ...q3, ...q4];
  const o = alloc(pts.length);
  pts.forEach(([u, v, nu, nv], j) => {
    o.u[j] = u;
    o.v[j] = v;
    o.nu[j] = nu;
    o.nv[j] = nv;
  });
  o.cardinal = [0, k, 2 * k, 3 * k];
  return o;
}

/** Polygon outline: every corner appears twice (one point per side normal), each side has a midpoint. */
function polygonOutline(s: BaseShape): Outline {
  const pg = s.poly!;
  const n = pg.u.length;
  const pts: [number, number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const du = pg.u[j] - pg.u[k];
    const dv = pg.v[j] - pg.v[k];
    const l = Math.hypot(du, dv) || 1;
    const nu = dv / l;
    const nv = -du / l;
    pts.push([pg.u[k], pg.v[k], nu, nv], [(pg.u[k] + pg.u[j]) / 2, (pg.v[k] + pg.v[j]) / 2, nu, nv], [pg.u[j], pg.v[j], nu, nv]);
  }
  // Start at (+A, 0) so the outline runs counter-clockwise from there, like the other shapes.
  const tol = 1e-9 * (s.A + s.B);
  let start = pts.findIndex(([u, v]) => Math.abs(u - s.A) < tol && Math.abs(v) < tol);
  if (start < 0) start = 0;
  const ordered = [...pts.slice(start), ...pts.slice(0, start)];
  const o = alloc(ordered.length);
  ordered.forEach(([u, v, nu, nv], i) => {
    o.u[i] = u;
    o.v[i] = v;
    o.nu[i] = nu;
    o.nv[i] = nv;
  });
  const find = (tu: number, tv: number) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < o.n; i++) {
      const d = Math.hypot(o.u[i] - tu, o.v[i] - tv);
      if (d < bd - tol) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  o.cardinal = [find(s.A, 0), find(0, s.B), find(-s.A, 0), find(0, -s.B)];
  return o;
}

/**
 * Outline of a general convex polygon for drawing: corners (where the outline turns
 * by more than 20°) appear twice, once per side normal; curved runs are thinned to
 * about `segments` points; the four points where the outline crosses the axes are
 * always included, because the cut-away view slices the tank there.
 */
function generalOutline(s: BaseShape, segments: number): Outline {
  const pg = s.poly!;
  const tol = 1e-9 * (s.A + s.B);
  // Dense points with the axis crossings inserted.
  const pu: number[] = [];
  const pv: number[] = [];
  const keep: boolean[] = [];
  const n0 = pg.u.length;
  for (let i = 0; i < n0; i++) {
    const j = (i + 1) % n0;
    const u0 = pg.u[i];
    const v0 = pg.v[i];
    const u1 = pg.u[j];
    const v1 = pg.v[j];
    pu.push(u0);
    pv.push(v0);
    keep.push(Math.abs(u0) < tol || Math.abs(v0) < tol);
    const cuts: number[] = [];
    if ((v0 < -tol && v1 > tol) || (v0 > tol && v1 < -tol)) cuts.push(v0 / (v0 - v1));
    if ((u0 < -tol && u1 > tol) || (u0 > tol && u1 < -tol)) cuts.push(u0 / (u0 - u1));
    for (const f of cuts.sort((a, b) => a - b)) {
      pu.push(u0 + f * (u1 - u0));
      pv.push(v0 + f * (v1 - v0));
      keep.push(true);
    }
  }
  const n = pu.length;
  // Outward normal of the edge from point i to i + 1 (counter-clockwise outline).
  const en = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const du = pu[j] - pu[i];
    const dv = pv[j] - pv[i];
    const l = Math.hypot(du, dv) || 1;
    return [dv / l, -du / l];
  };
  let perimeter = 0;
  for (let i = 0; i < n; i++) perimeter += Math.hypot(pu[(i + 1) % n] - pu[i], pv[(i + 1) % n] - pv[i]);
  const step = perimeter / Math.max(segments, 16);
  const pts: [number, number, number, number][] = [];
  const cardinal: number[] = [-1, -1, -1, -1];
  let since = Infinity;
  for (let i = 0; i < n; i++) {
    const a = en((i - 1 + n) % n);
    const b = en(i);
    const corner = a[0] * b[0] + a[1] * b[1] < Math.cos((20 * Math.PI) / 180);
    since += Math.hypot(pu[i] - pu[(i - 1 + n) % n], pv[i] - pv[(i - 1 + n) % n]);
    if (!(corner || keep[i] || since >= step * 0.999)) continue;
    since = 0;
    const at = pts.length;
    if (corner) pts.push([pu[i], pv[i], a[0], a[1]], [pu[i], pv[i], b[0], b[1]]);
    else {
      const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
      pts.push([pu[i], pv[i], (a[0] + b[0]) / l, (a[1] + b[1]) / l]);
    }
    if (Math.abs(pv[i]) < tol && pu[i] > 0 && cardinal[0] < 0) cardinal[0] = at;
    if (Math.abs(pu[i]) < tol && pv[i] > 0 && cardinal[1] < 0) cardinal[1] = at;
    if (Math.abs(pv[i]) < tol && pu[i] < 0 && cardinal[2] < 0) cardinal[2] = at;
    if (Math.abs(pu[i]) < tol && pv[i] < 0 && cardinal[3] < 0) cardinal[3] = at;
  }
  // Start at the +u axis crossing, like the other outlines.
  const start = Math.max(0, cardinal[0]);
  const ordered = [...pts.slice(start), ...pts.slice(0, start)];
  const o = alloc(ordered.length);
  ordered.forEach(([u, v, nu, nv], i) => {
    o.u[i] = u;
    o.v[i] = v;
    o.nu[i] = nu;
    o.nv[i] = nv;
  });
  const shift = (k: number) => (k < 0 ? 0 : (k - start + pts.length) % pts.length);
  o.cardinal = [shift(cardinal[0]), shift(cardinal[1]), shift(cardinal[2]), shift(cardinal[3])];
  return o;
}

function alloc(n: number): Outline {
  return {
    n,
    u: new Float64Array(n),
    v: new Float64Array(n),
    nu: new Float64Array(n),
    nv: new Float64Array(n),
    cardinal: [0, 0, 0, 0],
  };
}
