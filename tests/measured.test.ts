import { describe, expect, it } from 'vitest';
import { defaultBody, defaultHead } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import { capFromArc, toriShape } from '../src/core/heads';
import { bodyPerimeter, buildTank, overallOf, resolveBodySize, syncTankInputs } from '../src/core/tank';
import type { BodyConfig, HeadConfig, TankConfig, ToriBy } from '../src/core/types';
import { capacityOf } from '../src/core/volume';
import { emptyProject } from '../src/core/defaults';
import { parseProjectDoc } from '../src/app/persist';
import { fitToCapacity } from '../src/ui/tankPanel';
import { MM3_TO_L } from '../src/core/units';

function tank(o: {
  orientation?: 'vertical' | 'horizontal';
  basis?: 'inside' | 'outside';
  body?: Partial<BodyConfig>;
  start?: Partial<HeadConfig>;
  end?: Partial<HeadConfig>;
  sameEnds?: boolean;
}): TankConfig {
  return {
    orientation: o.orientation ?? 'horizontal',
    basis: o.basis ?? 'inside',
    body: { ...defaultBody(), thickness: 0, endScale: 1, ...o.body },
    start: { ...defaultHead('flat', 0), ...o.start },
    end: { ...defaultHead('flat', 0), ...o.end },
    tilt: 0,
    sameEnds: o.sameEnds,
  };
}

function expectRel(actual: number, expected: number, tol = 1e-6) {
  expect(Math.abs(actual - expected) / Math.max(Math.abs(expected), 1)).toBeLessThan(tol);
}

const ALL_BY: ToriBy[] = ['depth-crown', 'depth-knuckle', 'crown-knuckle', 'arc-depth', 'arc-crown', 'arc-knuckle'];

describe('measured torispherical heads', () => {
  for (const basis of ['inside', 'outside'] as const) {
    it(`any two of depth, crown, knuckle and arc give the same head (${basis})`, () => {
      const t = basis === 'outside' ? 8 : 0;
      // Reference: a Korbbogen head on a 2000 mm shell.
      const ref = buildTank(tank({ basis, body: { diameter: 2000, length: 3000, thickness: t }, start: { type: 'torispherical', tori: 'korbbogen', thickness: t } }));
      const h = ref.start;
      const R = ref.base.A;
      const shape = toriShape(R, h.meta.crownR!, h.meta.knuckleR!);
      expectRel(shape.depth, h.depth, 1e-9);
      const typed = {
        depth: h.depth + t,
        crownR: h.meta.crownR! + t,
        knuckleR: h.meta.knuckleR! + t,
        arc: shape.arc + Math.PI * t,
      };
      for (const toriBy of ALL_BY) {
        const m = buildTank(
          tank({ basis, body: { diameter: 2000, length: 3000, thickness: t }, start: { type: 'torispherical', tori: 'measured', toriBy, thickness: t, ...typed } }),
        );
        expect(m.warnings, toriBy).toEqual([]);
        expectRel(m.start.meta.crownR!, h.meta.crownR!, 1e-6);
        expectRel(m.start.meta.knuckleR!, h.meta.knuckleR!, 1e-6);
        expectRel(m.start.depth, h.depth, 1e-6);
        expectRel(capacityOf(m), capacityOf(ref), 1e-6);
      }
    });
  }

  it('impossible pairs give a plain warning and still a valid tank', () => {
    const cases: Partial<HeadConfig>[] = [
      { toriBy: 'depth-crown', depth: 50, crownR: 1000 }, // shallower than a plain dish
      { toriBy: 'depth-crown', depth: 1500, crownR: 2000 }, // deeper than the radius
      { toriBy: 'depth-knuckle', depth: 100, knuckleR: 200 }, // knuckle deeper than the head
      { toriBy: 'crown-knuckle', crownR: 500, knuckleR: 100 }, // crown smaller than the shell
      { toriBy: 'crown-knuckle', crownR: 2000, knuckleR: 1500 },
      { toriBy: 'arc-crown', arc: 1000, crownR: 2000 }, // shorter than the diameter
      { toriBy: 'arc-knuckle', arc: 9000, knuckleR: 200 },
      { toriBy: 'arc-depth', arc: 2010, depth: 600 },
      { toriBy: 'arc-depth', arc: 2400, depth: 0 },
    ];
    for (const c of cases) {
      const p = emptyProject();
      p.tank = tank({ body: { diameter: 2000, length: 3000 }, start: { type: 'torispherical', tori: 'measured', ...c } });
      const d = derive(p);
      expect(d.problems.length, JSON.stringify(c)).toBe(1);
      expect(d.problems[0]).toMatch(/^Left end: /);
      expect(Number.isFinite(d.totalL) && d.totalL > 0).toBe(true);
      expect(d.model.start.depth).toBeGreaterThan(0);
      expect(d.model.start.depth).toBeLessThanOrEqual(1000);
    }
  });
});

