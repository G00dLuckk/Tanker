import { area as polyArea, bbox, cleanIndices, contains, crossings, interpolate, nearestOnOutline, offset, rectangle, selfIntersects, signedDistance, triangulate, type Pt } from './polygon';
import type { PitCheck, PitConfig, PitSump, PlanPoint } from './types';
import { MM3_TO_L, clamp } from './units';
import type { LevelEngine } from './volume';

/**
 * Open concrete storages (asphalt pits, basins, bunds): a plan outline, a wall height
 * and a floor that is flat, slopes one way, or is given at every vertex, with optional
 * sumps and a wall batter.
 *
 * Level zero is the deepest point of the floor (the bottom of the deepest sump), so a
 * level is never negative and the scripts treat a storage like any tank. The volume
 * curve is worked out numerically: the plan is sampled on a fine grid, every cell is a
 * column of liquid from the floor up, and the volume at a level is the sum of the
 * columns below it. Plane and vertex floors are exact at the cell centres, so the
 * curve matches the analytic wedge + prism of a sloped floor to a few parts in 10⁵.
 */

export function defaultPit(): PitConfig {
  return {
    outline: rectangle(10000, 6000),
    wallHeight: 3000,
    heightRef: 'floorHigh',
    floor: { type: 'plane', direction: 0, drop: 200 },
    sumps: [],
    batter: 0,
    wallTop: 300,
    wallBase: 400,
    slab: 250,
    operationLevel: null,
    alarmHigh: null,
    alarmLow: null,
    checks: [],
  };
}

export interface SumpModel {
  cfg: PitSump;
  outline: Pt[];
  /** Bottom of the sump above level zero (mm). */
  bottom: number;
  /** Lowest main floor around the sump above level zero (mm): the top of the sump walls. */
  rim: number;
  /** The sump lies at least partly outside the storage. */
  outside: boolean;
}

export interface PitModel {
  cfg: PitConfig;
  /** Inner wall faces in plan, counter-clockwise, cleaned. */
  outline: Pt[];
  /** Plan area inside the walls (mm²). */
  area: number;
  box: { x0: number; x1: number; y0: number; y1: number };
  /** Triangulation of the outline (index triples). */
  tris: number[];
  /** Floor height at each outline vertex above level zero (mm). */
  vertexZ: number[];
  sumps: SumpModel[];
  /** Height of the drawing's reference (heightRef) above level zero (mm). */
  refZ: number;
  /** Lowest and highest point of the main floor above level zero (mm). */
  floorLow: number;
  floorHigh: number;
  /** Top of the wall above level zero (mm). */
  wallTop: number;
  /** Outward lean of the inner face (mm per mm of height). */
  batterK: number;
  /** Characteristic size for tolerances and drawing (mm). */
  size: number;
  /** Floor height above level zero at a plan point, sumps included; outside the outline, the floor at the nearest wall. */
  floorZ(x: number, y: number): number;
  /** Floor height without sumps. */
  mainFloorZ(x: number, y: number): number;
  /** Inside the inner wall faces at floor level. */
  inside(x: number, y: number): boolean;
  /** Inside the (battered) wall faces at a level above zero. */
  insideAt(x: number, y: number, level: number): boolean;
  /** The inner outline at a level, moved out by the batter. */
  outlineAt(level: number): Pt[];
  /** A height typed above the drawing's reference → above level zero, and back. */
  toDatum(h: number): number;
  fromDatum(z: number): number;
  problems: string[];
  warnings: string[];
}

const fmtMm = (v: number) => `${Math.round(v).toLocaleString('en-US')} mm`;

