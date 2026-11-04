import { describe, expect, it } from 'vitest';
import { defaultBody, defaultHead, defaultSensor, emptyProject } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import type { BodyConfig, HeadConfig, Project, TankConfig } from '../src/core/types';
import { MM3_TO_L } from '../src/core/units';
import { cloudStudioConfig, cloudStudioModel, cloudStudioPayload } from '../src/export/cloudstudio';
import { collect, type ExportOptions } from '../src/export/shared';

/**
 * Independent check of tank shape and size: every tank below is also described here
 * with textbook formulas (written separately from src/core), and its volume at many
 * levels is compared with the app's volume engine, the exported table and the
 * generated payload script.
 */

// ---------------------------------------------------------------------------
// Reference geometry

/** Cross-section: half size `a` across the cut, half size `b` along the cut direction, centre `c` along it. */
interface OSec {
  a: number;
  b: number;
  c: number;
}

/** A head: depth, breakpoints and the section at distance t from the shell (given the junction half sizes). */
interface OHead {
  d: number;
  breaks: number[];
  at(t: number): { ka: number; kb: number; c: number };
}

const flatH: OHead = { d: 0, breaks: [], at: () => ({ ka: 1, kb: 1, c: 0 }) };

/** A head of revolution from its radius profile r(t) on a shell of inside radius R. */
function revolved(R: number, d: number, r: (t: number) => number, breaks: number[] = []): OHead {
  return { d, breaks, at: (t) => ({ ka: r(t) / R, kb: r(t) / R, c: 0 }) };
}
const hemiH = (R: number) => revolved(R, R, (t) => Math.sqrt(Math.max(0, R * R - t * t)));
const ellipH = (R: number, d: number) => revolved(R, d, (t) => R * Math.sqrt(Math.max(0, 1 - (t / d) ** 2)));
/** Spherical cap of depth d. */
const capH = (R: number, d: number) => {
  const Rs = (R * R + d * d) / (2 * d);
  return revolved(R, d, (t) => Math.sqrt(Math.max(0, Rs * Rs - (t + Rs - d) ** 2)));
};
const coneH = (R: number, ro: number, d: number) => revolved(R, d, (t) => R - ((R - ro) * t) / d);
const parabH = (R: number, d: number) => revolved(R, d, (t) => R * Math.sqrt(Math.max(0, 1 - t / d)));
/**
 * Torispherical head from crown radius Rc and knuckle radius rk: the knuckle circle is
 * centred at radius R − rk on the junction plane, the crown sphere on the axis at distance
 * Rc − rk from it.
 */
function toriH(R: number, Rc: number, rk: number): OHead {
  const zc = -Math.sqrt((Rc - rk) ** 2 - (R - rk) ** 2);
  const d = Rc + zc;
  const tT = (-zc * rk) / (Rc - rk);
  return revolved(R, d, (t) => (t <= tT ? R - rk + Math.sqrt(Math.max(0, rk * rk - t * t)) : Math.sqrt(Math.max(0, Rc * Rc - (t - zc) ** 2))), [tT]);
}
/** Toriconical: knuckle rk, then a straight cone at alpha from the end plane down to the outlet radius ro. */
function toriconeH(R: number, rk: number, alphaDeg: number, ro: number): OHead {
  const al = (alphaDeg * Math.PI) / 180;
  const tK = rk * Math.cos(al);
  const rK = R - rk + rk * Math.sin(al);
  const d = tK + (rK - ro) * Math.tan(al);
  return revolved(R, d, (t) => (t <= tK ? R - rk + Math.sqrt(rk * rk - t * t) : rK - (t - tK) / Math.tan(al)), [tK]);
}
/** Flat plate with a rounded rim of radius rk: every side moves in by the same amount. */
function flangedH(A: number, B: number, rk: number): OHead {
  const inset = (t: number) => rk - Math.sqrt(Math.max(0, rk * rk - t * t));
  return { d: rk, breaks: [], at: (t) => ({ ka: (A - inset(t)) / A, kb: (B - inset(t)) / B, c: 0 }) };
}
/** Straight-sided head: the two half sizes go linearly to the outlet; `shift` keeps one side straight along the cut. */
function linearH(d: number, kaEnd: number, kbEnd: number, B: number, shift: -1 | 0 | 1 = 0): OHead {
  return {
    d,
    breaks: [],
    at: (t) => {
      const f = t / d;
      const kb = 1 - (1 - kbEnd) * f;
      return { ka: 1 - (1 - kaEnd) * f, kb, c: shift * B * (1 - kb) };
    },
  };
}