describe('shallow dome by arc length', () => {
  for (const t of [0, 6]) {
    it(`arc length gives the same dome as the depth (wall ${t})`, () => {
      const basis = t ? 'outside' : 'inside';
      const ref = buildTank(tank({ basis, body: { diameter: 1600, length: 2000, thickness: t }, end: { type: 'dished', dishBy: 'depth', depth: 220 + t, thickness: t } }));
      // Outside: the sphere one wall larger, from the outside wall to the outside wall.
      const Rs = ref.end.meta.sphereR! + t;
      const R = ref.base.A + t;
      const arc = 2 * Rs * Math.asin(R / Rs);
      const m = buildTank(tank({ basis, body: { diameter: 1600, length: 2000, thickness: t }, end: { type: 'dished', dishBy: 'arc', arc, thickness: t } }));
      expect(m.warnings).toEqual([]);
      expectRel(m.end.depth, ref.end.depth, 1e-9);
      expectRel(capacityOf(m), capacityOf(ref), 1e-9);
    });
  }

  it('the customer tank: tape over the roof from the outside wall to the outside wall', () => {
    // Outside circumference 14380, 5 mm plates, 4590.5 mm over the dome: the customer's own script
    // takes the outside sphere through the outside wall and the inside sphere 5 mm smaller.
    const rOut = 14380 / (2 * Math.PI);
    const rIn = rOut - 5;
    const k = (2 * rOut) / 4590.5;
    let th = Math.sqrt(6 * (1 - k));
    for (let i = 0; i < 50; i++) th -= (Math.sin(th) / th - k) / ((th * Math.cos(th) - Math.sin(th)) / (th * th));
    const sphereIn = 4590.5 / (2 * th) - 5;
    const rise = sphereIn - Math.sqrt(sphereIn ** 2 - rIn ** 2);
    const m = buildTank(tank({ orientation: 'vertical', basis: 'outside', body: { sizeBy: 'perimeter', perimeter: 14380, length: 9060, thickness: 5 }, end: { type: 'dished', dishBy: 'arc', arc: 4590.5, thickness: 5 } }));
    expectRel(m.base.A, rIn, 1e-9);
    expectRel(m.end.meta.sphereR!, sphereIn, 1e-7);
    expectRel(m.end.depth, rise, 1e-7);
  });

  it('limits: flat below the diameter, half sphere at π R', () => {
    expect(capFromArc(500, 900, 0).depth).toBe(0);
    expect(capFromArc(500, 900, 0).issue).toBeTruthy();
    expectRel(capFromArc(500, Math.PI * 500, 0).depth, 500, 1e-9);
    const over = capFromArc(500, 2000, 0);
    expectRel(over.depth, 500, 1e-9);
    expect(over.issue).toBeTruthy();
  });
});

describe('shell size from the circumference', () => {
  const shapes: Partial<BodyConfig>[] = [
    { type: 'cylinder', diameter: 1850 },
    { type: 'sphere', diameter: 3000 },
    { type: 'oval', width: 2500, depth: 1700 },
    { type: 'rect', width: 1200, depth: 1000, corner: 60 },
    { type: 'stadium', width: 2400, depth: 1500 },
    { type: 'polygon', sides: 8, width: 1500, depth: 1500 },
    { type: 'polygon', sides: 6, width: 1800, depth: 1500 },
  ];
  for (const s of shapes) {
    it(`${s.type}${s.sides ?? ''}: circumference reproduces the size`, () => {
      const plain = tank({ orientation: 'vertical', basis: 'outside', body: { ...s, length: 1500, thickness: 5 } });
      const P = bodyPerimeter(plain.body);
      const byP = tank({ orientation: 'vertical', basis: 'outside', body: { ...s, length: 1500, thickness: 5, sizeBy: 'perimeter', perimeter: P, diameter: 1, width: 1 } });
      const r = resolveBodySize(byP);
      expect(r.issue).toBeUndefined();
      const round = s.type === 'cylinder' || s.type === 'sphere';
      expectRel(round ? r.body.diameter : r.body.width, round ? s.diameter! : s.width!, 1e-9);
      expectRel(capacityOf(buildTank(byP)), capacityOf(buildTank(plain)), 1e-9);
    });
  }

  it('circle circumference is π × D', () => {
    expectRel(bodyPerimeter({ ...defaultBody(), type: 'cylinder', diameter: 1000 }), Math.PI * 1000, 1e-12);
    // Ellipse 2:1 (a = 2, b = 1): 9.688448220547676
    expectRel(bodyPerimeter({ ...defaultBody(), type: 'oval', width: 4, depth: 2 }), 9.688448220547676, 1e-7);
  });

  it('a circumference too short for the height is a warning', () => {
    const p = emptyProject();
    p.tank = tank({ orientation: 'vertical', body: { type: 'oval', depth: 1700, sizeBy: 'perimeter', perimeter: 2000, length: 1000 } });
    const d = derive(p);
    expect(d.problems.some((x) => /circumference/.test(x))).toBe(true);
    expect(d.totalL).toBeGreaterThan(0);
  });
});