export function buildPit(cfg: PitConfig): PitModel {
  const problems: string[] = [];
  const warnings: string[] = [];
  const typed = Array.isArray(cfg.outline) ? cfg.outline : [];
  // Corners on a straight side are kept when they carry a floor height.
  let idx = cleanIndices(typed, 0.01, cfg.floor?.type === 'vertices');
  let outline = idx.map((i) => ({ x: typed[i].x, y: typed[i].y }));
  if (outline.length >= 3 && selfIntersects(outline)) {
    problems.push('The plan outline crosses itself. Put the corners in order around the outline.');
    outline = rectangle(1000, 1000);
    idx = [0, 1, 2, 3];
  } else if (outline.length < 3 || polyArea(outline) <= 1) {
    problems.push('The plan needs at least three corners that enclose an area. Add corners or use the rectangle tool.');
    outline = rectangle(1000, 1000);
    idx = [0, 1, 2, 3];
  }
  const area = polyArea(outline);
  const box = bbox(outline);
  const tris = triangulate(outline);
  const n = outline.length;

  // Raw floor (before the datum shift) over the main floor.
  const floor = cfg.floor;
  let rawAt: (x: number, y: number) => number;
  let rawVertex: number[];
  if (floor.type === 'plane') {
    const drop = Number.isFinite(floor.drop) ? Math.max(0, floor.drop) : 0;
    if (floor.drop < 0) warnings.push('The floor drop cannot be negative: turn the slope direction around instead. It is taken as 0.');
    const th = ((Number.isFinite(floor.direction) ? floor.direction : 0) * Math.PI) / 180;
    const cx = Math.cos(th);
    const sy = Math.sin(th);
    const proj = outline.map((q) => q.x * cx + q.y * sy);
    const pMin = Math.min(...proj);
    const pMax = Math.max(...proj);
    const k = pMax - pMin > 1e-9 ? drop / (pMax - pMin) : 0;
    rawAt = (x, y) => (x * cx + y * sy - pMin) * k;
    rawVertex = proj.map((p) => (p - pMin) * k);
  } else if (floor.type === 'vertices') {
    const hs = Array.isArray(floor.heights) ? floor.heights : [];
    rawVertex = idx.map((i) => (Number.isFinite(hs[i]) ? hs[i] : 0));
    rawAt = (x, y) => {
      const v = interpolate(outline, tris, rawVertex, x, y);
      if (v !== null) return v;
      const near = nearestOnOutline(outline, x, y);
      const a = rawVertex[near.edge];
      const b = rawVertex[(near.edge + 1) % n];
      return a + (b - a) * near.t;
    };
  } else {
    rawAt = () => 0;
    rawVertex = outline.map(() => 0);
  }
  const mainMin = Math.min(...rawVertex);
  const mainMax = Math.max(...rawVertex);

  // Sumps: flat bottoms, each `depth` below the lowest main floor it cuts into.
  const sumpsRaw = (Array.isArray(cfg.sumps) ? cfg.sumps : [])
    .map((s) => {
      const poly = s.outline && s.outline.length >= 3 ? cleanIndices(s.outline).map((i) => ({ x: s.outline![i].x, y: s.outline![i].y })) : rectangle(Math.max(1, s.width), Math.max(1, s.length), s.x, s.y);
      if (poly.length < 3 || polyArea(poly) <= 0) return null;
      const depth = Number.isFinite(s.depth) ? Math.max(0, s.depth) : 0;
      // Lowest main floor within the sump: at its corners, along its edges or at a floor vertex inside it.
      let rim = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        for (let k = 0; k <= 8; k++) rim = Math.min(rim, rawAt(a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8));
      }
      outline.forEach((q, i) => {
        if (contains(poly, q.x, q.y)) rim = Math.min(rim, rawVertex[i]);
      });
      const outside = poly.some((q) => !contains(outline, q.x, q.y));
      return { cfg: s, outline: poly, bottom: rim - depth, rim, outside };
    })
    .filter((s): s is SumpModel => s !== null);
  for (const s of sumpsRaw) if (s.outside) warnings.push('A sump runs past the wall of the storage: only the part inside counts.');

  // Level zero: the deepest point of all.
  const z0 = Math.min(mainMin, ...sumpsRaw.map((s) => s.bottom));
  const vertexZ = rawVertex.map((v) => v - z0);
  const sumps = sumpsRaw.map((s) => ({ ...s, bottom: s.bottom - z0, rim: s.rim - z0 }));
  const floorLow = mainMin - z0;
  const floorHigh = mainMax - z0;
  const refZ = cfg.heightRef === 'floorHigh' ? floorHigh : cfg.heightRef === 'floorLow' ? floorLow : 0;
  const toDatum = (h: number) => h + refZ;
  const fromDatum = (z: number) => z - refZ;
  let wallTop = toDatum(Number.isFinite(cfg.wallHeight) ? cfg.wallHeight : 0);
  if (!(wallTop > floorHigh + 1)) {
    problems.push(`The wall top (${fmtMm(wallTop)} above the deepest point) is not above the highest point of the floor (${fmtMm(floorHigh)}). Raise the wall height.`);
    wallTop = floorHigh + 10;
  }
  const batterK = Number.isFinite(cfg.batter) && cfg.batter > 0 ? cfg.batter / 1000 : 0;
  if (cfg.batter < 0) warnings.push('A negative batter (walls leaning inward) is not supported; the walls are taken as vertical.');

  const mainFloorZ = (x: number, y: number) => rawAt(x, y) - z0;
  const floorZ = (x: number, y: number) => {
    for (const s of sumps) if (contains(s.outline, x, y)) return s.bottom;
    return mainFloorZ(x, y);
  };
  const inside = (x: number, y: number) => contains(outline, x, y);
  const outlineAt = (level: number) => (batterK > 0 ? offset(outline, batterK * clamp(level, 0, wallTop)) : outline);
  const insideAt = (x: number, y: number, level: number) => {
    if (batterK <= 0 || level <= 0) return inside(x, y);
    return contains(outline, x, y) || signedDistance(outline, x, y) <= batterK * clamp(level, 0, wallTop);
  };

  return {
    cfg,
    outline,
    area,
    box,
    tris,
    vertexZ,
    sumps,
    refZ,
    floorLow,
    floorHigh,
    wallTop,
    batterK,
    size: Math.max(box.x1 - box.x0, box.y1 - box.y0, wallTop),
    floorZ,
    mainFloorZ,
    inside,
    insideAt,
    outlineAt,
    toDatum,
    fromDatum,
    problems,
    warnings,
  };
}

