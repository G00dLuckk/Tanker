import { defaultCal, defaultCloud, defaultHead, defaultIot, defaultManhole, defaultSensor, defaultSim, defaultView, emptyProject } from '../core/defaults';
import { defaultPit } from '../core/pit';
import { defaultProject } from '../core/presets';
import type { CalConfig, CloudConfig, HeadConfig, ManholeConfig, PitCheck, PitConfig, PitFloor, PitSump, PlanPoint, ProfilePoint, Project, SensorConfig, SimState, SiteDevice, ViewState } from '../core/types';
import type { AppState, ExportPrefs } from './store';

const KEY = 'tanker-time/state/v1';
const LIB = 'tanker-time/library/v1';
const UI = 'tanker-time/ui/v1';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function defaultExportPrefs(): ExportPrefs {
  return {
    tab: 'config',
    source: 'level',
    input: 'measure',
    mode: 'step',
    step: 10,
    rows: 50,
    tolerance: 0.1,
    lengthUnit: 'auto',
    volumeUnit: 'auto',
    csVarIds: {},
    csFamily: 'auto',
  };
}

function normalizeCloud(c: Partial<CloudConfig>): CloudConfig {
  const out: CloudConfig = { ...defaultCloud(), ...c };
  if (out.iot) out.iot = { ...defaultIot('ultrasonic'), ...out.iot };
  if (Array.isArray(out.devices)) {
    out.devices = out.devices
      .filter((d) => d && typeof d === 'object' && typeof d.address === 'string')
      .map((d) => ({
        address: d.address,
        tank: typeof d.tank === 'string' ? d.tank : '',
        sensor: typeof d.sensor === 'string' ? d.sensor : '',
        name: typeof d.name === 'string' ? d.name : '',
        ...(Number.isInteger(d.number) && d.number! >= 1 && d.number! <= 99 ? { number: d.number } : {}),
      }));
  } else delete out.devices;
  return out;
}

export function normalizeExportPrefs(p: Partial<ExportPrefs> | null | undefined): ExportPrefs {
  const out = { ...defaultExportPrefs(), ...(p ?? {}) };
  // Older versions had more tabs (context, python, Cloud Studio config…).
  const tabs: Record<string, ExportPrefs['tab']> = { config: 'config', csconfig: 'config', payload: 'payload', cspayload: 'payload', table: 'table', csv: 'table', details: 'details' };
  out.tab = tabs[out.tab as string] ?? 'config';
  out.csVarIds = out.csVarIds && typeof out.csVarIds === 'object' ? { ...out.csVarIds } : {};
  if (out.csFamily !== 'lorawan' && out.csFamily !== 'tcp') out.csFamily = 'auto';
  return out;
}

/** A concrete storage as saved, with every field present and every number finite. */
export function normalizePit(raw: Partial<PitConfig> | null | undefined): PitConfig {
  const base = defaultPit();
  if (!raw || typeof raw !== 'object') return base;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const opt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pts = (list: unknown): PlanPoint[] =>
    (Array.isArray(list) ? list : []).filter((q) => q && typeof q === 'object' && Number.isFinite(q.x) && Number.isFinite(q.y)).map((q) => ({ x: Number(q.x), y: Number(q.y) }));
  const outline = pts(raw.outline);
  const f = raw.floor as Partial<PitFloor> | undefined;
  const floor: PitFloor =
    f?.type === 'plane'
      ? { type: 'plane', direction: num((f as { direction?: number }).direction, 0), drop: num((f as { drop?: number }).drop, 0) }
      : f?.type === 'vertices'
        ? { type: 'vertices', heights: (Array.isArray((f as { heights?: unknown }).heights) ? ((f as { heights: unknown[] }).heights as unknown[]) : []).map((h) => num(h, 0)) }
        : { type: 'flat' };
  const sumps: PitSump[] = (Array.isArray(raw.sumps) ? raw.sumps : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const out: PitSump = { x: num(s.x, 0), y: num(s.y, 0), width: num(s.width, 1000), length: num(s.length, 1000), depth: num(s.depth, 300) };
      const o = pts(s.outline);
      if (o.length >= 3) out.outline = o;
      return out;
    });
  const checks: PitCheck[] = (Array.isArray(raw.checks) ? raw.checks : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ level: num(c.level, NaN), litres: num(c.litres, NaN) }));
  return {
    outline: outline.length >= 3 ? outline : base.outline,
    wallHeight: num(raw.wallHeight, base.wallHeight),
    heightRef: raw.heightRef === 'datum' || raw.heightRef === 'floorLow' || raw.heightRef === 'floorHigh' ? raw.heightRef : base.heightRef,
    floor,
    sumps,
    batter: num(raw.batter, 0),
    wallTop: num(raw.wallTop, base.wallTop),
    wallBase: num(raw.wallBase, base.wallBase),
    slab: num(raw.slab, base.slab),
    operationLevel: opt(raw.operationLevel),
    alarmHigh: opt(raw.alarmHigh),
    alarmLow: opt(raw.alarmLow),
    checks,
  };
}