describe('overall length', () => {
  const heads = { start: { type: 'torispherical' as const, tori: 'klopper' as const, thickness: 7 }, end: { type: 'ellipsoidal' as const, thickness: 9 } };
  for (const basis of ['inside', 'outside'] as const) {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      it(`overall ${orientation} length (${basis}) gives back the straight shell`, () => {
        const plain = tank({ orientation, basis, body: { diameter: 1800, length: 4200, thickness: 6 }, ...heads });
        const pm = buildTank(plain);
        const overall = overallOf(pm, basis);
        const ends = pm.start.depth + pm.end.depth + (basis === 'outside' ? 7 + 9 : 0);
        expectRel(overall, 4200 + ends, 1e-12);
        const m = buildTank({ ...plain, body: { ...plain.body, lengthBy: 'overall', overall, length: 999 } });
        expect(m.warnings).toEqual([]);
        expectRel(m.L, 4200, 1e-9);
        expectRel(capacityOf(m), capacityOf(pm), 1e-9);
      });
    }
  }

  it('the overall length holds when the ends change', () => {
    const t = tank({ body: { diameter: 1800, lengthBy: 'overall', overall: 6000 }, start: { type: 'hemi' }, end: { type: 'flat' } });
    expectRel(buildTank(t).L, 6000 - 900, 1e-9);
    t.end = { ...t.end, type: 'hemi' };
    expectRel(buildTank(t).L, 6000 - 1800, 1e-9);
  });

  it('works with a stepped shell', () => {
    const body: Partial<BodyConfig> = { diameter: 2000, length: 3000, profileOn: true, profile: [{ at: 1500, size: 2000 }, { at: 1800, size: 1400 }] };
    const plain = tank({ orientation: 'vertical', body, end: { type: 'cone', angle: 30 } });
    const pm = buildTank(plain);
    const m = buildTank({ ...plain, body: { ...plain.body, lengthBy: 'overall', overall: overallOf(pm, 'inside'), length: 100 } });
    expect(m.warnings).toEqual([]);
    expectRel(m.L, 3000, 1e-6);
  });

  it('shorter than the ends alone is a warning', () => {
    const p = emptyProject();
    p.tank = tank({ body: { diameter: 1800, lengthBy: 'overall', overall: 1000 }, start: { type: 'hemi' }, end: { type: 'hemi' } });
    const d = derive(p);
    expect(d.problems.some((x) => /shorter than the two ends/.test(x))).toBe(true);
    expect(d.model.L).toBe(0);
  });
});

describe('same shape at both ends', () => {
  it('the end gets the same inside shape as the start but keeps its own plate', () => {
    const t = tank({
      basis: 'outside',
      body: { diameter: 1800, length: 3000, thickness: 6 },
      start: { type: 'dished', depth: 300, thickness: 6 },
      end: { type: 'cone', angle: 40, thickness: 10 },
      sameEnds: true,
    });
    const m = buildTank(t);
    expect(m.end.type).toBe('dished');
    expectRel(m.end.depth, 300 - 6, 1e-12);
    expectRel(m.start.depth, 300 - 6, 1e-12);
    expect(m.t.end).toBe(10);
    expectRel(m.outer.length, 3000 + 2 * (300 - 6) + 6 + 10, 1e-12);
    t.sameEnds = false;
    expect(buildTank(t).end.type).toBe('cone');
  });
});

describe('switching how sizes are given keeps the tank', () => {
  it('sync then switch modes leaves the capacity unchanged', () => {
    const t = tank({
      basis: 'outside',
      body: { type: 'oval', width: 2500, depth: 1700, length: 8000, thickness: 5 },
      start: { type: 'dished', depth: 250, thickness: 5 },
      end: { type: 'torispherical', tori: 'asme', thickness: 5 },
    });
    const cap0 = capacityOf(buildTank(t));
    syncTankInputs(t);
    t.body.sizeBy = 'perimeter';
    t.body.lengthBy = 'overall';
    expectRel(capacityOf(buildTank(t)), cap0, 1e-9);
    // Changing an end now keeps the overall length; switching back keeps the result.
    t.start = { ...t.start, depth: 400 };
    const cap1 = capacityOf(buildTank(t));
    syncTankInputs(t);
    t.body.sizeBy = 'size';
    t.body.lengthBy = 'shell';
    expectRel(capacityOf(buildTank(t)), cap1, 1e-9);
  });

  it('fit to capacity works with overall length and circumference', () => {
    const t = tank({ body: { diameter: 1800, length: 4000, sizeBy: 'perimeter', perimeter: Math.PI * 1800, lengthBy: 'overall', overall: 5800 }, start: { type: 'hemi' }, end: { type: 'hemi' } });
    for (const what of ['length', 'size'] as const) {
      const r = fitToCapacity(t, 20000, what);
      expect('error' in r, what).toBe(false);
      if (!('error' in r)) expectRel(r.litres, 20000, 2e-3);
    }
  });
});

