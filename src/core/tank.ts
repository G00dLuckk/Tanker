import { outlinePerimeter, outlineShape } from './bodies';
import { resolveHead, type HeadContext, type HeadProfile, type HeadSample } from './heads';
import { contains, polygonShape, polygonWidthAcrossCorners, shapeArea, type BaseShape } from './shape';
import type { BodyConfig, BodyType, HeadConfig, Orientation, TankConfig } from './types';

/**
 * Tank frame: a runs along the tank axis (up for vertical tanks, left→right for
 * horizontal tanks), u and v span the cross-section. For vertical tanks u is X
 * and v is the plan Y (front→back). For horizontal tanks u is the plan Y (across)
 * and v points up. The shell runs from a = 0 to a = L; the start head occupies
 * a < 0, the end head a > L.
 */
export interface Sec {
  ku: number;
  kv: number;
  cu: number;
  cv: number;
}

export interface Piece {
  kind: 'start' | 'body' | 'end';
  a0: number;
  a1: number;
}

export interface TankModel {
  orientation: Orientation;
  bodyType: BodyType;
  /** Inside cross-section at the start of the shell. */
  base: BaseShape;
  area0: number;
  round: boolean;
  /** Straight shell length (mm). */
  L: number;
  /** Scale of the shell's end section (taper). */
  endScale: number;
  /** Largest section scale along the shell (1 for straight shells). */
  maxScale: number;
  /** Custom shell profile as (a, scale) points from a = 0 to a = L, or null for a straight / tapered shell. */
  profile: { a: number; k: number }[] | null;
  start: HeadProfile;
  end: HeadProfile;
  aMin: number;
  aMax: number;
  pieces: Piece[];
  /** All a-values where the profile formula changes. */
  breaks: number[];
  /** Wall thickness of shell and heads (mm). */
  t: { shell: number; start: number; end: number };
  /** Characteristic size for tolerances (mm). */
  size: number;
  section(a: number, out: Sec): Sec;
  inside(a: number, u: number, v: number): boolean;
  /** Outside dimensions for display (mm). */
  outer: { width: number; depth: number; length: number; endWidth: number; endDepth: number };
  /** Inside dimensions for display (mm). */
  innerDims: { width: number; depth: number; length: number };
  /** Inputs that make no tank at all. */
  problems: string[];
  /** Typed sizes that could not be met exactly (circumference, overall length, measured heads); the tank is the closest fit. */
  warnings: string[];
}

const MIN_SIZE = 1; // mm

const fmtMm = (v: number) => `${Math.round(v).toLocaleString('en-US')} mm`;

/** Circumference of the shell from the typed sizes (per the dimension basis). */
export function bodyPerimeter(b: BodyConfig): number {
  const W = Math.max(0, b.width);
  const D = Math.max(0, b.depth);
  switch (b.type) {
    case 'cylinder':
    case 'sphere':
      return Math.PI * Math.max(0, b.diameter);
    case 'oval': {
      // Ramanujan's second approximation, exact for circles, within 1e-5 % for ovals up to 4:1.
      const a = W / 2;
      const c = D / 2;
      if (a + c <= 0) return 0;
      const q = ((a - c) / (a + c)) ** 2;
      return Math.PI * (a + c) * (1 + (3 * q) / (10 + Math.sqrt(4 - 3 * q)));
    }
    case 'rect':
    case 'stadium': {
      const r = b.type === 'stadium' ? Math.min(W, D) / 2 : Math.min(Math.max(0, b.corner), W / 2, D / 2);
      return 2 * (W + D) - (8 - 2 * Math.PI) * r;
    }
    case 'polygon': {
      const P = polygonShape(b.sides, W / 2, D / 2).poly!;
      let s = 0;
      for (let i = 0, n = P.u.length; i < n; i++) {
        const j = (i + 1) % n;
        s += Math.hypot(P.u[j] - P.u[i], P.v[j] - P.v[i]);
      }
      return s;
    }
    case 'chamfer':
    case 'trapezoid':
    case 'boxoval':
    case 'dshape':
    case 'trough':
      return outlinePerimeter(b, b.type);
  }
}

/** The body with a new width; a trapezoid keeps the ratio of its two widths. */
function withWidth(b: BodyConfig, w: number): BodyConfig {
  return { ...b, width: w, width2: b.type === 'trapezoid' && b.width > 0 ? (b.width2 * w) / b.width : b.width2 };
}

/**
 * The body with the diameter (round) or width (other shapes) worked out from the
 * circumference when the size is given that way. Depth / height stays as typed.
 */