/** Cells across the longer side of the plan: the first grid, and the finest one the refinement may reach. */
const GRID_START = 500;
const GRID_MAX = 2000;
/** Refine the grid while the full volume still changes by more than this fraction between one grid and the next. */
const GRID_TOL = 0.0005;

/** Row intervals [x from, x to] of a polygon at y, from its edge crossings. */
function rowIntervals(p: Pt[], y: number): [number, number][] {
  const xs = crossings(p, 'y', y);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
  return out;
}

function inIntervals(iv: [number, number][], x: number): boolean {
  for (const [a, b] of iv) if (x >= a && x <= b) return true;
  return false;
}

interface Columns {
  /** Cell size (mm). */
  c: number;
  /** Bottom of every liquid column above level zero (mm), sorted ascending. */
  z: Float64Array;
  /** Prefix sums of the column areas and of area × bottom, in the same order (index k = the first k columns). */
  prefixA: Float64Array;
  prefixAZ: Float64Array;
}

/**
 * Samples the plan on a grid of cells `across` the longer side. Every cell centre inside
 * the walls is a column from the floor up. The columns of each region (the main floor,
 * each sump) are weighted so they add up to that region's exact plan area, which makes
 * flat floors exact and keeps small sumps right even on a coarse grid.
 */
function sampleColumns(m: PitModel, across: number): Columns {
  const w = m.box.x1 - m.box.x0;
  const hgt = m.box.y1 - m.box.y0;
  const grow = m.batterK * m.wallTop;
  const c = Math.max(w, hgt) / across;
  const x0 = m.box.x0 - grow;
  const y0 = m.box.y0 - grow;
  const nx = Math.max(1, Math.ceil((w + 2 * grow) / c));
  const ny = Math.max(1, Math.ceil((hgt + 2 * grow) / c));
  const zs: number[] = [];
  // Region of each column: 0 = main floor, 1 + k = sump k, -1 = outside the walls (batter only).
  const region: number[] = [];
  const counts = new Array<number>(1 + m.sumps.length).fill(0);
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * c;
    // Where this row of cells crosses the walls and the sumps: one crossing test per row, not per cell.
    const inside = rowIntervals(m.outline, y);
    const sumpRows = m.sumps.map((s) => rowIntervals(s.outline, y));
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * c;
      if (inIntervals(inside, x)) {
        let r = 0;
        for (let k = 0; k < sumpRows.length; k++) {
          if (inIntervals(sumpRows[k], x)) {
            r = 1 + k;
            break;
          }
        }
        counts[r]++;
        region.push(r);
        zs.push(Math.min(r > 0 ? m.sumps[r - 1].bottom : m.mainFloorZ(x, y), m.wallTop));
      } else if (m.batterK > 0) {
        // Outside the floor outline: the column starts where the leaning wall reaches this point.
        const enter = signedDistance(m.outline, x, y) / m.batterK;
        if (enter < m.wallTop) {
          region.push(-1);
          zs.push(Math.min(m.wallTop, Math.max(enter, m.floorZ(x, y))));
        }
      }
    }
  }
  // Exact area of each region: a sump counts only where it lies inside the walls.
  const cell = c * c;
  const sumpArea = m.sumps.map((s, k) => (s.outside ? counts[1 + k] * cell : polyArea(s.outline)));
  const mainArea = Math.max(0, m.area - sumpArea.reduce((a, b) => a + b, 0));
  const weight = [counts[0] > 0 ? mainArea / counts[0] : cell, ...sumpArea.map((a, k) => (counts[1 + k] > 0 ? a / counts[1 + k] : cell))];
  const order = Array.from(zs.keys()).sort((a, b) => zs[a] - zs[b]);
  const z = new Float64Array(order.length);
  const prefixA = new Float64Array(order.length + 1);
  const prefixAZ = new Float64Array(order.length + 1);
  order.forEach((idx, k) => {
    const r = region[idx];
    const a = r < 0 ? cell : weight[r];
    z[k] = zs[idx];
    prefixA[k + 1] = prefixA[k] + a;
    prefixAZ[k + 1] = prefixAZ[k] + a * zs[idx];
  });
  return { c, z, prefixA, prefixAZ };
}

