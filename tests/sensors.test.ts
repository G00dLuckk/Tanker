import { describe, expect, it } from 'vitest';
import { breakLevels, sensorTable, simplify, strapTable } from '../src/core/calibration';
import { defaultBody, defaultHead, defaultManhole, defaultSensor } from '../src/core/defaults';
import { parseProjectDoc } from '../src/app/persist';
import { derive } from '../src/core/derive';
import { PRESETS } from '../src/core/presets';
import { fromAdc, fromSignal, manholeGeometry, readSensor, sensorGeometry, toAdc, toSignal } from '../src/core/sensors';
import { buildTank } from '../src/core/tank';
import type { BodyConfig, HeadConfig, ManholeConfig, SensorConfig, TankConfig } from '../src/core/types';
import { G } from '../src/core/units';
import { VolumeEngine } from '../src/core/volume';

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

function setup(cfg: TankConfig, s: Partial<SensorConfig> & { kind: SensorConfig['kind'] }, density = 1000) {
  const model = buildTank(cfg);
  const engine = new VolumeEngine(model, cfg.tilt);
  const sensor = { ...defaultSensor(s.kind, 'T-1'), ...s };
  const g = sensorGeometry(sensor, model, engine, density);
  return { model, engine, sensor, g };
}

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('top sensors', () => {
  it('centre of a flat-roof cylinder', () => {
    const { g } = setup(tank({ body: { diameter: 1000, length: 2000 } }), { kind: 'ultrasonic', deadBand: 250 });
    expect(g.ok).toBe(true);
    near(g.faceLevel, 2000);
    near(g.floorDist, 2000);
    near(g.validMax, 1750);
    near(g.validMin, 0);
    const r = readSensor(g, 600, 1000, null);
    expect(r.status).toBe('ok');
    near(r.trueValue, 1400);
    near(r.level, 600);
    expect(readSensor(g, 1900, 1000, null).status).toBe('deadband');
  });

  it('roof thickness and nozzle raise the face', () => {
    const { g } = setup(
      tank({ basis: 'outside', body: { diameter: 1000, length: 2000, thickness: 5 }, start: { thickness: 10 }, end: { thickness: 12 } }),
      { kind: 'ultrasonic', nozzle: 100 },
    );
    near(g.faceLevel, 2000 + 12 + 100);
  });

  it('off-centre on a hemispherical roof', () => {
    const R = 500;
    const { g } = setup(tank({ body: { diameter: 2 * R, length: 1000 }, end: { type: 'hemi' } }), { kind: 'radar', x: 300, nozzle: 0 });
    near(g.roofLevel, 1000 + Math.sqrt(R * R - 300 * 300), 1e-4);
  });

  it('off-centre above a cone bottom sees the cone wall first', () => {
    const R = 500;
    const d = 400;
    const { g } = setup(
      tank({ body: { diameter: 2 * R, length: 1000 }, start: { type: 'cone', sizeBy: 'depth', depth: d } }),
      { kind: 'ultrasonic', x: 250, deadBand: 100 },
    );
    near(g.floorLevel, d * (250 / R), 1e-4);
    near(g.validMin, d * (250 / R), 1e-4);
    const r = readSensor(g, 100, 1000, null);
    expect(r.status).toBe('floor');
    near(r.trueValue, g.floorDist);
    expect(g.warnings.some((w) => w.includes('floor under the sensor'))).toBe(true);
  });

  it('horizontal cylinder with a lateral offset', () => {
    const R = 600;
    const { g } = setup(tank({ orientation: 'horizontal', body: { diameter: 2 * R, length: 2000 } }), { kind: 'ultrasonic', x: 400, y: 200 });
    near(g.faceLevel, R + Math.sqrt(R * R - 200 * 200), 1e-6);
    near(g.floorLevel, R - Math.sqrt(R * R - 200 * 200), 1e-6);
  });

  it('tilted horizontal tank: sensor-derived level equals the true level', () => {
    const { g } = setup(tank({ orientation: 'horizontal', body: { diameter: 1600, length: 6000 }, tilt: 1.2 }), {
      kind: 'ultrasonic',
      x: 2500,
      deadBand: 0,
      maxRange: 99999,
      resolution: 0,
    });
    for (const L of [400, 800, 1200]) {
      const r = readSensor(g, L, 1000, null);
      if (r.status === 'ok') near(r.level, L, 1e-6);
    }
  });

  it('beam cone contact in a narrow tank', () => {
    const { g } = setup(tank({ body: { diameter: 200, length: 2000 } }), { kind: 'ultrasonic', beamAngle: 30, deadBand: 50 });
    const expected = 2000 - 100 / Math.tan((15 * Math.PI) / 180);
    expect(g.beamContactLevel).not.toBeNull();
    expect(Math.abs((g.beamContactLevel as number) - expected)).toBeLessThan(40);
  });

  it('outside the footprint is reported', () => {
    const { g } = setup(tank({ body: { diameter: 1000, length: 1000 } }), { kind: 'ultrasonic', x: 800 });
    expect(g.ok).toBe(false);
    expect(g.error).toBeTruthy();
  });
});

