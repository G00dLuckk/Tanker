import { describe, expect, it } from 'vitest';
import { defaultBody, defaultHead } from '../src/core/defaults';
import { halfChord, unitSeg } from '../src/core/shape';
import { buildTank } from '../src/core/tank';
import type { BodyConfig, HeadConfig, TankConfig } from '../src/core/types';
import { VolumeEngine } from '../src/core/volume';

/** Inside dimensions and zero walls, so formulas apply directly. */
function tank(o: {
  orientation?: 'vertical' | 'horizontal';
  body?: Partial<BodyConfig>;
  start?: Partial<HeadConfig>;
  end?: Partial<HeadConfig>;
  tilt?: number;
}): TankConfig {
  return {
    orientation: o.orientation ?? 'vertical',
    basis: 'inside',
    body: { ...defaultBody(), thickness: 0, endScale: 1, ...o.body },
    start: { ...defaultHead('flat', 0), ...o.start },
    end: { ...defaultHead('flat', 0), ...o.end },
    tilt: o.tilt ?? 0,
  };
}

const cap = (R: number, h: number) => (Math.PI * h * h * (3 * R - h)) / 3;
const circSeg = (R: number, h: number) => R * R * unitSeg((h - R) / R);

function expectRel(actual: number, expected: number, tol = 1e-6) {
  const scale = Math.max(Math.abs(expected), 1);
  expect(Math.abs(actual - expected) / scale).toBeLessThan(tol);
}

describe('vertical tanks', () => {
  it('flat cylinder', () => {
    const R = 500;
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 2 * R, length: 1000 } })));
    expectRel(e.depth, 1000);
    for (const h of [0, 1, 123.4, 500, 999, 1000]) expectRel(e.volume(h), Math.PI * R * R * h);
  });

  it('hemispherical bottom', () => {
    const R = 500;
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 2 * R, length: 1000 }, start: { type: 'hemi' } })));
    expectRel(e.depth, 1500);
    for (const h of [10, 250, 499, 500, 777, 1500]) {
      const ref = h <= R ? cap(R, h) : (2 / 3) * Math.PI * R ** 3 + Math.PI * R * R * (h - R);
      expectRel(e.volume(h), ref);
    }
  });

  it('2:1 ellipsoidal bottom and top', () => {
    const R = 600;
    const d = R / 2;
    const e = new VolumeEngine(
      buildTank(tank({ body: { diameter: 2 * R, length: 800 }, start: { type: 'ellipsoidal' }, end: { type: 'ellipsoidal' } })),
    );
    expectRel(e.depth, 800 + 2 * d);
    const s = d / R;
    for (const h of [5, 100, 299, 300, 700]) {
      const ref = h <= d ? s * cap(R, h / s) : s * (2 / 3) * Math.PI * R ** 3 + Math.PI * R * R * (h - d);
      expectRel(e.volume(h), ref);
    }
    expectRel(e.total, (4 / 3) * Math.PI * R * R * d + Math.PI * R * R * 800);
  });

  it('cone bottom to a point and with an outlet', () => {
    const R = 500;
    const d = 400;
    const e = new VolumeEngine(
      buildTank(tank({ body: { diameter: 2 * R, length: 600 }, start: { type: 'cone', sizeBy: 'depth', depth: d, outlet: 0 } })),
    );
    for (const h of [1, 100, 399]) expectRel(e.volume(h), (Math.PI * (R * h) ** 2 * h) / (3 * d * d));

    const r0 = 50;
    const e2 = new VolumeEngine(
      buildTank(
        tank({ body: { diameter: 2 * R, length: 600 }, start: { type: 'cone', sizeBy: 'depth', depth: d, outlet: 2 * r0 } }),
      ),
    );
    for (const h of [1, 100, 399, 400]) {
      const r = r0 + ((R - r0) * h) / d;
      expectRel(e2.volume(h), ((Math.PI * h) / 3) * (r0 * r0 + r0 * r + r * r));
    }
  });

  it('cone from angle gives the expected depth', () => {
    const R = 500;
    const m = buildTank(tank({ body: { diameter: 2 * R, length: 600 }, start: { type: 'cone', sizeBy: 'angle', angle: 45 } }));
    expectRel(m.start.depth, R);
  });

  it('rectangular box and tapered shell', () => {
    const e = new VolumeEngine(buildTank(tank({ body: { type: 'rect', width: 1200, depth: 1000, length: 1000 } })));
    for (const h of [3, 500, 1000]) expectRel(e.volume(h), 1200 * 1000 * h);

    // Frustum shell: radius 600 at the bottom, 450 at the top.
    const e2 = new VolumeEngine(buildTank(tank({ body: { diameter: 1200, length: 900, endScale: 0.75 } })));
    for (const h of [100, 450, 900]) {
      const r = 600 + ((450 - 600) * h) / 900;
      expectRel(e2.volume(h), ((Math.PI * h) / 3) * (600 * 600 + 600 * r + r * r));
    }
  });

  it('torispherical (Klöpper) depth matches DIN 28011 proportions', () => {
    const D = 2000;
    const m = buildTank(tank({ body: { diameter: D, length: 1000 }, end: { type: 'torispherical', tori: 'klopper' } }));
    expectRel(m.end.depth / D, 0.19377, 1e-4);
    // Head volume by brute-force Simpson integration of the profile.
    const e = new VolumeEngine(m);
    const R = D / 2;
    const n = 200000;
    const hs = { ku: 0, kv: 0, du: 0, dv: 0 };
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const t = (m.end.depth * i) / n;
      const k = m.end.at(t, hs).ku;
      const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
      sum += w * Math.PI * (k * R) ** 2;
    }
    const head = (sum * m.end.depth) / n / 3;
    expectRel(e.total, head + Math.PI * R * R * 1000, 1e-7);
    // Klöpper heads hold roughly 0.1 D³.
    expect(head / D ** 3).toBeGreaterThan(0.095);
    expect(head / D ** 3).toBeLessThan(0.105);
  });
});