interface OTank {
  shape: 'ellipse' | 'rect';
  /** Junction half sizes: across the cut and along it. */
  A: number;
  B: number;
  L: number;
  endScale?: number;
  start: OHead;
  end: OHead;
  /** World height of a point = p × axial position + q × position along the cut direction. */
  p: number;
  q: number;
}

function circleSeg(r: number, y: number): number {
  if (y <= 0) return 0;
  if (y >= 2 * r) return Math.PI * r * r;
  return r * r * Math.acos((r - y) / r) - (r - y) * Math.sqrt(2 * r * y - y * y);
}

class Reference {
  readonly len: number;
  readonly breaks: number[];
  readonly zero: number;
  readonly depth: number;
  readonly total: number;
  constructor(readonly o: OTank) {
    const { start, end, L } = o;
    this.len = start.d + L + end.d;
    const br = new Set<number>([0, start.d, start.d + L, this.len]);
    for (const t of start.breaks) br.add(start.d - t);
    for (const t of end.breaks) br.add(start.d + L + t);
    this.breaks = [...br].filter((x) => x >= 0 && x <= this.len).sort((x, y) => x - y);
    let lo = Infinity;
    let hi = -Infinity;
    const n = 20000;
    for (let i = 0; i <= n; i++) {
      const x = (this.len * i) / n;
      const s = this.sec(x);
      if (s.a <= 0 || s.b <= 0) continue;
      const h1 = o.p * x + o.q * (s.c - s.b);
      const h2 = o.p * x + o.q * (s.c + s.b);
      lo = Math.min(lo, h1, h2);
      hi = Math.max(hi, h1, h2);
    }
    // Upright tanks: the ends of the axis are exact.
    if (o.q === 0) {
      lo = 0;
      hi = this.len;
    }
    this.zero = lo;
    this.depth = hi - lo;
    this.total = this.volume(Infinity);
  }

  sec(x: number): OSec {
    const { start, end, L, A, B } = this.o;
    const s = this.o.endScale ?? 1;
    if (x < start.d) {
      const k = start.at(start.d - x);
      return { a: A * k.ka, b: B * k.kb, c: k.c };
    }
    if (x <= start.d + L) {
      const f = L > 0 ? 1 + ((s - 1) * (x - start.d)) / L : 1;
      return { a: A * f, b: B * f, c: 0 };
    }
    const k = end.at(x - start.d - L);
    return { a: A * s * k.ka, b: B * s * k.kb, c: k.c * s };
  }

  /** Liquid volume (mm³) at a level above the lowest inside point. */
  volume(level: number): number {
    const { p, q, shape } = this.o;
    const Y = this.zero + level;
    const area = (x: number) => {
      const s = this.sec(x);
      if (s.a <= 0 || s.b <= 0) return 0;
      const full = shape === 'ellipse' ? Math.PI * s.a * s.b : 4 * s.a * s.b;
      if (q === 0) return full;
      const w = (Y - p * x) / q;
      const y = q > 0 ? w - (s.c - s.b) : s.c + s.b - w;
      if (y <= 0) return 0;
      if (y >= 2 * s.b) return full;
      return shape === 'ellipse' ? (s.a / s.b) * circleSeg(s.b, y) : 2 * s.a * y;
    };
    // Upright: every section below the surface is full; integrate only up to it.
    const top = q === 0 ? Math.min(Y / p, this.len) : this.len;
    const cuts = [...this.breaks.filter((x) => x < top), top];
    let sum = 0;
    for (let i = 0; i < cuts.length - 1; i++) sum += simpson(area, cuts[i], cuts[i + 1], 4000);
    return sum;
  }
}

