import { isPressureSensor, SENSOR_KINDS } from './defaults';
import { chordRange } from './shape';
import type { Sec, TankModel } from './tank';
import type { ManholeConfig, Orientation, SensorConfig } from './types';
import { G, LENGTH, PRESSURE, clamp, isLengthUnit, isPressureUnit } from './units';
import type { LevelEngine } from './volume';

/**
 * What sensor placement needs to know about the thing that holds the liquid: a closed
 * tank (its TankModel) or an open concrete storage. Plan positions are X / Y as the
 * user types them; "up" is the untilted vertical in the tank frame.
 */
export interface Hull {
  orientation: Orientation;
  /** Characteristic size for tolerances (mm). */
  size: number;
  /** Lowest inside point along up (untilted level zero). */
  zero: number;
  /** Horizontal tanks: straight shell length, for the plan → tank-frame mapping. */
  L: number;
  /** Open at the top (a storage without a roof): top sensors sit on the wall top with a bracket. */
  open: boolean;
  /** Lowest and highest inside point along up at a plan position, or null outside. */
  span(x: number, y: number): { lo: number; hi: number } | null;
  /** Thickness of the roof (plate) above the inside roof point; 0 for an open storage. */
  roofThickness(x: number, y: number, roofUp: number): number;
  /** Tank-frame point inside the liquid space. */
  inside(a: number, u: number, v: number): boolean;
}

export function isHull(x: TankModel | Hull): x is Hull {
  return typeof (x as Hull).span === 'function';
}

/** The hull of a closed tank. */
export function tankHull(model: TankModel): Hull {
  return {
    orientation: model.orientation,
    size: model.size,
    zero: upZero(model),
    L: model.L,
    open: false,
    span: (x, y) => verticalSpan(model, x, y),
    roofThickness: (x, y, roofUp) => roofThickness(model, x, y, roofUp),
    inside: (a, u, v) => model.inside(a, u, v),
  };
}

/** Tank-frame point (a, u, v). */
export type Vec3 = [number, number, number];

export type SensorStatus =
  | 'ok'
  | 'deadband'
  | 'floor'
  | 'range'
  | 'submerged'
  | 'dry'
  | 'over'
  | 'wet'
  | 'off'
  | 'error';

export const STATUS_TEXT: Record<SensorStatus, string> = {
  ok: 'Reading',
  deadband: 'In dead band',
  floor: 'Beam hits floor',
  range: 'Out of range',
  submerged: 'Face submerged',
  dry: 'Above liquid',
  over: 'Over range',
  wet: 'Wet',
  off: 'Disabled',
  error: 'Not placed',
};

export interface SensorGeom {
  sensor: SensorConfig;
  mount: 'top' | 'bottom' | 'point';
  ok: boolean;
  error: string | null;
  warnings: string[];
  /** Tank-frame up direction. */
  up: Vec3;
  /** Inside roof and floor points on the sensor's vertical line. */
  roof: Vec3 | null;
  floor: Vec3 | null;
  /** Sensor face (top sensors) or sensing point (pressure, switch). */
  face: Vec3;
  /** Outside roof point the sensor or probe cable hangs from. */
  roofOuter: Vec3 | null;
  /** Level of the face / sensing point above level zero (mm). */
  faceLevel: number;
  floorLevel: number;
  roofLevel: number;
  /** Top sensors: distance from the face to the floor along the beam (mm). */
  floorDist: number;
  /** Cosine between the beam and the vertical. */
  cosTilt: number;
  /** Level range in which the sensor gives a usable reading (mm). */
  validMin: number;
  validMax: number;
  /** Top sensors: level below which the beam cone touches a wall, or null. */
  beamContactLevel: number | null;
  /** Untilted face height above level zero, used when a script ignores tilt (mm). */
  faceHeightUntilted: number;
  /** Top sensors on a manhole cover: that manhole. */
  manhole: ManholeGeom | null;
}

