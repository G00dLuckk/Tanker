import type { ExportPrefs } from '../app/store';
import type { Derived } from '../core/derive';
import type { Project, SimState, SiteDevice, ViewState } from '../core/types';
import { plain } from '../core/units';
import { bodyName, endNames } from './context';
import { conversionFor, identOf, today } from './shared';

/**
 * A Tanker Time project file (*.tank.json). It holds everything set in the app:
 * the tank, liquid, levels, sensors with their outputs and field calibration
 * points, units, the 3D view, the simulated level and the export choices.
 * The "summary" block repeats the key results in plain numbers for people who
 * open the file in a text editor; it is ignored when the file is opened.
 */
export const FILE_FORMAT = 'tanker-time-project';
export const FILE_VERSION = 2;
export const FILE_EXT = '.tank.json';

export interface ProjectFile {
  format: typeof FILE_FORMAT;
  formatVersion: number;
  app: string;
  saved: string;
  summary: Record<string, unknown>;
  /** The tank that was being edited (also the first place older versions look). */
  project: Project;
  /** Every tank on the site, the one being edited, their simulated levels and the site's devices. */
  tanks?: Project[];
  active?: number;
  levels?: number[];
  devices?: SiteDevice[];
  view?: ViewState;
  sim?: Partial<SimState>;
  exportPrefs?: ExportPrefs;
}

const r1 = (v: number) => Number(plain(v, 1));
const r3 = (v: number) => Number(plain(v, 3));

/** Plain-number summary of the tank and sensors (all lengths in mm, volumes in L). */
export function projectSummary(p: Project, d: Derived): Record<string, unknown> {
  const m = d.model;
  const n = endNames(p);
  const used = new Set<string>();
  const shape =
    d.kind === 'pit'
      ? {
          storage: {
            planAreaM2: r3(d.pit.area / 1e6),
            cornersMm: d.pit.outline.map((q) => [r1(q.x), r1(q.y)]),
            wallTopAboveZeroMm: r1(d.pit.wallTop),
            floor: d.pit.cfg.floor,
            floorLowHighMm: [r1(d.pit.floorLow), r1(d.pit.floorHigh)],
            sumps: d.pit.sumps.map((s) => ({ bottomMm: r1(s.bottom), rimMm: r1(s.rim), cornersMm: s.outline.map((q) => [r1(q.x), r1(q.y)]) })),
            batterMmPerM: d.pit.cfg.batter,
            heightsOnDrawingFrom: d.pit.cfg.heightRef,
            drawingZeroAboveLevelZeroMm: r1(d.pit.refZ),
          },
        }
      : {
          insideMm: { width: r1(2 * m.base.A), depth: r1(2 * m.base.B), straightLength: r1(m.L), totalLength: r1(m.innerDims.length) },
          outsideMm: { width: r1(m.outer.width), depth: r1(m.outer.depth), length: r1(m.outer.length) },
          wallMm: { shell: m.t.shell, [n.start.toLowerCase()]: m.t.start, [n.end.toLowerCase()]: m.t.end },
          [n.startLong]: { type: m.start.meta.label, insideDepthMm: r1(m.start.depth) },
          [n.endLong]: { type: m.end.meta.label, insideDepthMm: r1(m.end.depth) },
          tiltDeg: d.tilt,
        };
  return {
    note: 'Read-only summary for people. Lengths in mm, volumes in litres, level zero = lowest inside point. Tanker Time ignores this block when it opens the file.',
    tank: bodyName(p, m),
    capacityL: r3(d.totalL),
    fullDepthMm: r1(d.depth),
    ...shape,
    liquidDensity: p.liquid.density,
    problems: d.problems.length ? d.problems : undefined,
    manholes: d.manholes.length
      ? d.manholes.map((mg) => {
          const mh = mg.manhole;
          const base = { tag: mh.tag, shape: mh.shape, xMm: mh.x, yMm: mh.y, openingMm: mh.shape === 'round' ? [mh.diameter] : [mh.diameter, mh.length] };
          return mg.ok ? { ...base, neckMm: r1(mg.neckHeight), coverTopAboveZeroMm: r1(mg.coverHeight) } : { ...base, error: mg.error };
        })
      : undefined,
    sensors: d.geoms.map((g) => {
      const s = g.sensor;
      const base = { tag: s.tag, kind: s.kind, enabled: s.enabled, xMm: s.x, yMm: s.y, onManhole: g.manhole ? g.manhole.manhole.tag : undefined };
      if (!g.ok) return { ...base, error: g.error };
      if (g.mount === 'point') return { ...base, switchLevelMm: r1(g.faceLevel), switchVolumeL: r3(d.engine.litres(g.faceLevel)) };
      const c = conversionFor(g, d.density, identOf(s.tag, used), d.engine);
      return {
        ...base,
        sensingLevelMm: r1(g.faceLevel),
        validLevelMm: [r1(g.validMin), r1(g.validMax)],
        calibration: c.cal?.active ? c.cal.method : 'theory',
        formula: `level_mm = ${Number(c.A.toPrecision(10))} + (${Number(c.B.toPrecision(10))}) × raw`,
        raw: c.rawLabel,
      };
    }),
  };
}

export function buildProjectFile(
  project: Project,
  d: Derived,
  extra: { view?: ViewState; sim?: SimState; exportPrefs?: ExportPrefs; site?: { tanks: Project[]; active: number; levels: number[]; devices: SiteDevice[] } } = {},
): string {
  const doc: ProjectFile = {
    format: FILE_FORMAT,
    formatVersion: FILE_VERSION,
    app: 'Tanker Time',
    saved: new Date().toISOString(),
    summary: projectSummary(project, d),
    project,
    ...(extra.site ? { tanks: extra.site.tanks, active: extra.site.active, levels: extra.site.levels.map((v) => (Number.isFinite(v) ? v : 0)), devices: extra.site.devices } : {}),
    view: extra.view,
    sim: extra.sim ? { level: extra.sim.level, flow: extra.sim.flow, speed: extra.sim.speed, noise: extra.sim.noise } : undefined,
    exportPrefs: extra.exportPrefs,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

export function fileNameFor(project: Project): string {
  const base =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tank';
  return `${base}${FILE_EXT}`;
}

export { today };
