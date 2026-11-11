import { describe, expect, it } from 'vitest';
import { derive } from '../src/core/derive';
import { PRESETS } from '../src/core/presets';
import { PitEngine, buildPit, checkValues, defaultPit, pitTable } from '../src/core/pit';
import { area, contains, offset, rectangle, selfIntersects, triangulate } from '../src/core/polygon';
import type { PitConfig } from '../src/core/types';
import { MM3_TO_L } from '../src/core/units';

const pit = (o: Partial<PitConfig>): PitConfig => ({ ...defaultPit(), ...o });
const engine = (o: Partial<PitConfig>) => new PitEngine(buildPit(pit(o)));
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1);

describe('plan polygons', () => {
  it('area, orientation and point tests of an L-shape', () => {
    const L = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    expect(area(L)).toBe(4000 * 3000 - 2000 * 1000);
    expect(contains(L, 1000, 2500)).toBe(true);
    expect(contains(L, 3000, 2500)).toBe(false);
    expect(contains(L, 4000, 1000)).toBe(true);
    expect(selfIntersects(L)).toBe(false);
    const tris = triangulate(L);
    expect(tris.length).toBe(3 * (L.length - 2));
    let sum = 0;
    for (let t = 0; t < tris.length; t += 3) sum += area([L[tris[t]], L[tris[t + 1]], L[tris[t + 2]]]);
    expect(sum).toBeCloseTo(area(L), 6);
    expect(selfIntersects([{ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }])).toBe(true);
  });

  it('offsetting a rectangle grows every side by the offset', () => {
    const r = offset(rectangle(2000, 1000), 50);
    expect(area(r)).toBeCloseTo(2100 * 1100, 6);
  });
});