describe('pressure sensors and switches', () => {
  it('hydrostatic pressure from the head above the sensing point', () => {
    const rho = 998.2;
    const { g } = setup(tank({ body: { diameter: 1000, length: 3000 } }), { kind: 'pressure', elevation: 50 }, rho);
    near(g.faceLevel, 50);
    const r = readSensor(g, 1050, rho, null);
    near(r.trueValue, rho * G * 1.0, 1e-6);
    expect(readSensor(g, 20, rho, null).status).toBe('dry');
    // 0–5 mH₂O range tops out above this tank.
    near(g.validMax, 3000);
  });

  it('switch toggles at its height', () => {
    const { g } = setup(tank({ body: { diameter: 1000, length: 2000 } }), { kind: 'switch', elevation: 1500 });
    expect(readSensor(g, 1499, 1000, null).digital).toBe(0);
    expect(readSensor(g, 1501, 1000, null).digital).toBe(1);
  });
});

describe('signal chain', () => {
  const s: SensorConfig = {
    ...defaultSensor('pressure', 'PT'),
    signal: 'current',
    rangeMin: 0,
    rangeMax: 49033,
    outMin: 4,
    outMax: 20,
    adcBits: 12,
    adcVref: 3.3,
    shunt: 150,
  };
  it('maps measurand to mA and ADC counts and back', () => {
    near(toSignal(s, 49033 / 2), 12);
    near(toAdc(s, 12), Math.round((1.8 / 3.3) * 4095));
    near(fromSignal(s, 12), 49033 / 2, 1e-9);
    near(fromAdc(s, toAdc(s, 12, false)), 12, 1e-9);
  });
  it('inverted mapping', () => {
    const inv = { ...s, invert: true };
    near(toSignal(inv, 0), 20);
    near(fromSignal(inv, 20), 0);
  });
});