describe('horizontal tanks', () => {
  const R = 600;
  const L = 2000;

  it('flat ends', () => {
    const e = new VolumeEngine(buildTank(tank({ orientation: 'horizontal', body: { diameter: 2 * R, length: L } })));
    expectRel(e.depth, 2 * R);
    for (const h of [0.5, 37, 300, 600, 900, 1199.5, 1200]) expectRel(e.volume(h), L * circSeg(R, h));
  });

  it('hemispherical ends', () => {
    const e = new VolumeEngine(
      buildTank(tank({ orientation: 'horizontal', body: { diameter: 2 * R, length: L }, start: { type: 'hemi' }, end: { type: 'hemi' } })),
    );
    for (const h of [1, 50, 333, 600, 1000, 1199]) expectRel(e.volume(h), L * circSeg(R, h) + cap(R, h), 2e-6);
  });

  it('2:1 ellipsoidal ends', () => {
    const d = R / 2;
    const e = new VolumeEngine(
      buildTank(
        tank({ orientation: 'horizontal', body: { diameter: 2 * R, length: L }, start: { type: 'ellipsoidal' }, end: { type: 'ellipsoidal' } }),
      ),
    );
    for (const h of [2, 120, 600, 1111]) expectRel(e.volume(h), L * circSeg(R, h) + (d / R) * cap(R, h), 2e-6);
  });

  it('elliptical shell (road tanker)', () => {
    const A = 1250;
    const B = 850;
    const e = new VolumeEngine(
      buildTank(tank({ orientation: 'horizontal', body: { type: 'oval', width: 2 * A, depth: 2 * B, length: 8000 } })),
    );
    for (const h of [10, 425, 850, 1500]) expectRel(e.volume(h), 8000 * A * B * unitSeg((h - B) / B));
  });

  it('sphere', () => {
    const Rs = 1000;
    const e = new VolumeEngine(buildTank(tank({ body: { type: 'sphere', diameter: 2 * Rs } })));
    expectRel(e.depth, 2 * Rs);
    for (const h of [1, 200, 1000, 1700, 2000]) expectRel(e.volume(h), cap(Rs, h), 2e-6);
  });

  it('stadium shell matches its closed-form area', () => {
    const e = new VolumeEngine(
      buildTank(tank({ orientation: 'horizontal', body: { type: 'stadium', width: 2400, depth: 1600, length: 1000 } })),
    );
    // Stadium 2400 × 1600: rectangle 800 × 1600 plus a circle of radius 800.
    expectRel(e.total, 1000 * (800 * 1600 + Math.PI * 800 * 800));
    expectRel(e.volume(800), e.total / 2);
  });
});

