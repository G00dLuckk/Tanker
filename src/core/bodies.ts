/**
 * Outlines of the extra body shapes: chamfered box, trapezoid, box-oval
 * (superellipse), D-shape and U-trough. Each is a convex outline, mirror
 * symmetric left–right, built as a polygon; curves use many points, so the
 * volume engine's exact polygon slicing is within a few parts per million of
 * the true curve.
 */
import type { BaseShape } from './shape';
import type { BodyConfig } from './types';

export type OutlineBody = 'chamfer' | 'trapezoid' | 'boxoval' | 'dshape' | 'trough';

type Pts = [number, number][];

/** Points on the curved parts of an outline. */
const ARC_POINTS = 1024;

/** Corner cut of a chamfered box, limited so the cuts do not meet. */
function chamferOf(W: number, H: number, c: number): number {
  return Math.min(Math.max(0, c), 0.499 * Math.min(W, H));
}

function chamferPts(W: number, H: number, c0: number): Pts {
  const a = W / 2;
  const b = H / 2;
  const c = chamferOf(W, H, c0);
  return [
    [-a + c, -b],
    [a - c, -b],
    [a, -b + c],
    [a, b - c],
    [a - c, b],
    [-a + c, b],
    [-a, b - c],
    [-a, -b + c],
  ];
}

/** Wt across the +v side (top / back), Wb across the −v side. */
function trapezoidPts(Wt: number, Wb: number, H: number): Pts {
  const b = H / 2;
  return [
    [-Wb / 2, -b],
    [Wb / 2, -b],
    [Wt / 2, b],
    [-Wt / 2, b],
  ];
}

function superellipsePts(W: number, H: number, n: number): Pts {
  const a = W / 2;
  const b = H / 2;
  const e = 2 / Math.min(Math.max(n, 2), 12);
  const pts: Pts = [];
  const N = 2 * ARC_POINTS;
  for (let k = 0; k < N; k++) {
    const t = (2 * Math.PI * k) / N;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e]);
  }
  return pts;
}

/**
 * Flat −v side, straight sides, half round on the +v side (radius W / 2). When the
 * shape is lower than W / 2, the round part becomes a half ellipse as high as the shape.
 */
function dshapePts(W: number, H: number): Pts {
  const R = W / 2;
  const b = H / 2;
  const pts: Pts = [];
  if (H >= R) {
    const cv = b - R;
    pts.push([-R, -b], [R, -b]);
    for (let k = 0; k <= ARC_POINTS; k++) {
      const f = (Math.PI * k) / ARC_POINTS;
      pts.push([R * Math.cos(f), cv + R * Math.sin(f)]);
    }
    return pts;
  }
  for (let k = 0; k <= ARC_POINTS; k++) {
    const f = (Math.PI * k) / ARC_POINTS;
    pts.push([R * Math.cos(f), -b + H * Math.sin(f)]);
  }
  return pts;
}

/** Outline with the typed sizes (counter-clockwise, centred on its box). */
export function outlinePoints(b: BodyConfig, type: OutlineBody, W: number, H: number, W2 = b.width2): Pts {
  switch (type) {
    case 'chamfer':
      return chamferPts(W, H, b.chamfer);
    case 'trapezoid':
      return trapezoidPts(W, W2, H);
    case 'boxoval':
      return superellipsePts(W, H, b.squareness);
    case 'dshape':
      return dedupe(dshapePts(W, H));
    case 'trough':
      // The D-shape upside down; reversed to stay counter-clockwise.
      return dedupe(dshapePts(W, H).map(([u, v]) => [u, -v] as [number, number]).reverse());
  }
}

function dedupe(p: Pts): Pts {
  const out: Pts = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-9 * (Math.abs(q[0]) + Math.abs(q[1]) + 1)) out.push(q);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

/** Every line of a convex polygon moved inward by t (exact for straight sides). */
function insetPolygon(p: Pts, t: number): Pts {
  const n = p.length;
  const normal = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const du = p[j][0] - p[i][0];
    const dv = p[j][1] - p[i][1];
    const l = Math.hypot(du, dv) || 1;
    return [dv / l, -du / l];
  };
  return p.map(([u, v], i) => {
    const a = normal((i - 1 + n) % n);
    const b = normal(i);
    const d = 1 + a[0] * b[0] + a[1] * b[1];
    return [u - (t * (a[0] + b[0])) / d, v - (t * (a[1] + b[1])) / d];
  });
}

export function perimeterOf(p: Pts): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    s += Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]);
  }
  return s;
}

/** Circumference of the typed outline (per the dimension basis). */
export function outlinePerimeter(b: BodyConfig, type: OutlineBody): number {
  const W = Math.max(0, b.width);
  const H = Math.max(0, b.depth);
  if (!(W > 0 && H > 0)) return 0;
  return perimeterOf(outlinePoints(b, type, W, H, Math.max(0, b.width2)));
}

/**
 * Inside cross-section of an outline body. With outside measurements the wall is
 * taken off every side: exactly for the straight-sided shapes, and by shrinking the
 * sizes by twice the wall for the curved ones (exact for the round part of a D-shape).
 */
export function outlineShape(
  b: BodyConfig,
  type: OutlineBody,
  wall: number,
  outside: boolean,
  minSize: number,
  problem: (msg: string) => void,
  heightWord: string,
): BaseShape {
  const W = Math.max(0, b.width);
  const W2 = Math.max(0, b.width2);
  const H = Math.max(0, b.depth);
  const t = outside ? wall : 0;
  let pts: Pts;
  if (type === 'chamfer' || type === 'trapezoid') {
    if (!(Math.max(W, type === 'trapezoid' ? W2 : 0) - 2 * t > minSize)) problem('Width is too small for the wall thickness.');
    if (!(H - 2 * t > minSize)) problem(`${heightWord} is too small for the wall thickness.`);
    const outer = outlinePoints(b, type, Math.max(W, minSize * 10), Math.max(H, minSize * 10), Math.max(W2, 0));
    pts = t > 0 ? insetPolygon(outer, t) : outer;
    if (type === 'trapezoid' && Math.min(W, W2) - 2 * t <= 0) problem('The narrow side of the trapezoid is too small for the wall thickness.');
  } else {
    const wi = W - 2 * t;
    const hi = H - 2 * t;
    if (!(wi > minSize)) problem('Width is too small for the wall thickness.');
    if (!(hi > minSize)) problem(`${heightWord} is too small for the wall thickness.`);
    pts = outlinePoints(b, type, Math.max(wi, minSize * 10), Math.max(hi, minSize * 10));
  }
  // Centre on the bounding box, which the rest of the model assumes is [−A, A] × [−B, B].
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [u, v] of pts) {
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  return {
    kind: 'polygon',
    A: (u1 - u0) / 2,
    B: (v1 - v0) / 2,
    rho: 0,
    poly: { u: pts.map((p) => p[0] - cu), v: pts.map((p) => p[1] - cv), general: true },
  };
}
