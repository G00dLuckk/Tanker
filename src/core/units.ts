export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type VolumeUnit = 'L' | 'm3' | 'gal' | 'igal';
export type PressureUnit = 'Pa' | 'kPa' | 'bar' | 'mbar' | 'psi' | 'mH2O' | 'cmH2O' | 'mmH2O' | 'inH2O';
export type FlowUnit = 'L/min' | 'L/s' | 'm3/h' | 'gpm';

/** Standard gravity (m/s²). */
export const G = 9.80665;

interface UnitDef {
  /** Canonical units per one of this unit (mm, L, Pa or L/min). */
  k: number;
  label: string;
  /** Decimals used for display. */
  dp: number;
}

export const LENGTH: Record<LengthUnit, UnitDef> = {
  mm: { k: 1, label: 'mm', dp: 1 },
  cm: { k: 10, label: 'cm', dp: 2 },
  m: { k: 1000, label: 'm', dp: 4 },
  in: { k: 25.4, label: 'in', dp: 2 },
  ft: { k: 304.8, label: 'ft', dp: 3 },
};

export const VOLUME: Record<VolumeUnit, UnitDef> = {
  L: { k: 1, label: 'L', dp: 1 },
  m3: { k: 1000, label: 'm³', dp: 4 },
  gal: { k: 3.785411784, label: 'US gal', dp: 1 },
  igal: { k: 4.54609, label: 'imp gal', dp: 1 },
};

export const PRESSURE: Record<PressureUnit, UnitDef> = {
  Pa: { k: 1, label: 'Pa', dp: 0 },
  kPa: { k: 1000, label: 'kPa', dp: 3 },
  bar: { k: 1e5, label: 'bar', dp: 5 },
  mbar: { k: 100, label: 'mbar', dp: 2 },
  psi: { k: 6894.757293168, label: 'psi', dp: 4 },
  mH2O: { k: 9806.65, label: 'mH₂O', dp: 4 },
  cmH2O: { k: 98.0665, label: 'cmH₂O', dp: 2 },
  mmH2O: { k: 9.80665, label: 'mmH₂O', dp: 1 },
  inH2O: { k: 249.08891, label: 'inH₂O', dp: 3 },
};

export const FLOW: Record<FlowUnit, UnitDef> = {
  'L/min': { k: 1, label: 'L/min', dp: 1 },
  'L/s': { k: 60, label: 'L/s', dp: 3 },
  'm3/h': { k: 1000 / 60, label: 'm³/h', dp: 3 },
  gpm: { k: 3.785411784, label: 'US gpm', dp: 2 },
};

export const isLengthUnit = (u: string): u is LengthUnit => u in LENGTH;
export const isPressureUnit = (u: string): u is PressureUnit => u in PRESSURE;

export const lenTo = (mm: number, u: LengthUnit) => mm / LENGTH[u].k;
export const lenFrom = (v: number, u: LengthUnit) => v * LENGTH[u].k;
export const volTo = (litres: number, u: VolumeUnit) => litres / VOLUME[u].k;
export const presTo = (pa: number, u: PressureUnit) => pa / PRESSURE[u].k;
export const presFrom = (v: number, u: PressureUnit) => v * PRESSURE[u].k;
export const flowTo = (lpm: number, u: FlowUnit) => lpm / FLOW[u].k;
export const flowFrom = (v: number, u: FlowUnit) => v * FLOW[u].k;

/** mm³ → litres */
export const MM3_TO_L = 1e-6;

const groupFmt = new Map<number, Intl.NumberFormat>();

/** Display formatting: fixed decimals, comma grouping, always Western digits. */
export function fmt(v: number, dp: number): string {
  if (!Number.isFinite(v)) return '—';
  let f = groupFmt.get(dp);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    groupFmt.set(dp, f);
  }
  const s = f.format(v);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/** Plain number for inputs and code: no grouping, trailing zeros trimmed. */
export function plain(v: number, dp: number): string {
  if (!Number.isFinite(v)) return '';
  const s = v.toFixed(dp);
  if (!s.includes('.')) return s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

export function fmtLen(mm: number, u: LengthUnit, withUnit = true, dpOverride?: number): string {
  const d = dpOverride ?? LENGTH[u].dp;
  return fmt(lenTo(mm, u), d) + (withUnit ? ' ' + LENGTH[u].label : '');
}

export function fmtVol(litres: number, u: VolumeUnit, withUnit = true, dpOverride?: number): string {
  const d = dpOverride ?? VOLUME[u].dp;
  return fmt(volTo(litres, u), d) + (withUnit ? ' ' + VOLUME[u].label : '');
}

export function fmtPres(pa: number, u: PressureUnit, withUnit = true): string {
  return fmt(presTo(pa, u), PRESSURE[u].dp) + (withUnit ? ' ' + PRESSURE[u].label : '');
}

/** Picks a "nice" step (1, 2, 2.5, 5 × 10ⁿ) close to raw. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const n = m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10;
  return n * p;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
