import { chordRange, segBelow, shapeArea } from './shape';
import type { Sec, TankModel } from './tank';
import { MM3_TO_L } from './units';

/**
 * Liquid volume for any tank in the model, including installation tilt.
 *
 * The liquid surface is the plane {p : n·p = h} where n is world-up expressed
 * in the tank frame. Tilt only rotates the tank about the axis that keeps the
 * cut-away plane fixed, so n has an axial component plus at most one in-section
 * component (u for vertical tanks, v for horizontal tanks). Each cross-section
 * is then cut by a straight line parallel to one of its own axes, whose wetted
 * area has a closed form. The volume is the integral of that area along the
 * axis, done piecewise with Gauss–Legendre after splitting at every point where
 * the surface starts or stops cutting a section.
 */

// 10-point Gauss–Legendre nodes and weights on [-1, 1].
const GL_X = [
  -0.9739065285171717, -0.8650633666889845, -0.6794095682990244, -0.4333953941292472, -0.1488743389816312,
  0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845, 0.9739065285171717,
];
const GL_W = [
  0.0666713443086881, 0.1494513491505806, 0.219086362515982, 0.2692667193099963, 0.2955242247147529,
  0.2955242247147529, 0.2692667193099963, 0.219086362515982, 0.1494513491505806, 0.0666713443086881,
];

const SAMPLES_PER_PIECE = 48;

/**
 * What every part of the app needs from a level → volume model, whatever the shape:
 * the closed tanks below (VolumeEngine) and open concrete storages (PitEngine).
 * Levels are mm above level zero (the lowest inside point), volumes mm³.
 */
export interface LevelEngine {
  readonly depth: number;
  readonly total: number;
  readonly totalLitres: number;
  readonly curveLevels: Float64Array;
  readonly curveVolumes: Float64Array;
  /** In-section axis cut by the liquid surface: 0 = u, 1 = v, -1 = none (no tilt). */
  readonly axis: -1 | 0 | 1;
  readonly na: number;
  readonly nw: number;
  readonly hMin: number;
  readonly hMax: number;
  volume(level: number): number;
  litres(level: number): number;
  levelOf(volume: number): number;
  quickVolume(level: number): number;
  surfaceArea(level: number): number;
  levelOfPoint(a: number, u: number, v: number): number;
  /** Levels where the shape changes (ends of heads, floor breaks): always kept in compact tables. */
  breakLevels(): number[];
}

interface PieceCache {
  a0: number;
  a1: number;
  /** Panels per sub-interval for the integration. */
  panels: number;
  sa: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  full: number;
}

export class VolumeEngine implements LevelEngine {
  readonly model: TankModel;
  readonly tiltDeg: number;
  /** World-up components in the tank frame. */
  readonly na: number;
  readonly nw: number;
  /** In-section axis cut by the surface: 0 = u, 1 = v, -1 = none (upright tank). */
  readonly axis: -1 | 0 | 1;
  /** Plane offsets of the empty and full tank. */
  readonly hMin: number;
  readonly hMax: number;
  /** Largest liquid depth (mm). */
  readonly depth: number;
  /** Total internal volume (mm³). */
  readonly total: number;
  /** Dense level→volume curve for fast lookups. */
  readonly curveLevels: Float64Array;
  readonly curveVolumes: Float64Array;

  private readonly pieces: PieceCache[];
  private readonly sec: Sec = { ku: 0, kv: 0, cu: 0, cv: 0 };
  private readonly E: number;

  constructor(model: TankModel, tiltDeg = 0, curvePoints = 600) {
    this.model = model;
    this.tiltDeg = tiltDeg;
    const th = (tiltDeg * Math.PI) / 180;
    if (model.orientation === 'vertical') {
      this.na = Math.cos(th);
      const nu = -Math.sin(th);
      if (Math.abs(nu) < 1e-12) {
        this.axis = -1;
        this.nw = 0;
        this.na = 1;
      } else {
        this.axis = 0;
        this.nw = nu;
      }
    } else {
      this.na = Math.sin(th);
      this.nw = Math.cos(th);
      this.axis = 1;
    }
    this.E = this.axis === 0 ? model.base.A : model.base.B;

    this.pieces = model.breaks.slice(0, -1).map((a0, i) => this.cachePiece(a0, model.breaks[i + 1]));

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.pieces) {
      for (let i = 0; i < p.sa.length; i++) {
        if (p.lo[i] < lo) lo = p.lo[i];
        if (p.hi[i] > hi) hi = p.hi[i];
      }
    }
    this.hMin = this.refineExtreme(lo, -1);
    this.hMax = this.refineExtreme(hi, 1);
    this.depth = this.hMax - this.hMin;
    this.total = this.pieces.reduce((s, p) => s + p.full, 0);