describe('tables', () => {
  it('simplify keeps two points for a straight line and bounds the error', () => {
    const xs = Array.from({ length: 101 }, (_, i) => i);
    expect(simplify(xs, xs.map((x) => 3 * x + 1), 1e-9)).toEqual([0, 100]);
    const ys = xs.map((x) => x * x);
    const keep = simplify(xs, ys, 0.5);
    for (let i = 0; i < xs.length; i++) {
      const j = keep.findIndex((k) => k >= i);
      if (keep[j] === i) continue;
      const a = keep[j - 1];
      const b = keep[j];
      const y = ys[a] + ((ys[b] - ys[a]) * (i - a)) / (b - a);
      expect(Math.abs(y - ys[i])).toBeLessThanOrEqual(0.5 + 1e-12);
    }
  });

  it('compact strapping table for a flat cylinder needs only the ends', () => {
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 1000, length: 1000 } })));
    const t = strapTable(e, { mode: 'compact', step: 10, rows: 10, tolerance: 0.01 });
    expect(t.length).toBe(2);
  });

  it('compact table includes shell/head junction levels', () => {
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 1000, length: 1000 }, start: { type: 'cone', sizeBy: 'depth', depth: 300 } })));
    expect(breakLevels(e).some((L) => Math.abs(L - 300) < 1e-6)).toBe(true);
    const t = strapTable(e, { mode: 'compact', step: 10, rows: 10, tolerance: 0.05 });
    expect(t.some((r) => Math.abs(r.level - 300) < 1e-6)).toBe(true);
  });

  it('step table hits round numbers and both ends', () => {
    const e = new VolumeEngine(buildTank(tank({ body: { diameter: 1000, length: 1234 } })));
    const t = strapTable(e, { mode: 'step', step: 100, rows: 10, tolerance: 1 });
    expect(t[0].level).toBe(0);
    expect(t[1].level).toBeCloseTo(100, 9);
    expect(t[t.length - 1].level).toBeCloseTo(1234, 9);
  });

  it('sensor table is monotonic for every preset', () => {
    for (const preset of PRESETS) {
      const p = preset.build();
      const d = derive(p);
      expect(d.problems).toEqual([]);
      expect(d.totalL).toBeGreaterThan(0);
      for (const g of d.geoms) {
        if (!g.ok || g.mount === 'point') continue;
        const rows = sensorTable(g, d.engine, d.density, { mode: 'rows', step: 10, rows: 50, tolerance: 1 });
        expect(rows.length).toBeGreaterThan(2);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i].litres).toBeGreaterThanOrEqual(rows[i - 1].litres);
          if (g.mount === 'top') expect(rows[i].x).toBeLessThan(rows[i - 1].x);
          else expect(rows[i].x).toBeGreaterThanOrEqual(rows[i - 1].x);
        }
      }
    }
  });
});

describe('presets', () => {
  it('capacities are in the advertised range', () => {
    const cap = (id: string) => derive(PRESETS.find((p) => p.id === id)!.build()).totalL;
    expect(cap('water-5000')).toBeGreaterThan(4800);
    expect(cap('water-5000')).toBeLessThan(5300);
    expect(cap('horizontal-2000')).toBeGreaterThan(1950);
    expect(cap('horizontal-2000')).toBeLessThan(2050);
    expect(cap('vessel-10')).toBeGreaterThan(9700);
    expect(cap('vessel-10')).toBeLessThan(10300);
    expect(cap('tanker')).toBeGreaterThan(29000);
    expect(cap('tanker')).toBeLessThan(31000);
    expect(cap('ibc')).toBeGreaterThan(980);
    expect(cap('ibc')).toBeLessThan(1030);
  });
});

describe('guards', () => {
  it('a tank with no height still gives a usable model', () => {
    const d = derive({ ...PRESETS[1].build(), tank: tank({ orientation: 'vertical', body: { diameter: 1000, length: 0 } }) });
    expect(d.problems.length).toBe(1);
    expect(Number.isFinite(d.depth)).toBe(true);
    expect(d.depth).toBeGreaterThan(0);
    expect(Number.isFinite(d.totalL)).toBe(true);
  });

  it('an analog sensor with an empty range is reported, not divided by zero', () => {
    const { g } = setup(tank({ body: { diameter: 1000, length: 1000 } }), { kind: 'radar', signal: 'current', rangeMin: 500, rangeMax: 500 });
    expect(g.ok).toBe(false);
    expect(g.error).toMatch(/must differ/);
  });
});

