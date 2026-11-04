import type { HeadConfig, HeadType, Orientation, ToriBy, ToriStandard } from './types';
import { clamp } from './units';

/** Section scale and offset at a distance t from the shell junction, moving outward. */
export interface HeadSample {
  /** Scale along u relative to the junction section. */
  ku: number;
  /** Scale along v relative to the junction section. */
  kv: number;
  /** Centre offset along u (mm). */
  du: number;
  /** Centre offset along v (mm). */
  dv: number;
}

export interface HeadMeta {
  label: string;
  crownR?: number;
  knuckleR?: number;
  sphereR?: number;
  /** Actual wall angle from the end plane (deg). */
  angle?: number;
  outletU?: number;
  outletV?: number;
  /** Inside arc length over the head, tangent line to tangent line through the centre (mm). */
  arc?: number;
  /** The typed sizes could not be met exactly; the head was made as close as possible. */
  issue?: string;
}

export interface HeadProfile {
  type: HeadType;
  /** Inside depth from the shell junction to the far end (mm). */
  depth: number;
  /** Breakpoints in t (0 < t < depth) where the profile formula changes. */
  breaks: number[];
  /** The far end is a flat face with non-zero area. */
  closed: boolean;
  /** Tangent to the shell at the junction (no crease). */
  smooth: boolean;
  endKu: number;
  endKv: number;
  at(t: number, out: HeadSample): HeadSample;
  meta: HeadMeta;
}

export interface HeadContext {
  /** Inside half sizes of the junction section (mm). */
  A: number;
  B: number;
  round: boolean;
  /** Section is elliptical (round or oval) rather than rectangular. */
  elliptic: boolean;
  orientation: Orientation;
  basis: 'outside' | 'inside';
}

export const TORI_STANDARDS: Record<Exclude<ToriStandard, 'custom' | 'measured'>, { crown: number; knuckle: number; label: string }> = {
  klopper: { crown: 1.0, knuckle: 0.1, label: 'Klöpper (DIN 28011)' },
  korbbogen: { crown: 0.8, knuckle: 0.154, label: 'Korbbogen (DIN 28013)' },
  asme: { crown: 1.0, knuckle: 0.06, label: 'ASME flanged & dished' },
  r8010: { crown: 0.8, knuckle: 0.1, label: '80:10' },
};

/** Reference radius used by dome-type heads on a section. */
export function headRefRadius(ctx: HeadContext): number {
  return ctx.round ? ctx.A : (ctx.A + ctx.B) / 2;
}

