import { defaultBody, defaultHead, defaultManhole, defaultSensor, emptyProject } from './defaults';
import type { HeadConfig, Project, SensorConfig, SensorKind } from './types';

export type PresetGroup = 'Vertical tanks' | 'Horizontal tanks' | 'Box and special shapes';

export interface Preset {
  id: string;
  group: PresetGroup;
  label: string;
  description: string;
  build(): Project;
}

function head(type: HeadConfig['type'], thickness: number, extra: Partial<HeadConfig> = {}): HeadConfig {
  return { ...defaultHead(type, thickness), ...extra };
}

function sensor(kind: SensorKind, tag: string, extra: Partial<SensorConfig> = {}): SensorConfig {
  return { ...defaultSensor(kind, tag), ...extra };
}

export const PRESETS: Preset[] = [
  {
    id: 'water-5000',
    group: 'Vertical tanks',
    label: 'Vertical water tank · 5,000 L',
    description: 'Flat bottom, shallow domed roof, ultrasonic sensor on a short nozzle and a pressure sensor at the bottom.',
    build() {
      const p = emptyProject();
      p.name = 'Water tank 5,000 L';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1850, length: 1800, thickness: 8 },
        start: head('flat', 10),
        end: head('dished', 8, { depth: 220 }),
        tilt: 0,
      };
      p.marks = { overflow: 1780, outlet: 80 };
      p.sensors = [
        sensor('ultrasonic', 'LT-101', { x: 450, y: 0, nozzle: 40 }),
        sensor('pressure', 'LT-102', { x: 650, y: -350, elevation: 40 }),
      ];
      return p;
    },
  },
  {
    id: 'horizontal-2000',
    group: 'Horizontal tanks',
    label: 'Horizontal cylinder · 2,000 L',
    description: 'Flat ends, sensor on the top centre line. The level-to-volume curve is an S-shape.',
    build() {
      const p = emptyProject();
      p.name = 'Horizontal tank 2,000 L';
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1200, length: 1800, thickness: 5 },
        start: head('flat', 5),
        end: head('flat', 5),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, nozzle: 50, deadBand: 200 })];
      return p;
    },
  },
  {
    id: 'vessel-10',
    group: 'Horizontal tanks',
    label: 'Horizontal vessel · 2:1 heads · 10 m³',
    description: 'Semi-ellipsoidal heads, radar transmitter on a 150 mm nozzle with a 4–20 mA output.',
    build() {
      const p = emptyProject();
      p.name = 'Horizontal vessel 10 m³';
      p.units = { ...p.units, volume: 'm3' };
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 2000, length: 2600, thickness: 10 },
        start: head('ellipsoidal', 10),
        end: head('ellipsoidal', 10),
        tilt: 0,
      };
      p.sensors = [
        sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 150, rangeMin: 0, rangeMax: 2500 }),
        sensor('switch', 'LSH-102', { x: 600, y: 0, elevation: 1750, switchMode: 'high' }),
      ];
      return p;
    },
  },
  {
    id: 'tanker',
    group: 'Horizontal tanks',
    label: 'Road tanker · elliptical · 30 m³',
    description: 'Elliptical shell with dished ends, parked on a 0.8° slope, with one ultrasonic sensor near each end.',
    build() {
      const p = emptyProject();
      p.name = 'Road tanker 30 m³';
      p.units = { ...p.units, volume: 'm3' };
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'oval', width: 2500, depth: 1700, length: 8800, thickness: 5 },
        start: head('dished', 5, { depth: 250 }),
        end: head('dished', 5, { depth: 250 }),
        tilt: 0.8,
      };
      p.sensors = [
        sensor('ultrasonic', 'LT-101', { x: -3200, y: 0, nozzle: 60, deadBand: 200 }),
        sensor('ultrasonic', 'LT-102', { x: 3200, y: 0, nozzle: 60, deadBand: 200 }),
      ];
      return p;
    },
  },
  {
    id: 'cone-bottom',
    group: 'Vertical tanks',
    label: 'Cone-bottom process tank',
    description: 'Conical bottom with outlet and conical roof. The off-centre sensor cannot see into the cone.',
    build() {
      const p = emptyProject();
      p.name = 'Cone-bottom tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1600, length: 1500, thickness: 4 },
        start: head('cone', 5, { sizeBy: 'angle', angle: 30, outlet: 80 }),
        end: head('cone', 4, { sizeBy: 'angle', angle: 12, outlet: 300 }),
        tilt: 0,
      };
      p.marks = { overflow: 1850, outlet: null };
      p.sensors = [
        sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 120, rangeMin: 0, rangeMax: 3000 }),
        sensor('ultrasonic', 'LT-102', { x: 450, y: 0, nozzle: 0, deadBand: 250 }),
      ];
      return p;
    },
  },
  {
    id: 'ibc',
    group: 'Box and special shapes',
    label: 'Rectangular tank · 1,000 L (IBC size)',
    description: 'Rounded-corner box with a sensor on the fill cap and a pressure sensor on the bottom outlet.',
    build() {
      const p = emptyProject();
      p.name = 'Rectangular tank 1,000 L';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'rect', width: 1200, depth: 1000, corner: 60, length: 850, thickness: 3 },
        start: head('flat', 3),
        end: head('flat', 3),
        tilt: 0,
      };
      p.sensors = [
        sensor('laser', 'LT-101', { x: 0, y: 0, nozzle: 30 }),
        sensor('pressure', 'LT-102', { x: 0, y: -420, elevation: 20, rangeMax: 20000 }),
      ];
      return p;
    },
  },
  {
    id: 'sphere',
    group: 'Box and special shapes',
    label: 'Spherical tank · Ø 3 m',
    description: 'Sphere on legs with a radar on the top nozzle and a pressure transmitter at the bottom.',
    build() {
      const p = emptyProject();
      p.name = 'Spherical tank';
      p.units = { ...p.units, volume: 'm3' };
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'sphere', diameter: 3000, thickness: 12 },
        start: head('hemi', 12),
        end: head('hemi', 12),
        tilt: 0,
      };
      p.sensors = [
        sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 150, rangeMin: 0, rangeMax: 3500 }),
        sensor('pressure', 'LT-102', { x: 0, y: 0, elevation: 0 }),
      ];
      return p;
    },
  },
  {
    id: 'klopper',
    group: 'Vertical tanks',
    label: 'Vertical vessel · Klöpper heads',
    description: 'Torispherical heads to DIN 28011 on both ends, radar on the top head and a pressure transmitter.',
    build() {
      const p = emptyProject();
      p.name = 'Vessel with Klöpper heads';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1600, length: 2000, thickness: 6 },
        start: head('torispherical', 6, { tori: 'klopper' }),
        end: head('torispherical', 6, { tori: 'klopper' }),
        tilt: 0,
      };
      p.sensors = [
        sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 200, rangeMin: 0, rangeMax: 3000 }),
        sensor('pressure', 'LT-102', { x: 0, y: 0, elevation: 0 }),
      ];
      return p;
    },
  },
  {
    id: 'sloped-floor',
    group: 'Box and special shapes',
    label: 'Rectangular tank · sloped floor',
    description: 'Floor slopes 3° toward the drain side. The sensor sits above the low side.',
    build() {
      const p = emptyProject();
      p.name = 'Tank with sloped floor';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'rect', width: 2000, depth: 1500, corner: 0, length: 1500, thickness: 5 },
        start: head('sloped', 6, { sizeBy: 'angle', angle: 3, side: 'neg' }),
        end: head('flat', 5),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: -700, y: 0, nozzle: 0 })];
      return p;
    },
  },
  {
    id: 'tapered',
    group: 'Vertical tanks',
    label: 'Tapered tank · wider at the bottom',
    description: 'Frustum shell (Ø 1600 → Ø 1280) with a shallow dome. Area changes with height.',
    build() {
      const p = emptyProject();
      p.name = 'Tapered tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1600, length: 1800, endScale: 0.8, thickness: 6 },
        start: head('flat', 8),
        end: head('dished', 6, { depth: 120 }),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, nozzle: 30 })];
      return p;
    },
  },
  {
    id: 'trough',
    group: 'Box and special shapes',
    label: 'V-trough bottom tank',
    description: 'Rectangular tank with a V-shaped trough floor and a drain strip along the bottom.',
    build() {
      const p = emptyProject();
      p.name = 'V-trough tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'rect', width: 2400, depth: 1200, corner: 0, length: 1000, thickness: 5 },
        start: head('wedge', 5, { sizeBy: 'angle', angle: 35, outlet: 150, axis: 'u' }),
        end: head('flat', 5),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, nozzle: 0 })];
      return p;
    },
  },
  {
    id: 'capsule',
    group: 'Horizontal tanks',
    label: 'Horizontal capsule · hemispherical ends',
    description: 'Pressure tank (LPG style) with round ends. Radar on the top centre line, pressure sensor at the bottom.',
    build() {
      const p = emptyProject();
      p.name = 'Capsule tank';
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1250, length: 3000, thickness: 8 },
        start: head('hemi', 8),
        end: head('hemi', 8),
        tilt: 0,
      };
      p.sensors = [
        sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 120, rangeMin: 0, rangeMax: 1500 }),
        sensor('pressure', 'LT-102', { x: 600, y: 0, elevation: 0, rangeMax: 19613 }),
      ];
      return p;
    },
  },
  {
    id: 'cone-ends',
    group: 'Horizontal tanks',
    label: 'Horizontal tank · conical ends',
    description: 'Cylinder with 30° cone ends, for example a mixer or a dust collector body.',
    build() {
      const p = emptyProject();
      p.name = 'Horizontal tank with cone ends';
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1400, length: 2200, thickness: 5 },
        start: head('cone', 5, { sizeBy: 'angle', angle: 30, outlet: 200 }),
        end: head('cone', 5, { sizeBy: 'angle', angle: 30, outlet: 200 }),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, nozzle: 50, deadBand: 200 })];
      return p;
    },
  },
  {
    id: 'underground',
    group: 'Horizontal tanks',
    label: 'Underground fuel tank · 30 m³',
    description: 'Horizontal diesel tank with Klöpper ends, probe in the manhole, 0.5° fall toward the drain end.',
    build() {
      const p = emptyProject();
      p.name = 'Underground diesel tank';
      p.units = { ...p.units, volume: 'm3' };
      p.liquid = { preset: 'diesel', density: 832 };
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 2500, length: 5600, thickness: 7 },
        start: head('torispherical', 7, { tori: 'klopper' }),
        end: head('torispherical', 7, { tori: 'klopper' }),
        tilt: -0.5,
      };
      p.marks = { overflow: 2300, outlet: 100 };
      p.sensors = [
        sensor('submersible', 'LT-101', { x: -1800, y: 0, elevation: 30, rangeMax: 29420 }),
        sensor('switch', 'LSH-102', { x: -1700, y: 300, elevation: 2350, switchMode: 'high' }),
      ];
      return p;
    },
  },
  {
    id: 'silo',
    group: 'Vertical tanks',
    label: 'Silo · 60° hopper bottom',
    description: 'Tall cylinder on legs with a steep 60° cone hopper and a shallow cone roof. Radar in the roof centre.',
    build() {
      const p = emptyProject();
      p.name = 'Silo with hopper';
      p.units = { ...p.units, volume: 'm3' };
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 2500, length: 4000, thickness: 6 },
        start: head('cone', 6, { sizeBy: 'angle', angle: 60, outlet: 300 }),
        end: head('cone', 5, { sizeBy: 'angle', angle: 15, outlet: 400 }),
        tilt: 0,
      };
      p.sensors = [sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 150, rangeMin: 0, rangeMax: 8000, maxRange: 15000 })];
      return p;
    },
  },
  {
    id: 'vertical-21',
    group: 'Vertical tanks',
    label: 'Vertical vessel · 2:1 heads · 4 m³',
    description: 'Semi-ellipsoidal heads top and bottom, pressure transmitter on the bottom head and a low-level switch.',
    build() {
      const p = emptyProject();
      p.name = 'Vertical vessel 2:1 heads';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'cylinder', diameter: 1400, length: 2200, thickness: 6 },
        start: head('ellipsoidal', 6),
        end: head('ellipsoidal', 6),
        tilt: 0,
      };
      p.sensors = [
        sensor('pressure', 'LT-101', { x: 0, y: 0, elevation: 0, rangeMax: 29420 }),
        sensor('switch', 'LSL-102', { x: 400, y: 0, elevation: 300, switchMode: 'low' }),
      ];
      return p;
    },
  },
  {
    id: 'stepped',
    group: 'Vertical tanks',
    label: 'Stepped tank · two diameters',
    description: 'Wide lower part (Ø 1600), short cone, narrow upper part (Ø 1000). Uses the custom shell profile.',
    build() {
      const p = emptyProject();
      p.name = 'Stepped tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: {
          ...defaultBody(),
          type: 'cylinder',
          diameter: 1600,
          length: 2400,
          thickness: 5,
          profileOn: true,
          profile: [
            { at: 1200, size: 1600 },
            { at: 1450, size: 1000 },
            { at: 2400, size: 1000 },
          ],
        },
        start: head('flat', 6),
        end: head('dished', 5, { depth: 80 }),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, nozzle: 40 })];
      return p;
    },
  },
  {
    id: 'octagon',
    group: 'Box and special shapes',
    label: 'Octagonal tank · 6 m³',
    description: 'Eight flat sides (2 m across flats), flat bottom and a low pyramid roof. Sensor off the roof centre.',
    build() {
      const p = emptyProject();
      p.name = 'Octagonal tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'polygon', sides: 8, width: 2000, depth: 2000, length: 1600, thickness: 6 },
        start: head('flat', 8),
        end: head('cone', 5, { sizeBy: 'angle', angle: 8, outlet: 300, outlet2: 300 }),
        tilt: 0,
      };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 450, y: 0, nozzle: 30 })];
      return p;
    },
  },
  {
    id: 'hexagon',
    group: 'Box and special shapes',
    label: 'Hexagonal tank · hopper bottom',
    description: 'Six-sided tank with a pyramid hopper and outlet. The width runs across two corners.',
    build() {
      const p = emptyProject();
      p.name = 'Hexagonal hopper tank';
      p.tank = {
        orientation: 'vertical',
        basis: 'outside',
        body: { ...defaultBody(), type: 'polygon', sides: 6, width: 1800, depth: 1559, length: 1400, thickness: 5 },
        start: head('cone', 5, { sizeBy: 'angle', angle: 40, outlet: 200, outlet2: 200 }),
        end: head('flat', 5),
        tilt: 0,
      };
      p.sensors = [sensor('radar', 'LT-101', { x: 0, y: 0, nozzle: 100, rangeMin: 0, rangeMax: 3000 })];
      return p;
    },
  },
  {
    id: 'trapezoid-trailer',
    group: 'Box and special shapes',
    label: 'Trapezoidal fuel tank · lying',
    description: 'Wider at the top than the bottom, flanged flat ends, radar on the manhole cover.',
    build() {
      const p = emptyProject();
      p.name = 'Trapezoidal fuel tank';
      const mh = { ...defaultManhole('MH-1'), id: 'mh-trapezoid-1', x: 0, y: 0, diameter: 500, neck: 120, cover: 10 };
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'trapezoid', width: 2000, width2: 1400, depth: 1300, length: 4000, thickness: 5 },
        start: head('flanged', 5, { knuckleR: 100 }),
        end: head('flanged', 5, { knuckleR: 100 }),
        tilt: 0,
        sameEnds: true,
        manholes: [mh],
      };
      p.liquid = { preset: 'diesel', density: 832 };
      p.sensors = [sensor('radar', 'LT-101', { x: 0, y: 0, faceMode: 'manhole', manhole: mh.id, nozzle: 0, rangeMin: 0, rangeMax: 2000 })];
      return p;
    },
  },
  {
    id: 'box-oval-tanker',
    group: 'Horizontal tanks',
    label: 'Box-oval road tanker · 24,000 L',
    description: 'Superellipse shell (squareness 4) with shallow dished ends; ultrasonic on the middle manhole.',
    build() {
      const p = emptyProject();
      p.name = 'Box-oval road tanker';
      const mh = { ...defaultManhole('MH-1'), id: 'mh-boxoval-1', x: 0, y: 0, diameter: 500, neck: 200, cover: 12 };
      p.tank = {
        orientation: 'horizontal',
        basis: 'outside',
        body: { ...defaultBody(), type: 'boxoval', width: 2450, depth: 1700, squareness: 4, length: 6400, thickness: 5 },
        start: head('dished', 5, { depth: 150 }),
        end: head('dished', 5, { depth: 150 }),
        tilt: 0,
        sameEnds: true,
        manholes: [mh],
      };
      p.liquid = { preset: 'diesel', density: 832 };
      p.sensors = [sensor('ultrasonic', 'LT-101', { x: 0, y: 0, faceMode: 'manhole', manhole: mh.id, nozzle: 0, deadBand: 200 })];
      return p;
    },
  },
];

export const PRESET_GROUPS: PresetGroup[] = ['Vertical tanks', 'Horizontal tanks', 'Box and special shapes'];

export function defaultProject(): Project {
  return PRESETS[0].build();
}

for (const p of PRESETS) {
  const build = p.build;
  p.build = () => {
    const proj = build();
    proj.sensors.forEach((s, i) => (s.colorSlot = (i % 7) + 1));
    return proj;
  };
}
