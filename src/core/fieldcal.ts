import type { CalConfig, CalMethod } from './types';
import { MM3_TO_L } from './units';
import type { VolumeEngine } from './volume';

/**
 * Field calibration. The drawing gives a straight-line formula
 *   level_drawing = A + B × raw
 * for each sensor. Real installations differ a little (the sensor sits a few mm
 * higher, the liquid is lighter, the transmitter span is off), so the user can
 * enter raw values read at known true levels or volumes. The fit is a straight
 * line on top of the drawing formula:
 *   level_true = alpha + beta × level_drawing
 * so the calibrated formula stays linear in the raw value:
 *   level_true = (alpha + beta × A) + (beta × B) × raw
 */

export interface CalMethodInfo {
  value: CalMethod;
  label: string;
  short: string;
  /** Reference points needed before the correction applies. */
  need: number;
  text: string;
}

export const CAL_METHODS: CalMethodInfo[] = [
  {
    value: 'theory',
    label: 'From the drawing',
    short: 'Drawing',
    need: 0,
    text: 'The formula comes only from the tank size and the sensor settings. Good when the drawing and the sensor position are exact.',
  },
  {
    value: 'offset',
    label: '1-point (zero / offset)',
    short: '1-point',
    need: 1,
    text: 'Measure the true level once (dipstick, tape or sight glass) and note the raw value at the same moment. This fixes a constant error, for example a sensor that sits 15 mm higher than drawn.',
  },
  {
    value: 'twopoint',
    label: '2-point (zero and span)',
    short: '2-point',
    need: 2,
    text: 'Note the raw value at two known levels, one low and one high, as far apart as you can. This fixes the offset and the span (slope), for example a wrong density or a transmitter range that is a little off. Only the first two points are used.',
  },
  {
    value: 'multipoint',
    label: 'Multi-point (best fit)',
    short: 'Multi-point',
    need: 2,
    text: 'Note the raw value at three or more known levels or volumes, for example while filling the tank in steps with a flow meter. A best-fit straight line is used, and the table shows how far each point is from it.',
  },
];

export interface CalResidual {
  index: number;
  raw: number;
  /** Reference converted to a level (mm), NaN if it is outside the tank. */
  trueLevel: number;
  /** Level from the drawing formula (mm). */
  theoryLevel: number;
  /** Level from the calibrated formula (mm). */
  fitLevel: number;
  /** fitLevel − trueLevel (mm). */
  error: number;
  /** Volume error of the calibrated formula at this point (L). */
  volumeError: number;
  /** The point was used for the fit (2-point uses the first two). */
  used: boolean;
}

export interface CalFit {
  method: CalMethod;
  /** A correction is active. */
  active: boolean;
  /** Why the correction cannot be made. */
  error: string | null;
  warnings: string[];
  alpha: number;
  beta: number;
  residuals: CalResidual[];
  /** Largest |error| over the used points (mm), and as volume (L). */
  maxError: number;
  maxVolumeError: number;
  /** Correction at the middle of the valid range (mm): calibrated − drawing. */
  shiftAtMid: number;
}

/** Reference value → true level (mm), or NaN if it is outside the tank. */
export function refToLevel(cal: CalConfig, ref: number, engine: VolumeEngine): number {
  if (!Number.isFinite(ref)) return NaN;
  if (cal.ref === 'level') return ref >= -1e-9 && ref <= engine.depth + 1e-9 ? ref : NaN;
  const mm3 = ref / MM3_TO_L;
  if (mm3 < -1e-9 || mm3 > engine.total * (1 + 1e-9)) return NaN;
  return engine.levelOf(mm3);
}

