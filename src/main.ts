import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles.css';

import { isDark, sensorColor, token } from './app/colors';
import { canPickFiles, pickOpenFile, pickSaveFile, writeFile, type FileHandle } from './app/fileio';
import { loadState, normalizeExportPrefs, normalizeProject, parseProjectDoc, readUi, saveState, siteLevels, writeUi, type OpenedFile } from './app/persist';
import { Store, type Change } from './app/store';
import { emptyProject, newId } from './core/defaults';
import { derive, type Derived } from './core/derive';
import { readSensor, type Reading } from './core/sensors';
import type { Project } from './core/types';
import { MM3_TO_L } from './core/units';
import { TankViewer, type SensorVisual, type SiteTank } from './three/viewer';
import { LevelChart } from './ui/chart';
import { download, h, icon } from './ui/dom';
import { ExportDialog } from './ui/exportDialog';
import { buildProjectFile, fileNameFor } from './export/projectFile';
import { GuideDialog } from './ui/guide';
import { FieldSet } from './ui/fields';
import { Gauge } from './ui/gauge';
import { buildHeader, type Header } from './ui/header';
import { PlanView } from './ui/planView';
import { Readouts } from './ui/readouts';
import { buildSensorPanel, setRemoveSensor } from './ui/sensorPanel';
import { buildStage, type Stage } from './ui/stage';
import { buildTankPanel, setSectionToggleHandler, type PanelCtx } from './ui/tankPanel';
import { TankBar } from './ui/tankBar';
import { toast } from './ui/toast';

type ThemeMode = 'system' | 'light' | 'dark';

interface UiPrefs {
  theme: ThemeMode;
  open: string[];
  /** Name of the project file last saved or opened, and whether the project changed since. */
  fileName: string | null;
  fileDirty: boolean;
}

const GEOMETRY: Change[] = ['tank', 'liquid', 'marks', 'sensors', 'project'];

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tank'
  );
}

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

class App {
  private store: Store;
  private d: Derived;
  private ctx: PanelCtx;
  private ui: UiPrefs;
  private open: Set<string>;
  private viewer: TankViewer;
  private stage: Stage;
  private configScroll: HTMLElement;
  private fs = new FieldSet();
  private plan: PlanView;
  private gauge: Gauge;
  private chart: LevelChart;
  private readouts: Readouts;
  private exportDlg: ExportDialog;
  private guide: GuideDialog;
  private header: Header;
  private fileHandle: FileHandle | null = null;
  private readings = new Map<string, Reading>();
  private saveTimer = 0;
  private last = performance.now();
  private noiseAt = 0;
  private levelFraction: number | null = null;
  private tankBar: TankBar;
  /** Derived models of the other tanks, rebuilt when a tank's settings change. */
  private siteCache = new WeakMap<Project, { sig: string; d: Derived }>();