function simpson(f: (x: number) => number, a: number, b: number, n: number): number {
  if (!(b > a)) return 0;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}

// ---------------------------------------------------------------------------
// The tanks

const head = (type: HeadConfig['type'], o: Partial<HeadConfig> = {}): HeadConfig => ({ ...defaultHead(type, 0), ...o });
const body = (o: Partial<BodyConfig>): BodyConfig => ({ ...defaultBody(), thickness: 0, ...o });
const deg = (d: number) => (d * Math.PI) / 180;
const up = { p: 1, q: 0 };
const lying = (tilt = 0) => ({ p: Math.sin(deg(tilt)), q: Math.cos(deg(tilt)) });

interface Case {
  name: string;
  tank: TankConfig;
  ref: OTank;
}

function tank(orientation: 'vertical' | 'horizontal', basis: 'inside' | 'outside', b: BodyConfig, start: HeadConfig, end: HeadConfig, tilt = 0): TankConfig {
  return { orientation, basis, body: b, start, end, tilt };
}

const CASES: Case[] = [
  {
    name: 'standing cylinder, flat ends, outside sizes',
    tank: tank('vertical', 'outside', body({ diameter: 2000, thickness: 8, length: 3000 }), head('flat', { thickness: 10 }), head('flat', { thickness: 10 })),
    ref: { shape: 'ellipse', A: 992, B: 992, L: 3000, start: flatH, end: flatH, ...up },
  },
  {
    name: 'standing: hemispherical bottom, 2:1 top',
    tank: tank('vertical', 'inside', body({ diameter: 1800, length: 2400 }), head('hemi'), head('ellipsoidal', { ellipseRatio: 2 })),
    ref: { shape: 'ellipse', A: 900, B: 900, L: 2400, start: hemiH(900), end: ellipH(900, 450), ...up },
  },
  {
    name: 'standing, outside: 45° cone bottom with outlet, shallow dome top by depth',
    tank: tank(
      'vertical',
      'outside',
      body({ diameter: 1600, thickness: 6, length: 2000 }),
      head('cone', { sizeBy: 'angle', angle: 45, outlet: 150, thickness: 6 }),
      head('dished', { dishBy: 'depth', depth: 250, thickness: 6 }),
    ),
    // Inside radius 794; cone run 794 − 75 = 719 at 45°; dome 250 − 6 = 244 deep inside.
    ref: { shape: 'ellipse', A: 794, B: 794, L: 2000, start: coneH(794, 75, 719), end: capH(794, 244), ...up },
  },
  {
    name: 'standing: Klöpper bottom, 80:10 top',
    tank: tank('vertical', 'inside', body({ diameter: 2500, length: 3000 }), head('torispherical', { tori: 'klopper' }), head('torispherical', { tori: 'r8010' })),
    ref: { shape: 'ellipse', A: 1250, B: 1250, L: 3000, start: toriH(1250, 2500, 250), end: toriH(1250, 2000, 250), ...up },
  },
  {
    name: 'standing, outside: paraboloid bottom, toriconical top',
    tank: tank(
      'vertical',
      'outside',
      body({ diameter: 2000, thickness: 5, length: 1500 }),
      head('paraboloid', { depth: 600, thickness: 5 }),
      head('toricone', { sizeBy: 'angle', angle: 30, knuckleR: 120, outlet: 200, thickness: 5 }),
    ),
    ref: { shape: 'ellipse', A: 995, B: 995, L: 1500, start: parabH(995, 595), end: toriconeH(995, 115, 30, 100), ...up },
  },
  {
    name: 'standing: flanged flat bottom',
    tank: tank('vertical', 'inside', body({ diameter: 1500, length: 1000 }), head('flanged', { knuckleR: 100 }), head('flat')),
    ref: { shape: 'ellipse', A: 750, B: 750, L: 1000, start: flangedH(750, 750, 100), end: flatH, ...up },
  },
  {
    name: 'standing tapered shell (top 75 %), hemispherical top on the narrow end',
    tank: tank('vertical', 'inside', body({ diameter: 2000, length: 2000, endScale: 0.75 }), head('flat'), head('hemi')),
    // The top end is 1500 wide, so its hemisphere is 750 deep.
    ref: { shape: 'ellipse', A: 1000, B: 1000, L: 2000, endScale: 0.75, start: flatH, end: hemiH(750) },
  } as Case,
  {
    name: 'standing, same size body (X = Y = Z) and same size half-oval bottom',
    tank: tank('vertical', 'inside', body({ diameter: 1200, length: 500, uniform: true }), head('ellipsoidal', { uniform: true }), head('flat')),
    ref: { shape: 'ellipse', A: 600, B: 600, L: 1200, start: ellipH(600, 1200), end: flatH, ...up },
  },
  {
    name: 'standing box with a pyramid hopper by depth',
    tank: tank('vertical', 'inside', body({ type: 'rect', width: 2000, depth: 1500, corner: 0, length: 1800 }), head('cone', { sizeBy: 'depth', depth: 600, outlet: 200, outlet2: 150 }), head('flat')),
    ref: { shape: 'rect', A: 1000, B: 750, L: 1800, start: linearH(600, 0.1, 0.1, 750), end: flatH, ...up },
  },
  {
    name: 'standing box: V-trough bottom, single slope top',
    tank: tank(
      'vertical',
      'inside',
      body({ type: 'rect', width: 1600, depth: 1000, corner: 0, length: 1200 }),
      head('wedge', { sizeBy: 'depth', depth: 500, outlet: 300, axis: 'u' }),
      head('sloped', { sizeBy: 'depth', depth: 300, outlet: 0 }),
    ),
    // `a` is the half size across the cut; standing tanks have no cut, so u (width) is `a` here.
    ref: { shape: 'rect', A: 800, B: 500, L: 1200, start: { ...linearH(500, 150 / 800, 1, 500) }, end: linearH(300, 0, 1, 500), ...up },
  },
  {
    name: 'standing oval with 2:1 heads on the mean radius',
    tank: tank('vertical', 'inside', body({ type: 'oval', width: 2400, depth: 1600, length: 2000 }), head('ellipsoidal', { ellipseRatio: 2 }), head('ellipsoidal', { ellipseRatio: 2 })),
    ref: { shape: 'ellipse', A: 1200, B: 800, L: 2000, start: ellipH(1000, 500), end: ellipH(1000, 500), ...up },
  },
  {
    name: 'standing: eccentric 30° cone bottom',
    tank: tank('vertical', 'inside', body({ diameter: 1600, length: 1500 }), head('cone', { sizeBy: 'angle', angle: 30, outlet: 0, eccentric: true }), head('flat')),
    ref: { shape: 'ellipse', A: 800, B: 800, L: 1500, start: coneH(800, 0, 1600 * Math.tan(deg(30))), end: flatH, ...up },
  },
  {
    name: 'standing cylinder leaning 2°',
    tank: tank('vertical', 'inside', body({ diameter: 1500, length: 3000 }), head('flat'), head('flat'), 2),
    ref: { shape: 'ellipse', A: 750, B: 750, L: 3000, start: flatH, end: flatH, p: Math.cos(deg(2)), q: -Math.sin(deg(2)) },
  },
  {
    name: 'standing cylinder leaning 3° with a 2:1 bottom',
    tank: tank('vertical', 'inside', body({ diameter: 1500, length: 2000 }), head('ellipsoidal'), head('flat'), 3),
    ref: { shape: 'ellipse', A: 750, B: 750, L: 2000, start: ellipH(750, 375), end: flatH, p: Math.cos(deg(3)), q: -Math.sin(deg(3)) },
  },
  {
    name: 'lying cylinder, flat ends',
    tank: tank('horizontal', 'inside', body({ diameter: 1939, length: 3560 }), head('flat'), head('flat')),
    ref: { shape: 'ellipse', A: 969.5, B: 969.5, L: 3560, start: flatH, end: flatH, ...lying() },
  },
  {
    name: 'lying, outside: hemispherical ends',
    tank: tank('horizontal', 'outside', body({ diameter: 2500, thickness: 10, length: 6000 }), head('hemi', { thickness: 12 }), head('hemi', { thickness: 12 })),
    ref: { shape: 'ellipse', A: 1240, B: 1240, L: 6000, start: hemiH(1240), end: hemiH(1240), ...lying() },
  },
  {
    name: 'lying: 2:1 semi-ellipsoidal ends',
    tank: tank('horizontal', 'inside', body({ diameter: 2000, length: 5000 }), head('ellipsoidal'), head('ellipsoidal')),
    ref: { shape: 'ellipse', A: 1000, B: 1000, L: 5000, start: ellipH(1000, 500), end: ellipH(1000, 500), ...lying() },
  },
  {
    name: 'lying: Klöpper ends',
    tank: tank('horizontal', 'inside', body({ diameter: 2400, length: 6000 }), head('torispherical'), head('torispherical')),
    ref: { shape: 'ellipse', A: 1200, B: 1200, L: 6000, start: toriH(1200, 2400, 240), end: toriH(1200, 2400, 240), ...lying() },
  },
  {
    name: 'lying: shallow domes 174 mm (the small tank)',
    tank: tank('horizontal', 'inside', body({ diameter: 1939, length: 3560 }), head('dished', { depth: 174 }), head('dished', { depth: 174 })),
    ref: { shape: 'ellipse', A: 969.5, B: 969.5, L: 3560, start: capH(969.5, 174), end: capH(969.5, 174), ...lying() },
  },
  {
    name: 'lying: 20° cone ends',
    tank: tank('horizontal', 'inside', body({ diameter: 1800, length: 4000 }), head('cone', { angle: 20 }), head('cone', { angle: 20 })),
    ref: { shape: 'ellipse', A: 900, B: 900, L: 4000, start: coneH(900, 0, 900 * Math.tan(deg(20))), end: coneH(900, 0, 900 * Math.tan(deg(20))), ...lying() },
  },
  {
    name: 'lying: eccentric cone with a straight bottom',
    tank: tank('horizontal', 'inside', body({ diameter: 1600, length: 3000 }), head('cone', { sizeBy: 'depth', depth: 900, outlet: 400, eccentric: true, side: 'neg' }), head('flat')),
    ref: { shape: 'ellipse', A: 800, B: 800, L: 3000, start: linearH(900, 0.25, 0.25, 800, -1), end: flatH, ...lying() },
  },
  {
    name: 'lying oval (road tanker) with 4:1 heads',
    tank: tank('horizontal', 'inside', body({ type: 'oval', width: 2400, depth: 1600, length: 7000 }), head('ellipsoidal', { ellipseRatio: 4 }), head('ellipsoidal', { ellipseRatio: 4 })),
    ref: { shape: 'ellipse', A: 1200, B: 800, L: 7000, start: ellipH(1000, 250), end: ellipH(1000, 250), ...lying() },
  },
  {
    name: 'lying box, outside sizes',
    tank: tank('horizontal', 'outside', body({ type: 'rect', width: 1500, depth: 1200, corner: 0, thickness: 5, length: 3000 }), head('flat', { thickness: 5 }), head('flat', { thickness: 5 })),
    ref: { shape: 'rect', A: 745, B: 595, L: 3000, start: flatH, end: flatH, ...lying() },
  },
  {
    name: 'lying cylinder with hemispherical ends, right end raised 3°',
    tank: tank('horizontal', 'inside', body({ diameter: 2000, length: 5000 }), head('hemi'), head('hemi'), 3),
    ref: { shape: 'ellipse', A: 1000, B: 1000, L: 5000, start: hemiH(1000), end: hemiH(1000), ...lying(3) },
  },
  {
    name: 'lying, outside: paraboloid and toriconical ends',
    tank: tank(
      'horizontal',
      'outside',
      body({ diameter: 1600, thickness: 6, length: 2500 }),
      head('paraboloid', { depth: 506, thickness: 6 }),
      head('toricone', { sizeBy: 'angle', angle: 40, knuckleR: 106, outlet: 300, thickness: 6 }),
    ),
    ref: { shape: 'ellipse', A: 794, B: 794, L: 2500, start: parabH(794, 500), end: toriconeH(794, 100, 40, 150), ...lying() },
  },
];
// The tapered case needs p / q (kept apart above for readability).
Object.assign(CASES[6].ref, up);

