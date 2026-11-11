import { sensorTable, strapTable, type SensorRow, type StrapRow, type TableOptions } from '../core/calibration';
import { calibrated, fitCalibration, type CalFit } from '../core/fieldcal';
import { SENSOR_KINDS, isPressureSensor } from '../core/defaults';
import type { Derived } from '../core/derive';
import {
  digitalFactor,
  fromAdc,
  fromSignal,
  hasAdc,
  levelFromMeasure,
  type SensorGeom,
} from '../core/sensors';
import type { Project, SensorConfig } from '../core/types';
import type { LevelEngine } from '../core/volume';
import {
  LENGTH,
  MM3_TO_L,
  PRESSURE,
  VOLUME,
  isLengthUnit,
  isPressureUnit,
  lenTo,
  plain,
  volTo,
  type LengthUnit,
  type PressureUnit,
  type VolumeUnit,
} from '../core/units';

export interface ExportOptions {
  /** 'level' for the strapping table, or a sensor id. */
  source: string;
  /** For sensor sources: which raw representation keys the table. */
  input: 'measure' | 'signal' | 'adc';
  table: TableOptions;
  lengthUnit: LengthUnit;
  volumeUnit: VolumeUnit;
  pressureUnit: PressureUnit;
}

/** level = A + B × raw, valid for raw in [rawMin, rawMax]. */
export interface Conversion {
  geom: SensorGeom;
  sensor: SensorConfig;
  ident: string;
  rawLabel: string;
  rawUnit: string;
  A: number;
  B: number;
  rawMin: number;
  rawMax: number;
  /** Raw value at the lowest and highest valid level. */
  rawAtMin: number;
  rawAtMax: number;
  /** Formula from the drawing alone (before field calibration). */
  theoryA: number;
  theoryB: number;
  /** Field calibration result, null for 'From the drawing'. */
  cal: CalFit | null;
}

export interface ExportData {
  project: Project;
  d: Derived;
  opt: ExportOptions;
  date: string;
  strap: StrapRow[];
  conversions: Conversion[];
  switches: SensorGeom[];
  sourceGeom: SensorGeom | null;
  sourceRows: SensorRow[];
}

export const LEN_DP: Record<LengthUnit, number> = { mm: 2, cm: 3, m: 5, in: 3, ft: 4 };
export const VOL_DP: Record<VolumeUnit, number> = { L: 3, m3: 6, gal: 3, igal: 3 };

export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function identOf(tag: string, used: Set<string>): string {
  let id = tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) id = 'sensor';
  if (/^[0-9]/.test(id)) id = 's_' + id;
  let out = id;
  let n = 2;
  while (used.has(out)) out = `${id}_${n++}`;
  used.add(out);
  return out;
}

/** Measurand per raw unit and its description. */
export function rawInfo(s: SensorConfig): { label: string; unit: string; toMeasure: (raw: number) => number } {
  const pressure = isPressureSensor(s.kind);
  const what = pressure ? 'pressure' : 'distance';
  if (s.signal === 'digital') {
    const f = digitalFactor(s);
    return { label: `${what} in ${s.digitalUnit}`, unit: s.digitalUnit, toMeasure: (raw) => raw * f };
  }
  const sigUnit = s.signal === 'current' ? 'mA' : 'V';
  if (hasAdc(s)) {
    const via = s.signal === 'current' ? `${plain(s.shunt, 2)} Ω shunt` : `divider ×${plain(s.divider, 4)}`;
    return {
      label: `ADC counts (${s.adcBits}-bit, Vref ${plain(s.adcVref, 3)} V, ${via})`,
      unit: 'counts',
      toMeasure: (raw) => fromSignal(s, fromAdc(s, raw)),
    };
  }
  return { label: `${s.signal === 'current' ? 'loop current' : 'voltage'} in ${sigUnit}`, unit: sigUnit, toMeasure: (raw) => fromSignal(s, raw) };
}

/**
 * Raw → level formula for a sensor. With an engine, the sensor's field
 * calibration is applied (when it has enough points).
 */
