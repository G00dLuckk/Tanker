import type { TableMode } from '../core/calibration';
import type { Project, SimState, SiteDevice, ViewState } from '../core/types';
import type { LengthUnit, VolumeUnit } from '../core/units';

export type ExportTab = 'config' | 'payload' | 'table';

export interface ExportPrefs {
  tab: ExportTab;
  source: string;
  input: 'measure' | 'signal' | 'adc';
  mode: TableMode;
  /** mm */
  step: number;
  rows: number;
  /** litres */
  tolerance: number;
  lengthUnit: LengthUnit | 'auto';
  volumeUnit: VolumeUnit | 'auto';
  /** Variable type ids by unit (mm, %, L, kPa…); 0 or missing = not set. */
  csVarIds: Record<string, number>;
}

export interface AppState {
  /** The tank being edited: always tanks[active]. */
  project: Project;
  /** Every tank on the site, shown side by side in the 3D view. */
  tanks: Project[];
  active: number;
  /** Simulated level of each tank (mm), by position in tanks; NaN = not set yet. */
  levels: number[];
  /** Devices (DevEUIs) of the site and the sensor number each one is. */
  devices: SiteDevice[];
  view: ViewState;
  sim: SimState;
  selected: string | null;
  exportPrefs: ExportPrefs;
}

/**
 * What changed:
 * - tank / liquid / marks / sensors: inputs to the derived model
 * - structure: visible form fields change (re-render panels)
 * - sim: level, playback; view: 3D display; units; select; name
 * - site: tanks added, removed or switched, devices changed
 */
export type Change = 'tank' | 'liquid' | 'marks' | 'sensors' | 'structure' | 'sim' | 'view' | 'units' | 'select' | 'name' | 'project' | 'site';

type Listener = (changes: Set<Change>) => void;

export class Store {
  private listeners = new Set<Listener>();
  private pending = new Set<Change>();
  private scheduled = false;

  constructor(public state: AppState) {}

  get project(): Project {
    return this.state.project;
  }

  update(changes: Change | Change[], fn: (s: AppState) => void): void {
    fn(this.state);
    for (const c of Array.isArray(changes) ? changes : [changes]) this.pending.add(c);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Applies pending changes now (used by animation frames that need fresh state). */
  flush(): void {
    this.scheduled = false;
    if (!this.pending.size) return;
    const batch = new Set(this.pending);
    this.pending.clear();
    for (const l of this.listeners) l(batch);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