// ---------------------------------------------------------------------------

describe('tank shape and size against textbook formulas', { timeout: 60000 }, () => {
  for (const c of CASES) {
    it(c.name, () => {
      const ref = new Reference(c.ref);
      const p = emptyProject();
      p.tank = c.tank;
      p.sensors = [];
      const d = derive(p);
      expect(d.problems).toEqual([]);
      const tol = 2e-6 * ref.total + 1e3;
      expect(Math.abs(d.depth - ref.depth)).toBeLessThan(1e-3 + 1e-7 * ref.depth);
      expect(Math.abs(d.engine.total - ref.total)).toBeLessThan(tol);
      for (let i = 1; i < 40; i++) {
        const level = (ref.depth * i) / 40;
        const want = ref.volume(level);
        const got = d.engine.volume(level);
        if (Math.abs(got - want) >= tol) throw new Error(`level ${level.toFixed(1)} mm: app ${(got * MM3_TO_L).toFixed(4)} L, formula ${(want * MM3_TO_L).toFixed(4)} L`);
      }
      // The table the scripts carry: every row at its printed level.
      const ed = collect(p, d, { ...opts, lengthUnit: 'mm' });
      for (const r of ed.strap) expect(Math.abs(r.litres - ref.volume(r.level) * MM3_TO_L)).toBeLessThan(tol * MM3_TO_L);
      expect(ed.strap[ed.strap.length - 1].level).toBeCloseTo(ref.depth, 1);
    });
  }
});

