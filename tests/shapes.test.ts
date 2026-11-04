import { describe, expect, it } from 'vitest';
import { defaultBody, defaultCal, defaultHead } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import { fitCalibration } from '../src/core/fieldcal';
import { PRESETS } from '../src/core/presets';
import { halfChord, polygonShape, segBelow, shapeArea } from '../src/core/shape';
import { buildTank } from '../src/core/tank';
import type { BodyConfig, HeadConfig, TankConfig } from '../src/core/types';
import { MM3_TO_L } from '../src/core/units';
import { VolumeEngine, capacityOf } from '../src/core/volume';
import { parseProjectDoc } from '../src/app/persist';
import { buildProjectFile } from '../src/export/projectFile';
import { collect, type ExportOptions } from '../src/export/shared';

function tank(o: { orientation?: 'vertical' | 'horizontal'; body?: Partial<BodyConfig>; start?: Partial<HeadConfig>; end?: Partial<HeadConfig>; tilt?: number }): TankConfig {
  return {
    orientation: o.orientation ?? 'vertical',
    basis: 'inside',
    body: { ...defaultBody(), thickness: 0, endScale: 1, ...o.body },
    start: { ...defaultHead('flat', 0), ...o.start },
    end: { ...defaultHead('flat', 0), ...o.end },
    tilt: o.tilt ?? 0,
  };
}

function expectRel(actual: number, expected: number, tol = 1e-6) {
  expect(Math.abs(actual - expected) / Math.max(Math.abs(expected), 1)).toBeLessThan(tol);
}

describe('polygon cross-sections', () => {
  it('regular octagon area across flats', () => {
    const W = 2000;
    const s = polygonShape(8, W / 2, W / 2);
    expectRel(shapeArea(s), 2 * (Math.SQRT2 - 1) * W * W);
    // Flat sides: the half chord at the middle is the full half width.
    expectRel(halfChord(s, 1, 0), W / 2);
  });

  it('hexagon partial areas match a strip integration', () => {
    const s = polygonShape(6, 900, 779.4);
    for (const axis of [0, 1] as const) {
      const Q = axis === 1 ? s.B : s.A;
      for (const f of [-0.9, -0.3, 0, 0.42, 0.95]) {
        const eta = f * Q;
        const n = 20000;
        let area = 0;
        for (let i = 0; i < n; i++) {
          const w = -Q + ((eta + Q) * (i + 0.5)) / n;
          area += 2 * halfChord(s, axis, w) * ((eta + Q) / n);
        }
        expectRel(segBelow(s, axis, eta), area, 1e-5);
      }
    }
  });

  it('vertical octagonal prism volume is area × height', () => {
    const W = 1500;
    const e = new VolumeEngine(buildTank(tank({ body: { type: 'polygon', sides: 8, width: W, depth: W, length: 1200 } })));
    const area = 2 * (Math.SQRT2 - 1) * W * W;
    for (const h of [0, 300, 1200]) expectRel(e.volume(h), area * h);
  });

  it('horizontal hexagon fills like its cross-section', () => {
    const m = buildTank(tank({ orientation: 'horizontal', body: { type: 'polygon', sides: 6, width: 1000, depth: 866, length: 2000 } }));
    const e = new VolumeEngine(m);
    expectRel(e.depth, 866);
    for (const h of [50, 433, 800]) expectRel(e.volume(h), segBelow(m.base, 1, h - 433) * 2000);
  });

  it('outside basis across corners removes the wall along the corner direction', () => {
    const cfg = tank({ body: { type: 'polygon', sides: 6, width: 1000, depth: 866, thickness: 10, length: 500 } });
    cfg.basis = 'outside';
    const m = buildTank(cfg);
    expectRel(2 * m.base.A, 1000 - 20 / Math.cos(Math.PI / 6));
    expectRel(2 * m.base.B, 866 - 20);
  });
});

describe('custom shell profile', () => {
  it('stepped cylinder = cylinder + frustum + cylinder', () => {
    const R1 = 800;
    const R2 = 500;
    const body = {
      diameter: 2 * R1,
      length: 2400,
      profileOn: true,
      profile: [
        { at: 1200, size: 2 * R1 },
        { at: 1450, size: 2 * R2 },
      ],
    };
    const m = buildTank(tank({ body }));
    const e = new VolumeEngine(m);
    const frustum = (Math.PI * 250 * (R1 * R1 + R1 * R2 + R2 * R2)) / 3;
    expectRel(e.volume(1000), Math.PI * R1 * R1 * 1000);
    expectRel(e.total, Math.PI * R1 * R1 * 1200 + frustum + Math.PI * R2 * R2 * 950);
    expectRel(capacityOf(m), e.total);
    expect(m.endScale).toBeCloseTo(R2 / R1, 9);
  });
});

describe('new head sizing options', () => {
  it('semi-ellipsoidal head by depth', () => {
    const R = 600;
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 2 * R, length: 0 }, start: { type: 'ellipsoidal', ratioBy: 'depth', depth: 200 } })));
    expectRel(e.depth, 200);
    expectRel(e.total, (2 / 3) * Math.PI * R * R * 200);
  });

  it('shallow dome by dish radius', () => {
    const R = 500;
    const Rs = 1000;
    const d = Rs - Math.sqrt(Rs * Rs - R * R);
    const m = buildTank(tank({ body: { diameter: 2 * R, length: 100 }, end: { type: 'dished', dishBy: 'radius', dishRadius: Rs } }));
    expectRel(m.end.depth, d);
  });
});

