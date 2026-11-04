import { readLibrary, removeFromLibrary, saveToLibrary } from '../app/persist';
import type { Store } from '../app/store';
import { PRESETS, PRESET_GROUPS } from '../core/presets';
import type { Project } from '../core/types';
import { FLOW, LENGTH, PRESSURE, VOLUME, type FlowUnit, type LengthUnit, type PressureUnit, type VolumeUnit } from '../core/units';
import { h, icon } from './dom';
import { toast } from './toast';

export interface HeaderActions {
  loadProject(p: Project, message: string): void;
  newProject(): void;
  /** Save the project file; saveAs asks for a new name / place. */
  saveFile(saveAs: boolean): void;
  /** Open a project file (file picker). */
  openFile(): void;
  importProjectFile(file: File): void;
  openExport(): void;
  openGuide(): void;
  cycleTheme(): string;
  themeIcon(): string;
}

export interface Header {
  el: HTMLElement;
  /** Shows the file the project is saved in and whether there are unsaved changes. */
  setFileStatus(name: string | null, dirty: boolean): void;
  /** Hidden file input used when the browser has no file picker API. */
  pickFile(): void;
}

let openPop: { close: () => void } | null = null;

/** Button with a dropdown panel. The panel closes on Escape, outside clicks or `close()`. */
function popover(label: string, iconName: string, build: (close: () => void) => HTMLElement, align: 'start' | 'end' = 'start') {
  const id = `pop-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const btn = h('button', { type: 'button', class: 'btn btn-quiet', 'aria-expanded': 'false', 'aria-controls': id, 'aria-haspopup': 'true' }, icon(iconName, 17), h('span', { class: 'btn-text' }, label), icon('chevron', 14));
  const wrap = h('div', { class: 'pop-wrap' }, btn);
  let panel: HTMLElement | null = null;
  const close = () => {
    panel?.remove();
    panel = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    if (openPop?.close === close) openPop = null;
  };
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  };
  btn.addEventListener('click', () => {
    if (panel) return close();
    openPop?.close();
    panel = h('div', { class: `popover popover-${align}`, id }, build(close));
    wrap.appendChild(panel);
    btn.setAttribute('aria-expanded', 'true');
    openPop = { close };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    (panel.querySelector('button, select, input') as HTMLElement | null)?.focus();
  });
  return wrap;
}

const LOGO = `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" class="logo">
  <rect x="7" y="6" width="18" height="22" rx="5" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M8 18.5c3 1.4 13 1.4 16 0V23a4 4 0 0 1-4 4h-8a4 4 0 0 1-4-4z" fill="var(--water)"/>
  <rect x="13" y="2" width="6" height="4" rx="1" fill="var(--accent)"/>
  <path d="M16 6v9" stroke="var(--accent)" stroke-width="1.6" stroke-dasharray="2 2"/>
</svg>`;

export function buildHeader(store: Store, actions: HeaderActions): Header {
  const name = h('input', { id: 'project-name', class: 'project-input', type: 'text', maxlength: 80, autocomplete: 'off', spellcheck: 'false' });
  name.value = store.project.name;
  name.addEventListener('input', () => {
    const v = name.value.trim();
    if (v) store.update('name', (s) => (s.project.name = v));
  });
  name.addEventListener('change', () => {
    if (!name.value.trim()) name.value = store.project.name;
  });
  store.subscribe((c) => {
    if ((c.has('project') || c.has('name')) && document.activeElement !== name) name.value = store.project.name;
  });

  const brand = h('div', { class: 'brand' });
  brand.innerHTML = LOGO;
  brand.append(h('div', { class: 'brand-text' }, h('span', { class: 'brand-name' }, 'Tanker Time'), h('span', { class: 'brand-sub' }, 'Tank level & sensor lab')));

  const library = popover('Tank library', 'library', (close) =>
    h(
      'div',
      { class: 'menu-list', role: 'menu' },
      h('p', { class: 'menu-empty' }, 'Start from a tank like yours, then change the sizes. Your current tank is replaced (you can undo).'),
      PRESET_GROUPS.map((group) => [
        h('div', { class: 'menu-head' }, group),
        PRESETS.filter((p) => p.group === group).map((p) =>
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            role: 'menuitem',
            on: {
              click: () => {
                close();
                actions.loadProject(p.build(), `Loaded “${p.label}”`);
              },
            },
          },
          h('span', { class: 'menu-title' }, p.label),
          h('span', { class: 'menu-desc' }, p.description),
        ),
        ),
      ]),
    ),
  );

  const fileInput = h('input', { type: 'file', accept: '.json,.tank,application/json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) actions.importProjectFile(f);
    fileInput.value = '';
  });

  const menuBtn = (iconName: string, title: string, desc: string | null, keys: string | null, run: () => void) =>
    h(
      'button',
      {
        type: 'button',
        class: 'menu-item row',
        on: { click: run },
      },
      icon(iconName, 17),
      h('span', { class: 'menu-texts' }, h('span', { class: 'menu-title' }, title), desc ? h('span', { class: 'menu-desc' }, desc) : null),
      keys ? h('kbd', { class: 'menu-keys' }, keys) : null,
    );

  const projects = popover('File', 'folder', (close) => {
    const saved = readLibrary();
    const list = saved.length
      ? h(
          'ul',
          { class: 'saved-list' },
          saved.map((e) =>
            h(
              'li',
              null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'saved-open',
                  on: {
                    click: () => {
                      close();
                      actions.loadProject(structuredClone(e.project), `Opened “${e.name}”`);
                    },
                  },
                },
                h('span', { class: 'menu-title' }, e.name),
                h('span', { class: 'menu-desc' }, new Date(e.saved).toLocaleString()),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn',
                  'aria-label': `Delete saved tank ${e.name}`,
                  on: {
                    click: (ev: Event) => {
                      ev.stopPropagation();
                      removeFromLibrary(e.name);
                      close();
                      toast(`Deleted “${e.name}” from this browser`, {
                        label: 'Undo',
                        run: () => saveToLibrary(e.project),
                      });
                    },
                  },
                },
                icon('trash', 16),
              ),
            ),
          ),
        )
      : h('p', { class: 'menu-empty' }, 'Saved tanks appear here. They stay in this browser only.');
    const run = (fn: () => void) => () => {
      close();
      fn();
    };
    return h(
      'div',
      { class: 'menu-list' },
      h('div', { class: 'menu-head' }, 'Project file (.tank.json)'),
      menuBtn('save', 'Save', 'Shape, sizes, walls, liquid, sensors, calibration points, view and level', 'Ctrl+S', run(() => actions.saveFile(false))),
      menuBtn('download', 'Save as…', 'Save a copy under a new name', 'Ctrl+Shift+S', run(() => actions.saveFile(true))),
      menuBtn('open', 'Open file…', 'Or drop a .tank.json file anywhere on the page', 'Ctrl+O', run(() => actions.openFile())),
      menuBtn('plus', 'New blank tank', null, null, run(() => actions.newProject())),
      h('div', { class: 'menu-head' }, 'Saved in this browser'),
      menuBtn(
        'save',
        'Keep a copy in this browser',
        'Quick list below; it stays on this computer only',
        null,
        run(() => toast(saveToLibrary(store.project) ? `Saved “${store.project.name}” in this browser` : 'This browser blocks storage, so the tank was not saved. Save a file instead.')),
      ),
      list,
    );
  });

  const fileName = h('span', { class: 'file-name' });
  const fileState = h('span', { class: 'file-state' });
  const fileStatus = h('div', { class: 'file-status', 'aria-live': 'polite' }, fileName, fileState);
  const saveBtn = h(
    'button',
    { type: 'button', class: 'btn btn-quiet save-btn', title: 'Save the project file (Ctrl+S)', on: { click: () => actions.saveFile(false) } },
    icon('save', 17),
    h('span', { class: 'btn-text' }, 'Save'),
  );
  const guideBtn = h(
    'button',
    { type: 'button', class: 'btn btn-quiet', title: 'Step-by-step guide', on: { click: () => actions.openGuide() } },
    icon('guide', 17),
    h('span', { class: 'btn-text' }, 'Guide'),
  );

  const units = popover(
    'Units',
    'ruler',
    () => {
      const sel = <T extends string>(id: string, label: string, opts: Record<T, { label: string }>, get: () => T, set: (v: T) => void) => {
        const s = h('select', { id, class: 'select' }, (Object.keys(opts) as T[]).map((k) => h('option', { value: k }, opts[k].label)));
        s.value = get();
        s.addEventListener('change', () => store.update('units', () => set(s.value as T)));
        return h('div', { class: 'field' }, h('label', { for: id, class: 'field-label' }, label), h('div', { class: 'select-wrap' }, s, icon('chevron', 16)));
      };
      const u = store.project.units;
      return h(
        'div',
        { class: 'units-grid' },
        sel<LengthUnit>('unit-length', 'Length', LENGTH, () => u.length, (v) => (store.project.units.length = v)),
        sel<VolumeUnit>('unit-volume', 'Volume', VOLUME, () => u.volume, (v) => (store.project.units.volume = v)),
        sel<PressureUnit>('unit-pressure', 'Pressure', PRESSURE, () => u.pressure, (v) => (store.project.units.pressure = v)),
        sel<FlowUnit>('unit-flow', 'Flow', FLOW, () => u.flow, (v) => (store.project.units.flow = v)),
      );
    },
    'end',
  );

  const themeBtn = h('button', { type: 'button', class: 'icon-btn theme-btn', 'aria-label': 'Colour theme' });
  const setThemeIcon = () => {
    const name = actions.themeIcon();
    themeBtn.replaceChildren(icon(name, 18));
    themeBtn.title = name === 'auto' ? 'Theme: follows the system' : name === 'sun' ? 'Theme: light' : 'Theme: dark';
  };
  setThemeIcon();
  themeBtn.addEventListener('click', () => {
    actions.cycleTheme();
    setThemeIcon();
  });

  const exportBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => actions.openExport() } }, icon('doc', 17), h('span', null, 'Scripts & table'));

  const el = h(
    'header',
    { class: 'appbar' },
    brand,
    h('div', { class: 'project-name' }, h('label', { for: 'project-name', class: 'sr-only' }, 'Project name'), name, fileStatus),
    h('nav', { class: 'appbar-actions', 'aria-label': 'Project' }, library, projects, saveBtn, units, guideBtn, themeBtn, exportBtn, fileInput),
  );
  return {
    el,
    setFileStatus(file, dirty) {
      fileName.textContent = file ?? 'Not saved to a file yet';
      fileName.title = file ? `Project file: ${file}` : 'Use Save (Ctrl+S) to keep everything in a .tank.json file';
      fileState.textContent = file ? (dirty ? '· unsaved changes' : '· saved') : '';
      fileStatus.classList.toggle('is-dirty', dirty);
      saveBtn.classList.toggle('is-dirty', dirty);
    },
    pickFile() {
      fileInput.click();
    },
  };
}