// ---------------------------------------------------------------------------
// Sensor heights from the roof

describe('sensor face height from the roof', () => {
  const faceLevel = (t: TankConfig, x: number, y: number, nozzle: number) => {
    const p = emptyProject();
    p.tank = t;
    const s = defaultSensor('radar', 'LT');
    Object.assign(s, { x, y, nozzle, faceMode: 'auto', deadBand: 0, maxRange: 1e5 });
    p.sensors = [s];
    const g = derive(p).geoms[0];
    expect(g.error).toBeNull();
    return g.faceLevel;
  };

  it('flat roof: shell + bottom depth + roof plate + nozzle', () => {
    const t = tank('vertical', 'outside', body({ diameter: 2000, thickness: 8, length: 3000 }), head('ellipsoidal', { thickness: 10 }), head('flat', { thickness: 12 }));
    // Inside: 2:1 bottom on R = 992 is 496 deep, then 3000 of shell, then a 12 mm plate.
    expect(faceLevel(t, 300, -200, 150)).toBeCloseTo(496 + 3000 + 12 + 150, 3);
  });

  it('hemispherical roof off centre: the outside sphere at that radius', () => {
    const t = tank('vertical', 'inside', body({ diameter: 2000, length: 2000 }), head('flat'), head('hemi', { thickness: 10 }));
    const x = 400;
    const y = 300;
    const rr = Math.hypot(x, y);
    // Outside dome = sphere of radius 1000 + 10 on the same centre.
    const want = 2000 + Math.sqrt(1010 ** 2 - rr * rr) + 50;
    expect(Math.abs(faceLevel(t, x, y, 50) - want)).toBeLessThan(0.05);
  });

  it('lying cylinder, sensor off the centre line: the outside shell at that offset', () => {
    const t = tank('horizontal', 'inside', body({ diameter: 2000, length: 4000, thickness: 10 }), head('flat'), head('flat'));
    const y = 500;
    const want = 1000 + Math.sqrt(1010 ** 2 - y * y) + 100;
    expect(Math.abs(faceLevel(t, 700, y, 100) - want)).toBeLessThan(0.05);
  });

  it('cone roof off centre: the roof drops with the cone', () => {
    const t = tank('vertical', 'inside', body({ diameter: 2000, length: 2000 }), head('flat'), head('cone', { sizeBy: 'angle', angle: 30, outlet: 0, thickness: 0 }));
    const r = 600;
    expect(faceLevel(t, r, 0, 0)).toBeCloseTo(2000 + (1000 - r) * Math.tan(deg(30)), 2);
  });
});