describe('concrete storage volumes', () => {
  it('a flat rectangular pit is exactly area × level', () => {
    const e = engine({ outline: rectangle(10000, 6000), wallHeight: 3000, heightRef: 'datum', floor: { type: 'flat' }, sumps: [] });
    const A = 10000 * 6000;
    for (const h of [0, 10, 437, 1500, 2999, 3000]) expect(e.volume(h)).toBeCloseTo(A * h, 3);
    expect(e.depth).toBe(3000);
    const t = pitTable(e, 10);
    expect(t.length).toBe(301);
    for (const [L, litres] of t) expect(litres).toBe(Math.round(A * L * MM3_TO_L));
  });

  it('a rotated rectangle is still exactly area × level', () => {
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const rot = rectangle(8000, 5000).map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
    const e = engine({ outline: rot, wallHeight: 2000, heightRef: 'datum', floor: { type: 'flat' }, sumps: [] });
    expect(e.total).toBeCloseTo(8000 * 5000 * 2000, 0);
    expect(e.volume(777)).toBeCloseTo(8000 * 5000 * 777, 0);
  });

  it('Storage 7: plane slope over 355.78 m², 300 mm drop, wedge + prism within 0.1 %', () => {
    const e = engine({ outline: rectangle(20000, 17789), wallHeight: 4000, heightRef: 'floorHigh', floor: { type: 'plane', direction: 180, drop: 300 }, sumps: [] });
    expect(e.depth).toBe(4300);
    const A = 355.78;
    const d = 0.3;
    const analytic = (h: number) => ((h / 1000 <= d ? (A * (h / 1000) ** 2) / (2 * d) : (A * d) / 2 + A * (h / 1000 - d)) * 1000);
    expect(e.litres(0)).toBe(0);
    expect(rel(e.litres(300), 53367)).toBeLessThan(0.001);
    expect(rel(e.litres(4100), 1405331)).toBeLessThan(0.001);
    expect(rel(e.litres(4300), 1476487)).toBeLessThan(0.001);
    for (const h of [50, 150, 299, 301, 1000, 2500, 4000]) expect(rel(e.litres(h), analytic(h))).toBeLessThan(0.001);
    // The table the script interpolates reproduces the same values.
    const t = pitTable(e, 10);
    expect(t[30]).toEqual([300, Math.round(e.litres(300))]);
    expect(t[t.length - 1]).toEqual([4300, Math.round(e.totalLitres)]);
    expect(Math.abs(t[410][1] - 1405331)).toBeLessThanOrEqual(1405331 * 0.001);
  });

  it('the slope direction can point any way; the capacity does not change', { timeout: 30000 }, () => {
    const base = { outline: rectangle(20000, 17789), wallHeight: 4000, heightRef: 'floorHigh' as const, sumps: [] };
    const ref = engine({ ...base, floor: { type: 'plane', direction: 180, drop: 300 } }).total;
    for (const dir of [0, 90, 270, 37]) {
      const e = engine({ ...base, floor: { type: 'plane', direction: dir, drop: 300 } });
      expect(rel(e.total, ref)).toBeLessThan(0.002);
    }
  });

  it('a flat pit with a sump: the sump fills first', () => {
    const e = engine({ outline: rectangle(12000, 8000), wallHeight: 2500, heightRef: 'floorLow', floor: { type: 'flat' }, sumps: [{ x: 5000, y: -3000, width: 1000, length: 1000, depth: 400 }] });
    expect(e.depth).toBe(2900);
    const As = 1000 * 1000;
    const A = 12000 * 8000;
    const V = (h: number) => As * Math.min(h, 400) + A * Math.max(0, h - 400);
    for (const h of [100, 400, 401, 1000, 2900]) expect(rel(e.volume(h), V(h))).toBeLessThan(0.002);
    expect(e.breakLevels()).toContain(400);
  });

  it('a floor given at the corners equals the plane it describes', () => {
    const plane = engine({ outline: rectangle(20000, 17789), wallHeight: 4300, heightRef: 'datum', floor: { type: 'plane', direction: 0, drop: 300 }, sumps: [] });
    const verts = engine({ outline: rectangle(20000, 17789), wallHeight: 4300, heightRef: 'datum', floor: { type: 'vertices', heights: [0, 300, 300, 0] }, sumps: [] });
    for (const h of [100, 300, 1234, 4300]) expect(rel(verts.volume(h), plane.volume(h))).toBeLessThan(1e-6);
    // A ridge: two slopes meeting in the middle, drawn with two extra corners.
    const ridge = engine({
      outline: [
        { x: -5000, y: -3000 },
        { x: 0, y: -3000 },
        { x: 5000, y: -3000 },
        { x: 5000, y: 3000 },
        { x: 0, y: 3000 },
        { x: -5000, y: 3000 },
      ],
      wallHeight: 2000,
      heightRef: 'datum',
      floor: { type: 'vertices', heights: [0, 200, 0, 0, 200, 0] },
      sumps: [],
    });
    // Two wedges of 5000 × 6000 plan each: V(h) = 2 · 6000 · 5000 · h² / (2 · 200) below the ridge.
    expect(rel(ridge.volume(100), (2 * 6000 * 5000 * 100 * 100) / (2 * 200))).toBeLessThan(0.002);
    expect(rel(ridge.volume(2000), 10000 * 6000 * 2000 - 10000 * 6000 * 100)).toBeLessThan(0.002);
  });

  it('a wall batter widens the storage with height', () => {
    const W = 10000;
    const D = 6000;
    const k = 20; // mm per m
    const e = engine({ outline: rectangle(W, D), wallHeight: 3000, heightRef: 'datum', floor: { type: 'flat' }, sumps: [], batter: k });
    // Area at height z: (W + 2kz)(D + 2kz) with k in mm/mm; integrate analytically.
    const kk = k / 1000;
    const V = (h: number) => W * D * h + (W + D) * kk * h * h + (4 / 3) * kk * kk * h * h * h;
    for (const h of [500, 1500, 3000]) expect(rel(e.volume(h), V(h))).toBeLessThan(0.004);
    expect(e.total).toBeGreaterThan(W * D * 3000);
  });

  it('volume and surface area never decrease with the level', () => {
    const e = engine({ outline: rectangle(20000, 17789), wallHeight: 4000, heightRef: 'floorHigh', floor: { type: 'plane', direction: 45, drop: 300 }, sumps: [{ x: 6000, y: 5000, width: 1500, length: 1500, depth: 500 }] });
    let prev = -1;
    let prevA = -1;
    for (let h = 0; h <= e.depth; h += 10) {
      const v = e.volume(h);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      const a = e.surfaceArea(h + 1);
      expect(a).toBeGreaterThanOrEqual(prevA);
      prevA = a;
    }
    const t = pitTable(e, 10);
    for (let i = 1; i < t.length; i++) expect(t[i][1]).toBeGreaterThanOrEqual(t[i - 1][1]);
    expect(e.levelOf(e.volume(1234))).toBeCloseTo(1234, 3);
  });

  it('heights on the drawing are measured from the chosen reference', () => {
    const base = { outline: rectangle(10000, 8000), floor: { type: 'plane' as const, direction: 0, drop: 500 }, sumps: [{ x: 0, y: 0, width: 1000, length: 1000, depth: 300 }] };
    const fromDatum = buildPit(pit({ ...base, wallHeight: 4000, heightRef: 'datum' }));
    const fromLow = buildPit(pit({ ...base, wallHeight: 4000, heightRef: 'floorLow' }));
    const fromHigh = buildPit(pit({ ...base, wallHeight: 4000, heightRef: 'floorHigh' }));
    // The sump sits where the plane floor is 225 mm up its slope, so its bottom is 75 mm below the main floor's lowest point.
    expect(fromDatum.wallTop).toBe(4000);
    expect(fromLow.wallTop).toBe(4075);
    expect(fromHigh.wallTop).toBe(4575);
    expect(fromHigh.refZ).toBe(575);
    expect(fromHigh.toDatum(-575)).toBe(0);
    expect(fromLow.sumps[0].bottom).toBe(0);
    expect(fromLow.sumps[0].rim).toBe(300);
  });

  it('bad outlines are reported and the design still builds', () => {
    const two = buildPit(pit({ outline: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }));
    expect(two.problems[0]).toMatch(/at least three corners/);
    const crossed = buildPit(pit({ outline: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }] }));
    expect(crossed.problems[0]).toMatch(/crosses itself/);
    const low = buildPit(pit({ outline: rectangle(1000, 1000), wallHeight: 100, heightRef: 'datum', floor: { type: 'plane', direction: 0, drop: 300 } }));
    expect(low.problems[0]).toMatch(/not above the highest point of the floor/);
  });

  it('drawing check values are compared and flagged past 0.5 %', () => {
    const e = engine({
      outline: rectangle(20000, 17789),
      wallHeight: 4000,
      heightRef: 'floorHigh',
      floor: { type: 'plane', direction: 180, drop: 300 },
      sumps: [],
      checks: [
        { level: 0, litres: 53367 },
        { level: 4000, litres: 1476487 },
        { level: 2000, litres: 700000 },
      ],
    });
    const r = checkValues(e);
    expect(r.map((x) => x.ok)).toEqual([true, true, false]);
    expect(r[2].errorPct).toBeGreaterThan(5);
  });

  it('the asphalt storage preset derives with its sensor on the wall top', () => {
    const p = PRESETS.find((x) => x.id === 'asphalt-storage')!.build();
    const d = derive(p);
    expect(d.kind).toBe('pit');
    expect(d.depth).toBe(4300);
    expect(rel(d.totalL, 1476487)).toBeLessThan(0.001);
    const g = d.geoms[0];
    expect(g.ok).toBe(true);
    expect(g.faceHeightUntilted).toBe(4550);
    expect(g.floorLevel).toBeCloseTo(277.5, 3);
    // The TEK 766 cannot see the floor from the wall top: the design says so.
    expect(g.warnings.some((w) => /past its 4000 mm range/.test(w))).toBe(true);
    expect(d.problems).toEqual([]);
  });
});