describe('manholes', () => {
  function onManhole(cfg: TankConfig, mh: Partial<ManholeConfig>, s: Partial<SensorConfig> = {}) {
    const model = buildTank(cfg);
    const engine = new VolumeEngine(model, cfg.tilt);
    const m: ManholeConfig = { ...defaultManhole('MH-1'), ...mh };
    const mg = manholeGeometry(m, model, engine);
    const sensor: SensorConfig = { ...defaultSensor('radar', 'LT-1'), x: m.x, y: m.y, faceMode: 'manhole', manhole: m.id, nozzle: 0, ...s };
    const g = sensorGeometry(sensor, model, engine, 1000, [mg]);
    return { mg, g };
  }

  it('flat roof: face = roof + plate + neck + sensor height', () => {
    const cfg = tank({ basis: 'outside', body: { diameter: 1000, length: 2000, thickness: 5 }, end: { thickness: 12 } });
    const { mg, g } = onManhole(cfg, { neck: 150 }, { nozzle: -10 });
    expect(mg.ok).toBe(true);
    near(mg.coverHeight, 2000 + 12 + 150);
    near(mg.neckHeight, 150);
    near(g.faceLevel, 2000 + 12 + 150 - 10);
    near(g.floorDist, 2000 + 12 + 150 - 10);
    expect(g.manhole).toBe(mg);
  });

  it('cover height given above level zero', () => {
    const { mg, g } = onManhole(tank({ body: { diameter: 1000, length: 2000 } }), { heightBy: 'zero', top: 2300 });
    near(mg.neckHeight, 300);
    near(g.faceLevel, 2300);
  });

  it('off-centre on a hemispherical roof, neck sits on the low side', () => {
    const R = 500;
    const { mg, g } = onManhole(tank({ body: { diameter: 2 * R, length: 1000 }, end: { type: 'hemi' } }), { x: 300, diameter: 100, neck: 100 });
    near(mg.roofOuterUp - 0, 1000 + Math.sqrt(R * R - 300 * 300), 1e-3);
    near(g.faceLevel, 1000 + 400 + 100, 1e-3);
    // The roof falls away toward the wall, so the neck starts lower on that side.
    expect(mg.baseUp).toBeLessThan(mg.roofOuterUp - 30);
  });

  it('top of a horizontal cylinder', () => {
    const cfg = tank({ orientation: 'horizontal', body: { diameter: 1000, length: 3000 } });
    const { mg, g } = onManhole(cfg, { x: 500, neck: 200 });
    expect(mg.ok).toBe(true);
    near(mg.coverHeight, 1200, 1e-6);
    near(g.faceLevel, 1200, 1e-6);
    near(g.floorDist, 1200, 1e-6);
    expect(g.validMin).toBeCloseTo(0, 6);
  });

  it('rectangular hatch on a box tank', () => {
    const cfg = tank({ body: { type: 'rect', width: 2000, depth: 1000, length: 1500 } });
    const { mg, g } = onManhole(cfg, { shape: 'rect', diameter: 600, length: 400, x: 500, neck: 80 }, { x: 700, y: 150 });
    expect(mg.ok).toBe(true);
    expect(mg.warnings).toEqual([]);
    near(g.faceLevel, 1580);
    expect(g.warnings.some((w) => w.includes('outside the opening'))).toBe(false);
  });

  it('warns when the sensor is off the opening or the beam hits the neck', () => {
    const cfg = tank({ body: { diameter: 2000, length: 2000 } });
    const off = onManhole(cfg, { diameter: 400 }, { x: 300 });
    expect(off.g.warnings.some((w) => w.includes('outside the opening'))).toBe(true);
    const narrow = onManhole(cfg, { diameter: 100, neck: 600 }, { beamAngle: 30 });
    expect(narrow.g.warnings.some((w) => w.includes('manhole neck'))).toBe(true);
    const wide = onManhole(cfg, { diameter: 600, neck: 150 }, { beamAngle: 8 });
    expect(wide.g.warnings.some((w) => w.includes('manhole neck'))).toBe(false);
  });

  it('errors without a manhole or with the cover below the roof', () => {
    const cfg = tank({ body: { diameter: 1000, length: 2000 } });
    const model = buildTank(cfg);
    const engine = new VolumeEngine(model, 0);
    const lone = sensorGeometry({ ...defaultSensor('radar', 'LT-1'), faceMode: 'manhole', manhole: 'nope' }, model, engine, 1000, []);
    expect(lone.ok).toBe(false);
    const { mg, g } = onManhole(cfg, { heightBy: 'zero', top: 1500 });
    expect(mg.ok).toBe(false);
    expect(g.ok).toBe(false);
  });

  it('works through derive() and survives the project file', () => {
    const p = PRESETS[0].build();
    const mh = { ...defaultManhole('MH-1'), neck: 250 };
    p.tank.manholes = [mh];
    p.sensors = [{ ...defaultSensor('ultrasonic', 'LT-101'), faceMode: 'manhole', manhole: mh.id, nozzle: 20 }];
    const d = derive(p);
    expect(d.manholes[0].ok).toBe(true);
    near(d.geoms[0].faceLevel, d.manholes[0].coverLevel + 20, 1e-6);
    const opened = parseProjectDoc(JSON.stringify({ project: p }));
    expect(opened.project.tank.manholes).toEqual(p.tank.manholes);
    expect(opened.project.sensors[0].faceMode).toBe('manhole');
  });

  it('gives the neck its own size: plate, clear area and how high liquid can stand in it', () => {
    const cfg = tank({ body: { diameter: 2000, length: 3000 } });
    const round = onManhole(cfg, { diameter: 600, neck: 400, cover: 10 }).mg;
    near(round.area, Math.PI * 300 * 300, 1e-6);
    near(round.roofThickness, round.roofOuterUp - round.roofUp, 1e-9);
    near(round.neckDepth, round.roofThickness + 400 - 10, 1e-9);
    const rect = onManhole(cfg, { shape: 'rect', diameter: 800, length: 500, neck: 5, cover: 40 }).mg;
    near(rect.area, 800 * 500, 1e-6);
    // A cover thicker than the neck leaves no room for liquid above the roof plate's underside.
    expect(rect.neckDepth).toBe(0);
  });

  it('a concrete storage with a slab on top: the manhole counts from the wall top', () => {
    const p = PRESETS.find((x) => x.id === 'basin-sump')!.build();
    const mh: ManholeConfig = { ...defaultManhole('MH-1'), shape: 'rect', diameter: 700, length: 700, x: 1000, y: 500, neck: 350, cover: 60 };
    p.tank.manholes = [mh];
    p.sensors = [{ ...defaultSensor('radar', 'LT-101'), x: 1000, y: 500, faceMode: 'manhole', manhole: mh.id, nozzle: 0, deadBand: 80, maxRange: 8000 }];
    const d = derive(p);
    expect(d.kind).toBe('pit');
    if (d.kind !== 'pit') return;
    const mg = d.manholes[0];
    expect(mg.ok).toBe(true);
    near(mg.roofLevel, d.pit.wallTop, 1e-9);
    expect(mg.roofThickness).toBe(0);
    near(mg.coverHeight, d.pit.wallTop + 350, 1e-9);
    near(mg.neckDepth, 350 - 60, 1e-9);
    const g = d.geoms[0];
    expect(g.ok).toBe(true);
    expect(g.manhole).toBe(mg);
    near(g.faceLevel, d.pit.wallTop + 350, 1e-9);
    // 350 mm above the wall top clears the 80 mm dead band: a full storage can be measured.
    near(g.validMax, d.depth, 1e-9);
    expect(g.warnings.some((w) => w.includes('dead band'))).toBe(false);
    // Outside the walls, or with the cover below the wall top, it is refused in plain words.
    p.tank.manholes = [{ ...mh, x: 99999 }];
    expect(derive(p).manholes[0].error).toBe('The centre is outside the storage. Move the manhole inside the inner wall faces.');
    p.tank.manholes = [{ ...mh, heightBy: 'zero', top: 100 }];
    expect(derive(p).manholes[0].error).toBe('The top of the cover is below the wall top.');
    p.tank.manholes = [];
    expect(derive(p).geoms[0].error).toBe('There is no manhole on this storage. Add one, or put the sensor on the wall top.');
    // The project file keeps the manhole of a storage.
    p.tank.manholes = [mh];
    const opened = parseProjectDoc(JSON.stringify({ project: p }));
    expect(opened.project.tank.manholes).toEqual([mh]);
  });
});