// ---------------------------------------------------------------------------
// Through the generated payload script, in each length unit

const opts: ExportOptions = {
  source: 'level',
  input: 'measure',
  table: { mode: 'compact', step: 10, rows: 100, tolerance: 0.05 },
  lengthUnit: 'mm',
  volumeUnit: 'L',
  pressureUnit: 'kPa',
};

interface Ep {
  address: string;
  value?: number;
}

function load(code: string): { getEndpoints: (a: string, e: unknown) => void; parseUplink: (d: unknown, p: unknown) => void } {
  const body = `${code}\nreturn { getEndpoints: typeof getEndpoints === 'undefined' ? undefined : getEndpoints, parseUplink: typeof parseUplink === 'undefined' ? undefined : parseUplink };`;
  return new Function('endpointType', 'downlinkBuildResult', 'env', body)({ genericSensor: 28 }, { ok: 0, unsupported: 1 }, { log: () => {} });
}

function runScripts(p: Project, distance: number): Ep[] {
  const d = derive(p);
  const ed = collect(p, d, opts);
  const m = cloudStudioModel([ed], {}, [{ address: 'A840417369618159' }]);
  const eps: Ep[] = [];
  load(cloudStudioConfig(m)).getEndpoints('A840417369618159', {
    addEndpoint: (address: string) => {
      const e: Ep = { address };
      eps.push(e);
      return e;
    },
  });
  const device = {
    endpoints: { byAddress: (a: string) => {
      const e = eps.find((x) => x.address === a);
      return e ? { updateGenericSensorStatus: (v: number) => (e.value = v) } : null;
    } },
    updateDeviceBattery: () => {},
  };
  load(cloudStudioPayload(m)).parseUplink(device, { port: 0, asBytes: () => [], asParsedObject: () => ({ distance }) });
  return eps;
}