export function resolveHead(cfg: HeadConfig, ctx: HeadContext): HeadProfile {
  const R = headRefRadius(ctx);
  const inner = (d: number) => (ctx.basis === 'outside' ? Math.max(0, d - cfg.thickness) : Math.max(0, d));

  switch (cfg.type) {
    case 'flat':
      return flatHead();
    case 'hemi':
      return ellipsoidalHead('hemi', R, R, 'Hemispherical');
    case 'ellipsoidal': {
      if (cfg.ratioBy === 'arc') {
        const e = ellipsoidFromArc(R, cfg.arc, ctx.basis === 'outside' ? Math.max(0, cfg.thickness) : 0);
        const head = ellipsoidalHead('ellipsoidal', R, e.depth, `Semi-ellipsoidal ${trim(R / e.depth)}:1`);
        if (e.issue) head.meta.issue = e.issue;
        return head;
      }
      if (cfg.ratioBy === 'depth') {
        // Up to twice the diameter, like a paraboloid (a same-size head is as deep as the outside width).
        const d = clamp(inner(cfg.depth), R / 20, 4 * R);
        return ellipsoidalHead('ellipsoidal', R, d, `Semi-ellipsoidal ${trim(R / d)}:1`);
      }
      const ratio = clamp(cfg.ellipseRatio || 2, 0.5, 20);
      return ellipsoidalHead('ellipsoidal', R, R / ratio, `${trim(ratio)}:1 semi-ellipsoidal`);
    }
    case 'torispherical': {
      // The standards give the inside radii as fractions of the head's outside diameter
      // (DIN 28011: R = Da, r = 0.1 Da; DIN 28013: R = 0.8 Da, r = 0.154 Da; ASME: L = Do).
      const Da = 2 * R + 2 * Math.max(0, cfg.thickness);
      if (cfg.tori === 'measured') {
        // Typed sizes are on the outside surface when measured outside: radii and depth grow by the wall, the arc by π × wall.
        const t = ctx.basis === 'outside' ? Math.max(0, cfg.thickness) : 0;
        const m = solveMeasuredTori(R, cfg.toriBy, {
          depth: cfg.depth - t,
          crown: cfg.crownR - t,
          knuckle: cfg.knuckleR - t,
          arc: cfg.arc - Math.PI * t,
          // A head sized by one measurement takes the standard knuckle: a fraction of Da.
          knuckleD: (cfg.knuckle * Da) / (2 * R),
        });
        const head = torisphericalHead(R, m.crown, m.knuckle, 'Torispherical (measured)');
        if (m.issue) head.meta.issue = m.issue;
        return head;
      }
      const D = Da;
      const std = cfg.tori === 'custom' ? null : TORI_STANDARDS[cfg.tori];
      const fc = std ? std.crown : cfg.crown;
      const fk = std ? std.knuckle : cfg.knuckle;
      const label = std ? `Torispherical, ${std.label}` : 'Torispherical (custom radii)';
      return torisphericalHead(R, fc * D, fk * D, label);
    }
    case 'dished': {
      if (cfg.dishBy === 'arc') {
        const c = capFromArc(R, cfg.arc, ctx.basis === 'outside' ? Math.max(0, cfg.thickness) : 0);
        const head = c.depth <= 1e-6 ? flatHead() : dishedHead(R, c.depth);
        if (c.issue) head.meta.issue = c.issue;
        return head;
      }
      if (cfg.dishBy === 'radius') {
        // Spherical cap of the given dish radius (at least the shell radius).
        const Rs = Math.max(cfg.dishRadius, R);
        const d = Rs - Math.sqrt(Math.max(0, Rs * Rs - R * R));
        if (d <= 1e-6) return flatHead();
        return dishedHead(R, d);
      }
      const d = Math.min(inner(cfg.depth), R);
      if (d <= 1e-6) return flatHead();
      return dishedHead(R, d);
    }
    case 'cone':
      return linearHead(cfg, ctx, 'cone', inner);
    case 'wedge':
      return linearHead(cfg, ctx, 'wedge', inner);
    case 'sloped':
      return linearHead(cfg, ctx, 'sloped', inner);
    case 'paraboloid': {
      const d = clamp(inner(cfg.depth), R / 50, 4 * R);
      return paraboloidHead(d);
    }
    case 'flanged': {
      const rk = clamp(inner(cfg.knuckleR), 1e-3 * R, 0.999 * Math.min(ctx.A, ctx.B));
      return flangedHead(ctx.A, ctx.B, rk);
    }
    case 'toricone':
      return toriconeHead(cfg, R, inner);
  }
}

/** Paraboloid of revolution: the section radius falls as √(1 − t / depth). */
function paraboloidHead(d: number): HeadProfile {
  return {
    type: 'paraboloid',
    depth: d,
    breaks: [],
    closed: false,
    smooth: false,
    endKu: 0,
    endKv: 0,
    at(t, out) {
      const k = Math.sqrt(Math.max(0, 1 - t / d));
      out.ku = k;
      out.kv = k;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label: 'Paraboloidal' },
  };
}

/**
 * Flat head with a rounded knuckle (flanged-only head): a quarter circle of radius
 * rk turns the shell into a flat plate. Every side moves in by the same amount, so a
 * box gets rounded edges with flat sides, and a cylinder a rounded rim.
 */