/** Number of columns whose bottom is below the level. */
function columnsBelow(col: Columns, level: number): number {
  const z = col.z;
  let lo = 0;
  let hi = z.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (z[mid] < level) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function columnVolume(col: Columns, level: number): number {
  const k = columnsBelow(col, level);
  return level * col.prefixA[k] - col.prefixAZ[k];
}

/** Level → volume of a concrete storage. Lengths mm, volumes mm³, like the tank engine. */
export class PitEngine implements LevelEngine {
  readonly pit: PitModel;
  readonly axis = -1 as const;
  readonly na = 1;
  readonly nw = 0;
  readonly hMin = 0;
  readonly hMax: number;
  readonly depth: number;
  readonly total: number;
  readonly curveLevels: Float64Array;
  readonly curveVolumes: Float64Array;
  /** Cells across the longer side of the plan in the grid that was kept. */
  readonly cellsAcross: number;
  private readonly col: Columns;

  constructor(pit: PitModel, curvePoints = 600) {
    this.pit = pit;
    this.hMax = pit.wallTop;
    this.depth = pit.wallTop;
    // Refine the grid until the capacity settles: the first grid is kept when a grid half as
    // fine already agrees with it; otherwise the grid is doubled until two in a row agree.
    let across = GRID_START;
    let col = sampleColumns(pit, across);
    let total = columnVolume(col, pit.wallTop);
    let previous = columnVolume(sampleColumns(pit, across / 2), pit.wallTop);
    while (across < GRID_MAX && Math.abs(total - previous) > GRID_TOL * Math.max(total, 1)) {
      across *= 2;
      col = sampleColumns(pit, across);
      previous = total;
      total = columnVolume(col, pit.wallTop);
    }
    this.col = col;
    this.cellsAcross = across;
    this.total = total;
    const n = Math.max(16, curvePoints);
    this.curveLevels = new Float64Array(n + 1);
    this.curveVolumes = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const L = (this.depth * i) / n;
      this.curveLevels[i] = L;
      this.curveVolumes[i] = i === n ? this.total : this.volume(L);
    }
  }

  volume(level: number): number {
    if (level <= 0) return 0;
    if (level >= this.depth) return this.total;
    return columnVolume(this.col, level);
  }

  litres(level: number): number {
    return this.volume(level) * MM3_TO_L;
  }

  get totalLitres(): number {
    return this.total * MM3_TO_L;
  }

  quickVolume(level: number): number {
    return this.volume(level);
  }

  /** Free surface area at a level (mm²): the plan area of the columns below it. */
  surfaceArea(level: number): number {
    return this.col.prefixA[columnsBelow(this.col, level)];
  }

  levelOf(volume: number): number {
    if (volume <= 0) return 0;
    if (volume >= this.total) return this.depth;
    let lo = 0;
    let hi = this.depth;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.volume(mid) < volume) lo = mid;
      else hi = mid;
      if (hi - lo < 1e-7) break;
    }
    return (lo + hi) / 2;
  }

  levelOfPoint(a: number): number {
    return a;
  }

  breakLevels(): number[] {
    const p = this.pit;
    const out = [p.floorLow, p.floorHigh];
    for (const s of p.sumps) out.push(s.bottom, s.rim);
    for (const z of p.vertexZ) out.push(z);
    return [...new Set(out)].filter((L) => L > 0 && L < this.depth).sort((a, b) => a - b);
  }
}

