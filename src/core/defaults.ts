import type {
  BodyConfig,
  CloudConfig,
  IotConfig,
  CalConfig,
  HeadConfig,
  HeadType,
  ManholeConfig,
  Project,
  SensorConfig,
  SensorKind,
  SimState,
  TankConfig,
  ViewState,
} from './types';

export function defaultHead(type: HeadType = 'flat', thickness = 5): HeadConfig {
  return {
    type,
    ellipseRatio: 2,
    ratioBy: 'ratio',
    dishBy: 'depth',
    dishRadius: 2000,
    depth: 200,
    sizeBy: 'angle',
    angle: 30,
    outlet: 0,
    outlet2: 0,
    eccentric: false,
    side: 'pos',
    axis: 'u',
    tori: 'klopper',
    crown: 1,
    knuckle: 0.1,
    toriBy: 'depth-crown',
    crownR: 1800,
    knuckleR: 180,
    arc: 2400,
    thickness,
  };
}

/** IoT device settings: radar and ultrasonic sensors default to the Dragino models, the others to JSON. */
export function defaultIot(kind: SensorKind): IotConfig {
  const top = kind === 'ultrasonic' || kind === 'radar' || kind === 'laser';
  return {
    device: kind === 'radar' ? 'dragino-mr' : kind === 'ultrasonic' ? 'dragino-dds' : 'json',
    addresses: '',
    key: top ? 'distance' : kind === 'switch' ? 'alarm' : 'pressure',
    batteryKey: 'battery',
    port: 0,
    offset: 0,
    size: 2,
    order: 'be',
    signed: false,
    divisor: 1,
  };
}

export function defaultCloud(): CloudConfig {
  return { tank: 1 };
}

export function defaultBody(): BodyConfig {
  return {
    type: 'cylinder',
    diameter: 1850,
    width: 1600,
    depth: 1200,
    corner: 0,
    width2: 1200,
    chamfer: 150,
    squareness: 4,
    length: 1800,
    sizeBy: 'size',
    perimeter: 5812,
    lengthBy: 'shell',
    overall: 2000,
    endScale: 1,
    thickness: 8,
    sides: 8,
    profileOn: false,
    profile: [],
  };
}

export function defaultTank(): TankConfig {
  return {
    orientation: 'vertical',
    basis: 'outside',
    body: defaultBody(),
    start: defaultHead('flat', 8),
    end: { ...defaultHead('dished', 8), depth: 220 },
    tilt: 0,
  };
}

export interface LiquidPreset {
  id: string;
  label: string;
  density: number;
}

export const LIQUIDS: LiquidPreset[] = [
  { id: 'water20', label: 'Water, 20 °C', density: 998.2 },
  { id: 'water4', label: 'Water, 4 °C', density: 1000 },
  { id: 'seawater', label: 'Sea water', density: 1025 },
  { id: 'diesel', label: 'Diesel', density: 832 },
  { id: 'petrol', label: 'Petrol / gasoline', density: 740 },
  { id: 'milk', label: 'Milk', density: 1032 },
  { id: 'custom', label: 'Custom', density: 1000 },
];

export const SENSOR_KINDS: Record<SensorKind, { label: string; short: string; mount: 'top' | 'bottom' | 'point'; prefix: string }> = {
  ultrasonic: { label: 'Ultrasonic distance', short: 'Ultrasonic', mount: 'top', prefix: 'LT' },
  radar: { label: 'Radar distance', short: 'Radar', mount: 'top', prefix: 'LT' },
  laser: { label: 'Laser / ToF distance', short: 'Laser / ToF', mount: 'top', prefix: 'LT' },
  pressure: { label: 'Hydrostatic pressure (bottom)', short: 'Pressure', mount: 'bottom', prefix: 'LT' },
  submersible: { label: 'Submersible probe (hanging)', short: 'Submersible probe', mount: 'bottom', prefix: 'LT' },
  switch: { label: 'Level switch (float)', short: 'Level switch', mount: 'point', prefix: 'LS' },
};