export function conversionFor(g: SensorGeom, density: number, ident: string, engine?: LevelEngine): Conversion {
  const s = g.sensor;
  const info = rawInfo(s);
  const lv = (raw: number) => levelFromMeasure(g, info.toMeasure(raw), density);
  const theoryA = lv(0);
  const theoryB = lv(1) - theoryA;
  const cal = engine && s.cal && s.cal.method !== 'theory' ? fitCalibration(s.cal, theoryA, theoryB, engine, g.validMin, g.validMax) : null;
  const { A, B } = calibrated(cal, theoryA, theoryB);
  const rawAt = (level: number) => (B !== 0 ? (level - A) / B : NaN);
  const rawAtMin = rawAt(g.validMin);
  const rawAtMax = rawAt(g.validMax);
  return {
    geom: g,
    sensor: s,
    ident,
    rawLabel: info.label,
    rawUnit: info.unit,
    A,
    B,
    rawMin: Math.min(rawAtMin, rawAtMax),
    rawMax: Math.max(rawAtMin, rawAtMax),
    rawAtMin,
    rawAtMax,
    theoryA,
    theoryB,
    cal,
  };
}

/** Applies a conversion's field calibration to another level = A + B × x formula of the same sensor. */
export function withCal(c: Conversion, A: number, B: number): { A: number; B: number } {
  return calibrated(c.cal, A, B);
}

/** Drawing level for a true level, so simulated readings follow the calibrated sensor. */
export function theoryLevelOf(c: Conversion, level: number): number {
  return c.cal && c.cal.active ? (level - c.cal.alpha) / c.cal.beta : level;
}

export function collect(project: Project, d: Derived, opt: ExportOptions): ExportData {
  const used = new Set<string>();
  const conversions: Conversion[] = [];
  const switches: SensorGeom[] = [];
  for (const g of d.geoms) {
    if (!g.sensor.enabled || !g.ok) continue;
    if (g.mount === 'point') {
      switches.push(g);
      continue;
    }
    if (!(g.validMax > g.validMin)) continue;
    const c = conversionFor(g, d.density, identOf(g.sensor.tag, used), d.engine);
    if (!Number.isFinite(c.A) || !Number.isFinite(c.B) || c.B === 0) continue;
    conversions.push(c);
  }
  const sourceGeom = d.geoms.find((g) => g.sensor.id === opt.source && g.ok && g.mount !== 'point') ?? null;
  const sourceConv = sourceGeom ? conversions.find((c) => c.sensor.id === sourceGeom.sensor.id) : undefined;
  // Volumes are computed at the level exactly as printed, so every row is exact
  // as written (on big tanks 0.01 mm of level can be a tenth of a litre).
  const k = LENGTH[opt.lengthUnit].k;
  const dp = LEN_DP[opt.lengthUnit];
  const strap = strapTable(d.engine, opt.table).map((r) => {
    const level = Math.min(Number(plain(r.level / k, dp)) * k, d.depth);
    return { level, litres: d.engine.volume(level) * MM3_TO_L };
  });
  return {
    project,
    d,
    opt,
    date: today(),
    strap,
    conversions,
    switches,
    sourceGeom,
    sourceRows: sourceGeom
      ? sensorTable(sourceGeom, d.engine, d.density, opt.table, sourceConv?.cal?.active ? (lv) => theoryLevelOf(sourceConv, lv) : undefined)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Unit helpers for the export

export function L(ed: ExportData, mm: number): string {
  return plain(lenTo(mm, ed.opt.lengthUnit), LEN_DP[ed.opt.lengthUnit]);
}

export function V(ed: ExportData, litres: number): string {
  return plain(volTo(litres, ed.opt.volumeUnit), VOL_DP[ed.opt.volumeUnit]);
}

export function lenLabel(ed: ExportData): string {
  return LENGTH[ed.opt.lengthUnit].label;
}

export function volLabel(ed: ExportData): string {
  return VOLUME[ed.opt.volumeUnit].label;
}

export function rawDp(c: Conversion): number {
  if (c.rawUnit === 'counts') return 2;
  if (c.rawUnit === 'mA' || c.rawUnit === 'V') return 5;
  if (isLengthUnit(c.rawUnit)) return { mm: 2, cm: 3, m: 5, in: 3, ft: 4 }[c.rawUnit];
  if (isPressureUnit(c.rawUnit)) return Math.max(2, PRESSURE[c.rawUnit].dp + 1);
  return 4;
}

/** Significant-digit formatting for formula coefficients. */
export function coef(v: number): string {
  if (!Number.isFinite(v)) return 'NaN';
  if (v === 0) return '0';
  const s = Number(v.toPrecision(10)).toString();
  return s.includes('e') ? v.toExponential(9) : s;
}

export function kindLabel(s: SensorConfig): string {
  return SENSOR_KINDS[s.kind].label;
}