function flangedHead(A: number, B: number, rk: number): HeadProfile {
  const inset = (t: number) => rk - Math.sqrt(Math.max(0, rk * rk - t * t));
  return {
    type: 'flanged',
    depth: rk,
    breaks: [],
    closed: true,
    smooth: true,
    endKu: (A - rk) / A,
    endKv: (B - rk) / B,
    at(t, out) {
      const d = inset(Math.min(t, rk));
      out.ku = (A - d) / A;
      out.kv = (B - d) / B;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label: 'Flanged flat head', knuckleR: rk },
  };
}

/**
 * Cone with a knuckle at the shell (toriconical): a circle of radius rk turns the
 * shell to the cone wall, then the cone runs straight to the outlet.
 */
function toriconeHead(cfg: HeadConfig, R: number, inner: (d: number) => number): HeadProfile {
  const ro = clamp(cfg.outlet / 2, 0, 0.98 * R);
  const rkIn = clamp(inner(cfg.knuckleR), 1e-4 * R, 0.98 * (R - ro));
  // Wall angle alpha from the end plane; the knuckle ends where its slope matches the cone.
  const shape = (alpha: number) => {
    const s = Math.sin(alpha);
    const c = Math.cos(alpha);
    const rk = Math.min(rkIn, (0.999 * (R - ro)) / Math.max(1 - s, 1e-9));
    const tK = rk * c;
    const rK = R - rk * (1 - s);
    const depth = tK + (rK - ro) * (s / c);
    return { rk, tK, rK, depth };
  };
  let alpha: number;
  let issue: string | undefined;
  if (cfg.sizeBy === 'angle') alpha = clamp(cfg.angle, 0.5, 89) * (Math.PI / 180);
  else {
    const target = inner(cfg.depth);
    const lo = 0.5 * (Math.PI / 180);
    const hi = 89 * (Math.PI / 180);
    if (target <= shape(lo).depth) {
      alpha = lo;
      issue = `A toriconical head is at least about ${Math.round(shape(lo).depth)} mm deep inside with this knuckle (that is almost a flat head with a knuckle).`;
    } else if (target >= shape(hi).depth) {
      alpha = hi;
      issue = `With this knuckle and outlet the head can be at most ${Math.round(shape(hi).depth)} mm deep inside.`;
    } else {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 100; i++) {
        const m = (a + b) / 2;
        if (shape(m).depth < target) a = m;
        else b = m;
      }
      alpha = (a + b) / 2;
    }
  }
  const { rk, tK, rK, depth } = shape(alpha);
  const cot = Math.cos(alpha) / Math.sin(alpha);
  const deg = (alpha * 180) / Math.PI;
  return {
    type: 'toricone',
    depth,
    breaks: tK > 0 && tK < depth ? [tK] : [],
    closed: ro > 1e-6,
    smooth: true,
    endKu: ro / R,
    endKv: ro / R,
    at(t, out) {
      const r = t <= tK ? R - rk + Math.sqrt(Math.max(0, rk * rk - t * t)) : Math.max(ro, rK - (t - tK) * cot);
      const k = r / R;
      out.ku = k;
      out.kv = k;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label: `Toriconical, ${deg.toFixed(1)}° wall`, angle: deg, knuckleR: rk, outletU: 2 * ro, outletV: 2 * ro, issue },
  };
}

function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function flatHead(): HeadProfile {
  return {
    type: 'flat',
    depth: 0,
    breaks: [],
    closed: true,
    smooth: false,
    endKu: 1,
    endKv: 1,
    at(_t, out) {
      out.ku = 1;
      out.kv = 1;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label: 'Flat' },
  };
}

function ellipsoidalHead(type: HeadType, R: number, depth: number, label: string): HeadProfile {
  const d = Math.max(depth, 1e-9);
  return {
    type,
    depth: d,
    breaks: [],
    closed: false,
    smooth: true,
    endKu: 0,
    endKv: 0,
    at(t, out) {
      const f = t / d;
      const k = f >= 1 ? 0 : Math.sqrt(Math.max(0, 1 - f * f));
      out.ku = k;
      out.kv = k;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label, arc: 2 * quarterEllipse(R, d) },
  };
}