export function fitCalibration(
  cal: CalConfig,
  A: number,
  B: number,
  engine: VolumeEngine,
  validMin: number,
  validMax: number,
): CalFit {
  const fit: CalFit = {
    method: cal.method,
    active: false,
    error: null,
    warnings: [],
    alpha: 0,
    beta: 1,
    residuals: [],
    maxError: 0,
    maxVolumeError: 0,
    shiftAtMid: 0,
  };
  if (cal.method === 'theory') return fit;

  const pts = cal.points
    .map((p, index) => ({ index, raw: p.raw, trueLevel: refToLevel(cal, p.ref, engine), theoryLevel: A + B * p.raw }))
    .filter((p) => Number.isFinite(p.raw) && Number.isFinite(p.theoryLevel));
  const good = pts.filter((p) => Number.isFinite(p.trueLevel));
  const bad = cal.points.length - good.length;
  if (bad > 0) fit.warnings.push(`${bad} point${bad === 1 ? ' is' : 's are'} empty or outside the tank and ${bad === 1 ? 'is' : 'are'} not used.`);

  const need = CAL_METHODS.find((m) => m.value === cal.method)?.need ?? 0;
  if (good.length < need) {
    fit.error = need === 1 ? 'Add one reference point to apply the correction.' : `Add at least ${need} reference points to apply the correction.`;
    return fit;
  }
  const used = cal.method === 'twopoint' ? good.slice(0, 2) : good;
  if (cal.method === 'offset') {
    fit.alpha = used.reduce((s, p) => s + (p.trueLevel - p.theoryLevel), 0) / used.length;
  } else {
    const n = used.length;
    const mx = used.reduce((s, p) => s + p.theoryLevel, 0) / n;
    const my = used.reduce((s, p) => s + p.trueLevel, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of used) {
      sxx += (p.theoryLevel - mx) ** 2;
      sxy += (p.theoryLevel - mx) * (p.trueLevel - my);
    }
    if (!(Math.sqrt(sxx / n) > Math.max(1, engine.depth * 0.005))) {
      fit.error = 'The reference points are too close together. Use one low and one high level, as far apart as you can.';
      return fit;
    }
    fit.beta = sxy / sxx;
    fit.alpha = my - fit.beta * mx;
    if (!(fit.beta > 0)) {
      fit.error = 'The raw values move the wrong way against the reference. Check that each raw value belongs to its reference.';
      return fit;
    }
    if (fit.beta < 0.8 || fit.beta > 1.25) {
      fit.warnings.push(`The span differs by ${Math.abs((fit.beta - 1) * 100).toFixed(1)} % from the drawing. Check the units of the raw values and the sensor range.`);
    }
    if (cal.method === 'multipoint' && n === 2) fit.warnings.push('With two points this is the same as a 2-point calibration. Add more points to see the scatter.');
  }

  fit.active = true;
  const usedSet = new Set(used.map((p) => p.index));
  const clampL = (l: number) => Math.min(Math.max(l, 0), engine.depth);
  for (const p of pts) {
    const fitLevel = fit.alpha + fit.beta * p.theoryLevel;
    const ok = Number.isFinite(p.trueLevel);
    const error = ok ? fitLevel - p.trueLevel : NaN;
    const volumeError = ok ? (engine.volume(clampL(fitLevel)) - engine.volume(clampL(p.trueLevel))) * MM3_TO_L : NaN;
    const isUsed = usedSet.has(p.index);
    fit.residuals.push({ index: p.index, raw: p.raw, trueLevel: p.trueLevel, theoryLevel: p.theoryLevel, fitLevel, error, volumeError, used: isUsed });
    if (ok && isUsed) {
      fit.maxError = Math.max(fit.maxError, Math.abs(error));
      fit.maxVolumeError = Math.max(fit.maxVolumeError, Math.abs(volumeError));
    }
  }
  const mid = (validMin + validMax) / 2;
  fit.shiftAtMid = fit.alpha + (fit.beta - 1) * mid;
  if (Math.abs(fit.shiftAtMid) > Math.max(50, engine.depth * 0.1)) {
    fit.warnings.push(`The correction is large (${Math.round(fit.shiftAtMid)} mm at mid range). Check the sensor position, the nozzle height and the reference values.`);
  }
  return fit;
}

/** Applies a fit to a level = A + B × raw formula. */
export function calibrated(fit: CalFit | null, A: number, B: number): { A: number; B: number } {
  if (!fit || !fit.active) return { A, B };
  return { A: fit.alpha + fit.beta * A, B: fit.beta * B };
}