export function resolveBodySize(cfg: TankConfig): { body: BodyConfig; issue?: string } {
  const b = cfg.body;
  if (b.uniform && b.type !== 'sphere') return { body: uniformBody(b) };
  if (b.sizeBy !== 'perimeter') return { body: b };
  const P = b.perimeter;
  if (!(P > 0)) return { body: b, issue: 'Type the circumference of the shell.' };
  if (b.type === 'cylinder' || b.type === 'sphere') return { body: { ...b, diameter: P / Math.PI } };
  const at = (w: number) => bodyPerimeter(withWidth(b, w));
  const lo = 1e-6;
  if (!(at(lo) < P)) {
    return { body: b, issue: `With this ${cfg.orientation === 'vertical' ? 'depth' : 'height'} the circumference must be more than ${fmtMm(at(lo))}.` };
  }
  let hi = Math.max(b.width, b.depth, 1);
  for (let i = 0; i < 80 && at(hi) < P; i++) hi *= 2;
  let a = lo;
  for (let i = 0; i < 100; i++) {
    const m = (a + hi) / 2;
    if (at(m) < P) a = m;
    else hi = m;
  }
  return { body: withWidth(b, (a + hi) / 2) };
}

/** Body types whose width and depth are one size (a diameter). */
export function isRoundBody(type: BodyConfig['type']): boolean {
  return type === 'cylinder' || type === 'sphere';
}

/**
 * Same size: width (X), depth (Y) and straight shell length (Z) all take the width,
 * or the diameter of a round shell. The size is the diameter / width as typed and the
 * length is the straight shell.
 */
export function uniformBody(b: BodyConfig): BodyConfig {
  const x = isRoundBody(b.type) ? b.diameter : b.width;
  return { ...b, sizeBy: 'size', lengthBy: 'shell', diameter: x, width: x, depth: x, length: x };
}

/** Head shapes that can be as deep as the shell is wide, so a same-size (Z = X) head is possible. */
export function canBeUniform(type: HeadConfig['type']): boolean {
  return type === 'ellipsoidal' || type === 'paraboloid' || type === 'cone' || type === 'toricone' || type === 'wedge' || type === 'sloped';
}

/** A same-size head: its depth is the shell width x at its end (on the dimension basis). */
export function uniformHead(h: HeadConfig, x: number): HeadConfig {
  if (!h.uniform || !canBeUniform(h.type)) return h;
  return { ...h, ratioBy: 'depth', sizeBy: 'depth', depth: x };
}

/** Overall length (height) of a model, end to end, on the dimension basis. */
export function overallOf(m: TankModel, basis: TankConfig['basis']): number {
  return basis === 'outside' ? m.outer.length : m.innerDims.length;
}

export function buildTank(cfg: TankConfig): TankModel {
  const sized = resolveBodySize(cfg);
  const base: TankConfig = sized.body === cfg.body ? cfg : { ...cfg, body: sized.body };
  const extra = sized.issue ? [sized.issue] : [];
  if (base.body.lengthBy !== 'overall' || cfg.body.type === 'sphere') return withWarnings(buildShell(base), extra);

  // Overall length given: the straight shell is whatever is left between the two ends.
  // The ends do not depend on the shell length (except through a stepped profile), so this settles in a step or two.
  const target = cfg.body.overall;
  const at = (L: number) => buildShell({ ...base, body: { ...base.body, length: L } });
  let L = Math.max(0, Number.isFinite(base.body.length) ? base.body.length : 0);
  let m = at(L);
  for (let i = 0; i < 30; i++) {
    const next = Math.max(0, target - (overallOf(m, cfg.basis) - m.L));
    if (Math.abs(next - L) < 1e-7 * Math.max(1, target)) break;
    L = next;
    m = at(L);
  }
  const what = cfg.orientation === 'vertical' ? 'height' : 'length';
  if (!(target > 0)) extra.push(`Type the overall ${what}.`);
  else if (Math.abs(overallOf(m, cfg.basis) - target) > 0.05) {
    const ends = overallOf(m, cfg.basis) - m.L;
    extra.push(
      target < ends
        ? `The overall ${what} (${fmtMm(target)}) is shorter than the two ends alone (${fmtMm(ends)}).`
        : `The overall ${what} could not be matched; it is ${fmtMm(overallOf(m, cfg.basis))}.`,
    );
  }
  return withWarnings(m, extra);
}

function withWarnings(m: TankModel, extra: string[]): TankModel {
  if (extra.length) m.warnings.unshift(...extra);
  return m;
}

/**
 * Writes the worked-out values back into the inputs so every way of giving a size
 * agrees: diameter / width from the circumference, shell length from the overall
 * length, and the circumference and overall length from the current tank.
 * Used when switching how a size is given, so the tank does not change.
 */
export function syncTankInputs(t: TankConfig): void {
  const m = buildTank(t);
  const sized = resolveBodySize(t).body;
  t.body.diameter = sized.diameter;
  t.body.width = sized.width;
  if (t.body.lengthBy === 'overall' && t.body.type !== 'sphere' && m.problems.length === 0) t.body.length = m.L;
  t.body.perimeter = bodyPerimeter(t.body);
  t.body.overall = overallOf(m, t.basis);
}