/** Length of a quarter ellipse with semi-axes a and b (Simpson's rule on the smooth parametric integrand). */
export function quarterEllipse(a: number, b: number): number {
  const n = 256;
  const f = (th: number) => Math.hypot(a * Math.sin(th), b * Math.cos(th));
  const hh = Math.PI / 2 / n;
  let sum = f(0) + f(Math.PI / 2);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * hh);
  return (sum * hh) / 3;
}

/**
 * Semi-ellipsoidal head from the arc length over it, tangent line to tangent line
 * through the centre. With t > 0 the arc is measured on the outside surface, which
 * is longer by π t (the surface turns through half a turn). R is the inside radius.
 */
export function ellipsoidFromArc(R: number, arc: number, t: number): { depth: number; issue?: string } {
  const lo = R / 20;
  const hi = 2 * R;
  const inside = arc - Math.PI * t;
  const arcOf = (d: number) => 2 * quarterEllipse(R, d);
  if (!(inside > arcOf(lo))) return { depth: lo, issue: `A semi-ellipsoidal head on this shell has an arc of at least ${mm(arcOf(lo) + Math.PI * t)} (a 20:1 head).` };
  if (inside > arcOf(hi)) return { depth: hi, issue: `A semi-ellipsoidal head on this shell can have an arc of at most ${mm(arcOf(hi) + Math.PI * t)} (a 0.5:1 head).` };
  let a = lo;
  let b = hi;
  for (let k = 0; k < 80; k++) {
    const m = (a + b) / 2;
    if (arcOf(m) < inside) a = m;
    else b = m;
  }
  return { depth: (a + b) / 2 };
}

function dishedHead(R: number, d: number): HeadProfile {
  const Rs = (R * R + d * d) / (2 * d);
  return {
    type: 'dished',
    depth: d,
    breaks: [],
    closed: false,
    smooth: Math.abs(d - R) < 1e-9 * R,
    endKu: 0,
    endKv: 0,
    at(t, out) {
      const y = t + Rs - d;
      const k = Math.sqrt(Math.max(0, Rs * Rs - y * y)) / R;
      out.ku = k;
      out.kv = k;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label: 'Shallow dome (spherical cap)', sphereR: Rs, arc: 2 * Rs * Math.asin(Math.min(1, R / Rs)) },
  };
}

function torisphericalHead(R: number, crownIn: number, knuckleIn: number, label: string): HeadProfile {
  const rk = clamp(knuckleIn, 1e-4 * R, 0.999 * R);
  const Rc = Math.max(crownIn, R * 1.0001, rk * 1.0001);
  const tc = -Math.sqrt(Math.max(0, (Rc - rk) ** 2 - (R - rk) ** 2));
  const depth = Rc + tc;
  const tT = (-tc * rk) / (Rc - rk);
  return {
    type: 'torispherical',
    depth,
    breaks: tT > 0 && tT < depth ? [tT] : [],
    closed: false,
    smooth: true,
    endKu: 0,
    endKv: 0,
    at(t, out) {
      let r: number;
      if (t <= tT) r = R - rk + Math.sqrt(Math.max(0, rk * rk - t * t));
      else {
        const y = t - tc;
        r = Math.sqrt(Math.max(0, Rc * Rc - y * y));
      }
      const k = r / R;
      out.ku = k;
      out.kv = k;
      out.du = 0;
      out.dv = 0;
      return out;
    },
    meta: { label, crownR: Rc, knuckleR: rk, arc: toriShape(R, Rc, rk).arc },
  };
}