/** Fills in fields missing from older or hand-edited project files. */
export function normalizeProject(p: Partial<Project> | null | undefined): Project {
  const base = emptyProject();
  if (!p || typeof p !== 'object' || !p.tank) return defaultProject();
  const head = (h: Partial<HeadConfig> | undefined, fallback: HeadConfig): HeadConfig => ({ ...fallback, ...(h ?? {}) });
  const body = { ...base.tank.body, ...(p.tank.body ?? {}) };
  body.profile = (Array.isArray(body.profile) ? body.profile : [])
    .filter((pt: Partial<ProfilePoint>) => pt && Number.isFinite(pt.at) && Number.isFinite(pt.size))
    .map((pt: ProfilePoint) => ({ at: pt.at, size: pt.size }));
  if (![6, 8, 10, 12].includes(body.sides)) body.sides = 8;
  const tank = {
    ...base.tank,
    ...p.tank,
    body,
    start: head(p.tank.start, defaultHead('flat', 5)),
    end: head(p.tank.end, defaultHead('flat', 5)),
  };
  if (Array.isArray(p.tank.manholes)) {
    tank.manholes = p.tank.manholes
      .filter((mh) => mh && typeof mh === 'object')
      .map((mh, i): ManholeConfig => ({ ...defaultManhole(`MH-${i + 1}`), ...mh }));
  } else delete tank.manholes;
  if (p.tank.kind === 'pit') {
    tank.kind = 'pit';
    tank.pit = normalizePit(p.tank.pit);
  } else {
    delete tank.kind;
    if (p.tank.pit && typeof p.tank.pit === 'object') tank.pit = normalizePit(p.tank.pit);
    else delete tank.pit;
  }
  const sensors: SensorConfig[] = (Array.isArray(p.sensors) ? p.sensors : []).map((s, i) => {
    const kind = s && s.kind ? s.kind : 'ultrasonic';
    const c: Partial<CalConfig> = s?.cal ?? {};
    const cal: CalConfig = {
      ...defaultCal(),
      ...c,
      points: (Array.isArray(c.points) ? c.points : []).filter((pt) => pt && typeof pt === 'object').map((pt) => ({ raw: Number(pt.raw), ref: Number(pt.ref) })),
    };
    const out: SensorConfig = { ...defaultSensor(kind, s?.tag ?? `LT-${101 + i}`), ...s, cal, colorSlot: s?.colorSlot ?? (i % 7) + 1 };
    if (s?.iot) {
      out.iot = { ...defaultIot(kind), ...s.iot };
      // Projects saved before the device models were split.
      if ((out.iot.device as string) === 'dragino') out.iot.device = 'dragino-mr';
    }
    if (!['auto', 'manhole', 'manual'].includes(out.faceMode)) out.faceMode = 'auto';
    return out;
  });
  return {
    version: 1,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : base.name,
    tank,
    liquid: { ...base.liquid, ...(p.liquid ?? {}) },
    marks: { ...base.marks, ...(p.marks ?? {}) },
    sensors,
    units: { ...base.units, ...(p.units ?? {}) },
    ...(p.cloud ? { cloud: normalizeCloud(p.cloud) } : {}),
  };
}

/** Site devices: DevEUIs with their sensor number. */
export function normalizeDevices(list: unknown): SiteDevice[] {
  if (!Array.isArray(list)) return [];
  const out: SiteDevice[] = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || typeof d.address !== 'string') continue;
    const address = d.address.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (!address || out.some((x) => x.address === address)) continue;
    out.push(Number.isInteger(d.number) && d.number >= 1 ? { address, number: d.number } : { address });
  }
  return out;
}

/**
 * Tanks saved before a site could hold several: the tank number becomes the number
 * of the first distance sensor, and the devices keep that number (or their own).
 */
export function siteFromLegacy(tanks: Project[]): SiteDevice[] {
  const devices: SiteDevice[] = [];
  for (const p of tanks) {
    const c = p.cloud;
    if (!c) continue;
    const first = p.sensors.find((s) => s.enabled && (s.kind === 'ultrasonic' || s.kind === 'radar' || s.kind === 'laser'));
    if (first && first.number === undefined && Number.isInteger(c.tank) && c.tank >= 1) first.number = c.tank;
    for (const d of c.devices ?? []) if (!d.tank || d.tank === p.name) devices.push({ address: d.address, number: d.number ?? c.tank });
    delete p.cloud;
  }
  return normalizeDevices(devices);
}

