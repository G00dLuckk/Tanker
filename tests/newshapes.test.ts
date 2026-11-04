import { describe, expect, it } from 'vitest';
import { defaultBody, defaultHead, defaultManhole, defaultSensor } from '../src/core/defaults';
import { manholeGeometry, sensorGeometry, verticalSpan } from '../src/core/sensors';
import { makeOutline } from '../src/core/shape';
import { bodyPerimeter, buildTank, resolveBodySize } from '../src/core/tank';
import type { BodyConfig, HeadConfig, TankConfig } from '../src/core/types';
import { VolumeEngine, capacityOf } from '../src/core/volume';

function tank(o: {
  orientation?: 'vertical' | 'horizontal';
  basis?: 'inside' | 'outside';
  body?: Partial<BodyConfig>;
  start?: Partial<HeadConfig>;
  end?: Partial<HeadConfig>;
  tilt?: number;
}): TankConfig {
  return {
    orientation: o.orientation ?? 'vertical',
    basis: o.basis ?? 'inside',
    body: { ...defaultBody(), thickness: 0, endScale: 1, ...o.body },
    start: { ...defaultHead('flat', 0), ...o.start },
    end: { ...defaultHead('flat', 0), ...o.end },
    tilt: o.tilt ?? 0,
  };
}

function expectRel(actual: number, expected: number, tol = 1e-6) {
  expect(Math.abs(actual - expected) / Math.max(Math.abs(expected), 1)).toBeLessThan(tol);
}

/** Simpson's rule, used as an independent check of head volumes. */
function simpson(f: (x: number) => number, a: number, b: number, n = 20000): number {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}

