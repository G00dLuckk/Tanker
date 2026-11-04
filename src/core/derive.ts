import { manholeGeometry, sensorGeometry, type ManholeGeom, type SensorGeom } from './sensors';
import { buildTank, type TankModel } from './tank';
import type { Project } from './types';
import { clamp } from './units';
import { VolumeEngine } from './volume';

/** Everything computed from a project: geometry, volume engine and sensor placement. */
export interface Derived {
  model: TankModel;
  engine: VolumeEngine;
  geoms: SensorGeom[];
  manholes: ManholeGeom[];
  density: number;
  tilt: number;
  /** Capacity (L). */
  totalL: number;
  /** Largest liquid depth (mm). */
  depth: number;
  problems: string[];
}

export const MAX_TILT = 30;

export function derive(p: Project): Derived {
  const model = buildTank(p.tank);
  const tilt = clamp(Number.isFinite(p.tank.tilt) ? p.tank.tilt : 0, -MAX_TILT, MAX_TILT);
  const engine = new VolumeEngine(model, tilt);
  const density = p.liquid.density > 0 ? p.liquid.density : 1000;
  const manholes = (p.tank.manholes ?? []).map((mh) => manholeGeometry(mh, model, engine));
  const geoms = p.sensors.map((s) => sensorGeometry(s, model, engine, density, manholes));
  return {
    model,
    engine,
    geoms,
    manholes,
    density,
    tilt,
    totalL: engine.totalLitres,
    depth: engine.depth,
    problems: [...model.problems, ...model.warnings],
  };
}