export interface ManholeGeom {
  manhole: ManholeConfig;
  ok: boolean;
  error: string | null;
  warnings: string[];
  /** Tank-frame up coordinates (mm): inside roof and outside roof at the centre. */
  roofUp: number;
  roofOuterUp: number;
  /** Lowest outside roof point under the opening: where the neck meets the roof. */
  baseUp: number;
  /** Top of the cover. */
  coverUp: number;
  /** Neck height from the outside roof at the centre to the top of the cover (mm). */
  neckHeight: number;
  /** Top of the cover above level zero, untilted (mm). */
  coverHeight: number;
  /** Level of the top of the cover at its centre (mm, includes tilt). */
  coverLevel: number;
  /** Inside roof above level zero at the centre (mm, includes tilt). */
  roofLevel: number;
  /** Roof plate at the centre, measured straight up (mm); 0 on a concrete storage. */
  roofThickness: number;
  /** Underside of the cover above the inside roof at the centre (mm): how high liquid can stand in the neck. */
  neckDepth: number;
  /** Clear area of the opening (mm²). */
  area: number;
}

/** Half sizes of a manhole opening along X and Y (mm). */
export function manholeHalf(mh: ManholeConfig): [number, number] {
  return mh.shape === 'round' ? [mh.diameter / 2, mh.diameter / 2] : [mh.diameter / 2, mh.length / 2];
}

/** Points around the edge of the opening (plan X, Y), counter-clockwise. */
export function manholeEdge(mh: ManholeConfig, n = 24, grow = 0): [number, number][] {
  const [hx, hy] = manholeHalf(mh);
  const pts: [number, number][] = [];
  if (mh.shape === 'round') {
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      pts.push([mh.x + (hx + grow) * Math.cos(t), mh.y + (hy + grow) * Math.sin(t)]);
    }
    return pts;
  }
  const k = Math.max(2, Math.round(n / 4));
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[(c + 1) % 4];
    for (let i = 0; i < k; i++) {
      const f = i / k;
      pts.push([mh.x + (ax + (bx - ax) * f) * (hx + grow), mh.y + (ay + (by - ay) * f) * (hy + grow)]);
    }
  }
  return pts;
}

/** Clear distance from a plan point to the edge of the opening (mm), negative outside it. */
export function manholeClearance(mh: ManholeConfig, x: number, y: number): number {
  const [hx, hy] = manholeHalf(mh);
  const dx = x - mh.x;
  const dy = y - mh.y;
  if (mh.shape === 'round') return hx - Math.hypot(dx, dy);
  return Math.min(hx - Math.abs(dx), hy - Math.abs(dy));
}

/**
 * A manhole on the roof of a tank, or on the slab that covers a concrete storage (there the
 * "roof" is the wall top, and the neck height counts from it: slab + frame).
 */