/** The level → litres table the payload script interpolates: every `step` mm from 0 to the wall top, whole litres. */
export function pitTable(engine: PitEngine, step = 10): [number, number][] {
  const top = engine.depth;
  const out: [number, number][] = [];
  const s = Math.max(1, step);
  for (let L = 0; L < top - 1e-9; L += s) out.push([Math.round(L * 1000) / 1000, Math.round(engine.litres(L))]);
  out.push([Math.round(top * 1000) / 1000, Math.round(engine.totalLitres)]);
  // Never let rounding make the table step down.
  for (let i = 1; i < out.length; i++) if (out[i][1] < out[i - 1][1]) out[i][1] = out[i - 1][1];
  return out;
}

export interface CheckResult {
  check: PitCheck;
  /** The check's level above level zero (mm). */
  level: number;
  /** Capacity the design gives at that level (L). */
  litres: number;
  /** (design − drawing) / drawing × 100, NaN when the drawing value is 0. */
  errorPct: number;
  ok: boolean;
}

/** Every drawing check value against the design; a mismatch over 0.5 % is flagged. */
export function checkValues(engine: PitEngine): CheckResult[] {
  const p = engine.pit;
  return (p.cfg.checks ?? [])
    .filter((c) => Number.isFinite(c.level) && Number.isFinite(c.litres))
    .map((check) => {
      const level = clamp(p.toDatum(check.level), 0, engine.depth);
      const litres = engine.litres(level);
      const errorPct = check.litres !== 0 ? ((litres - check.litres) / check.litres) * 100 : NaN;
      return { check, level, litres, errorPct, ok: Number.isFinite(errorPct) && Math.abs(errorPct) <= 0.5 };
    });
}

/** The plan point of the highest main floor, where a top sensor sees the shortest empty distance. */
export function shallowestPoint(p: PitModel): PlanPoint {
  let best = p.outline[0];
  let bz = -Infinity;
  p.outline.forEach((q, i) => {
    if (p.vertexZ[i] > bz) {
      bz = p.vertexZ[i];
      best = q;
    }
  });
  return { x: best.x, y: best.y };
}