function buildShell(cfg: TankConfig): TankModel {
  const problems: string[] = [];
  const warnings: string[] = [];
  const b = cfg.body;
  const outside = cfg.basis === 'outside';
  const ts = Math.max(0, b.thickness);
  const sphere = b.type === 'sphere';

  // Polygons measured across corners lose more than 2 × wall from the outside size.
  const cornerWall = b.type === 'polygon' && polygonWidthAcrossCorners(b.sides) ? 1 / Math.cos(Math.PI / Math.max(6, b.sides)) : 1;
  const innerOf = (outerSize: number, label: string, k = 1) => {
    const v = outside ? outerSize - 2 * ts * k : outerSize;
    if (!(v > MIN_SIZE)) {
      problems.push(`${label} is too small for the wall thickness.`);
      return MIN_SIZE * 10;
    }
    return v;
  };

  let base: BaseShape;
  switch (b.type) {
    case 'cylinder':
    case 'sphere': {
      const R = innerOf(b.diameter, 'Diameter') / 2;
      base = { kind: 'ellipse', A: R, B: R, rho: 0 };
      break;
    }
    case 'oval':
      base = {
        kind: 'ellipse',
        A: innerOf(b.width, 'Width') / 2,
        B: innerOf(b.depth, cfg.orientation === 'vertical' ? 'Depth' : 'Height') / 2,
        rho: 0,
      };
      break;
    case 'rect': {
      const A = innerOf(b.width, 'Width') / 2;
      const B = innerOf(b.depth, cfg.orientation === 'vertical' ? 'Depth' : 'Height') / 2;
      const rho = Math.min(Math.max(0, outside ? b.corner - ts : b.corner), A, B);
      base = { kind: 'roundrect', A, B, rho };
      break;
    }
    case 'stadium': {
      const A = innerOf(b.width, 'Width') / 2;
      const B = innerOf(b.depth, cfg.orientation === 'vertical' ? 'Depth' : 'Height') / 2;
      base = { kind: 'roundrect', A, B, rho: Math.min(A, B) };
      break;
    }
    case 'polygon': {
      const A = innerOf(b.width, 'Width', cornerWall) / 2;
      const B = innerOf(b.depth, cfg.orientation === 'vertical' ? 'Depth' : 'Height') / 2;
      base = polygonShape(b.sides, A, B);
      break;
    }
    case 'chamfer':
    case 'trapezoid':
    case 'boxoval':
    case 'dshape':
    case 'trough':
      base = outlineShape(b, b.type, ts, outside, MIN_SIZE, (msg) => problems.push(msg), cfg.orientation === 'vertical' ? 'Depth' : 'Height');
      break;
  }

  const round = base.kind === 'ellipse' && Math.abs(base.A - base.B) < 1e-9;
  let L = sphere ? 0 : Math.max(0, Number.isFinite(b.length) ? b.length : 0);
  // Custom profile: section scale at points along the shell, linear in between.
  const sizeRef = 2 * base.A;
  const widthWall = b.type === 'polygon' ? cornerWall : 1;
  const profile =
    !sphere && b.profileOn && L > 0
      ? [
          { a: 0, k: 1 },
          ...(b.profile ?? [])
            .filter((pt) => Number.isFinite(pt.at) && Number.isFinite(pt.size) && pt.at > 0)
            .map((pt) => ({ a: Math.min(pt.at, L), k: clampScale(((outside ? pt.size - 2 * ts * widthWall : pt.size) || 0) / sizeRef) }))
            .sort((x, y) => x.a - y.a),
        ]
      : null;
  if (profile) {
    // Points closer than 0.1 mm collapse into one; the last one holds to the end of the shell.
    for (let i = profile.length - 1; i > 0; i--) if (profile[i].a - profile[i - 1].a < 0.1) profile.splice(i, 1);
    if (profile[profile.length - 1].a < L) profile.push({ a: L, k: profile[profile.length - 1].k });
  }
  const endScale = sphere ? 1 : profile ? profile[profile.length - 1].k : clampScale(b.endScale);
  const profileScale = (a: number): number => {
    const P = profile!;
    if (a <= 0) return P[0].k;
    for (let i = 1; i < P.length; i++) {
      if (a <= P[i].a) return P[i - 1].k + ((P[i].k - P[i - 1].k) * (a - P[i - 1].a)) / (P[i].a - P[i - 1].a);
    }
    return P[P.length - 1].k;
  };
  const maxScale = profile ? Math.max(...profile.map((pt) => pt.k)) : Math.max(1, endScale);

  const headCfg = (h: HeadConfig): HeadConfig => (sphere ? { ...h, type: 'hemi', thickness: ts } : h);
  const ctx = (k: number): HeadContext => ({
    A: base.A * k,
    B: base.B * k,
    round,
    elliptic: base.kind === 'ellipse',
    orientation: cfg.orientation,
    basis: cfg.basis,
  });
  // Same-size heads: depth = the shell width at that end, on the dimension basis.
  const widthAt = (k: number) => 2 * base.A * k + (outside ? 2 * ts : 0);
  const startCfg = uniformHead(headCfg(cfg.start), widthAt(1));
  // Linked ends: the end gets exactly the start's inside shape; its own plate thickness only changes the outside (t.end below).
  const endCfg = uniformHead(headCfg(cfg.sameEnds ? cfg.start : cfg.end), widthAt(endScale));
  const start = resolveHead(startCfg, ctx(1));
  const end = resolveHead(endCfg, ctx(endScale));
  const vertical = cfg.orientation === 'vertical';
  const sameIssue = !!cfg.sameEnds && start.meta.issue === end.meta.issue;
  if (!sphere && start.meta.issue) warnings.push(`${sameIssue ? 'Both ends' : vertical ? 'Bottom' : 'Left end'}: ${start.meta.issue}`);
  if (!sphere && end.meta.issue && !sameIssue) warnings.push(`${vertical ? 'Top' : 'Right end'}: ${end.meta.issue}`);

  if (!(L + start.depth + end.depth > MIN_SIZE)) {
    problems.push(
      cfg.orientation === 'vertical'
        ? 'The tank has no height: set a shell height or choose a domed or conical head.'
        : 'The tank has no length: set a shell length or choose a domed or conical end.',
    );
    L = MIN_SIZE * 10;
  }
  const aMin = -start.depth;
  const aMax = L + end.depth;

  const pieces: Piece[] = [];
  if (start.depth > 0) pieces.push({ kind: 'start', a0: aMin, a1: 0 });
  if (L > 0) pieces.push({ kind: 'body', a0: 0, a1: L });
  if (end.depth > 0) pieces.push({ kind: 'end', a0: L, a1: aMax });

  const brk = new Set<number>([aMin, 0, L, aMax]);
  if (profile) for (const pt of profile) brk.add(pt.a);
  for (const t of start.breaks) brk.add(-t);
  for (const t of end.breaks) brk.add(L + t);
  const breaks = [...brk].filter((a) => a >= aMin && a <= aMax).sort((x, y) => x - y);

  const hs: HeadSample = { ku: 1, kv: 1, du: 0, dv: 0 };
  const section = (a: number, out: Sec): Sec => {
    if (a < aMin || a > aMax) {
      out.ku = 0;
      out.kv = 0;
      out.cu = 0;
      out.cv = 0;
    } else if (a < 0) {
      start.at(-a, hs);
      out.ku = hs.ku;
      out.kv = hs.kv;
      out.cu = hs.du;
      out.cv = hs.dv;
    } else if (a <= L) {
      const s = profile ? profileScale(a) : L > 0 ? 1 + ((endScale - 1) * a) / L : 1;
      out.ku = s;
      out.kv = s;
      out.cu = 0;
      out.cv = 0;
    } else {
      end.at(a - L, hs);
      out.ku = endScale * hs.ku;
      out.kv = endScale * hs.kv;
      out.cu = hs.du;
      out.cv = hs.dv;
    }
    return out;
  };

  const tmp: Sec = { ku: 0, kv: 0, cu: 0, cv: 0 };
  const inside = (a: number, u: number, v: number): boolean => {
    if (a < aMin || a > aMax) return false;
    section(a, tmp);
    if (tmp.ku <= 1e-12 || tmp.kv <= 1e-12) return false;
    return contains(base, (u - tmp.cu) / tmp.ku, (v - tmp.cv) / tmp.kv);
  };

  const t = {
    shell: ts,
    start: sphere ? ts : Math.max(0, cfg.start.thickness),
    end: sphere ? ts : Math.max(0, cfg.end.thickness),
  };

  return {
    orientation: cfg.orientation,
    bodyType: b.type,
    base,
    area0: shapeArea(base),
    round,
    L,
    endScale,
    maxScale,
    profile,
    start,
    end,
    aMin,
    aMax,
    pieces,
    breaks,
    t,
    size: Math.max(2 * base.A * maxScale, 2 * base.B * maxScale, aMax - aMin),
    section,
    inside,
    outer: {
      width: 2 * (base.A + ts),
      depth: 2 * (base.B + ts),
      length: aMax - aMin + t.start + t.end,
      endWidth: 2 * (base.A * endScale + ts),
      endDepth: 2 * (base.B * endScale + ts),
    },
    innerDims: { width: 2 * base.A, depth: 2 * base.B, length: aMax - aMin },
    problems,
    warnings,
  };
}

function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(Math.max(s, 0.05), 20);
}