export function manholeGeometry(mh: ManholeConfig, hullOrModel: TankModel | Hull, engine: LevelEngine): ManholeGeom {
  const model = isHull(hullOrModel) ? hullOrModel : tankHull(hullOrModel);
  const zero = model.zero;
  const warnings: string[] = [];
  const g: ManholeGeom = {
    manhole: mh,
    ok: false,
    error: null,
    warnings,
    roofUp: 0,
    roofOuterUp: 0,
    baseUp: 0,
    coverUp: 0,
    neckHeight: 0,
    coverHeight: 0,
    coverLevel: 0,
    roofLevel: 0,
    roofThickness: 0,
    neckDepth: 0,
    area: 0,
  };
  const [hx, hy] = manholeHalf(mh);
  if (!(hx > 0) || !(hy > 0)) {
    g.error = 'The opening size must be more than zero.';
    return g;
  }
  g.area = mh.shape === 'round' ? Math.PI * hx * hx : 4 * hx * hy;
  const span = model.span(mh.x, mh.y);
  if (!span) {
    g.error = model.open ? 'The centre is outside the storage. Move the manhole inside the inner wall faces.' : 'The centre is outside the tank. Move the manhole inside the outline.';
    return g;
  }
  const t = model.roofThickness(mh.x, mh.y, span.hi);
  g.roofThickness = t;
  g.roofUp = span.hi;
  g.roofOuterUp = span.hi + t;
  let lowest = span.hi;
  let outside = 0;
  for (const [ex, ey] of manholeEdge(mh)) {
    const e = model.span(ex, ey);
    if (e) lowest = Math.min(lowest, e.hi);
    else outside++;
  }
  g.baseUp = lowest + t;
  if (outside) warnings.push(model.open ? 'The opening runs past the inner wall face: part of it is over the wall.' : 'The opening runs past the edge of the roof: it is wider than the roof at this position.');
  g.coverUp = mh.heightBy === 'zero' ? zero + mh.top : g.roofOuterUp + mh.neck;
  g.neckHeight = g.coverUp - g.roofOuterUp;
  if (g.neckHeight < -1e-6) {
    g.error = model.open ? 'The top of the cover is below the wall top.' : 'The top of the cover is below the roof at the manhole centre.';
    return g;
  }
  if (mh.cover > g.neckHeight + 1e-6) {
    warnings.push(`The cover is thicker than the neck is high: the top of the cover should be at least one cover thickness above the ${model.open ? 'wall top' : 'roof'}.`);
  }
  g.neckDepth = Math.max(0, g.coverUp - Math.max(0, mh.cover) - g.roofUp);
  const levelOf = (up: number) => {
    const p = planToTank(model, mh.x, mh.y, up);
    return engine.levelOfPoint(p[0], p[1], p[2]);
  };
  g.coverHeight = g.coverUp - zero;
  g.coverLevel = levelOf(g.coverUp);
  g.roofLevel = levelOf(g.roofUp);
  g.ok = true;
  return g;
}

export interface Reading {
  status: SensorStatus;
  valid: boolean;
  /** Noise-free measured quantity: distance (mm) or pressure (Pa); 1/0 for switches. */
  trueValue: number;
  /** Measured quantity including noise and quantisation. */
  value: number;
  /** Value in the sensor's digital unit, when the signal is digital. */
  digital: number | null;
  /** Analog output (mA or V). */
  signal: number | null;
  /** ADC counts. */
  adc: number | null;
  /** Level computed from the measurement (mm), NaN when invalid. */
  level: number;
}

const tmpSec: Sec = { ku: 0, kv: 0, cu: 0, cv: 0 };

export function upVector(model: TankModel | Hull): Vec3 {
  return model.orientation === 'vertical' ? [1, 0, 0] : [0, 0, 1];
}

/** Converts a plan position to the tank-frame coordinates across the up axis. */
export function planToTank(model: TankModel | Hull, x: number, y: number, up: number): Vec3 {
  return model.orientation === 'vertical' ? [up, x, y] : [x + model.L / 2, y, up];
}

export function upOf(model: TankModel | Hull, p: Vec3): number {
  return model.orientation === 'vertical' ? p[0] : p[2];
}