describe('tilt', () => {
  it('tilted horizontal cylinder matches column integration', () => {
    const R = 600;
    const L = 3000;
    const th = (2 * Math.PI) / 180;
    const m = buildTank(tank({ orientation: 'horizontal', body: { diameter: 2 * R, length: L }, tilt: 2 }));
    const e = new VolumeEngine(m, 2);
    // Columns over (a, u): liquid from the shell bottom up to the surface.
    const ref = (h: number) => {
      const na = Math.sin(th);
      const nv = Math.cos(th);
      const na_ = 1200;
      const nu_ = 600;
      let sum = 0;
      for (let i = 0; i < na_; i++) {
        const a = ((i + 0.5) * L) / na_;
        const vcut = (h - na * a) / nv;
        for (let j = 0; j < nu_; j++) {
          const u = -R + ((j + 0.5) * 2 * R) / nu_;
          const half = halfChord(m.base, 0, u);
          const top = Math.min(half, vcut);
          if (top > -half) sum += top + half;
        }
      }
      return (sum * L * 2 * R) / (na_ * nu_);
    };
    for (const level of [100, 600, 1150]) {
      const h = e.hMin + level;
      expectRel(e.volume(level), ref(h), 2e-4);
    }
    expectRel(e.hMin, -R * Math.cos(th));
    expectRel(e.depth, 2 * R * Math.cos(th) + L * Math.sin(th));
  });

  it('leaning vertical cylinder matches column integration', () => {
    const R = 500;
    const L = 1500;
    const deg = 3;
    const th = (deg * Math.PI) / 180;
    const m = buildTank(tank({ body: { diameter: 2 * R, length: L }, tilt: deg }));
    const e = new VolumeEngine(m, deg);
    // Columns along the tank axis; u = R·cos φ removes the edge singularity.
    const ref = (h: number) => {
      const na = Math.cos(th);
      const nu = -Math.sin(th);
      const n = 20000;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const phi = ((i + 0.5) * Math.PI) / n;
        const u = R * Math.cos(phi);
        const half = R * Math.sin(phi);
        const top = Math.min(L, Math.max(0, (h - nu * u) / na));
        sum += 2 * half * top * ((half * Math.PI) / n);
      }
      return sum;
    };
    for (const level of [10, 700, 1500]) expectRel(e.volume(level), ref(e.hMin + level), 1e-5);
    expectRel(e.hMin, -R * Math.sin(th));
  });

  it('tilted tank with heads stays monotonic and complete', () => {
    const m = buildTank(
      tank({ orientation: 'horizontal', body: { diameter: 1600, length: 4000 }, start: { type: 'torispherical' }, end: { type: 'cone', angle: 20 }, tilt: 1.5 }),
    );
    const e = new VolumeEngine(m, 1.5);
    let prev = -1;
    for (let i = 0; i <= 400; i++) {
      const v = e.volume((e.depth * i) / 400);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6 * e.total);
      prev = v;
    }
    expectRel(e.volume(e.depth), e.total);
    // Tilt does not change the capacity.
    expectRel(new VolumeEngine(m, 0).total, e.total, 1e-9);
  });
});

describe('inverse lookup', () => {
  it('levelOf inverts volume', () => {
    const e = new VolumeEngine(
      buildTank(tank({ orientation: 'horizontal', body: { diameter: 1800, length: 3000 }, start: { type: 'hemi' }, end: { type: 'dished', depth: 300 } })),
    );
    for (const L of [0.3, 12, 450, 900, 1799]) expect(Math.abs(e.levelOf(e.volume(L)) - L)).toBeLessThan(1e-4);
  });
});