describe('new bodies', () => {
  it('lying trapezoid: wetted area of a trapezoid at every level', () => {
    const [Wt, Wb, H, L] = [2000, 1400, 1300, 4000];
    const m = buildTank(tank({ orientation: 'horizontal', body: { type: 'trapezoid', width: Wt, width2: Wb, depth: H, length: L } }));
    const e = new VolumeEngine(m, 0);
    expectRel(e.depth, H, 1e-9);
    for (const h of [0, 120, 650, 1111, 1300]) {
      const area = (h * (Wb + Wb + ((Wt - Wb) * h) / H)) / 2;
      expectRel(e.volume(h), area * L, 1e-9);
    }
  });

  it('standing trapezoid (plan) fills like a prism', () => {
    const m = buildTank(tank({ body: { type: 'trapezoid', width: 1800, width2: 1000, depth: 900, length: 2000 } }));
    const e = new VolumeEngine(m, 0);
    for (const h of [300, 2000]) expectRel(e.volume(h), ((1800 + 1000) / 2) * 900 * h, 1e-9);
  });

  it('chamfered box, outside sizes: the wall comes off every side exactly', () => {
    const [W, H, c, t] = [2000, 1500, 200, 6];
    const m = buildTank(tank({ basis: 'outside', body: { type: 'chamfer', width: W, depth: H, chamfer: c, length: 1000, thickness: t } }));
    const ci = c - t * (2 - Math.SQRT2);
    expectRel(capacityOf(m), ((W - 2 * t) * (H - 2 * t) - 2 * ci * ci) * 1000, 1e-9);
  });

  it('box-oval area matches the superellipse formula', () => {
    // Area of |x/a|^4 + |y/b|^4 ≤ 1 is 4ab Γ(1.25)² / Γ(1.5).
    const [a, b] = [1200, 800];
    const m = buildTank(tank({ body: { type: 'boxoval', width: 2 * a, depth: 2 * b, squareness: 4, length: 1000 } }));
    expectRel(capacityOf(m), ((4 * a * b * 0.9064024770554771 ** 2) / 0.886226925452758) * 1000, 2e-5);
  });

  it('lying D-shape: rectangle below, half circle above', () => {
    const [W, H, L] = [2000, 1600, 3000];
    const R = W / 2;
    const m = buildTank(tank({ orientation: 'horizontal', body: { type: 'dshape', width: W, depth: H, length: L } }));
    const e = new VolumeEngine(m, 0);
    expectRel(e.depth, H, 1e-9);
    expectRel(e.volume(400), W * 400 * L, 1e-9);
    const y = 500;
    const seg = y * Math.sqrt(R * R - y * y) + R * R * Math.asin(y / R);
    expectRel(e.volume(H - R + y), (W * (H - R) + seg) * L, 1e-5);
    expectRel(e.totalLitres * 1e6, (W * (H - R) + (Math.PI * R * R) / 2) * L, 1e-5);
  });

  it('lying U-trough: round bottom fills like a circle segment', () => {
    const [W, H, L] = [1600, 1200, 2500];
    const R = W / 2;
    const m = buildTank(tank({ orientation: 'horizontal', body: { type: 'trough', width: W, depth: H, length: L } }));
    const e = new VolumeEngine(m, 0);
    for (const h of [100, 500, 800]) {
      const seg = R * R * Math.acos((R - h) / R) - (R - h) * Math.sqrt(2 * R * h - h * h);
      expectRel(e.volume(h), seg * L, 1e-5);
    }
    expectRel(e.volume(1000), ((Math.PI * R * R) / 2 + W * 200) * L, 1e-5);
  });

  it('roof of a lying D-shape follows the round top (sensors and manholes)', () => {
    const cfg = tank({ orientation: 'horizontal', body: { type: 'dshape', width: 2000, depth: 1600, length: 3000 } });
    const m = buildTank(cfg);
    const e = new VolumeEngine(m, 0);
    const span = verticalSpan(m, 0, 800)!;
    expectRel(span.hi - span.lo, 600 + 600, 1e-5);
    const mh = { ...defaultManhole('MH-1'), neck: 100 };
    const mg = manholeGeometry(mh, m, e);
    expectRel(mg.coverHeight, 1600 + 100, 1e-6);
    const g = sensorGeometry({ ...defaultSensor('radar', 'LT-1'), faceMode: 'manhole', manhole: mh.id, nozzle: 0 }, m, e, 1000, [mg]);
    expectRel(g.faceLevel, 1700, 1e-6);
  });

  it('sloping lying D-shape matches column integration', () => {
    const [W, H, L, deg] = [2000, 1600, 3000, 2];
    const R = W / 2;
    const th = (deg * Math.PI) / 180;
    const m = buildTank(tank({ orientation: 'horizontal', body: { type: 'dshape', width: W, depth: H, length: L }, tilt: deg }));
    const e = new VolumeEngine(m, deg);
    // Columns over (a, u), bounds written out by hand: floor at v = −H/2, roof on the circle centred at H/2 − R.
    const ref = (h: number) => {
      const [na, nu] = [1200, 600];
      let sum = 0;
      for (let i = 0; i < na; i++) {
        const a = ((i + 0.5) * L) / na;
        const vcut = (h - Math.sin(th) * a) / Math.cos(th);
        for (let j = 0; j < nu; j++) {
          const u = -R + ((j + 0.5) * W) / nu;
          const top = Math.min(H / 2 - R + Math.sqrt(R * R - u * u), vcut);
          if (top > -H / 2) sum += top + H / 2;
        }
      }
      return (sum * L * W) / (na * nu);
    };
    for (const level of [150, 900, 1600]) expectRel(e.volume(level), ref(e.hMin + level), 3e-4);
  });

  it('typed circumference sizes a trapezoid and keeps its width ratio', () => {
    const cfg = tank({ orientation: 'horizontal', body: { type: 'trapezoid', width: 2000, width2: 1500, depth: 1200, length: 1000, sizeBy: 'perimeter', perimeter: 6000 } });
    const sized = resolveBodySize(cfg).body;
    expectRel(bodyPerimeter(sized), 6000, 1e-9);
    expectRel(sized.width2 / sized.width, 0.75, 1e-12);
  });

  it('drawing outlines put the cut-away points on the axes', () => {
    for (const type of ['trapezoid', 'dshape', 'trough', 'boxoval', 'chamfer'] as const) {
      const m = buildTank(tank({ orientation: 'horizontal', body: { type, width: 2000, width2: 1200, depth: 1400, length: 1000 } }));
      const o = makeOutline(m.base, 112);
      const [c0, c1, c2, c3] = o.cardinal;
      expect(Math.abs(o.v[c0])).toBeLessThan(1e-6);
      expect(o.u[c0]).toBeGreaterThan(0);
      expect(Math.abs(o.u[c1])).toBeLessThan(1e-6);
      expect(o.v[c1]).toBeGreaterThan(0);
      expect(Math.abs(o.v[c2])).toBeLessThan(1e-6);
      expect(o.u[c2]).toBeLessThan(0);
      expect(Math.abs(o.u[c3])).toBeLessThan(1e-6);
      expect(o.v[c3]).toBeLessThan(0);
      expect(o.n).toBeLessThan(400);
    }
  });
});