/** Cone / pyramid, V-trough and single slope: sections shrink linearly. */
function linearHead(
  cfg: HeadConfig,
  ctx: HeadContext,
  type: 'cone' | 'wedge' | 'sloped',
  inner: (d: number) => number,
): HeadProfile {
  const { A, B } = ctx;
  let kEu = 1;
  let kEv = 1;
  // Axis the slanted wall runs along, and whether one side stays straight.
  let runAxis: 'u' | 'v' = 'u';
  let eccentric = false;

  if (type === 'cone') {
    kEu = clamp(cfg.outlet / 2 / A, 0, 0.98);
    kEv = ctx.elliptic ? kEu : clamp(cfg.outlet2 / 2 / B, 0, 0.98);
    eccentric = cfg.eccentric;
    runAxis = eccentric && ctx.orientation === 'horizontal' ? 'v' : 'u';
  } else if (type === 'wedge') {
    runAxis = cfg.axis;
    const E = runAxis === 'u' ? A : B;
    const kE = clamp(cfg.outlet / 2 / E, 0, 0.98);
    if (runAxis === 'u') kEu = kE;
    else kEv = kE;
  } else {
    runAxis = 'u';
    eccentric = true;
    kEu = clamp(cfg.outlet / A / 2, 0, 0.98);
  }

  const E = runAxis === 'u' ? A : B;
  const kE = runAxis === 'u' ? kEu : kEv;
  const run = (eccentric ? 2 : 1) * E * (1 - kE);
  let depth: number;
  if (cfg.sizeBy === 'angle') {
    const ang = clamp(cfg.angle, 0.5, 89) * (Math.PI / 180);
    depth = run * Math.tan(ang);
  } else {
    depth = inner(cfg.depth);
  }
  if (depth <= 1e-6) return flatHead();
  const angle = (Math.atan2(depth, run) * 180) / Math.PI;
  const sign = cfg.side === 'neg' ? -1 : 1;
  const d = depth;

  const label =
    type === 'cone'
      ? `${eccentric ? 'Eccentric conical' : ctx.elliptic ? 'Conical' : 'Pyramid (hopper)'}, ${angle.toFixed(1)}° wall`
      : type === 'wedge'
        ? `V-trough, ${angle.toFixed(1)}° walls`
        : `Single slope, ${angle.toFixed(1)}°`;

  return {
    type,
    depth: d,
    breaks: [],
    closed: kEu > 1e-6 && kEv > 1e-6,
    smooth: false,
    endKu: kEu,
    endKv: kEv,
    at(t, out) {
      const f = clamp(t / d, 0, 1);
      const ku = 1 - (1 - kEu) * f;
      const kv = 1 - (1 - kEv) * f;
      out.ku = ku;
      out.kv = kv;
      out.du = 0;
      out.dv = 0;
      if (eccentric) {
        if (runAxis === 'u') out.du = sign * A * (1 - ku);
        else out.dv = sign * B * (1 - kv);
      }
      return out;
    },
    meta: { label, angle, outletU: 2 * kEu * A, outletV: 2 * kEv * B },
  };
}

/** Depth and edge-to-edge arc length of a torispherical head (all inside sizes). */
export function toriShape(R: number, Rc: number, rk: number): { depth: number; arc: number } {
  const s = Math.max(0, (Rc - rk) ** 2 - (R - rk) ** 2);
  const phi = Math.asin(clamp((R - rk) / (Rc - rk), 0, 1));
  return { depth: Rc - Math.sqrt(s), arc: 2 * (rk * (Math.PI / 2 - phi) + Rc * phi) };
}

const mm = (v: number) => `${Math.round(v)} mm`;

/**
 * Finds x in [lo, hi] with f(x) = 0 by scanning for a sign change and bisecting.
 * Without a sign change it returns the scanned x whose value is closest to zero.
 */