  constructor(root: HTMLElement) {
    this.ui = readUi<UiPrefs>({ theme: 'system', open: ['shape', 'dims', 'sensors'], fileName: null, fileDirty: false });
    this.open = new Set(this.ui.open);
    this.applyTheme(this.ui.theme, false);

    this.store = new Store(loadState());
    this.d = this.safeDerive(this.store.project) ?? derive(emptyProject());
    this.store.state.sim.level = Math.min(this.store.state.sim.level, this.d.depth);
    this.ctx = { store: this.store, derived: () => this.d };

    const header = buildHeader(this.store, {
      loadProject: (p, msg) => this.loadProject(p, msg),
      newProject: () => {
        const p = emptyProject();
        p.name = 'New tank';
        this.loadProject(p, 'Started a blank tank');
      },
      saveFile: (as) => void this.saveFile(as),
      openFile: () => void this.openFile(),
      importProjectFile: (f) => this.importFile(f),
      openExport: () => this.exportDlg.open(),
      openGuide: () => this.guide.open(),
      cycleTheme: () => {
        const order: ThemeMode[] = ['system', 'light', 'dark'];
        const next = order[(order.indexOf(this.ui.theme) + 1) % order.length];
        this.applyTheme(next, true);
        return next;
      },
      themeIcon: () => (this.ui.theme === 'system' ? 'auto' : this.ui.theme === 'light' ? 'sun' : 'moon'),
    });

    this.stage = buildStage(this.ctx, {
      fit: (v) => this.viewer.fit(v),
      screenshot: () => download(`${slug(this.store.project.name)}-3d.png`, this.viewer.screenshot(), 'image/png'),
      setLevel: (mm) => this.setLevel(mm),
    });

    this.tankBar = new TankBar(this.store, {
      select: (i) => this.selectTank(i),
      add: (copy) => this.addTank(copy),
      remove: (i) => this.removeTank(i),
      showAll: () => this.viewer.fit('site'),
    });
    this.stage.el.append(this.tankBar.el);

    this.configScroll = h('div', { class: 'panel-scroll' });
    const config = h('aside', { class: 'panel panel-config', 'aria-label': 'Tank and sensor setup' }, this.configScroll);
    this.readouts = new Readouts(this.ctx, (id) => this.select(id));
    this.chart = new LevelChart(this.ctx);
    const exportCard = h(
      'section',
      { class: 'card card-cta' },
      h('div', { class: 'card-label' }, 'For your platform'),
      h('p', null, 'The configuration and payload scripts for every tank and sensor on the site, and the level-to-volume table of this tank.'),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', on: { click: () => this.exportDlg.open('config') } }, icon('doc', 17), 'Configuration'),
      h('button', { type: 'button', class: 'btn btn-block', on: { click: () => this.exportDlg.open('payload') } }, icon('doc', 17), 'Payload'),
      h('button', { type: 'button', class: 'btn btn-block', on: { click: () => this.exportDlg.open('table') } }, icon('doc', 17), 'Table'),
    );
    const live = h('aside', { class: 'panel panel-live', 'aria-label': 'Readings' }, h('div', { class: 'panel-scroll' }, this.readouts.el, this.chart.el, exportCard));

    this.header = header;
    root.append(h('div', { class: 'app' }, header.el, h('main', { class: 'workspace' }, config, this.stage.el, live)));

    this.plan = new PlanView(this.ctx, (id) => this.select(id));
    this.gauge = new Gauge(this.ctx, (mm) => this.setLevel(mm));
    this.stage.gaugeHost.append(this.gauge.el);
    this.exportDlg = new ExportDialog(this.ctx);
    this.guide = new GuideDialog(this.ctx, {
      goTo: (id) => this.goToSection(id),
      openExport: () => this.exportDlg.open(),
      save: () => void this.saveFile(false),
      fileName: () => this.ui.fileName,
      dirty: () => this.ui.fileDirty,
    });
    this.updateFileStatus();
    this.installFileShortcuts();

    this.viewer = new TankViewer(this.stage.viewport);
    this.viewer.onSelectSensor = (id) => this.select(id);
    this.viewer.onSelectTank = (i) => this.selectTank(i);
    this.viewer.setUnit(this.store.project.units.length);
    this.viewer.setView(this.store.state.view);
    this.viewer.setTheme(this.viewerTheme());
    this.viewer.setSite(this.siteTanks(), this.store.state.active);
    this.viewer.setTank(this.d, this.visuals(), this.store.state.sim.level, true);

    setRemoveSensor((id) => this.removeSensor(id));
    setSectionToggleHandler(() => this.saveUi());

    this.renderConfig();
    this.readouts.rebuild();
    this.chart.rebuild();
    this.updateLive();
    this.updateBanner();

    this.store.subscribe((c) => this.onChange(c));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.ui.theme === 'system') this.onThemeChange();
    });
    requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------------------

  private safeDerive(p: Project): Derived | null {
    try {
      return derive(p);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  private visuals(): SensorVisual[] {
    return this.d.geoms.map((geom) => ({ geom, color: sensorColor(geom.sensor) }));
  }

  /** Derived model of a tank of the site (the one being edited uses the live one). */
  private derivedOf(p: Project): Derived | null {
    if (p === this.store.project) return this.d;
    const sig = JSON.stringify([p.tank, p.liquid]);
    const hit = this.siteCache.get(p);
    if (hit && hit.sig === sig) return hit.d;
    const d = this.safeDerive(p);
    if (d) this.siteCache.set(p, { sig, d });
    return d;
  }

  /** Every tank of the site for the 3D view, with its simulated level. */
  private siteTanks(): SiteTank[] {
    const st = this.store.state;
    const levels = siteLevels(st);
    const out: SiteTank[] = [];
    st.tanks.forEach((p, i) => {
      const d = this.derivedOf(p) ?? derive(emptyProject());
      out.push({ key: i === st.active ? 'active' : JSON.stringify([p.tank, p.liquid]), d, name: p.name, level: levels[i] });
    });
    return out;
  }

  /** Edits another tank of the site. */
  private selectTank(i: number) {
    const st = this.store.state;
    if (i === st.active || !st.tanks[i]) return;
    st.levels[st.active] = st.sim.level;
    const level = st.levels[i];
    this.levelFraction = Number.isFinite(level) ? null : 0.62;
    this.store.update(['project', 'structure', 'units', 'name', 'site'], (s) => {
      s.active = i;
      s.project = s.tanks[i];
      s.selected = null;
      s.sim.direction = 0;
      if (Number.isFinite(level)) s.sim.level = level;
    });
  }

  /** A name not used by another tank of the site. */
  private freeName(base: string): string {
    const names = new Set(this.store.state.tanks.map((p) => p.name));
    if (!names.has(base)) return base;
    const stem = base.replace(/\s*\(\d+\)$/, '');
    let n = 2;
    while (names.has(`${stem} (${n})`)) n++;
    return `${stem} (${n})`;
  }

  /** Adds a tank to the site, a copy of the one being edited or a blank one, and edits it. */
  private addTank(copy: boolean) {
    const st = this.store.state;
    const from = st.project.name;
    let p: Project;
    if (copy) {
      p = structuredClone(st.project);
      // The copy's sensors are new sensors: they get their own ids and the next free numbers.
      for (const s of p.sensors) {
        s.id = newId();
        delete s.number;
      }
      p.name = this.freeName(st.project.name);
    } else {
      p = emptyProject();
      p.units = { ...st.project.units };
      p.name = this.freeName(`Tank ${st.tanks.length + 1}`);
    }
    st.tanks.push(p);
    st.levels.push(NaN);
    this.markDirty();
    this.selectTank(st.tanks.length - 1);
    toast(copy ? `Added ${p.name}, a copy of ${from}` : `Added ${p.name}`);
  }

  /** Removes a tank from the site (undo brings it back). */
  private removeTank(i: number) {
    const st = this.store.state;
    if (st.tanks.length < 2 || !st.tanks[i]) return;
    st.levels[st.active] = st.sim.level;
    const removed = st.tanks[i];
    const removedLevel = st.levels[i];
    const next = i === st.active ? Math.max(0, i - 1) : st.active > i ? st.active - 1 : st.active;
    const level = st.levels.filter((_, j) => j !== i)[next];
    this.levelFraction = Number.isFinite(level) ? null : 0.62;
    this.store.update(['project', 'structure', 'units', 'name', 'site'], (s) => {
      s.tanks.splice(i, 1);
      s.levels.splice(i, 1);
      s.active = next;
      s.project = s.tanks[next];
      s.selected = null;
      s.sim.direction = 0;
      if (Number.isFinite(s.levels[next])) s.sim.level = s.levels[next];
    });
    this.markDirty();
    toast(`Removed ${removed.name} from the site`, {
      label: 'Undo',
      run: () => {
        const s = this.store.state;
        s.levels[s.active] = s.sim.level;
        s.tanks.splice(i, 0, removed);
        s.levels.splice(i, 0, removedLevel);
        if (s.active >= i) s.active += 1;
        this.selectTank(i);
      },
    });
  }

  private viewerTheme() {
    return { dark: isDark(), grid: token('--grid-3d') || '#d4dde2', gridMajor: token('--grid-3d-major') || '#9fb3bf' };
  }

  private onChange(c: Set<Change>) {
    const st = this.store.state;
    if (!c.has('project') && (['tank', 'liquid', 'marks', 'sensors', 'name', 'units', 'site'] as Change[]).some((k) => c.has(k))) this.markDirty();
    if (c.has('name') || c.has('project')) this.updateFileStatus();
    const geometry = GEOMETRY.some((k) => c.has(k));
    if (geometry) {
      const prevSize = this.d.model.size;
      const prevOrientation = this.d.model.orientation;
      const next = this.safeDerive(st.project);
      if (next) this.d = next;
      if (this.levelFraction !== null) {
        st.sim.level = this.d.depth * this.levelFraction;
        this.levelFraction = null;
      }
      st.sim.level = Math.min(Math.max(st.sim.level, 0), this.d.depth);
      const tankChanged = c.has('tank') || c.has('project');
      if (tankChanged || c.has('site') || c.has('liquid')) this.viewer.setSite(this.siteTanks(), st.active);
      if (tankChanged) {
        const ratio = this.d.model.size / prevSize;
        const refit = c.has('project') || ratio > 1.12 || ratio < 0.75 || prevOrientation !== this.d.model.orientation;
        this.viewer.setTank(this.d, this.visuals(), st.sim.level, refit);
      } else if (c.has('sensors') || c.has('liquid')) {
        this.viewer.updateDerived(this.d);
        this.viewer.setSensors(this.visuals());
      }
      if (c.has('sensors') || c.has('project')) this.readouts.rebuild();
      this.chart.rebuild();
      this.updateBanner();
      this.exportDlg.refresh();
      this.guide.refresh();
    }
    if (c.has('site') || c.has('project') || c.has('name')) this.tankBar.render();
    if (c.has('name') && !c.has('project')) this.viewer.setSite(this.siteTanks(), st.active);
    if (c.has('site') && !geometry) this.exportDlg.refresh();
    if (c.has('structure') || c.has('project') || c.has('select')) this.renderConfig();
    else if (geometry || c.has('units') || c.has('name')) {
      this.fs.refresh();
      this.plan.draw();
    }
    if (c.has('select')) {
      this.viewer.setSelected(st.selected);
      this.plan.draw();
    }
    if (c.has('units')) {
      this.viewer.setUnit(this.store.project.units.length);
      this.chart.rebuild();
      this.readouts.rebuild();
      this.exportDlg.refresh();
    }
    if (c.has('view')) this.viewer.setView(st.view);
    if (c.has('sim') || geometry) this.viewer.setLevel(st.sim.level);
    this.updateLive();
    this.scheduleSave();
  }

  private updateLive() {
    const st = this.store.state;
    const level = st.sim.level;
    const noisy = st.sim.noise;
    this.readings.clear();
    for (const g of this.d.geoms) this.readings.set(g.sensor.id, readSensor(g, level, this.d.density, noisy ? gaussian() : null));
    this.readouts.update(level, this.readings);
    this.viewer.setReadings(this.readings);
    this.gauge.draw();
    this.chart.setLevel(level);
    this.stage.refresh();
  }

  private updateBanner() {
    const msgs = [...this.d.problems];
    this.stage.banner.hidden = !msgs.length;
    this.stage.banner.textContent = msgs.join(' ');
  }

  private renderConfig() {
    const scroll = this.configScroll.scrollTop;
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    this.fs = new FieldSet();
    const tank = buildTankPanel(this.ctx, this.fs, this.open);
    const sensors = buildSensorPanel(this.ctx, this.fs, this.open, this.plan, (id) => this.select(id));
    this.configScroll.replaceChildren(tank, sensors);
    this.fs.refresh();
    this.configScroll.scrollTop = scroll;
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el && this.configScroll.contains(el)) el.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => this.plan.draw());
  }

  private select(id: string | null) {
    if (this.store.state.selected === id) return;
    this.store.update('select', (s) => (s.selected = id));
    if (id) {
      this.open.add('sensors');
      requestAnimationFrame(() => {
        const card = this.configScroll.querySelector(`[data-id="${id}"]`);
        card?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      });
    }
  }

  private setLevel(mm: number) {
    const depth = this.d.depth;
    this.store.update('sim', (s) => (s.sim.level = Math.min(Math.max(mm, 0), depth)));
  }

  /**
   * Opens a tank in place of the one being edited (library, examples, new blank tank),
   * or a whole site from a project file.
   */
  private loadProject(p: Project, message: string, file?: { name: string; handle: FileHandle | null; doc: OpenedFile }) {
    const st = this.store.state;
    const prevSite = { tanks: [...st.tanks], active: st.active, levels: siteLevels(st), devices: [...st.devices] };
    const prev = structuredClone(this.store.project);
    const prevLevel = this.store.state.sim.level;
    const prevFile = { name: this.ui.fileName, dirty: this.ui.fileDirty, handle: this.fileHandle };
    if (file) this.replaceSite(file.doc);
    else this.replaceProject(normalizeProject(p), 0.62);
    if (file) {
      const doc = file.doc;
      this.store.update(['sim', 'view'], (s) => {
        if (doc.view) s.view = { ...s.view, ...doc.view };
        if (doc.sim) {
          const sim = doc.sim;
          if (Number.isFinite(sim.level)) s.sim.level = sim.level as number;
          if (Number.isFinite(sim.flow)) s.sim.flow = sim.flow as number;
          if (Number.isFinite(sim.speed)) s.sim.speed = sim.speed as number;
          if (typeof sim.noise === 'boolean') s.sim.noise = sim.noise;
        }
        if (doc.exportPrefs) {
          // Variable type ids belong to the platform account: ids in the file add to the ones already set.
          const ids = { ...s.exportPrefs.csVarIds, ...(doc.exportPrefs.csVarIds ?? {}) };
          s.exportPrefs = normalizeExportPrefs({ ...s.exportPrefs, ...doc.exportPrefs, csVarIds: ids });
        }
      });
      this.setFile(file.name, file.handle, false);
    } else {
      this.setFile(null, null, true);
    }
    toast(message, {
      label: 'Undo',
      run: () => {
        if (file) this.replaceSite(prevSite);
        else this.replaceProject(prev, null);
        this.store.update('sim', (s) => (s.sim.level = prevLevel));
        this.setFile(prevFile.name, prevFile.handle, prevFile.dirty);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Project files

  private setFile(name: string | null, handle: FileHandle | null, dirty: boolean) {
    this.ui.fileName = name;
    this.ui.fileDirty = dirty;
    this.fileHandle = handle;
    this.updateFileStatus();
    this.saveUi();
  }

  private markDirty() {
    if (this.ui.fileDirty) return;
    this.ui.fileDirty = true;
    this.updateFileStatus();
  }

  private updateFileStatus() {
    this.header?.setFileStatus(this.ui.fileName, this.ui.fileDirty);
    document.title = `${this.ui.fileDirty && this.ui.fileName ? '• ' : ''}${this.store.project.name} · Tanker Time`;
  }

  private fileText(): string {
    const st = this.store.state;
    return buildProjectFile(st.project, this.d, {
      view: st.view,
      sim: st.sim,
      exportPrefs: st.exportPrefs,
      site: { tanks: st.tanks, active: st.active, levels: siteLevels(st), devices: st.devices },
    });
  }

  private async saveFile(saveAs: boolean) {
    const text = this.fileText();
    const suggested = this.ui.fileName ?? fileNameFor(this.store.project);
    try {
      if (canPickFiles()) {
        let handle = saveAs ? null : this.fileHandle;
        if (!handle) handle = await pickSaveFile(suggested);
        if (!handle) return;
        await writeFile(handle, text);
        this.setFile(handle.name, handle, false);
        toast(`Saved ${handle.name}`);
      } else {
        download(suggested, text, 'application/json');
        this.setFile(suggested, null, false);
        toast(`Downloaded ${suggested}. Your browser puts it in the Downloads folder.`);
      }
    } catch (err) {
      toast(`Could not save the file: ${(err as Error).message}`);
    }
  }

  private async openFile() {
    if (!canPickFiles()) {
      this.header.pickFile();
      return;
    }
    try {
      const picked = await pickOpenFile();
      if (picked) await this.importFile(picked.file, picked.handle);
    } catch (err) {
      toast(`Could not open the file: ${(err as Error).message}`);
    }
  }

  private installFileShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void this.saveFile(e.shiftKey);
      } else if (k === 'o' && !e.shiftKey) {
        e.preventDefault();
        void this.openFile();
      }
    });
    // Drop a project file anywhere on the page to open it.
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      document.body.classList.add('is-dropping');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) document.body.classList.remove('is-dropping');
    });
    window.addEventListener('drop', (e) => {
      document.body.classList.remove('is-dropping');
      if (!hasFiles(e)) return;
      e.preventDefault();
      const f = e.dataTransfer!.files[0];
      if (f) void this.importFile(f);
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.ui.fileName && this.ui.fileDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  private goToSection(id: string) {
    this.open.add(id);
    this.renderConfig();
    this.saveUi();
    requestAnimationFrame(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  /** Puts a tank in place of the one being edited. */
  private replaceProject(p: Project, levelFraction: number | null) {
    this.levelFraction = levelFraction;
    this.store.update(['project', 'structure', 'units', 'name', 'site'], (s) => {
      s.tanks[s.active] = p;
      s.project = p;
      s.selected = null;
      s.sim.direction = 0;
    });
  }

  /** Puts a whole site (tanks, levels, devices) in place of this one. */
  private replaceSite(doc: { tanks: Project[]; active: number; levels: number[]; devices: OpenedFile['devices'] }) {
    const level = doc.levels[doc.active];
    this.levelFraction = Number.isFinite(level) ? null : 0.62;
    this.store.update(['project', 'structure', 'units', 'name', 'site'], (s) => {
      s.tanks = doc.tanks;
      s.active = doc.active;
      s.levels = [...doc.levels];
      s.devices = doc.devices ?? [];
      s.project = s.tanks[s.active];
      s.selected = null;
      s.sim.direction = 0;
      if (Number.isFinite(level)) s.sim.level = level;
    });
  }

  private async importFile(f: File, handle: FileHandle | null = null) {
    try {
      const doc = parseProjectDoc(await f.text());
      this.loadProject(doc.project, `Opened ${f.name}`, { name: f.name, handle, doc });
    } catch (err) {
      toast(`Could not read ${f.name}: ${(err as Error).message}`);
    }
  }

  private removeSensor(id: string) {
    const list = this.store.project.sensors;
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const removed = list[idx];
    this.store.update(['sensors', 'structure'], (s) => {
      s.project.sensors.splice(idx, 1);
      if (s.selected === id) s.selected = null;
    });
    toast(`Removed ${removed.tag}`, {
      label: 'Undo',
      run: () => this.store.update(['sensors', 'structure'], (s) => s.project.sensors.splice(Math.min(idx, s.project.sensors.length), 0, removed)),
    });
  }

  private applyTheme(mode: ThemeMode, notify: boolean) {
    this.ui.theme = mode;
    if (mode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    if (notify) {
      this.saveUi();
      this.onThemeChange();
    }
  }

  private onThemeChange() {
    this.viewer.setTheme(this.viewerTheme());
    this.viewer.setSensors(this.visuals());
    this.chart.rebuild();
    this.readouts.rebuild();
    this.renderConfig();
    this.updateLive();
  }

  private saveUi() {
    this.ui.open = [...this.open];
    writeUi(this.ui);
    this.updateFileStatus();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveState(this.store.state);
      this.saveUi();
    }, 400);
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    // Follow real time even when frames are slow (software rendering), within reason.
    const dt = Math.min(0.5, (now - this.last) / 1000);
    this.last = now;
    const s = this.store.state.sim;
    if (s.direction !== 0 && s.flow > 0) {
      const e = this.d.engine;
      const marks = this.store.project.marks;
      const v = e.volume(s.level) + s.direction * (s.flow / 60) * dt * s.speed * 1e6;
      let limit: number;
      let what: string;
      if (s.direction > 0) {
        const useOvf = marks.overflow !== null && s.level < marks.overflow - 1e-6;
        limit = useOvf ? Math.min(marks.overflow as number, e.depth) : e.depth;
        what = useOvf ? 'Reached the overflow level' : 'The tank is full';
      } else {
        const useOut = marks.outlet !== null && s.level > marks.outlet + 1e-6;
        limit = useOut ? Math.max(marks.outlet as number, 0) : 0;
        what = useOut ? 'Reached the outlet: the rest cannot drain' : 'The tank is empty';
      }
      let level = e.levelOf(Math.min(Math.max(v, 0), e.total));
      let stop = false;
      if ((s.direction > 0 && level >= limit) || (s.direction < 0 && level <= limit)) {
        level = limit;
        stop = true;
      }
      this.store.update('sim', (st) => {
        st.sim.level = level;
        if (stop) st.sim.direction = 0;
      });
      if (stop) toast(`${what} (${(e.volume(level) * MM3_TO_L).toFixed(1)} L)`);
    } else if (s.noise && now - this.noiseAt > 250) {
      this.noiseAt = now;
      this.updateLive();
    }
  };
}

const app = new App(document.getElementById('app')!);
// Development hook for automated checks; stripped from production builds.
if (import.meta.env.DEV) (window as unknown as { __tankerTime: App }).__tankerTime = app;
