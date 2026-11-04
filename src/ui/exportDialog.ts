import type { AppState, ExportPrefs, ExportTab } from '../app/store';
import { derive, type Derived } from '../core/derive';
import { hasAdc, hasAnalog } from '../core/sensors';
import type { Project, SiteDevice } from '../core/types';
import { LENGTH, VOLUME, type LengthUnit, type VolumeUnit } from '../core/units';
import { DEFAULT_VAR_IDS, MAX_NUMBER, cloudStudioConfig, cloudStudioModel, cloudStudioPayload, isAddress, parseDeviceLines, type CsModel } from '../export/cloudstudio';
import { csv, tableView } from '../export/data';
import { collect, type ExportData } from '../export/shared';
import { copyText, download, h, icon } from './dom';
import { FieldSet, lengthField, numField, segmented, selectField, type Field } from './fields';
import type { PanelCtx } from './tankPanel';
import { toast } from './toast';

const TABS: { id: ExportTab; label: string; ext: string; mime: string }[] = [
  { id: 'config', label: 'Configuration', ext: '-configuration.js', mime: 'text/javascript' },
  { id: 'payload', label: 'Payload', ext: '-payload.js', mime: 'text/javascript' },
  { id: 'table', label: 'Table', ext: '-table.csv', mime: 'text/csv' },
];

/** The configuration and payload scripts share the site settings. */
function isScript(t: ExportTab): boolean {
  return t === 'config' || t === 'payload';
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tank'
  );
}

export class ExportDialog {
  private dlg: HTMLDialogElement;
  private options = h('div', { class: 'export-options' });
  private view = h('div', { class: 'export-view' });
  private meta = h('span', { class: 'export-meta' });
  private tabs: HTMLButtonElement[] = [];
  private fs = new FieldSet();
  private data: ExportData | null = null;
  private cs: CsModel | null = null;
  /** Sensor number given to pasted DevEUIs that do not carry one. */
  private pasteNumber: number | undefined = undefined;
  /** Derived models of the other tanks of the site. */
  private cache = new WeakMap<Project, { sig: string; d: Derived }>();
  /** Text in the paste box that is not a device yet (kept when the options are rebuilt). */
  private pasteText = '';
  private text = '';
  private timer = 0;
  /** Typing in the paste box or a device row: the scripts follow after a short pause. */
  private typingTimer = 0;
  /** The option fields are out of date (held back while typing in a device row). */
  private stale = false;

