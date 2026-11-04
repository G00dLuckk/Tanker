import { describe, expect, it } from 'vitest';
import { defaultBody, defaultHead } from '../src/core/defaults';
import { buildTank } from '../src/core/tank';
import type { BodyConfig, HeadConfig, TankConfig } from '../src/core/types';
import { VolumeEngine } from '../src/core/volume';

function tank(o: { orientation?: 'vertical' | 'horizontal'; basis?: 'inside' | 'outside'; body?: Partial<BodyConfig>; start?: Partial<HeadConfig>; end?: Partial<HeadConfig> }): TankConfig {
  return {
    orientation: o.orientation ?? 'vertical',
    basis: o.basis ?? 'inside',
    body: { ...defaultBody(), thickness: 0, endScale: 1, ...o.body },
    start: { ...defaultHead('flat', 0), ...o.start },
    end: { ...defaultHead('flat', 0), ...o.end },
    tilt: 0,
  };
}

const volume = (cfg: TankConfig) => new VolumeEngine(buildTank(cfg)).total;

function expectRel(actual: number, expected: number, tol = 1e-6) {
  expect(Math.abs(actual - expected) / Math.max(Math.abs(expected), 1)).toBeLessThan(tol);
}

describe('same size: body X = Y = Z', () => {
  it('a cylinder takes its diameter as the shell length', () => {
    const m = buildTank(tank({ body: { type: 'cylinder', diameter: 2000, length: 3000, uniform: true } }));
    expect(m.L).toBeCloseTo(2000, 9);
    expect(m.innerDims.width).toBeCloseTo(2000, 9);
    expectRel(volume(tank({ body: { type: 'cylinder', diameter: 2000, length: 3000, uniform: true } })), Math.PI * 1000 ** 2 * 2000);
  });

  it('a box becomes a cube of its width, standing or lying', () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const cfg = tank({ orientation, body: { type: 'rect', width: 1500, depth: 900, length: 700, corner: 0, uniform: true } });
      const m = buildTank(cfg);
      expect([m.innerDims.width, m.innerDims.depth, m.innerDims.length].map((v) => Math.round(v))).toEqual([1500, 1500, 1500]);
      expectRel(volume(cfg), 1500 ** 3);
    }
  });

  it('ignores the circumference and the overall length while it is on', () => {
    const cfg = tank({ body: { type: 'cylinder', diameter: 1200, length: 500, sizeBy: 'perimeter', perimeter: 9999, lengthBy: 'overall', overall: 9999, uniform: true } });
    const m = buildTank(cfg);
    expect(m.innerDims.width).toBeCloseTo(1200, 9);
    expect(m.L).toBeCloseTo(1200, 9);
  });

  it('off: the sizes stay as typed', () => {
    const m = buildTank(tank({ body: { type: 'rect', width: 1500, depth: 900, length: 700, corner: 0, uniform: false } }));
    expect([m.innerDims.width, m.innerDims.depth, m.L].map((v) => Math.round(v))).toEqual([1500, 900, 700]);
  });
});

describe('same size: head depth Z = shell width X', () => {
  it('a half-oval head as deep as the shell is wide', () => {
    const cfg = tank({ body: { type: 'cylinder', diameter: 2000, length: 1000 }, end: { type: 'ellipsoidal', ratioBy: 'ratio', ellipseRatio: 2, uniform: true } });
    const m = buildTank(cfg);
    expect(m.end.depth).toBeCloseTo(2000, 6);
    // Shell + half ellipsoid of semi-axes 1000, 1000, 2000.
    expectRel(volume(cfg), Math.PI * 1000 ** 2 * 1000 + (2 / 3) * Math.PI * 1000 ** 2 * 2000, 1e-5);
  });

  it('cones and paraboloids follow the width; the outside depth is measured through the head plate', () => {
    const cone = buildTank(tank({ basis: 'outside', body: { type: 'cylinder', diameter: 1000, length: 1000, thickness: 5 }, start: { type: 'cone', sizeBy: 'angle', angle: 30, outlet: 0, thickness: 8, uniform: true } }));
    // Outside width 1000 → outside depth 1000 → inside depth 1000 − 8.
    expect(cone.start.depth).toBeCloseTo(992, 6);
    const para = buildTank(tank({ body: { type: 'cylinder', diameter: 1600, length: 1000 }, end: { type: 'paraboloid', depth: 100, uniform: true } }));
    expect(para.end.depth).toBeCloseTo(1600, 6);
  });

  it('on a tapered shell each end takes its own width', () => {
    const m = buildTank(tank({ body: { type: 'cylinder', diameter: 2000, length: 1000, endScale: 0.5 }, start: { type: 'cone', uniform: true }, end: { type: 'cone', uniform: true } }));
    expect(m.start.depth).toBeCloseTo(2000, 6);
    expect(m.end.depth).toBeCloseTo(1000, 6);
  });

  it('follows the body when both locks are on', () => {
    const m = buildTank(tank({ body: { type: 'cylinder', diameter: 1800, length: 300, uniform: true }, end: { type: 'ellipsoidal', uniform: true } }));
    expect(m.L).toBeCloseTo(1800, 9);
    expect(m.end.depth).toBeCloseTo(1800, 6);
  });

  it('has no effect on heads that cannot be that deep, or when off', () => {
    const hemi = buildTank(tank({ body: { type: 'cylinder', diameter: 2000, length: 1000 }, end: { type: 'hemi', uniform: true } }));
    expect(hemi.end.depth).toBeCloseTo(1000, 6);
    const off = buildTank(tank({ body: { type: 'cylinder', diameter: 2000, length: 1000 }, end: { type: 'cone', sizeBy: 'depth', depth: 300, uniform: false } }));
    expect(off.end.depth).toBeCloseTo(300, 6);
  });
});