describe('payload script levels and volumes against the formulas', { timeout: 60000 }, () => {
  CASES.forEach((c) => {
    it(c.name, () => {
      const ref = new Reference(c.ref);
      const p = emptyProject();
      p.name = 'Oracle';
      p.tank = c.tank;
      const s = defaultSensor('radar', 'LT');
      Object.assign(s, { x: 0, y: 0, faceMode: 'manual', faceHeight: Math.ceil(ref.depth) + 400, deadBand: 0, maxRange: 1e6, beamAngle: 0, signal: 'digital', digitalUnit: 'mm' });
      s.cal = { method: 'theory', ref: 'level', points: [] };
      p.sensors = [s];
      const g = derive(p).geoms[0];
      expect(g.ok).toBe(true);
      for (let f = 0.02; f < 1; f += 0.07) {
        const level = g.validMin + (g.validMax - g.validMin) * f;
        const distance = Math.round(((g.faceLevel - level) / g.cosTilt) * 10) / 10;
        const lv = g.faceLevel - distance * g.cosTilt;
        const eps = runScripts(p, distance);
        const val = (a: string) => eps.find((e) => e.address === a)?.value;
        // Endpoint 1: the sensor's own reading.
        expect(val('1')).toBe(distance);
        const want = ref.volume(lv) * MM3_TO_L;
        const slope = (ref.volume(Math.min(lv + 1, ref.depth)) - ref.volume(Math.max(lv - 1, 0))) * MM3_TO_L * 0.5;
        // The formula is written to 0.01 mm, so a level just on a rounding edge may round either way.
        expect(Math.abs(val('11')! - lv)).toBeLessThanOrEqual(0.52);
        expect(Math.abs(val('13')! - want), `${lv.toFixed(1)} mm`).toBeLessThan(0.5 + 0.05 + 1e-3 * slope + 2e-5 * want);
        expect(Math.abs(val('12')! - (100 * want) / (ref.total * MM3_TO_L))).toBeLessThan(0.051 + 60 / (ref.total * MM3_TO_L));
      }
    });
  });
});