describe('new heads', () => {
  const R = 600;
  const L = 1000;
  const shell = Math.PI * R * R * L;

  it('paraboloidal head holds half its cylinder', () => {
    const d = 400;
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, end: { type: 'paraboloid', depth: d } }));
    expectRel(m.end.depth, d);
    expectRel(capacityOf(m), shell + (Math.PI * R * R * d) / 2, 1e-7);
  });

  it('flanged flat head: a quarter-round rim, then flat', () => {
    const rk = 120;
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, end: { type: 'flanged', knuckleR: rk } }));
    expectRel(m.end.depth, rk);
    expect(m.end.closed).toBe(true);
    const head = simpson((t) => Math.PI * (R - rk + Math.sqrt(Math.max(0, rk * rk - t * t))) ** 2, 0, rk);
    expectRel(capacityOf(m), shell + head, 1e-6);
  });

  it('flanged head on a box keeps flat sides', () => {
    const [A, B, rk] = [800, 500, 100];
    const m = buildTank(tank({ body: { type: 'rect', width: 2 * A, depth: 2 * B, length: L }, end: { type: 'flanged', knuckleR: rk } }));
    const inset = (t: number) => rk - Math.sqrt(Math.max(0, rk * rk - t * t));
    const head = simpson((t) => 4 * (A - inset(t)) * (B - inset(t)), 0, rk);
    expectRel(capacityOf(m), 4 * A * B * L + head, 1e-6);
  });

  it('toriconical head: knuckle then straight cone', () => {
    const [ro, rk, deg] = [50, 100, 45];
    const a = (deg * Math.PI) / 180;
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, start: { type: 'toricone', sizeBy: 'angle', angle: deg, outlet: 2 * ro, knuckleR: rk } }));
    const tK = rk * Math.cos(a);
    const rK = R - rk * (1 - Math.sin(a));
    const depth = tK + (rK - ro) * Math.tan(a);
    expectRel(m.start.depth, depth, 1e-9);
    const r = (t: number) => (t <= tK ? R - rk + Math.sqrt(rk * rk - t * t) : rK - (t - tK) / Math.tan(a));
    const head = simpson((t) => Math.PI * r(t) ** 2, 0, tK) + simpson((t) => Math.PI * r(t) ** 2, tK, depth);
    expectRel(capacityOf(m), shell + head, 1e-6);
  });

  it('toriconical head sized by depth finds the wall angle', () => {
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, start: { type: 'toricone', sizeBy: 'depth', depth: 450, outlet: 100, knuckleR: 80 } }));
    expectRel(m.start.depth, 450, 1e-9);
    expect(m.start.meta.issue).toBeUndefined();
  });

  it('80:10 torispherical standard', () => {
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, end: { type: 'torispherical', tori: 'r8010' } }));
    expectRel(m.end.meta.crownR!, 0.8 * 2 * R);
    expectRel(m.end.meta.knuckleR!, 0.1 * 2 * R);
  });
});
