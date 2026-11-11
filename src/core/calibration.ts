import { readSensor, toAdc, toSignal, hasAdc, hasAnalog, digitalFactor, type SensorGeom } from './sensors';
import { MM3_TO_L } from './units';
import type { LevelEngine } from './volume';

export type TableMode = 'step' | 'rows' | 'compact';

export interface TableOptions {
  mode: TableMode;
  /** Level step (mm) for 'step' mode. */
  step: number;
  /** Number of intervals for 'rows' mode. */
  rows: number;
  /** Largest interpolation error (litres) for 'compact' mode. */
  tolerance: number;
}

export interface StrapRow {
  level: number;
  litres: number;
}

export interface SensorRow extends StrapRow {
  /** Measured quantity: distance (mm) or pressure (Pa). */
  x: number;
  /** In the sensor's digital unit. */
  digital: number;
  signal: number | null;
  /** Ideal (unrounded) ADC counts. */
  adc: number | null;
}

/** Keeps the fewest points so linear interpolation stays within tol (vertical distance). */
export function simplify(xs: ArrayLike<number>, ys: ArrayLike<number>, tol: number): number[] {
  const n = xs.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const x0 = xs[i0];
    const y0 = ys[i0];
    const dx = xs[i1] - x0;
    const dy = ys[i1] - y0;
    let worst = 0;
    let idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const t = dx !== 0 ? (xs[i] - x0) / dx : 0;
      const err = Math.abs(ys[i] - (y0 + t * dy));
      if (err > worst) {
        worst = err;
        idx = i;
      }
    }
    if (idx >= 0 && worst > tol) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Levels for a table over [lo, hi]. */
export function tableLevels(engine: LevelEngine, lo: number, hi: number, opt: TableOptions): number[] {
  if (!(hi > lo)) return [lo];
  if (opt.mode === 'rows') {
    const n = Math.max(1, Math.min(10000, Math.round(opt.rows)));
    return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
  }
  if (opt.mode === 'step') {
    const step = Math.max(opt.step, (hi - lo) / 20000);
    const out = [lo];
    let v = (Math.floor(lo / step + 1e-9) + 1) * step;
    while (v < hi - 1e-9 * step) {
      out.push(v);
      v += step;
    }
    out.push(hi);
    return out;
  }
  // Compact: dense sampling, then simplification between the shell/head
  // junction levels, which are always kept.
  const n = 4000;
  const fixed = breakLevels(engine).filter((L) => L > lo && L < hi);
  const set = new Set<number>(fixed);
  for (let i = 0; i <= n; i++) set.add(lo + ((hi - lo) * i) / n);
  const levels = [...set].sort((a, b) => a - b);
  const vols = levels.map((L) => engine.volume(L) * MM3_TO_L);
  const fixedSet = new Set(fixed);
  const tol = Math.max(opt.tolerance, 1e-9);
  const out: number[] = [levels[0]];
  let start = 0;
  for (let i = 1; i < levels.length; i++) {
    if (i < levels.length - 1 && !fixedSet.has(levels[i])) continue;
    const idx = simplify(levels.slice(start, i + 1), vols.slice(start, i + 1), tol);
    // idx[0] is this segment's first point, already pushed as the previous segment's end.
    for (let j = 1; j < idx.length; j++) out.push(levels[start + idx[j]]);
    start = i;
  }
  return out;
}

/** Levels where the shape changes (junctions of shell and heads, floor breaks of a storage). */
export function breakLevels(engine: LevelEngine): number[] {
  return engine.breakLevels();
}

export function strapTable(engine: LevelEngine, opt: TableOptions): StrapRow[] {
  return tableLevels(engine, 0, engine.depth, opt).map((level) => ({ level, litres: engine.volume(level) * MM3_TO_L }));
}

/**
 * Noise-free sensor readings across its valid range, with the true volume.
 * `readAt` maps a true level to the level the sensor model should read at
 * (used for field-calibrated sensors, whose real readings differ from the drawing).
 */
export function sensorTable(
  g: SensorGeom,
  engine: LevelEngine,
  density: number,
  opt: TableOptions,
  readAt?: (level: number) => number,
): SensorRow[] {
  if (!g.ok || g.mount === 'point' || !(g.validMax > g.validMin)) return [];
  const s = g.sensor;
  const levels = tableLevels(engine, g.validMin, g.validMax, opt);
  const rows: SensorRow[] = [];
  for (const level of levels) {
    const r = readSensor(g, readAt ? readAt(level) : level, density, null);
    let x = r.trueValue;
    if (!Number.isFinite(x)) continue;
    // At the limits the status may flip to dead band / floor; keep the physical value.
    const signal = hasAnalog(s) ? toSignal(s, x) : null;
    const adc = signal !== null && hasAdc(s) ? toAdc(s, signal, false) : null;
    rows.push({ level, litres: engine.volume(level) * MM3_TO_L, x, digital: x / digitalFactor(s), signal, adc });
  }
  return rows;
}