    const n = Math.max(16, curvePoints);
    this.curveLevels = new Float64Array(n + 1);
    this.curveVolumes = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const L = (this.depth * i) / n;
      this.curveLevels[i] = L;
      this.curveVolumes[i] = i === 0 ? 0 : i === n ? this.total : this.volumeAtH(this.hMin + L);
    }
    // Guard against tiny non-monotonic noise in the lookup curve.
    for (let i = 1; i <= n; i++) {
      if (this.curveVolumes[i] < this.curveVolumes[i - 1]) this.curveVolumes[i] = this.curveVolumes[i - 1];
    }
  }

  /** Lowest and highest plane offset over a section. */
  heightRange(a: number, out: [number, number]): [number, number] {
    const s = this.model.section(a, this.sec);
    if (this.axis === -1) {
      out[0] = a;
      out[1] = a;
      return out;
    }
    const k = this.axis === 0 ? s.ku : s.kv;
    const c = this.axis === 0 ? s.cu : s.cv;
    const h1 = this.na * a + this.nw * (c - k * this.E);
    const h2 = this.na * a + this.nw * (c + k * this.E);
    out[0] = Math.min(h1, h2);
    out[1] = Math.max(h1, h2);
    return out;
  }

  /** Wetted cross-section area at axial position a for surface offset h (mm²). */
  segArea(a: number, h: number): number {
    const s = this.model.section(a, this.sec);
    const kk = s.ku * s.kv;
    if (kk <= 0) return 0;
    if (this.axis === -1) return a <= h ? kk * this.model.area0 : 0;
    const k = this.axis === 0 ? s.ku : s.kv;
    if (k <= 1e-14) return 0;
    const c = this.axis === 0 ? s.cu : s.cv;
    const wcut = (h - this.na * a) / this.nw;
    const eta = (wcut - c) / k;
    const below = segBelow(this.model.base, this.axis, eta);
    return kk * (this.nw > 0 ? below : this.model.area0 - below);
  }

  /** Volume (mm³) below the surface plane n·p = h. */
  volumeAtH(h: number): number {
    if (h <= this.hMin) return 0;
    if (h >= this.hMax) return this.total;
    let sum = 0;
    const range: [number, number] = [0, 0];
    for (const p of this.pieces) {
      const n = p.sa.length;
      let allFull = true;
      let allEmpty = true;
      for (let i = 0; i < n; i++) {
        if (p.hi[i] > h) allFull = false;
        if (p.lo[i] < h) allEmpty = false;
      }
      if (allFull) {
        sum += p.full;
        continue;
      }
      if (allEmpty) continue;

      const cuts: number[] = [p.a0];
      for (let i = 0; i < n - 1; i++) {
        if (p.lo[i] > h !== p.lo[i + 1] > h) cuts.push(this.bisect(p.sa[i], p.sa[i + 1], h, 0, range));
        if (this.axis !== -1 && p.hi[i] > h !== p.hi[i + 1] > h) {
          cuts.push(this.bisect(p.sa[i], p.sa[i + 1], h, 1, range));
        }
      }
      cuts.push(p.a1);
      cuts.sort((x, y) => x - y);
      for (let j = 0; j < cuts.length - 1; j++) {
        const x0 = cuts[j];
        const x1 = cuts[j + 1];
        if (x1 - x0 <= 0) continue;
        const panels = Math.max(1, Math.ceil((p.panels * (x1 - x0)) / (p.a1 - p.a0)));
        sum += this.integrate(x0, x1, panels, h);
      }
    }
    return Math.min(Math.max(sum, 0), this.total);
  }

  /** Liquid volume (mm³) at a level measured from the lowest inside point. */
  volume(level: number): number {
    return this.volumeAtH(this.hMin + level);
  }

  litres(level: number): number {
    return this.volume(level) * MM3_TO_L;
  }

  get totalLitres(): number {
    return this.total * MM3_TO_L;
  }

  /** Free surface area at a level (mm²), from the slope of the volume curve. */
  surfaceArea(level: number): number {
    const d = Math.max(this.depth * 1e-5, 1e-3);
    const l0 = Math.max(0, level - d);
    const l1 = Math.min(this.depth, level + d);
    if (l1 <= l0) return 0;
    return (this.volume(l1) - this.volume(l0)) / (l1 - l0);
  }

  /** Level (mm) holding a given volume (mm³). */
  levelOf(volume: number): number {
    if (volume <= 0) return 0;
    if (volume >= this.total) return this.depth;
    const V = this.curveVolumes;
    let lo = 0;
    let hi = V.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (V[m] < volume) lo = m;
      else hi = m;
    }
    // Illinois false-position on the exact volume between the two curve nodes.
    let x0 = this.curveLevels[lo];
    let x1 = this.curveLevels[hi];
    let f0 = V[lo] - volume;
    let f1 = V[hi] - volume;
    if (f1 === f0) return x0;
    let side = 0;
    let x = x0;
    for (let it = 0; it < 40; it++) {
      x = (x0 * f1 - x1 * f0) / (f1 - f0);
      const f = this.volume(x) - volume;
      if (Math.abs(f) <= this.total * 1e-12 || Math.abs(x1 - x0) < this.depth * 1e-12) break;
      if (f * f1 > 0) {
        x1 = x;
        f1 = f;
        if (side === -1) f0 /= 2;
        side = -1;
      } else {
        x0 = x;
        f0 = f;
        if (side === 1) f1 /= 2;
        side = 1;
      }
    }
    return x;
  }

  /** Volume (mm³) from the dense curve with linear interpolation (fast). */
  quickVolume(level: number): number {
    const L = this.curveLevels;
    if (level <= 0) return 0;
    if (level >= this.depth) return this.total;
    const f = (level / this.depth) * (L.length - 1);
    const i = Math.min(L.length - 2, Math.floor(f));
    const t = f - i;
    return this.curveVolumes[i] * (1 - t) + this.curveVolumes[i + 1] * t;
  }

  /** Volume (mm³) of the tank between two axial positions, completely full. */
  rangeVolume(a0: number, a1: number): number {
    let sum = 0;
    const area0 = this.model.area0;
    const f = (a: number) => {
      const s = this.model.section(a, this.sec);
      return s.ku * s.kv * area0;
    };
    const br = this.model.breaks;
    for (let i = 0; i < br.length - 1; i++) {
      const x0 = Math.max(a0, br[i]);
      const x1 = Math.min(a1, br[i + 1]);
      if (x1 > x0) sum += this.gl(x0, x1, 8, f);
    }
    return sum;
  }

  /** World-height offset of a tank-frame point relative to the plane normal. */
  heightOf(a: number, u: number, v: number): number {
    if (this.axis === -1) return a;
    return this.na * a + this.nw * (this.axis === 0 ? u : v);
  }

  /** Level of a tank-frame point above level zero. */
  levelOfPoint(a: number, u: number, v: number): number {
    return this.heightOf(a, u, v) - this.hMin;
  }

  /** Levels where the tank profile changes shape (junctions of shell and heads). */
  breakLevels(): number[] {
    const r: [number, number] = [0, 0];
    const out: number[] = [];
    for (const a of this.model.breaks) {
      this.heightRange(a, r);
      out.push(r[0] - this.hMin, r[1] - this.hMin);
    }
    return out.filter((L) => L > 0 && L < this.depth);
  }

  private cachePiece(a0: number, a1: number): PieceCache {
    const m = SAMPLES_PER_PIECE;
    const sa = new Float64Array(m + 1);
    const lo = new Float64Array(m + 1);
    const hi = new Float64Array(m + 1);
    const r: [number, number] = [0, 0];
    for (let i = 0; i <= m; i++) {
      // Cosine spacing: denser at both ends where head profiles change fastest.
      const a = a0 + ((a1 - a0) * (1 - Math.cos((Math.PI * i) / m))) / 2;
      sa[i] = a;
      this.heightRange(a, r);
      lo[i] = r[0];
      hi[i] = r[1];
    }
    const isBody = a0 >= 0 && a1 <= this.model.L;
    const panels = isBody ? (this.model.endScale === 1 ? 2 : 4) : 8;
    let full = 0;
    const area0 = this.model.area0;
    const integrandFull = (a: number) => {
      const s = this.model.section(a, this.sec);
      return s.ku * s.kv * area0;
    };
    full = this.gl(a0, a1, panels, integrandFull);
    return { a0, a1, panels, sa, lo, hi, full };
  }

  private integrate(x0: number, x1: number, panels: number, h: number): number {
    return this.gl(x0, x1, panels, (a) => this.segArea(a, h));
  }

  private gl(x0: number, x1: number, panels: number, f: (a: number) => number): number {
    const w = (x1 - x0) / panels;
    let sum = 0;
    for (let p = 0; p < panels; p++) {
      const c = x0 + w * (p + 0.5);
      const half = w / 2;
      let s = 0;
      for (let i = 0; i < 10; i++) s += GL_W[i] * f(c + half * GL_X[i]);
      sum += s * half;
    }
    return sum;
  }

  /** Finds a where the low (which = 0) or high (which = 1) edge height of the section equals h. */
  private bisect(a0: number, a1: number, h: number, which: 0 | 1, r: [number, number]): number {
    const s0 = this.heightRange(a0, r)[which] > h;
    let lo = a0;
    let hi = a1;
    for (let it = 0; it < 60; it++) {
      const m = 0.5 * (lo + hi);
      if (this.heightRange(m, r)[which] > h === s0) lo = m;
      else hi = m;
      if (hi - lo < 1e-10 * this.model.size) break;
    }
    return 0.5 * (lo + hi);
  }

  /** Refines the sampled lowest (dir = -1) or highest (dir = 1) surface offset. */
  private refineExtreme(sampled: number, dir: -1 | 1): number {
    let best = sampled;
    const r: [number, number] = [0, 0];
    for (const p of this.pieces) {
      const n = p.sa.length;
      for (let i = 0; i < n; i++) {
        const v = dir < 0 ? p.lo[i] : p.hi[i];
        if (v !== sampled) continue;
        // Golden-section search around the best sample.
        let a = p.sa[Math.max(0, i - 1)];
        let b = p.sa[Math.min(n - 1, i + 1)];
        const g = (x: number) => dir * this.heightRange(x, r)[dir < 0 ? 0 : 1];
        const phi = (Math.sqrt(5) - 1) / 2;
        let c = b - phi * (b - a);
        let d = a + phi * (b - a);
        let gc = g(c);
        let gd = g(d);
        for (let it = 0; it < 80; it++) {
          if (gc > gd) {
            b = d;
            d = c;
            gd = gc;
            c = b - phi * (b - a);
            gc = g(c);
          } else {
            a = c;
            c = d;
            gc = gd;
            d = a + phi * (b - a);
            gd = g(d);
          }
        }
        const cand = dir * Math.max(gc, gd);
        if (dir < 0 ? cand < best : cand > best) best = cand;
      }
    }
    return best;
  }

  /** Half chord of the surface within the section at a (for drawing the surface). */
  surfaceChord(a: number, h: number): { w: number; c0: number; c1: number } | null {
    const s = this.model.section(a, this.sec);
    if (this.axis === -1) return null;
    const k = this.axis === 0 ? s.ku : s.kv;
    const kOther = this.axis === 0 ? s.kv : s.ku;
    if (k <= 1e-14 || kOther <= 1e-14) return null;
    const c = this.axis === 0 ? s.cu : s.cv;
    const cOther = this.axis === 0 ? s.cv : s.cu;
    const wcut = (h - this.na * a) / this.nw;
    const eta = (wcut - c) / k;
    const ch = chordRange(this.model.base, this.axis, eta);
    if (!ch) return null;
    return { w: wcut, c0: cOther + kOther * ch[0], c1: cOther + kOther * ch[1] };
  }
}

export function sectionArea(model: TankModel, a: number): number {
  const s = model.section(a, { ku: 0, kv: 0, cu: 0, cv: 0 });
  return s.ku * s.kv * shapeArea(model.base);
}

/** Full internal volume (mm³) of a tank model, without building a volume engine. */
export function capacityOf(model: TankModel): number {
  const sec: Sec = { ku: 0, kv: 0, cu: 0, cv: 0 };
  const area0 = model.area0;
  const br = model.breaks;
  const panels = 8;
  let sum = 0;
  for (let i = 0; i < br.length - 1; i++) {
    const x0 = br[i];
    const x1 = br[i + 1];
    if (!(x1 > x0)) continue;
    const w = (x1 - x0) / panels;
    for (let p = 0; p < panels; p++) {
      const c = x0 + w * (p + 0.5);
      let s = 0;
      for (let j = 0; j < 10; j++) {
        model.section(c + (w / 2) * GL_X[j], sec);
        s += GL_W[j] * sec.ku * sec.kv * area0;
      }
      sum += (s * w) / 2;
    }
  }
  return sum;
}