describe('capacity helper', () => {
  it('matches the volume engine for every preset', () => {
    for (const p of PRESETS) {
      const proj = p.build();
      const m = buildTank(proj.tank);
      expectRel(capacityOf(m), new VolumeEngine(m).total, 1e-7);
    }
  });
});

const opts: ExportOptions = {
  source: 'level',
  input: 'measure',
  table: { mode: 'step', step: 10, rows: 100, tolerance: 0.05 },
  lengthUnit: 'mm',
  volumeUnit: 'L',
  pressureUnit: 'kPa',
};

describe('field calibration', () => {
  it('recovers a sensor that sits 12 mm higher with a 1-point offset', () => {
    const p = PRESETS.find((x) => x.id === 'water-5000')!.build();
    const s = p.sensors[0];
    const d0 = derive(p);
    const c0 = collect(p, d0, opts).conversions.find((c) => c.sensor.id === s.id)!;
    // Real sensor face is 12 mm higher: at true level L the distance is (face + 12 − L).
    const trueLevel = 900;
    const raw = (c0.geom.faceLevel + 12 - trueLevel) / 1; // digital mm
    s.cal = { method: 'offset', ref: 'level', points: [{ raw, ref: trueLevel }] };
    const d = derive(p);
    const c = collect(p, d, opts).conversions.find((x) => x.sensor.id === s.id)!;
    expect(c.cal?.active).toBe(true);
    expect(c.cal!.alpha).toBeCloseTo(12, 9);
    expect(c.A + c.B * raw).toBeCloseTo(trueLevel, 9);
    expect(c.theoryA).toBeCloseTo(c0.A, 9);
  });

  it('2-point and multi-point fits recover offset and span, also from volumes', () => {
    const p = PRESETS.find((x) => x.id === 'water-5000')!.build();
    const d = derive(p);
    const e = d.engine;
    const A = 2000;
    const B = -1;
    // Truth: level_true = 5 + 0.98 × level_drawing.
    const truth = (raw: number) => 5 + 0.98 * (A + B * raw);
    const raws = [1800, 1200, 600, 300];
    const byLevel = { ...defaultCal(), method: 'multipoint' as const, points: raws.map((r) => ({ raw: r, ref: truth(r) })) };
    const f1 = fitCalibration(byLevel, A, B, e, 0, 1800);
    expect(f1.alpha).toBeCloseTo(5, 6);
    expect(f1.beta).toBeCloseTo(0.98, 9);
    expect(f1.maxError).toBeLessThan(1e-6);
    const byVolume = { method: 'twopoint' as const, ref: 'volume' as const, points: raws.map((r) => ({ raw: r, ref: e.volume(truth(r)) * MM3_TO_L })) };
    const f2 = fitCalibration(byVolume, A, B, e, 0, 1800);
    expect(f2.alpha).toBeCloseTo(5, 4);
    expect(f2.beta).toBeCloseTo(0.98, 6);
    expect(f2.residuals.filter((r) => r.used).length).toBe(2);
  });

  it('asks for more points and rejects points too close together', () => {
    const e = derive(PRESETS[0].build()).engine;
    expect(fitCalibration({ method: 'twopoint', ref: 'level', points: [{ raw: 1, ref: 100 }] }, 2000, -1, e, 0, 1800).error).toMatch(/at least 2/);
    const close = fitCalibration({ method: 'twopoint', ref: 'level', points: [{ raw: 1000, ref: 1000 }, { raw: 1000.2, ref: 1000.3 }] }, 2000, -1, e, 0, 1800);
    expect(close.active).toBe(false);
  });

  it('calibrated JS export follows the corrected formula', async () => {
    const p = PRESETS.find((x) => x.id === 'water-5000')!.build();
    const s = p.sensors[0];
    s.cal = { method: 'twopoint', ref: 'level', points: [{ raw: 1700, ref: 300 }, { raw: 600, ref: 1405 }] };
    const ed = collect(p, derive(p), opts);
    const c = ed.conversions.find((x) => x.sensor.id === s.id)!;
    expect(c.A + c.B * 1700).toBeCloseTo(300, 9);
    expect(c.A + c.B * 600).toBeCloseTo(1405, 9);
    expect(c.rawMin).toBeLessThan(c.rawMax);
  });
});

describe('project file', () => {
  it('saves and opens everything, including calibration points and the profile', () => {
    const p = PRESETS.find((x) => x.id === 'stepped')!.build();
    p.sensors[0].cal = { method: 'offset', ref: 'volume', points: [{ raw: 1500, ref: 1234.5 }] };
    const d = derive(p);
    const text = buildProjectFile(p, d, {
      view: { mode: 'xray', dims: false, beams: true, labels: true, grid: false },
      sim: { level: 777, flow: 50, direction: 0, speed: 5, noise: true },
    });
    const doc = JSON.parse(text);
    expect(doc.format).toBe('tanker-time-project');
    expect(doc.summary.capacityL).toBeGreaterThan(0);
    const opened = parseProjectDoc(text);
    expect(opened.project).toEqual(p);
    expect(opened.view?.mode).toBe('xray');
    expect(opened.sim?.level).toBe(777);
  });

  it('opens older files without the new fields', () => {
    const old = PRESETS[0].build() as any;
    delete old.tank.body.sides;
    delete old.tank.body.profile;
    delete old.tank.body.profileOn;
    delete old.tank.start.ratioBy;
    for (const s of old.sensors) delete s.cal;
    const opened = parseProjectDoc(JSON.stringify(old));
    expect(opened.project.tank.body.sides).toBe(8);
    expect(opened.project.tank.body.profile).toEqual([]);
    expect(opened.project.sensors[0].cal.method).toBe('theory');
    expect(opened.project.tank.start.ratioBy).toBe('ratio');
  });
});