export function isTopSensor(kind: SensorKind): boolean {
  return SENSOR_KINDS[kind].mount === 'top';
}

export function isPressureSensor(kind: SensorKind): boolean {
  return kind === 'pressure' || kind === 'submersible';
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Sensible defaults per sensor type. Values that depend on the tank are set by the caller. */
export function defaultSensor(kind: SensorKind, tag: string): SensorConfig {
  const base: SensorConfig = {
    id: newId(),
    tag,
    kind,
    enabled: true,
    colorSlot: 1,
    x: 0,
    y: 0,
    nozzle: 0,
    faceMode: 'auto',
    faceHeight: 2000,
    deadBand: 250,
    maxRange: 4500,
    beamAngle: 30,
    elevation: 30,
    switchMode: 'high',
    signal: 'digital',
    digitalUnit: 'mm',
    resolution: 1,
    rangeMin: 0,
    rangeMax: 4500,
    outMin: 4,
    outMax: 20,
    invert: false,
    adcBits: 12,
    adcVref: 3.3,
    shunt: 150,
    divider: 1,
    noise: 2,
    cal: defaultCal(),
  };
  switch (kind) {
    case 'ultrasonic':
      return { ...base, deadBand: 250, maxRange: 4500, beamAngle: 30, noise: 3, rangeMax: 4500 };
    case 'radar':
      return {
        ...base,
        deadBand: 80,
        maxRange: 10000,
        beamAngle: 8,
        noise: 1,
        signal: 'current',
        rangeMin: 0,
        rangeMax: 6000,
        adcBits: 12,
      };
    case 'laser':
      return { ...base, deadBand: 40, maxRange: 4000, beamAngle: 3, noise: 1.5, rangeMax: 4000 };
    case 'pressure':
    case 'submersible':
      return {
        ...base,
        elevation: kind === 'pressure' ? 0 : 50,
        signal: 'current',
        digitalUnit: 'kPa',
        resolution: 10,
        rangeMin: 0,
        rangeMax: 49033, // 0–5 mH₂O
        noise: 2,
      };
    case 'switch':
      return { ...base, elevation: 1500, signal: 'digital', noise: 0 };
  }
}

export function defaultManhole(tag: string): ManholeConfig {
  return {
    id: newId(),
    tag,
    x: 0,
    y: 0,
    shape: 'round',
    diameter: 500,
    length: 600,
    heightBy: 'neck',
    neck: 150,
    top: 2500,
    cover: 10,
  };
}

/** Next free manhole tag, e.g. MH-3 after MH-1 and MH-2. */
export function nextManholeTag(manholes: ManholeConfig[]): string {
  let max = 0;
  for (const m of manholes) {
    const n = m.tag.match(/(\d+)\s*$/);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `MH-${max + 1}`;
}

export function defaultCal(): CalConfig {
  return { method: 'theory', ref: 'level', points: [] };
}

/** First colour slot (1–7) not used by another sensor. */
export function nextColorSlot(sensors: SensorConfig[]): number {
  const used = new Set(sensors.map((s) => s.colorSlot));
  for (let i = 1; i <= 7; i++) if (!used.has(i)) return i;
  return (sensors.length % 7) + 1;
}

/** Next free ISA-style tag number, e.g. LT-103 after LT-101 and LT-102. */
export function nextTag(sensors: SensorConfig[], kind: SensorKind, high = true): string {
  const prefix = kind === 'switch' ? (high ? 'LSH' : 'LSL') : SENSOR_KINDS[kind].prefix;
  let max = 100;
  for (const s of sensors) {
    const m = s.tag.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function defaultView(): ViewState {
  return { mode: 'cutaway', dims: true, beams: true, labels: true, grid: true };
}

export function defaultSim(): SimState {
  return { level: 1200, flow: 120, direction: 0, speed: 10, noise: false };
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: 'New tank',
    tank: defaultTank(),
    liquid: { preset: 'water20', density: 998.2 },
    marks: { overflow: null, outlet: null },
    sensors: [],
    units: { length: 'mm', volume: 'L', pressure: 'kPa', flow: 'L/min' },
  };
}