describe('project files', () => {
  it('older files open with the new fields filled in', () => {
    const p = emptyProject() as any;
    delete p.tank.body.sizeBy;
    delete p.tank.body.perimeter;
    delete p.tank.body.lengthBy;
    delete p.tank.body.overall;
    delete p.tank.sameEnds;
    delete p.tank.end.toriBy;
    delete p.tank.end.arc;
    const opened = parseProjectDoc(JSON.stringify({ project: p })).project;
    expect(opened.tank.body.sizeBy).toBe('size');
    expect(opened.tank.body.lengthBy).toBe('shell');
    expect(opened.tank.sameEnds).toBeFalsy();
    expect(opened.tank.end.toriBy).toBe('depth-crown');
    const cap = capacityOf(buildTank(opened.tank)) * MM3_TO_L;
    expectRel(cap, capacityOf(buildTank(emptyProject().tank)) * MM3_TO_L, 1e-12);
  });
});

describe('heads sized by one measurement', () => {
  for (const basis of ['inside', 'outside'] as const) {
    const t = basis === 'outside' ? 8 : 0;
    const body = { diameter: 2000, length: 3000, thickness: t };

    it(`torispherical by depth only or arc only matches the standard head (${basis})`, () => {
      for (const std of ['klopper', 'korbbogen', 'asme'] as const) {
        const ref = buildTank(tank({ basis, body, start: { type: 'torispherical', tori: std, thickness: t } }));
        const h = ref.start;
        const R = ref.base.A;
        // The assumed knuckle is a fraction of the head's outside diameter, like the standards.
        const knuckle = h.meta.knuckleR! / (2 * R + 2 * t);
        expect(knuckle).toBeCloseTo(std === 'klopper' ? 0.1 : std === 'korbbogen' ? 0.154 : 0.06, 9);
        const arc = toriShape(R, h.meta.crownR!, h.meta.knuckleR!).arc;
        for (const typed of [
          { toriBy: 'depth' as ToriBy, depth: h.depth + t },
          { toriBy: 'arc' as ToriBy, arc: arc + Math.PI * t },
        ]) {
          const m = buildTank(tank({ basis, body, start: { type: 'torispherical', tori: 'measured', knuckle, thickness: t, ...typed } }));
          expect(m.warnings, `${std} ${typed.toriBy}`).toEqual([]);
          expectRel(m.start.meta.crownR!, h.meta.crownR!, 1e-6);
          expectRel(m.start.depth, h.depth, 1e-6);
          expectRel(capacityOf(m), capacityOf(ref), 1e-6);
        }
      }
    });

    it(`semi-ellipsoidal by arc length matches the 2:1 head (${basis})`, () => {
      const ref = buildTank(tank({ basis, body, end: { type: 'ellipsoidal', ratioBy: 'ratio', ellipseRatio: 2, thickness: t } }));
      const arc = ref.end.meta.arc! + Math.PI * t;
      const m = buildTank(tank({ basis, body, end: { type: 'ellipsoidal', ratioBy: 'arc', arc, thickness: t } }));
      expect(m.warnings).toEqual([]);
      expectRel(m.end.depth, ref.end.depth, 1e-6);
      expectRel(capacityOf(m), capacityOf(ref), 1e-6);
    });
  }

  it('half-ellipse arc: π R for a hemisphere, and plain warnings out of range', () => {
    const hemi = buildTank(tank({ body: { diameter: 2000, length: 3000 }, end: { type: 'hemi' } }));
    expectRel(hemi.end.meta.arc!, Math.PI * 1000, 1e-9);
    for (const arc of [1500, 9000]) {
      const p = emptyProject();
      p.tank = tank({ body: { diameter: 2000, length: 3000 }, end: { type: 'ellipsoidal', ratioBy: 'arc', arc } });
      const d = derive(p);
      expect(d.problems.length).toBe(1);
      expect(d.totalL).toBeGreaterThan(0);
    }
  });
});
