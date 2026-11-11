import { LIQUIDS } from '../core/defaults';
import { MAX_TILT, isPit, type Derived } from '../core/derive';
import { defaultPit } from '../core/pit';
import { fmtVol, plain } from '../core/units';
import { h, icon } from './dom';
import { explain, lengthField, plainField, segmented, selectField, toggleField, type Ctx, type Field } from './fields';

/** Panel context: the store plus the live derived model. */
export interface PanelCtx extends Ctx {
  derived(): Derived;
}

export let onSectionToggle: (() => void) | null = null;
export function setSectionToggleHandler(fn: () => void) {
  onSectionToggle = fn;
}

/** A collapsible panel section with a one-line summary in its header. */
export function section(id: string, title: string, summary: () => string, open: Set<string>, ...children: (HTMLElement | null)[]): Field {
  const sum = h('span', { class: 'section-sum' });
  const det = h(
    'details',
    { class: 'section', id: `sec-${id}`, open: open.has(id) },
    h('summary', null, h('span', { class: 'section-title' }, title), sum, icon('chevron', 16)),
    h('div', { class: 'section-body' }, children),
  );
  det.addEventListener('toggle', () => {
    if (det.open) open.add(id);
    else open.delete(id);
    onSectionToggle?.();
  });
  return { el: det, refresh: () => (sum.textContent = summary()) };
}

export function grid(...items: (Field | null)[]): HTMLElement {
  return h('div', { class: 'field-grid' }, items.filter(Boolean).map((f) => (f as Field).el));
}

/** Tank (a shell with two ends) or concrete storage (an open pit drawn in plan). */
export function kindField(ctx: PanelCtx): Field {
  return segmented(ctx, {
    id: 'tank-kind',
    label: 'What holds the liquid',
    options: [
      { value: 'tank', label: 'Tank (shell with ends)' },
      { value: 'pit', label: 'Concrete storage (open pit)' },
    ],
    get: () => (isPit(ctx.store.project.tank) ? 'pit' : 'tank'),
    set: (v) => {
      const t = ctx.store.project.tank;
      if (v === 'pit') {
        t.kind = 'pit';
        if (!t.pit) t.pit = defaultPit();
        // A storage has no roof: sensors on a manhole move to the wall top.
        for (const s of ctx.store.project.sensors) if (s.faceMode === 'manhole') s.faceMode = 'auto';
      } else delete t.kind;
    },
    change: ['tank', 'structure', 'sensors'],
  });
}

/** Installation & liquid: tilt (tanks only), liquid and density, overflow and outlet levels. */
export function installSection(ctx: PanelCtx, fs: import('./fields').FieldSet, open: Set<string>, withTilt: boolean): Field {
  const d = () => ctx.derived();
  const vert = ctx.store.project.tank.orientation === 'vertical';
  const liquidOpts = LIQUIDS.map((l) => ({ value: l.id, label: l.id === 'custom' ? 'Custom' : `${l.label} · ${plain(l.density, 1)}` }));
  const inst: Field[] = [];
  if (withTilt) {
    inst.push(
      plainField(ctx, {
        id: 'tilt',
        label: vert ? 'Lean (top toward +X)' : 'Slope (right end up)',
        unit: '°',
        dp: 2,
        min: -MAX_TILT,
        max: MAX_TILT,
        step: 0.1,
        hint: 'Installation tilt. Sensors measure along the tank axis, the liquid stays level.',
        get: () => ctx.store.project.tank.tilt,
        set: (v) => (ctx.store.project.tank.tilt = v),
        change: ['tank'],
      }),
    );
  }
  inst.push(
    selectField(ctx, {
      id: 'liquid',
      label: 'Liquid',
      options: () => liquidOpts,
      get: () => ctx.store.project.liquid.preset,
      set: (v) => {
        const l = LIQUIDS.find((x) => x.id === v)!;
        ctx.store.project.liquid.preset = v;
        if (v !== 'custom') ctx.store.project.liquid.density = l.density;
      },
      change: ['liquid'],
    }),
    plainField(ctx, {
      id: 'density',
      label: 'Density',
      unit: 'kg/m³',
      dp: 1,
      min: 1,
      max: 25000,
      step: 1,
      get: () => ctx.store.project.liquid.density,
      set: (v) => {
        ctx.store.project.liquid.density = v;
        const l = LIQUIDS.find((x) => x.id === ctx.store.project.liquid.preset);
        if (!l || Math.abs(l.density - v) > 1e-9) ctx.store.project.liquid.preset = 'custom';
      },
      change: ['liquid'],
    }),
  );
  const marks = ctx.store.project.marks;
  const markField = (key: 'overflow' | 'outlet', label: string, fallback: () => number): Field[] => {
    const tog = toggleField(ctx, {
      id: `mark-${key}`,
      label,
      get: () => ctx.store.project.marks[key] !== null,
      set: (v) => (ctx.store.project.marks[key] = v ? fallback() : null),
      change: ['marks', 'structure'],
    });
    if (marks[key] === null) return [tog];
    return [
      tog,
      lengthField(ctx, {
        id: `mark-${key}-v`,
        label: `${label} height`,
        min: 0,
        max: () => d().depth,
        get: () => ctx.store.project.marks[key] ?? 0,
        set: (v) => (ctx.store.project.marks[key] = v),
        change: ['marks'],
        note: () => {
          const lv = ctx.store.project.marks[key];
          if (lv === null) return '';
          const e = d().engine;
          return `= ${fmtVol(e.litres(Math.min(Math.max(lv, 0), e.depth)), ctx.store.project.units.volume)}`;
        },
      }),
    ];
  };
  inst.push(...markField('overflow', 'Overflow level', () => Math.round(d().depth * 0.95)), ...markField('outlet', 'Outlet level', () => Math.round(Math.min(80, d().depth * 0.05))));
  inst.forEach((f) => fs.add(f));
  return fs.add(
    section(
      'install',
      'Installation & liquid',
      () => {
        const l = LIQUIDS.find((x) => x.id === ctx.store.project.liquid.preset);
        return `${l && l.id !== 'custom' ? l.label.split(',')[0] : 'Custom'}${withTilt ? ` · tilt ${plain(ctx.store.project.tank.tilt, 2)}°` : ''}`;
      },
      open,
      explain(
        withTilt ? 'Tilt, liquid and levels' : 'Liquid and levels',
        [
          ...(withTilt ? ['Tilt: a tank that is not level holds liquid differently. A horizontal tank 10 m long with a 0.5° slope has one end 87 mm lower than the other.'] : []),
          'Density: only pressure sensors need it (pressure = density × g × liquid height). Distance sensors do not care.',
          'Overflow level: the highest level you can really fill to. Outlet level: liquid below it cannot be pumped out.',
        ],
      ),
      grid(...inst),
    ),
  );
}