export interface SiteDoc {
  tanks?: unknown;
  project?: unknown;
  active?: unknown;
  devices?: unknown;
  levels?: unknown;
}

/** The site of a saved state or project file: its tanks, the one being edited, the levels and the devices. */
export function normalizeSite(doc: SiteDoc): { tanks: Project[]; active: number; devices: SiteDevice[]; levels: number[] } {
  const raw = Array.isArray(doc.tanks) && doc.tanks.length ? doc.tanks : doc.project ? [doc.project] : [];
  const tanks = raw.map((p) => normalizeProject(p as Partial<Project>));
  if (!tanks.length) tanks.push(defaultProject());
  const active = Number.isInteger(doc.active) ? Math.min(Math.max(doc.active as number, 0), tanks.length - 1) : 0;
  const legacy = siteFromLegacy(tanks);
  const devices = Array.isArray(doc.devices) ? normalizeDevices(doc.devices) : legacy;
  const levels = tanks.map((_, i) => {
    const v = Array.isArray(doc.levels) ? Number(doc.levels[i]) : NaN;
    return Number.isFinite(v) ? v : NaN;
  });
  return { tanks, active, devices, levels };
}

export function loadState(): AppState {
  const saved = read<Partial<AppState>>(KEY);
  const site = normalizeSite((saved ?? {}) as SiteDoc);
  return {
    project: site.tanks[site.active],
    tanks: site.tanks,
    active: site.active,
    levels: site.levels,
    devices: site.devices,
    view: { ...defaultView(), ...(saved?.view ?? {}) },
    sim: { ...defaultSim(), ...(saved?.sim ?? {}), direction: 0 },
    selected: null,
    exportPrefs: normalizeExportPrefs(saved?.exportPrefs),
  };
}

/** Levels of every tank, with the one being edited at its current level. */
export function siteLevels(s: AppState): number[] {
  return s.tanks.map((_, i) => (i === s.active ? s.sim.level : (s.levels[i] ?? NaN)));
}

export function saveState(s: AppState): void {
  write(KEY, { tanks: s.tanks, active: s.active, levels: siteLevels(s), devices: s.devices, view: s.view, sim: { ...s.sim, direction: 0 }, exportPrefs: s.exportPrefs });
}

export interface LibraryEntry {
  name: string;
  saved: string;
  project: Project;
}

export function readLibrary(): LibraryEntry[] {
  const list = read<LibraryEntry[]>(LIB);
  return Array.isArray(list) ? list : [];
}

export function saveToLibrary(project: Project): boolean {
  const list = readLibrary().filter((e) => e.name !== project.name);
  list.unshift({ name: project.name, saved: new Date().toISOString(), project: structuredClone(project) });
  return write(LIB, list.slice(0, 50));
}

export function removeFromLibrary(name: string): void {
  write(
    LIB,
    readLibrary().filter((e) => e.name !== name),
  );
}

export function readUi<T extends object>(fallback: T): T {
  return { ...fallback, ...(read<Partial<T>>(UI) ?? {}) };
}

export function writeUi(v: object): void {
  write(UI, v);
}

export interface OpenedFile {
  /** The tank that was being edited. */
  project: Project;
  /** Every tank on the site (just the project for a file of one tank). */
  tanks: Project[];
  active: number;
  levels: number[];
  /** Devices of the site; missing in files of one tank saved before sites. */
  devices: SiteDevice[] | null;
  view?: ViewState;
  sim?: Partial<SimState>;
  exportPrefs?: Partial<ExportPrefs>;
}

/** Accepts a project file (*.tank.json), an older project export, or a Tanker Time JSON export. */
export function parseProjectDoc(text: string): OpenedFile {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const p = doc && typeof doc === 'object' && 'project' in doc ? doc.project : doc;
  if (!p || typeof p !== 'object' || !p.tank) throw new Error('This file does not contain a Tanker Time tank.');
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as any) : undefined);
  const site = normalizeSite({ tanks: doc.tanks, project: p, active: doc.active, devices: doc.devices, levels: doc.levels });
  const hasSite = Array.isArray(doc.devices) || Array.isArray(doc.tanks) || !!(p as Project).cloud?.devices;
  return {
    project: site.tanks[site.active],
    tanks: site.tanks,
    active: site.active,
    levels: site.levels,
    devices: hasSite ? site.devices : null,
    view: obj(doc.view) ? { ...defaultView(), ...doc.view } : undefined,
    sim: obj(doc.sim),
    exportPrefs: obj(doc.exportPrefs),
  };
}

export function parseProjectFile(text: string): Project {
  return parseProjectDoc(text).project;
}

export { defaultSim, defaultView };
