import { defaultBody, defaultHead } from './defaults';
import { buildPit, PitEngine, type PitModel } from './pit';
import { manholeGeometry, sensorGeometry, tankHull, type Hull, type ManholeGeom, type SensorGeom } from './sensors';
import { buildTank, type TankModel } from './tank';
import type { Project, TankConfig } from './types';
import { clamp } from './units';
import { VolumeEngine } from './volume';

/** Everything computed from a project: geometry, volume engine and sensor placement. */
interface DerivedBase {
  /**
   * The tank model. For a concrete storage this is a stand-in box the size of the
   * storage (used where only a size or an orientation is needed); the geometry,
   * volumes and sensors come from `pit` and `engine`.
   */
  model: TankModel;
  hull: Hull;
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

export type Derived =
  | (DerivedBase & { kind: 'tank'; engine: VolumeEngine; pit: null })
  | (DerivedBase & { kind: 'pit'; engine: PitEngine; pit: PitModel });

export const MAX_TILT = 30;

export function isPit(t: TankConfig): boolean {
  return t.kind === 'pit' && !!t.pit;
}

export function derive(p: Project): Derived {
  if (isPit(p.tank)) return derivePit(p);
  const model = buildTank(p.tank);
  const tilt = clamp(Number.isFinite(p.tank.tilt) ? p.tank.tilt : 0, -MAX_TILT, MAX_TILT);
  const engine = new VolumeEngine(model, tilt);
  const density = p.liquid.density > 0 ? p.liquid.density : 1000;
  const manholes = (p.tank.manholes ?? []).map((mh) => manholeGeometry(mh, model, engine));
  const hull = tankHull(model);
  const geoms = p.sensors.map((s) => sensorGeometry(s, hull, engine, density, manholes));
  return {
    kind: 'tank',
    model,
    pit: null,
    hull,
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

/** The hull of a concrete storage: inside the inner wall faces, from the floor to the wall top, no roof. */
export function pitHull(pit: PitModel): Hull {
  return {
    orientation: 'vertical',
    size: pit.size,
    zero: 0,
    L: 0,
    open: true,
    span: (x, y) => (pit.inside(x, y) ? { lo: pit.floorZ(x, y), hi: pit.wallTop } : null),
    roofThickness: () => 0,
    inside: (a, u, v) => a <= pit.wallTop && pit.insideAt(u, v, a) && a >= pit.floorZ(u, v),
  };
}

function derivePit(p: Project): Derived {
  const pit = buildPit(p.tank.pit!);
  const engine = new PitEngine(pit);
  const density = p.liquid.density > 0 ? p.liquid.density : 1000;
  const hull = pitHull(pit);
  // Manholes in the slab that covers the storage: the "roof" under them is the wall top.
  const manholes = (p.tank.manholes ?? []).map((mh) => manholeGeometry(mh, hull, engine));
  const geoms = p.sensors.map((s) => sensorGeometry(s, hull, engine, density, manholes));
  // Stand-in box: the storage's outside plan size and its wall height, standing on the ground.
  const wall = Math.max(0, pit.cfg.wallTop);
  const standIn: TankConfig = {
    orientation: 'vertical',
    basis: 'inside',
    body: { ...defaultBody(), type: 'rect', width: pit.box.x1 - pit.box.x0 + 2 * wall, depth: pit.box.y1 - pit.box.y0 + 2 * wall, length: pit.wallTop, thickness: 0, corner: 0 },
    start: defaultHead('flat', 0),
    end: defaultHead('flat', 0),
    tilt: 0,
  };
  return {
    kind: 'pit',
    model: buildTank(standIn),
    pit,
    hull,
    engine,
    geoms,
    manholes,
    density,
    tilt: 0,
    totalL: engine.totalLitres,
    depth: engine.depth,
    problems: [...pit.problems, ...pit.warnings],
  };
}