function solve1d(f: (x: number) => number, lo: number, hi: number, n = 400): { x: number; exact: boolean } {
  let px = lo;
  let pv = f(lo);
  if (pv === 0) return { x: lo, exact: true };
  let best = { x: lo, v: Math.abs(pv) };
  for (let i = 1; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    const v = f(x);
    if (Math.abs(v) < best.v) best = { x, v: Math.abs(v) };
    if (v === 0) return { x, exact: true };
    if (pv * v < 0) {
      let a = px;
      let b = x;
      let fa = pv;
      for (let k = 0; k < 100; k++) {
        const m = (a + b) / 2;
        const fm = f(m);
        if (fa * fm <= 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      return { x: (a + b) / 2, exact: true };
    }
    px = x;
    pv = v;
  }
  return { x: best.x, exact: false };
}

/**
 * Crown and knuckle radii of a torispherical head from any two of: depth, crown
 * radius, knuckle radius and arc length (all inside sizes, shell radius R), or from
 * the depth or arc alone with the knuckle radius taken as knuckleD × D.
 * When the two sizes cannot describe a torispherical head, the closest head is
 * returned with a plain explanation in `issue`.
 */
export function solveMeasuredTori(
  R: number,
  by: ToriBy,
  m: { depth: number; crown: number; knuckle: number; arc: number; knuckleD?: number },
): { crown: number; knuckle: number; issue?: string } {
  if (by === 'depth' || by === 'arc') {
    // One measurement: the knuckle follows the standard (DIN / Klöpper 0.1 D), the crown is solved.
    const rk = clamp((m.knuckleD ?? 0.1) * 2 * R, 1e-4 * R, 0.999 * R);
    return solveMeasuredTori(R, by === 'depth' ? 'depth-knuckle' : 'arc-knuckle', { ...m, knuckle: rk });
  }
  const rkMin = 1e-4 * R;
  const rkMax = 0.999 * R;
  const RcMin = R * 1.0001;
  const RcMax = R * 1e4;
  // Exact relations between depth d, crown Rc and knuckle rk:
  // Rc = (d² + (R − rk)² − rk²) / (2 (d − rk)) and rk = (Rc² − R² − (Rc − d)²) / (2 (Rc − R)).
  const crownOf = (d: number, rk: number) => (d * d + (R - rk) ** 2 - rk * rk) / (2 * (d - rk));
  const knuckleOf = (d: number, Rc: number) => (Rc * Rc - R * R - (Rc - d) ** 2) / (2 * (Rc - R));
  const done = (crown: number, knuckle: number, issue?: string) => {
    const c = clamp(Number.isFinite(crown) ? crown : RcMax, RcMin, RcMax);
    return { crown: c, knuckle: clamp(Number.isFinite(knuckle) ? knuckle : rkMin, rkMin, rkMax), issue };
  };
  const crownTooSmall = `The crown radius must be larger than the inside radius (${mm(R)}).`;
  const knuckleOut = `The knuckle radius must be more than 0 and less than the inside radius (${mm(R)}).`;

  if (by === 'depth-crown' || by === 'depth-knuckle' || by === 'arc-depth') {
    if (!(m.depth > 0)) return done(2 * R, 0.1 * 2 * R, 'Type a head depth greater than the wall thickness.');
    if (m.depth > R * 1.000001) return done(RcMin, rkMax, `A dished head cannot be deeper than the inside radius (${mm(R)}). Use semi-ellipsoidal for deeper heads.`);
  }
  switch (by) {
    case 'crown-knuckle': {
      if (!(m.crown > R)) return done(m.crown, m.knuckle, crownTooSmall);
      if (!(m.knuckle > 0 && m.knuckle < R)) return done(m.crown, m.knuckle, knuckleOut);
      return done(m.crown, m.knuckle);
    }
    case 'depth-crown': {
      const Rc = m.crown;
      if (!(Rc > R)) return done(RcMin, m.depth, crownTooSmall);
      const capDepth = Rc - Math.sqrt(Rc * Rc - R * R);
      if (m.depth < capDepth * (1 - 1e-9)) {
        return done(Rc, rkMin, `With this crown radius the head is at least ${mm(capDepth)} deep inside (a plain dish). Type a deeper head or a larger crown radius.`);
      }
      return done(Rc, knuckleOf(m.depth, Rc));
    }
    case 'depth-knuckle': {
      const rk = m.knuckle;
      if (!(rk > 0 && rk < R)) return done(crownOf(m.depth, rkMin), rkMin, knuckleOut);
      if (rk >= m.depth) return done(RcMax, rk, `The head must be deeper than its knuckle radius (${mm(rk)} inside).`);
      return done(crownOf(m.depth, rk), rk);
    }
    case 'arc-crown': {
      const Rc = m.crown;
      if (!(Rc > R)) return done(RcMin, rkMin, crownTooSmall);
      const r = solve1d((rk) => toriShape(R, Rc, rk).arc - m.arc, rkMin, rkMax);
      if (r.exact) return done(Rc, r.x);
      const a0 = toriShape(R, Rc, rkMin).arc;
      const a1 = toriShape(R, Rc, rkMax).arc;
      return done(Rc, r.x, `With this crown radius the inside arc must be between ${mm(Math.min(a0, a1))} and ${mm(Math.max(a0, a1))}.`);
    }
    case 'arc-knuckle': {
      if (!(m.knuckle > 0 && m.knuckle < R)) return done(2 * R, m.knuckle, knuckleOut);
      const rk = clamp(m.knuckle, rkMin, rkMax);
      // Search over s = R / Rc in (0, 1) so very flat crowns are reachable.
      const r = solve1d((s) => toriShape(R, R / s, rk).arc - m.arc, R / RcMax, 1 / 1.0001);
      if (r.exact) return done(R / r.x, rk);
      const a0 = toriShape(R, RcMax, rk).arc;
      const a1 = toriShape(R, RcMin, rk).arc;
      return done(R / r.x, rk, `With this knuckle radius the inside arc must be between ${mm(Math.min(a0, a1))} and ${mm(Math.max(a0, a1))}.`);
    }
    case 'arc-depth': {
      const d = m.depth;
      // The knuckle runs from almost 0 (a plain dish) to almost the depth (a flat crown).
      const hi = Math.min(d * 0.9999, rkMax);
      const r = solve1d((rk) => toriShape(R, crownOf(d, rk), rk).arc - m.arc, rkMin, hi);
      if (r.exact) return done(crownOf(d, r.x), r.x);
      const a0 = toriShape(R, crownOf(d, rkMin), rkMin).arc;
      const a1 = toriShape(R, crownOf(d, hi), hi).arc;
      return done(crownOf(d, r.x), r.x, `With this depth the inside arc must be between ${mm(Math.min(a0, a1))} and ${mm(Math.max(a0, a1))}.`);
    }
  }
}

/**
 * Spherical cap (shallow dome) from the arc length over it, edge to edge through
 * the centre. R is the inside radius. With t > 0 the arc is measured on the outside
 * surface: a sphere t larger on the same centre, from the outside wall on one side
 * to the outside wall on the other (where a tape laid over the roof starts and ends).
 */
export function capFromArc(R: number, arc: number, t: number): { depth: number; issue?: string } {
  // Inside half angle phi: the inside sphere R / sin phi meets the inside wall; the
  // outside sphere (one wall larger) meets the outside wall, R + t from the axis.
  const arcOf = (phi: number) => {
    const So = R / Math.sin(phi) + t;
    // Without a wall the arc spans exactly phi (asin loses digits near a half sphere).
    return 2 * So * (t > 0 ? Math.asin(Math.min(1, (R + t) / So)) : phi);
  };
  const hi = arcOf(Math.PI / 2);
  if (!(arc > 2 * (R + t))) return { depth: 0, issue: `The arc must be longer than the ${t > 0 ? 'outside' : 'inside'} diameter (${mm(2 * (R + t))}).` };
  let phi = Math.PI / 2;
  let issue: string | undefined;
  if (arc > hi * (1 + 1e-9)) issue = `A dome on this shell can have an arc of at most ${mm(hi)} (a half sphere).`;
  else {
    let a = 1e-9;
    let b = Math.PI / 2;
    for (let k = 0; k < 100; k++) {
      const mid = (a + b) / 2;
      if (arcOf(mid) < arc) a = mid;
      else b = mid;
    }
    phi = (a + b) / 2;
  }
  const Rs = R / Math.sin(phi);
  return { depth: Rs * (1 - Math.cos(phi)), issue };
}