/** Lowest and highest inside point along the up axis at a plan position, or null outside the tank. */
export function verticalSpan(model: TankModel, x: number, y: number): { lo: number; hi: number } | null {
  if (model.orientation === 'horizontal') {
    const a = x + model.L / 2;
    if (a < model.aMin || a > model.aMax) return null;
    const s = model.section(a, tmpSec);
    if (s.ku <= 1e-12 || s.kv <= 1e-12) return null;
    const ub = (y - s.cu) / s.ku;
    if (Math.abs(ub) >= model.base.A) return null;
    const ch = chordRange(model.base, 0, ub);
    if (!ch) return null;
    return { lo: s.cv + s.kv * ch[0], hi: s.cv + s.kv * ch[1] };
  }
  const n = 400;
  const { aMin, aMax } = model;
  let first = -1;
  let last = -1;
  for (let i = 0; i <= n; i++) {
    const a = aMin + ((aMax - aMin) * i) / n;
    if (model.inside(a, x, y)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const step = (aMax - aMin) / n;
  const edge = (inA: number, outA: number) => {
    let lo = inA;
    let hi = outA;
    for (let it = 0; it < 60; it++) {
      const m = 0.5 * (lo + hi);
      if (model.inside(m, x, y)) lo = m;
      else hi = m;
    }
    return lo;
  };
  const aIn0 = aMin + first * step;
  const aIn1 = aMin + last * step;
  const lo = first === 0 ? aMin : edge(aIn0, aIn0 - step);
  const hi = last === n ? aMax : edge(aIn1, aIn1 + step);
  return { lo, hi };
}

/** Lowest inside point along the up axis over the whole tank (untilted level zero). */
export function upZero(model: TankModel): number {
  if (model.orientation === 'vertical') return model.aMin;
  let best = Infinity;
  const n = 600;
  for (let i = 0; i <= n; i++) {
    const a = model.aMin + ((model.aMax - model.aMin) * i) / n;
    const s = model.section(a, tmpSec);
    best = Math.min(best, s.cv - s.kv * model.base.B);
  }
  return best;
}

/** Wall thickness at the roof point and its slope factor. */
function roofThickness(model: TankModel, x: number, y: number, roofUp: number): number {
  let t: number;
  if (model.orientation === 'vertical') {
    t = roofUp >= model.L - 1e-6 * model.size ? model.t.end : model.t.shell;
  } else {
    const a = x + model.L / 2;
    t = a < 0 ? model.t.start : a > model.L ? model.t.end : model.t.shell;
  }
  const d = Math.max(model.size * 1e-3, 0.5);
  const h = (px: number, py: number) => verticalSpan(model, px, py)?.hi;
  const hx0 = h(x - d, y);
  const hx1 = h(x + d, y);
  const hy0 = h(x, y - d);
  const hy1 = h(x, y + d);
  const gx = hx0 !== undefined && hx1 !== undefined ? (hx1 - hx0) / (2 * d) : 0;
  const gy = hy0 !== undefined && hy1 !== undefined ? (hy1 - hy0) / (2 * d) : 0;
  return t * Math.sqrt(1 + gx * gx + gy * gy);
}

export function sensorGeometry(
  sensor: SensorConfig,
  hullOrModel: TankModel | Hull,
  engine: LevelEngine,
  density: number,
  manholes: ManholeGeom[] = [],
): SensorGeom {
  const model = isHull(hullOrModel) ? hullOrModel : tankHull(hullOrModel);
  const mount = SENSOR_KINDS[sensor.kind].mount;
  const up = upVector(model);
  const cosTilt = engine.axis === -1 ? 1 : model.orientation === 'vertical' ? engine.na : engine.nw;
  const warnings: string[] = [];
  const zero = model.zero;
  const span = model.span(sensor.x, sensor.y);
  const levelOf = (p: Vec3) => engine.levelOfPoint(p[0], p[1], p[2]);
  const top = model.open ? 'wall top' : 'roof';

  const base: SensorGeom = {
    sensor,
    mount,
    ok: false,
    error: null,
    warnings,
    up,
    roof: null,
    floor: null,
    face: planToTank(model, sensor.x, sensor.y, zero),
    roofOuter: null,
    faceLevel: 0,
    floorLevel: 0,
    roofLevel: engine.depth,
    floorDist: 0,
    cosTilt,
    validMin: 0,
    validMax: 0,
    beamContactLevel: null,
    faceHeightUntilted: 0,
    manhole: null,
  };

  if (!span) {
    base.error = model.open ? 'This position is outside the storage. Move the sensor inside the inner wall faces.' : 'This position is outside the tank. Move the sensor inside the outline.';
    return base;
  }
  if (hasAnalog(sensor) && sensor.kind !== 'switch') {
    if (sensor.rangeMin === sensor.rangeMax) {
      base.error = 'The measurement at the bottom and top of the signal range must differ.';
      return base;
    }
    if (sensor.outMin === sensor.outMax) {
      base.error = 'Signal min and signal max must differ.';
      return base;
    }
  }

  const roof = planToTank(model, sensor.x, sensor.y, span.hi);
  const floor = planToTank(model, sensor.x, sensor.y, span.lo);
  base.roof = roof;
  base.floor = floor;
  base.floorLevel = levelOf(floor);
  base.roofLevel = levelOf(roof);
  const tRoof = model.roofThickness(sensor.x, sensor.y, span.hi);
  base.roofOuter = planToTank(model, sensor.x, sensor.y, span.hi + tRoof);

  if (mount === 'top') {
    let faceUp: number;
    if (sensor.faceMode === 'manhole') {
      const mg = manholes.find((x) => x.manhole.id === sensor.manhole);
      if (!mg) {
        base.error = manholes.length
          ? 'Choose the manhole this sensor sits on.'
          : model.open
            ? 'There is no manhole on this storage. Add one, or put the sensor on the wall top.'
            : 'There is no manhole on this tank. Add one, or put the sensor on the roof.';
        return base;
      }
      if (!mg.ok) {
        base.error = `Manhole ${mg.manhole.tag}: ${mg.error}`;
        return base;
      }
      base.manhole = mg;
      faceUp = mg.coverUp + sensor.nozzle;
      base.roofOuter = planToTank(model, sensor.x, sensor.y, mg.coverUp);
      const clear = manholeClearance(mg.manhole, sensor.x, sensor.y);
      if (clear < 0) {
        warnings.push(`The sensor is outside the opening of ${mg.manhole.tag}: its beam would hit the ${model.open ? 'slab' : 'roof plate'}. Move it over the opening.`);
      } else {
        // Beam width where it leaves the neck (at the inside roof) against the clear opening.
        const half = (clamp(sensor.beamAngle, 0, 170) / 2) * (Math.PI / 180);
        const throughNeck = faceUp - span.hi;
        const width = 2 * throughNeck * Math.tan(half);
        if (throughNeck > 0 && width > 2 * clear + 1e-6) {
          warnings.push(
            `The ${sensor.beamAngle}° beam is ${Math.round(width)} mm wide where it leaves the manhole neck, but only ${Math.round(2 * clear)} mm is clear around the sensor: echoes from the neck can read as liquid.`,
          );
        }
      }
    } else {
      faceUp = sensor.faceMode === 'manual' ? zero + sensor.faceHeight : span.hi + tRoof + sensor.nozzle;
    }
    const face = planToTank(model, sensor.x, sensor.y, faceUp);
    base.face = face;
    base.faceLevel = levelOf(face);
    base.faceHeightUntilted = faceUp - zero;
    base.floorDist = faceUp - span.lo;
    if (faceUp < span.hi - 1e-6 && sensor.faceMode !== 'auto') {
      warnings.push(model.open ? 'The face is below the wall top: the sensor hangs inside the storage.' : 'The face is below the roof at this position: the sensor sits inside the tank.');
    }
    if (faceUp <= span.lo) {
      base.error = model.open ? 'The sensor face is below the floor.' : 'The sensor face is below the tank floor.';
      return base;
    }
    let near = sensor.deadBand;
    let far = Math.min(base.floorDist, sensor.maxRange);
    if (hasAnalog(sensor)) {
      near = Math.max(near, Math.min(sensor.rangeMin, sensor.rangeMax));
      far = Math.min(far, Math.max(sensor.rangeMin, sensor.rangeMax));
    }
    base.validMax = clamp(base.faceLevel - near * cosTilt, 0, engine.depth);
    base.validMin = clamp(base.faceLevel - far * cosTilt, 0, engine.depth);
    if (hasAnalog(sensor) && Math.max(sensor.rangeMin, sensor.rangeMax) < Math.min(base.floorDist, sensor.maxRange)) {
      warnings.push('The analog output range ends before the floor: low levels saturate the signal.');
    }
    if (base.validMax <= base.validMin) {
      warnings.push('The dead band and range leave no measurable level at this position.');
    }
    if (sensor.maxRange < base.floorDist) {
      warnings.push(
        model.open
          ? `The floor under the sensor is ${Math.round(base.floorDist)} mm from its face, past its ${Math.round(sensor.maxRange)} mm range: the lowest ${Math.round(base.floorDist - sensor.maxRange)} mm cannot be measured. Move the sensor toward the shallowest part of the floor, or lower the bracket.`
          : `Range ends ${Math.round(base.floorDist - sensor.maxRange)} mm above the floor: low levels cannot be measured.`,
      );
    }
    if (model.open && base.manhole && faceUp - span.hi < sensor.deadBand - 1e-6) {
      warnings.push(
        `The face is only ${Math.round(faceUp - span.hi)} mm above the wall top, less than the ${Math.round(sensor.deadBand)} mm dead band: a full storage cannot be measured. Levels above ${Math.round(base.validMax)} mm fall in the dead band.`,
      );
    } else if (model.open && faceUp - span.hi < sensor.deadBand - 1e-6) {
      warnings.push(
        `The face is only ${Math.round(faceUp - span.hi)} mm above the wall top, less than the ${Math.round(sensor.deadBand)} mm dead band: a full storage cannot be measured. Raise the bracket to at least ${Math.round(sensor.deadBand)} mm.`,
      );
    } else if (base.validMax < engine.depth - 1e-6) {
      warnings.push(`Levels above ${Math.round(base.validMax)} mm fall in the dead band.`);
    }
    if (base.floorLevel > 1e-3 * model.size + 0.5) {
      warnings.push(
        model.open
          ? `The floor under the sensor is ${Math.round(base.floorLevel)} mm above the deepest point: the beam cannot see levels below that, so they read as ${Math.round(base.floorLevel)} mm.`
          : `The floor under the sensor is ${Math.round(base.floorLevel)} mm above level zero: lower levels are hidden from the beam.`,
      );
    }
    base.beamContactLevel = beamContact(sensor, model, base, engine);
    if (base.beamContactLevel !== null && base.beamContactLevel > base.validMin + 1) {
      warnings.push(
        `The ${sensor.beamAngle}° beam touches the ${model.open ? 'wall' : 'tank wall'} below level ${Math.round(base.beamContactLevel)} mm; echoes there may be unreliable.`,
      );
    }
  } else {
    const elevUp = sensor.kind === 'pressure' ? span.lo + sensor.elevation : zero + sensor.elevation;
    if (elevUp < span.lo - 1e-6) {
      base.error = model.open ? 'The sensing point is below the floor at this position.' : 'The sensing point is below the tank floor at this position.';
      return base;
    }
    if (elevUp > span.hi + 1e-6) {
      base.error = model.open ? `The sensing point is above the ${top}.` : 'The sensing point is above the tank roof at this position.';
      return base;
    }
    const face = planToTank(model, sensor.x, sensor.y, elevUp);
    base.face = face;
    base.faceLevel = levelOf(face);
    base.faceHeightUntilted = elevUp - zero;
    if (isPressureSensor(sensor.kind)) {
      const toHead = (pa: number) => (pa * 1000) / (density * G);
      const pLo = Math.max(0, Math.min(sensor.rangeMin, sensor.rangeMax));
      const maxHead = toHead(Math.max(sensor.rangeMin, sensor.rangeMax));
      base.validMin = clamp(base.faceLevel + toHead(pLo), 0, engine.depth);
      base.validMax = clamp(base.faceLevel + maxHead, 0, engine.depth);
      if (base.faceLevel + maxHead < engine.depth - 1e-6) {
        warnings.push(`The pressure range tops out at level ${Math.round(base.faceLevel + maxHead)} mm.`);
      }
      if (base.faceLevel > 0.5) {
        warnings.push(`Liquid below ${Math.round(base.faceLevel)} mm sits under the sensing point and reads as zero.`);
      }
    } else {
      base.validMin = 0;
      base.validMax = engine.depth;
    }
  }
  base.ok = true;
  return base;
}

/** Level below which the beam cone first touches a wall, or null if it stays clear. */
function beamContact(sensor: SensorConfig, model: Hull, g: SensorGeom, engine: LevelEngine): number | null {
  const half = (clamp(sensor.beamAngle, 0, 170) / 2) * (Math.PI / 180);
  if (half <= 0) return null;
  const tanH = Math.tan(half);
  // A nozzle or manhole neck above the inside roof is not part of the tank: start below it.
  const vertical = model.orientation === 'vertical';
  const faceUp = vertical ? g.face[0] : g.face[2];
  const roofUp = g.roof ? (vertical ? g.roof[0] : g.roof[2]) : faceUp;
  const s0 = Math.max(sensor.deadBand, 1, faceUp - roofUp + 1e-3 * model.size);
  const s1 = Math.min(g.floorDist, sensor.maxRange) * 0.995;
  if (s1 <= s0) return null;
  const face = g.face;
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
    const r = s * tanH;
    const c: Vec3 = vertical ? [face[0] - s, face[1], face[2]] : [face[0], face[1], face[2] - s];
    for (let k = 0; k < 12; k++) {
      const ang = (2 * Math.PI * k) / 12;
      const du = r * Math.cos(ang);
      const dv = r * Math.sin(ang);
      const p: Vec3 = vertical ? [c[0], c[1] + du, c[2] + dv] : [c[0] + du, c[1] + dv, c[2]];
      if (!model.inside(p[0], p[1], p[2])) {
        return clamp(engine.levelOfPoint(c[0], c[1], c[2]), 0, engine.depth);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal chain: measured quantity → digital value / analog signal → ADC counts

export function measurandUnitIsLength(sensor: SensorConfig): boolean {
  return !isPressureSensor(sensor.kind);
}

export function signalUnit(sensor: SensorConfig): 'mA' | 'V' | '' {
  return sensor.signal === 'current' ? 'mA' : sensor.signal === 'voltage' ? 'V' : '';
}

/** Canonical measurand (mm or Pa) per one digital unit. */
export function digitalFactor(sensor: SensorConfig): number {
  const u = sensor.digitalUnit;
  if (measurandUnitIsLength(sensor)) return isLengthUnit(u) ? LENGTH[u].k : 1;
  return isPressureUnit(u) ? PRESSURE[u].k : 1;
}

export function toSignal(sensor: SensorConfig, x: number): number {
  const span = sensor.rangeMax - sensor.rangeMin;
  let f = span !== 0 ? (x - sensor.rangeMin) / span : 0;
  f = clamp(f, 0, 1);
  if (sensor.invert) f = 1 - f;
  return sensor.outMin + f * (sensor.outMax - sensor.outMin);
}

export function fromSignal(sensor: SensorConfig, sig: number): number {
  const out = sensor.outMax - sensor.outMin;
  let f = out !== 0 ? (sig - sensor.outMin) / out : 0;
  if (sensor.invert) f = 1 - f;
  return sensor.rangeMin + f * (sensor.rangeMax - sensor.rangeMin);
}

/** Voltage at the ADC pin for a given signal. */
export function adcVolts(sensor: SensorConfig, sig: number): number {
  return sensor.signal === 'current' ? (sig / 1000) * sensor.shunt : sig * sensor.divider;
}

export function adcFull(sensor: SensorConfig): number {
  return Math.pow(2, clamp(Math.round(sensor.adcBits), 1, 24)) - 1;
}

export function toAdc(sensor: SensorConfig, sig: number, round = true): number {
  const v = adcVolts(sensor, sig);
  const c = clamp(v / sensor.adcVref, 0, 1) * adcFull(sensor);
  return round ? Math.round(c) : c;
}

export function fromAdc(sensor: SensorConfig, counts: number): number {
  const v = (counts / adcFull(sensor)) * sensor.adcVref;
  return sensor.signal === 'current' ? (v / sensor.shunt) * 1000 : v / sensor.divider;
}

export function hasAnalog(sensor: SensorConfig): boolean {
  return sensor.signal !== 'digital' && sensor.kind !== 'switch';
}

export function hasAdc(sensor: SensorConfig): boolean {
  return hasAnalog(sensor) && sensor.adcBits > 0;
}

/** Level (mm) from a measured value, using the sensor's position. */
export function levelFromMeasure(g: SensorGeom, x: number, density: number): number {
  if (g.mount === 'top') return g.faceLevel - x * g.cosTilt;
  return g.faceLevel + (x * 1000) / (density * G);
}

export function measureAtLevel(g: SensorGeom, level: number, density: number): { x: number; status: SensorStatus } {
  const s = g.sensor;
  if (!s.enabled) return { x: NaN, status: 'off' };
  if (!g.ok) return { x: NaN, status: 'error' };
  if (g.mount === 'top') {
    const d = (g.faceLevel - level) / g.cosTilt;
    if (d < 0) return { x: NaN, status: 'submerged' };
    if (d >= g.floorDist) return { x: g.floorDist, status: g.floorDist > s.maxRange ? 'range' : 'floor' };
    if (d > s.maxRange) return { x: d, status: 'range' };
    if (d < s.deadBand) return { x: d, status: 'deadband' };
    return { x: d, status: 'ok' };
  }
  if (s.kind === 'switch') {
    const wet = level >= g.faceLevel;
    return { x: wet ? 1 : 0, status: wet ? 'wet' : 'dry' };
  }
  const head = level - g.faceLevel;
  if (head <= 0) return { x: 0, status: 'dry' };
  const p = (density * G * head) / 1000;
  if (p > s.rangeMax) return { x: p, status: 'over' };
  return { x: p, status: 'ok' };
}

/** Full reading at a level, with optional noise (standard normal sample). */
export function readSensor(g: SensorGeom, level: number, density: number, noise: number | null): Reading {
  const s = g.sensor;
  const m = measureAtLevel(g, level, density);
  const r: Reading = {
    status: m.status,
    valid: m.status === 'ok',
    trueValue: m.x,
    value: m.x,
    digital: null,
    signal: null,
    adc: null,
    level: NaN,
  };
  if (s.kind === 'switch') {
    r.valid = g.ok && s.enabled;
    r.digital = m.x;
    return r;
  }
  if (!Number.isFinite(m.x)) return r;

  let x = m.x;
  if (noise !== null && s.noise > 0 && m.status !== 'dry') {
    const mmToX = g.mount === 'top' ? 1 : (density * G) / 1000;
    x += noise * s.noise * mmToX;
    if (g.mount !== 'top') x = Math.max(0, x);
  }
  if (s.signal === 'digital') {
    const res = s.resolution > 0 ? s.resolution : 0;
    if (res > 0) x = Math.round(x / res) * res;
    r.digital = x / digitalFactor(s);
  } else {
    const sig = toSignal(s, x);
    r.signal = sig;
    if (hasAdc(s)) {
      r.adc = toAdc(s, sig);
      x = fromSignal(s, fromAdc(s, r.adc));
    } else {
      x = fromSignal(s, sig);
    }
    const lo = Math.min(s.rangeMin, s.rangeMax);
    const hi = Math.max(s.rangeMin, s.rangeMax);
    if (r.status === 'ok' && (m.x < lo - 1e-9 || m.x > hi + 1e-9)) {
      r.status = 'range';
      r.valid = false;
    }
  }
  r.value = x;
  if (r.valid) r.level = levelFromMeasure(g, x, density);
  return r;
}