describe('standard torispherical heads with a plate thickness', () => {
  // DIN 28011 / 28013 give the inside depth of the dished part from the outside diameter Da and plate s.
  const headOf = (tori: 'klopper' | 'korbbogen' | 'asme' | 'r8010', basis: 'inside' | 'outside', Da: number, s: number) => {
    const p = emptyProject();
    const dia = basis === 'outside' ? Da : Da - 2 * s;
    p.tank = tank('vertical', basis, body({ diameter: dia, thickness: s, length: 1000 }), head('flat'), head('torispherical', { tori, thickness: s }));
    p.sensors = [];
    return derive(p).model.end;
  };
  const RADII = { klopper: [1, 0.1], korbbogen: [0.8, 0.154], asme: [1, 0.06], r8010: [0.8, 0.1] } as const;
  for (const basis of ['inside', 'outside'] as const) {
    for (const [Da, s] of [
      [1000, 10],
      [2000, 8],
      [4000, 30],
    ]) {
      it(`inside radii are fractions of the outside diameter (Da ${Da}, s ${s}, ${basis})`, () => {
        for (const [std, [fc, fk]] of Object.entries(RADII)) {
          const h = headOf(std as keyof typeof RADII, basis, Da, s);
          expect(h.meta.crownR, std).toBeCloseTo(fc * Da, 6);
          expect(h.meta.knuckleR, std).toBeCloseTo(fk * Da, 6);
        }
        // The h2 formulas of DIN 28011 / 28013 are rounded fits: within 0.1 % of Da.
        expect(Math.abs(headOf('klopper', basis, Da, s).depth - (0.1935 * Da - 0.455 * s))).toBeLessThan(1e-3 * Da);
        expect(Math.abs(headOf('korbbogen', basis, Da, s).depth - (0.255 * Da - 0.635 * s))).toBeLessThan(1e-3 * Da);
      });
    }
  }

  it('an outside-measured Klöpper tank holds what its formula says', () => {
    // Da = 2000 → inside R = 990, crown 2000 and knuckle 200 (inside radii).
    const t = tank('vertical', 'outside', body({ diameter: 2000, thickness: 10, length: 2500 }), head('torispherical', { thickness: 10 }), head('torispherical', { tori: 'r8010', thickness: 10 }));
    const ref = new Reference({ shape: 'ellipse', A: 990, B: 990, L: 2500, start: toriH(990, 2000, 200), end: toriH(990, 1600, 200), ...up });
    const p = emptyProject();
    p.tank = t;
    p.sensors = [];
    const d = derive(p);
    expect(Math.abs(d.depth - ref.depth)).toBeLessThan(1e-3);
    for (let i = 1; i < 20; i++) {
      const level = (ref.depth * i) / 20;
      expect(Math.abs(d.engine.volume(level) - ref.volume(level))).toBeLessThan(2e-6 * ref.total + 1e3);
    }
  });
});

// Head and body sizes as the app shows them.
describe('sizes the app shows', () => {
  it('outside and inside sizes of an outside-measured tank', () => {
    const p = emptyProject();
    p.tank = tank('vertical', 'outside', body({ diameter: 2000, thickness: 8, length: 3000 }), head('ellipsoidal', { thickness: 10 }), head('dished', { dishBy: 'depth', depth: 250, thickness: 12 }));
    const m = derive(p).model;
    expect(m.innerDims.width).toBeCloseTo(1984, 6);
    expect(m.outer.width).toBeCloseTo(2000, 6);
    // Inside: 496 (2:1 on R 992) + 3000 + (250 − 12).
    expect(m.innerDims.length).toBeCloseTo(496 + 3000 + 238, 6);
    // Outside: the inside plus both plates.
    expect(m.outer.length).toBeCloseTo(496 + 3000 + 238 + 10 + 12, 6);
  });
});