  constructor(private ctx: PanelCtx) {
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', on: { click: () => this.dlg.close() } }, icon('close', 18));
    const tabList = h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Output format' },
      TABS.map((t) => {
        const b = h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'tab',
            id: `tab-${t.id}`,
            'aria-controls': 'export-panel',
            on: { click: () => this.setTab(t.id) },
          },
          t.label,
        );
        this.tabs.push(b);
        return b;
      }),
    );
    tabList.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex((t) => t.id === this.prefs.tab);
      const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      this.setTab(TABS[n].id);
      this.tabs[n].focus();
    });
    const copyBtn = h('button', { type: 'button', class: 'btn', on: { click: () => this.copy() } }, icon('copy', 16), 'Copy');
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => this.save() } }, icon('download', 16), 'Download');
    this.view.id = 'export-panel';
    this.view.setAttribute('role', 'tabpanel');
    this.view.tabIndex = 0;
    this.dlg = h(
      'dialog',
      { class: 'export-dialog', 'aria-labelledby': 'export-title' },
      h(
        'div',
        { class: 'export-shell' },
        h(
          'header',
          { class: 'export-head' },
          h(
            'div',
            null,
            h('h2', { id: 'export-title' }, 'Scripts & table'),
            h('p', null, 'The configuration and payload scripts for every tank and sensor on the site, and the level-to-volume table of this tank.'),
          ),
          close,
        ),
        h(
          'div',
          { class: 'export-body' },
          this.options,
          h('section', { class: 'export-main' }, tabList, h('div', { class: 'export-toolbar' }, this.meta, h('div', { class: 'export-actions' }, copyBtn, dlBtn)), this.view),
        ),
      ),
    );
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
    // Options held back while typing in a device row are rebuilt once the focus leaves it.
    this.options.addEventListener('focusout', () =>
      window.setTimeout(() => {
        if (this.stale && this.dlg.open) this.buildOptions();
      }, 0),
    );
    document.body.appendChild(this.dlg);
  }

  /** True while the user types in a device row: rebuilding would replace the field under the caret. */
  private typingInDevice(): boolean {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && this.options.contains(a) && !!a.closest('.cs-device, .cs-entry');
  }

  private get prefs(): ExportPrefs {
    return this.ctx.store.state.exportPrefs;
  }

  open(tab?: ExportTab) {
    if (tab) this.prefs.tab = tab;
    const src = this.prefs.source;
    if (src !== 'level' && !this.ctx.store.project.sensors.some((s) => s.id === src)) this.prefs.source = 'level';
    this.buildOptions();
    this.regenerate();
    if (!this.dlg.open) this.dlg.showModal();
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  /** Called when the project changes while the dialog is open. */
  refresh() {
    if (!this.dlg.open) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.buildOptions();
      this.regenerate();
    }, 150);
  }

  private units(): { lu: LengthUnit; vu: VolumeUnit } {
    const p = this.prefs;
    const u = this.ctx.store.project.units;
    return { lu: p.lengthUnit === 'auto' ? u.length : p.lengthUnit, vu: p.volumeUnit === 'auto' ? u.volume : p.volumeUnit };
  }

  private buildOptions() {
    // The scripts still follow every keystroke; the option fields catch up when the field is left.
    if (this.typingInDevice()) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const ctx = this.ctx;
    const p = this.prefs;
    const st = ctx.store;
    this.fs = new FieldSet();
    const prefsChange = () => {
      this.buildOptions();
      this.regenerate();
    };
    // Option fields write export preferences and only regenerate the export.
    const local: PanelCtx = {
      derived: ctx.derived,
      store: {
        state: st.state,
        get project() {
          return st.project;
        },
        update: (_changes, fn) => {
          fn(st.state);
          prefsChange();
        },
      },
    };
    const fields: Field[] = [];
    const levelSensors = ctx.derived().geoms.filter((g) => g.ok && g.sensor.enabled && g.mount !== 'point');
    const cs = isScript(p.tab);
    if (!cs) fields.push(
      selectField(local, {
        id: 'ex-source',
        label: 'Table keyed by',
        options: () => [{ value: 'level', label: 'Level (strapping table)' }, ...levelSensors.map((g) => ({ value: g.sensor.id, label: `${g.sensor.tag} reading` }))],
        get: () => p.source,
        set: (v) => (p.source = v),
        change: [],
      }),
    );
    const src = levelSensors.find((g) => g.sensor.id === p.source);
    if (!cs && src && (hasAnalog(src.sensor) || hasAdc(src.sensor))) {
      const opts: { value: 'measure' | 'signal' | 'adc'; label: string }[] = [{ value: 'measure', label: 'Measurement' }, { value: 'signal', label: 'Signal' }];
      if (hasAdc(src.sensor)) opts.push({ value: 'adc', label: 'ADC' });
      fields.push(segmented(local, { id: 'ex-input', label: 'First column', options: opts, get: () => p.input, set: (v) => (p.input = v), change: [] }));
    }
    fields.push(
      segmented(local, {
        id: 'ex-mode',
        label: 'Rows',
        options: [
          { value: 'step', label: 'Every step' },
          { value: 'rows', label: 'Count' },
          { value: 'compact', label: 'Compact' },
        ],
        get: () => p.mode,
        set: (v) => (p.mode = v),
        change: [],
      }),
    );
    if (p.mode === 'step') {
      const lf = lengthField(local, { id: 'ex-step', label: 'Level step', min: 0.01, get: () => p.step, set: (v) => (p.step = v), change: [] });
      fields.push(lf);
    } else if (p.mode === 'rows') {
      fields.push(numField({ id: 'ex-rows', label: 'Intervals', unit: () => 'rows', get: () => p.rows, set: (v) => ((p.rows = Math.round(v)), prefsChange()), dp: () => 0, min: () => 1, max: () => 10000, step: () => 10 }));
    } else {
      const vu = this.units().vu;
      fields.push(
        numField({
          id: 'ex-tol',
          label: 'Largest error allowed',
          unit: () => VOLUME[vu].label,
          get: () => p.tolerance / VOLUME[vu].k,
          set: (v) => ((p.tolerance = Math.max(v, 1e-6) * VOLUME[vu].k), prefsChange()),
          dp: () => VOLUME[vu].dp + 2,
          min: () => 0.000001,
          step: () => 0.01,
        }),
      );
    }
    fields.push(
      selectField(local, {
        id: 'ex-lu',
        label: 'Length unit',
        options: () => [{ value: 'auto', label: `As in the app (${LENGTH[st.project.units.length].label})` }, ...(Object.keys(LENGTH) as LengthUnit[]).map((k) => ({ value: k, label: LENGTH[k].label }))],
        get: () => p.lengthUnit,
        set: (v) => (p.lengthUnit = v as LengthUnit | 'auto'),
        change: [],
      }),
      selectField(local, {
        id: 'ex-vu',
        label: 'Volume unit',
        options: () => [{ value: 'auto', label: `As in the app (${VOLUME[st.project.units.volume].label})` }, ...(Object.keys(VOLUME) as VolumeUnit[]).map((k) => ({ value: k, label: VOLUME[k].label }))],
        get: () => p.volumeUnit,
        set: (v) => (p.volumeUnit = v as VolumeUnit | 'auto'),
        change: [],
      }),
    );
    if (cs) fields.length = 0;
    fields.forEach((f) => this.fs.add(f));
    // Rebuilding replaces the inputs: keep the focus where the user is typing.
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active && this.options.contains(active) ? active.id : '';
    const caret = focusId && typeof active?.selectionStart === 'number' ? active.selectionStart : null;
    this.options.replaceChildren(
      ...(cs
        ? [this.cloudOptions()]
        : [
            h('div', { class: 'field-grid one' }, fields.map((f) => f.el)),
            h('p', { class: 'panel-note' }, 'The level-to-volume table of the tank you are editing. Step tables are exact at each row; compact tables keep the fewest rows that stay within the error you allow.'),
          ]),
    );
    if (focusId) {
      const el = document.getElementById(focusId) as HTMLInputElement | null;
      if (el) {
        el.focus();
        if (caret !== null && typeof el.setSelectionRange === 'function') {
          try {
            el.setSelectionRange(caret, caret);
          } catch {
            // Selection is not supported on this input type.
          }
        }
      }
    }
  }

  /**
   * Changes the site's devices or a sensor number (saved with the site). The numbers the
   * scripts gave are kept on the sensors first, so no sensor moves when another one does.
   */
  private editSite(fn: (s: AppState) => void) {
    const entries = this.cs?.entries ?? [];
    this.ctx.store.update(['site'], (s) => {
      for (const e of entries) {
        const sensor = s.tanks[e.tankIndex]?.sensors.find((x) => x.id === e.sensorId);
        if (sensor) sensor.number = e.number;
      }
      fn(s);
    });
  }

  /** Derived model of a tank of the site (the one being edited uses the live one). */
  private derivedOf(p: Project): Derived {
    if (p === this.ctx.store.project) return this.ctx.derived();
    const sig = JSON.stringify([p.tank, p.liquid, p.sensors]);
    const hit = this.cache.get(p);
    if (hit && hit.sig === sig) return hit.d;
    const d = derive(p);
    this.cache.set(p, { sig, d });
    return d;
  }

  /** Site settings: the numbered sensors of every tank, the devices and the variable type ids. */
  private cloudOptions(): HTMLElement {
    const st = this.ctx.store;
    const p = this.prefs;
    const cs = this.cs;
    const entries = cs?.entries ?? [];
    const els: HTMLElement[] = [
      h('div', { class: 'cs-heading' }, `Sensors (${entries.length})`),
      h(
        'p',
        { class: 'panel-note' },
        'Every ultrasonic, radar or laser sensor of every tank on the site, with its number: a device with number 3 gets the endpoints 31, 32 and 33. The payload script works out from each uplink which sensor model sent it.',
      ),
    ];

    // Sensor numbers.
    const list = h('div', { class: 'cs-entries' });
    for (const e of entries) {
      const num = h('input', {
        type: 'number',
        class: 'text-input cs-num',
        id: `cs-no-${e.tankIndex}-${e.sensorId}`,
        min: '1',
        max: String(MAX_NUMBER),
        step: '1',
        inputmode: 'numeric',
        'aria-label': `Number of ${e.name}`,
      });
      num.value = String(e.number);
      const commit = () => {
        const n = Math.round(Number(num.value));
        if (!(n >= 1 && n <= MAX_NUMBER)) {
          num.value = String(e.number);
          return;
        }
        if (n === e.number) return;
        this.editSite((s) => {
          const sensor = s.tanks[e.tankIndex]?.sensors.find((x) => x.id === e.sensorId);
          if (!sensor) return;
          // A number already taken: the other sensor swaps to this one's number.
          const other = entries.find((x) => x.number === n);
          if (other) {
            const os = s.tanks[other.tankIndex]?.sensors.find((x) => x.id === other.sensorId);
            if (os) os.number = e.number;
          }
          sensor.number = n;
          // Devices follow their sensor.
          for (const d of s.devices) {
            if (d.number === e.number) d.number = n;
            else if (other && d.number === n) d.number = e.number;
          }
        });
      };
      // The scripts follow a short pause in typing; leaving the field commits at once.
      num.addEventListener('input', () => {
        clearTimeout(this.typingTimer);
        this.typingTimer = window.setTimeout(() => {
          // A number of another sensor may be on the way to a longer one (2 → 21): swap only when the field is left.
          const n = Math.round(Number(num.value));
          if (num.value.trim() && !entries.some((x) => x !== e && x.number === n)) commit();
        }, 400);
      });
      num.addEventListener('change', () => {
        clearTimeout(this.typingTimer);
        commit();
      });
      num.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
      });
      const count = cs?.devices.filter((d) => d.number === e.number).length ?? 0;
      list.append(
        h(
          'div',
          { class: 'cs-entry' },
          num,
          h(
            'div',
            { class: 'cs-entry-text' },
            h('span', { class: 'cs-entry-name' }, e.name),
            h('span', { class: 'cs-entry-sub' }, `${e.kind} ${e.tag} · ${e.shape === 'table' ? 'volume from a table' : e.shape} · ${count} device${count === 1 ? '' : 's'}`),
          ),
        ),
      );
    }
    if (entries.length) els.push(list);
    else els.push(h('p', { class: 'panel-note note-warn' }, 'No tank on the site has an ultrasonic, radar or laser sensor on its roof yet. Add one in the Sensors section.'));

    // Devices.
    const devices = st.state.devices;
    els.push(h('div', { class: 'cs-heading' }, `Devices (${devices.length})`));
    const options = (sel: HTMLSelectElement, value: number | undefined, empty: string) => {
      sel.append(h('option', { value: '' }, empty));
      for (const e of entries) sel.append(h('option', { value: String(e.number) }, `${e.number} · ${e.name}`));
      if (value !== undefined && !entries.some((e) => e.number === value)) sel.append(h('option', { value: String(value) }, `${value} · no such sensor`));
      sel.value = value === undefined ? '' : String(value);
    };
    const pasteNo = h('select', { class: 'select', id: 'cs-paste-no', 'aria-label': 'Sensor number of the pasted devices' });
    options(pasteNo, this.pasteNumber, 'The next sensor without a device');
    pasteNo.addEventListener('change', () => (this.pasteNumber = pasteNo.value ? Number(pasteNo.value) : undefined));
    const paste = h('textarea', {
      class: 'text-input cs-paste',
      id: 'cs-paste',
      rows: 3,
      spellcheck: 'false',
      placeholder: 'A84041F359618158\nA840411AFA618156, 2\n866207058378443, 3',
    });
    paste.value = this.pasteText;
    /**
     * Adds pasted DevEUIs / IMEIs to the site, each with a sensor number at once: the number on
     * its line, else the one chosen below the box, else the next sensor that has no device yet.
     */
    const addRows = (rows: { address: string; number?: number }[], rest: string) => {
      const have = new Set(st.state.devices.map((d) => d.address));
      const fresh = rows.filter((r) => !have.has(r.address));
      this.pasteText = rest;
      paste.value = rest;
      const fallback = this.pasteNumber;
      this.editSite((s) => {
        const used = new Set(s.devices.map((d) => d.number));
        for (const r of fresh) {
          const number = r.number ?? fallback ?? entries.find((e) => !used.has(e.number))?.number ?? entries[0]?.number;
          used.add(number);
          s.devices.push(number ? { address: r.address, number } : { address: r.address });
        }
      });
      toast(fresh.length === rows.length ? `Added ${fresh.length} device${fresh.length === 1 ? '' : 's'}` : `Added ${fresh.length}; ${rows.length - fresh.length} already listed`);
    };
    const complete = isAddress;
    /**
     * Adds the lines that hold full DevEUIs and leaves the rest in the box. While typing,
     * the last line is only taken when it is just an address (a number may still be coming).
     */
    const take = (typing: boolean) => {
      const lines = paste.value.split(/\r?\n/);
      const rows: { address: string; number?: number }[] = [];
      const keep: string[] = [];
      lines.forEach((line, i) => {
        const r = parseDeviceLines(line);
        const last = i === lines.length - 1;
        const ok = r.length > 0 && r.every((x) => complete(x.address)) && !(typing && last && /[,;\t]\s*$|[,;\t]\s*\d*$/.test(line));
        if (ok) rows.push(...r);
        else if (line.trim() || (typing && last)) keep.push(line);
      });
      if (rows.length) addRows(rows, keep.join('\n'));
    };
    paste.addEventListener('input', (e) => {
      this.pasteText = paste.value;
      clearTimeout(this.typingTimer);
      if ((e as InputEvent).inputType === 'insertFromPaste') take(false);
      else this.typingTimer = window.setTimeout(() => take(true), 700);
    });
    paste.addEventListener('change', () => {
      clearTimeout(this.typingTimer);
      take(false);
    });
    els.push(
      h(
        'div',
        { class: 'cs-paste-box' },
        h('label', { class: 'field-label', for: 'cs-paste' }, 'Paste or type DevEUIs (LoRaWAN) or IMEIs (SIM card / TCP), one per line, with the sensor number after a comma if you like. They go into the scripts as soon as they are complete.'),
        paste,
        h('label', { class: 'field-label', for: 'cs-paste-no' }, 'Sensor number for lines without one'),
        h('div', { class: 'select-wrap' }, pasteNo, icon('chevron', 16)),
      ),
    );

    const rows = h('div', { class: 'cs-devices' });
    devices.forEach((d, i) => {
      const edit = (fn: (x: SiteDevice) => void) =>
        this.editSite((s) => {
          const x = s.devices[i];
          if (x) fn(x);
        });
      const addr = h('input', { type: 'text', class: 'text-input cs-addr', id: `cs-dev-${i}-addr`, spellcheck: 'false', autocomplete: 'off', 'aria-label': `Device ${i + 1} DevEUI or IMEI` });
      addr.value = d.address;
      const setAddr = (x: SiteDevice) => (x.address = addr.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase());
      addr.addEventListener('input', () => {
        clearTimeout(this.typingTimer);
        this.typingTimer = window.setTimeout(() => edit(setAddr), 300);
      });
      addr.addEventListener('change', () => {
        clearTimeout(this.typingTimer);
        edit(setAddr);
      });
      const no = h('select', { class: 'select', id: `cs-dev-${i}-no`, 'aria-label': `Device ${i + 1} sensor number` });
      options(no, d.number, 'Choose the sensor…');
      no.addEventListener('change', () =>
        edit((x) => {
          if (no.value) x.number = Number(no.value);
          else delete x.number;
        }),
      );
      const remove = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove device ${i + 1}`, on: { click: () => this.editSite((s) => s.devices.splice(i, 1)) } }, icon('close', 16));
      rows.append(h('div', { class: 'cs-device' }, h('div', { class: 'cs-device-line' }, addr, remove), h('div', { class: 'select-wrap' }, no, icon('chevron', 16))));
    });
    if (devices.length) els.push(rows);
    else els.push(h('p', { class: 'panel-note' }, 'No devices yet. Paste the DevEUIs or IMEIs above.'));

    // Variable type ids: one per unit, kept for every project in this browser.
    const units: [string, string][] = [
      ['mm', 'Length (mm)'],
      ['%', 'Fill (%)'],
      ['L', 'Volume (L)'],
    ];
    const vf: Field[] = units.map(([u, label]) =>
      numField({
        id: `cs-var-${u.replace(/[^a-z0-9]/gi, '_')}`,
        label,
        unit: () => 'id',
        hint: 'Variable type id from the platform (Configuration → Variable types). 0 = not set.',
        get: () => p.csVarIds[u] ?? DEFAULT_VAR_IDS[u] ?? 0,
        set: (v) => {
          p.csVarIds[u] = Math.max(0, Math.round(v));
          this.regenerate();
        },
        dp: () => 0,
        min: () => 0,
      }),
    );
    vf.forEach((f) => this.fs.add(f));
    els.push(h('div', { class: 'cs-heading' }, 'Variable type ids'), h('div', { class: 'field-grid two' }, vf.map((f) => f.el)));
    if (cs && !(cs.varIds['%'] > 0 && cs.varIds.L > 0)) {
      els.push(h('p', { class: 'panel-note note-warn' }, 'Without a % id the Fill level endpoint is not made; without an L id the Volume endpoint is not made.'));
    }

    for (const w of cs?.warnings ?? []) els.push(h('p', { class: 'panel-note note-warn' }, w));
    return h('div', { class: 'cs-options' }, els);
  }

  private regenerate() {
    const ctx = this.ctx;
    const p = this.prefs;
    const { lu, vu } = this.units();
    const table = { mode: p.mode, step: Math.max(p.step, 0.01), rows: p.rows, tolerance: p.tolerance };
    const opt = { source: p.source, input: p.input, table, lengthUnit: lu, volumeUnit: vu, pressureUnit: ctx.store.project.units.pressure };
    try {
      this.data = collect(ctx.store.project, ctx.derived(), opt);
      if (isScript(p.tab)) {
        // Every tank of the site, in mm: the scripts work in mm and litres.
        const st = ctx.store.state;
        const eds = st.tanks.map((t) => collect(t, this.derivedOf(t), { ...opt, source: 'level', lengthUnit: 'mm', volumeUnit: 'L' }));
        const sig = (m: CsModel | null) => (m ? JSON.stringify([m.warnings, m.entries.map((e) => [e.number, e.name, e.shape]), m.devices, m.varIds]) : '');
        const before = sig(this.cs);
        this.cs = cloudStudioModel(eds, p.csVarIds, st.devices);
        // Sensors, warnings and device counts are shown with the options: rebuild them when they change.
        if (before !== sig(this.cs)) this.buildOptions();
      }
    } catch (err) {
      this.data = null;
      this.view.replaceChildren(h('p', { class: 'panel-note note-error' }, `Could not build the export: ${(err as Error).message}`));
      return;
    }
    this.renderTab();
  }

  private setTab(t: ExportTab) {
    const options = isScript(t) !== isScript(this.prefs.tab);
    this.prefs.tab = t;
    if (options) {
      this.buildOptions();
      this.regenerate();
    } else this.renderTab();
  }

  private renderTab() {
    const ed = this.data;
    if (!ed) return;
    const tab = this.prefs.tab;
    TABS.forEach((t, i) => {
      this.tabs[i].setAttribute('aria-selected', String(t.id === tab));
      this.tabs[i].tabIndex = t.id === tab ? 0 : -1;
    });
    this.view.setAttribute('aria-labelledby', `tab-${tab}`);
    if (tab === 'table') {
      const t = tableView(ed);
      this.text = csv(ed);
      const max = 3000;
      const rows = t.rows.slice(0, max);
      const more = t.rows.length > max ? h('p', { class: 'panel-note' }, `Showing the first ${max} of ${t.rows.length} rows. Download or copy for all of them.`) : '';
      this.view.replaceChildren(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data-table' },
            h('caption', null, t.title),
            h('thead', null, h('tr', null, t.columns.map((c) => h('th', { scope: 'col' }, c)))),
            h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))),
          ),
        ),
        more,
      );
      this.meta.textContent = `${t.rows.length} rows`;
      return;
    }
    this.text = this.cs ? (tab === 'config' ? cloudStudioConfig(this.cs) : cloudStudioPayload(this.cs)) : '';
    const code = h('code', null, this.text);
    this.view.replaceChildren(h('pre', { class: `code code-${tab}` }, code));
    const lines = this.text.split('\n').length - 1;
    const kb = new Blob([this.text]).size / 1024;
    const n = this.cs?.entries.length ?? 0;
    const tanks = new Set(this.cs?.entries.map((e) => e.tankIndex)).size;
    this.meta.textContent = `${tanks} tank${tanks === 1 ? '' : 's'} · ${n} sensor${n === 1 ? '' : 's'} · ${lines} lines · ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
  }

  /** Runs a pending update now, so Copy and Download right after typing get the latest script. */
  private flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.buildOptions();
    }
    this.regenerate();
  }

  private async copy() {
    this.flush();
    const pre = this.view.querySelector('pre') as HTMLElement | null;
    const ok = await copyText(this.text, pre ?? undefined);
    toast(ok ? 'Copied to the clipboard' : 'Text selected: press Ctrl+C to copy');
  }

  private save() {
    this.flush();
    const tab = TABS.find((t) => t.id === this.prefs.tab)!;
    const name = isScript(tab.id) && this.ctx.store.state.tanks.length > 1 ? 'site' : this.ctx.store.project.name;
    download(`${slug(name)}${tab.ext}`, this.text, tab.mime);
  }
}

