import { defaultManhole, nextManholeTag } from '../core/defaults';
import type { Derived } from '../core/derive';
import { centroid } from '../core/polygon';
import { manholeHalf } from '../core/sensors';
import type { ManholeConfig, SensorConfig, TankConfig } from '../core/types';
import { fmtLen, fmtVol, type LengthUnit } from '../core/units';
import { h, icon } from './dom';
import { FieldSet, lengthField, segmented, textField, type Field } from './fields';
import type { PanelCtx } from './tankPanel';

export function manholesOf(t: TankConfig): ManholeConfig[] {
  if (!t.manholes) t.manholes = [];
  return t.manholes;
}

/** A new manhole: at a given spot, or the middle of the roof (the middle of the length for horizontal tanks). */
export function newManhole(d: Derived, existing: ManholeConfig[], at?: { x: number; y: number }): ManholeConfig {
  const mh = defaultManhole(nextManholeTag(existing));
  const m = d.model;
  // Opening about a quarter of the narrow side, between 300 and 600 mm, rounded to 50 mm.
  const narrow = d.kind === 'pit' ? Math.min(d.pit.box.x1 - d.pit.box.x0, d.pit.box.y1 - d.pit.box.y0) : 2 * Math.min(m.base.A, m.base.B);
  // In the slab over a storage: 450 mm from the wall top to the cover top (slab + frame) to start with.
  if (d.kind === 'pit') mh.neck = 450;
  mh.diameter = Math.min(600, Math.max(300, Math.round((0.25 * narrow) / 50) * 50));
  mh.length = mh.diameter;
  if (at) {
    mh.x = Math.round(at.x);
    mh.y = Math.round(at.y);
  } else {
    let spots: [number, number][] =
      m.orientation === 'vertical'
        ? [[0, 0], [0.4 * m.base.A, 0], [-0.4 * m.base.A, 0], [0, 0.4 * m.base.B], [0, -0.4 * m.base.B]]
        : [[0, 0], [0.3 * m.L, 0], [-0.3 * m.L, 0], [0.15 * m.L, 0], [-0.15 * m.L, 0]];
    if (d.kind === 'pit') {
      // The middle of the storage, then points halfway from the middle to each corner.
      const o = d.pit.outline;
      const c = centroid(o);
      spots = [[c.x, c.y], ...o.map((q): [number, number] => [(q.x + c.x) / 2, (q.y + c.y) / 2])];
    }
    let best = spots[0];
    let bestD = -1;
    for (const p of spots) {
      if (!d.hull.span(p[0], p[1])) continue;
      const dmin = existing.length ? Math.min(...existing.map((e) => Math.hypot(e.x - p[0], e.y - p[1]))) : Infinity;
      if (dmin > bestD + 1e-6) {
        bestD = dmin;
        best = p;
      }
    }
    [mh.x, mh.y] = best.map((v) => Math.round(v)) as [number, number];
  }
  return mh;
}

/** Moves a manhole and the sensors that sit on it by the same amount. */
export function moveManhole(mh: ManholeConfig, sensors: SensorConfig[], x: number, y: number): void {
  const dx = x - mh.x;
  const dy = y - mh.y;
  mh.x = x;
  mh.y = y;
  for (const s of sensors) {
    if (s.faceMode === 'manhole' && s.manhole === mh.id) {
      s.x += dx;
      s.y += dy;
    }
  }
}

/** Removes a manhole. Sensors on it keep their current face height, entered by hand. */
export function removeManhole(ctx: PanelCtx, id: string): void {
  const d = ctx.derived();
  ctx.store.update(['sensors', 'structure'], (state) => {
    const p = state.project;
    for (const s of p.sensors) {
      if (s.faceMode !== 'manhole' || s.manhole !== id) continue;
      const g = d.geoms.find((x) => x.sensor.id === s.id);
      s.faceMode = 'manual';
      if (g?.ok) s.faceHeight = Math.round(g.faceHeightUntilted);
      s.manhole = undefined;
    }
    p.tank.manholes = manholesOf(p.tank).filter((m) => m.id !== id);
    if (state.selected === id) state.selected = null;
  });
}

/** Small round or square manhole symbol for the card header. */
export function manholeBadge(mh: ManholeConfig): HTMLElement {
  return h('span', { class: `mh-badge${mh.shape === 'rect' ? ' is-rect' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'mh-badge-in' }));
}

export function manholeCards(ctx: PanelCtx, fs: FieldSet, select: (id: string | null) => void): HTMLElement[] {
  return manholesOf(ctx.store.project.tank).map((mh) => manholeCard(ctx, fs, mh, select));
}

function manholeCard(ctx: PanelCtx, fs: FieldSet, m0: ManholeConfig, select: (id: string | null) => void): HTMLElement {
  const st = ctx.store;
  const id = m0.id;
  const M = () => manholesOf(st.project.tank).find((x) => x.id === id)!;
  const selected = st.state.selected === id;
  const u = () => st.project.units.length as LengthUnit;
  const fid = (k: string) => `mh-${id}-${k}`;
  const mmLen = (v: number) => fmtLen(v, u(), false, u() === 'mm' ? 0 : undefined);
  const onIt = () => st.project.sensors.filter((s) => s.faceMode === 'manhole' && s.manhole === id);

  const sub = h('span', { class: 'sensor-sub' });
  const statusDot = h('span', { class: 'status-dot' });
  const headBtn = h(
    'button',
    { type: 'button', class: 'sensor-select', 'aria-expanded': String(selected), on: { click: () => select(selected ? null : id) } },
    manholeBadge(m0),
    h('span', { class: 'sensor-titles' }, h('span', { class: 'sensor-name' }, 'Manhole'), sub),
    statusDot,
  );
  const actions = h(
    'div',
    { class: 'sensor-actions' },
    h(
      'button',
      { type: 'button', class: 'icon-btn', title: 'Remove manhole', 'aria-label': `Remove ${m0.tag}`, on: { click: () => removeManhole(ctx, id) } },
      icon('trash', 16),
    ),
  );
  const card = h(
    'article',
    { class: `sensor-card manhole-card${selected ? ' is-selected' : ''}`, 'data-id': id },
    h('header', { class: 'sensor-head' }, headBtn, actions),
  );

  fs.add({
    el: card,
    refresh: () => {
      const mh = M();
      if (!mh) return;
      const g = ctx.derived().manholes.find((x) => x.manhole.id === id);
      const size = mh.shape === 'round' ? `Ø ${mmLen(mh.diameter)}` : `${mmLen(mh.diameter)} × ${mmLen(mh.length)}`;
      const n = onIt().length;
      sub.textContent = `${mh.tag} · ${size} · X ${mmLen(mh.x)} · Y ${mmLen(mh.y)}${n ? ` · ${n} sensor${n === 1 ? '' : 's'}` : ''}`;
      statusDot.className = `status-dot ${g?.ok ? (g.warnings.length ? 'is-warn' : 'is-ok') : 'is-bad'}`;
      statusDot.title = g?.ok ? (g.warnings.length ? 'Placed, see notes' : 'Placed') : (g?.error ?? '');
    },
  });

  if (!selected) return card;

  const pit = ctx.derived().kind === 'pit';
  const vert = pit || st.project.tank.orientation === 'vertical';
  const items: Field[] = [
    textField(ctx, { id: fid('tag'), label: 'Tag', get: () => M().tag, set: (v) => (M().tag = v), change: ['sensors'], maxLength: 16 }),
    segmented(ctx, {
      id: fid('shape'),
      label: 'Opening',
      options: [
        { value: 'round', label: 'Round' },
        { value: 'rect', label: 'Rectangular' },
      ],
      get: () => M().shape,
      set: (v) => (M().shape = v),
      change: ['sensors', 'structure'],
    }),
  ];
  if (M().shape === 'round') {
    items.push(lengthField(ctx, { id: fid('dia'), label: 'Opening diameter (inside)', min: 1, get: () => M().diameter, set: (v) => (M().diameter = v), change: ['sensors'] }));
  } else {
    items.push(
      lengthField(ctx, { id: fid('w'), label: 'Opening along X', min: 1, get: () => M().diameter, set: (v) => (M().diameter = v), change: ['sensors'] }),
      lengthField(ctx, { id: fid('l'), label: 'Opening along Y', min: 1, get: () => M().length, set: (v) => (M().length = v), change: ['sensors'] }),
    );
  }
  items.push(
    lengthField(ctx, {
      id: fid('x'),
      label: vert ? 'Centre X (left–right)' : 'Centre X (along length)',
      get: () => M().x,
      set: (v) => moveManhole(M(), st.project.sensors, v, M().y),
      change: ['sensors'],
    }),
    lengthField(ctx, {
      id: fid('y'),
      label: vert ? 'Centre Y (front–back)' : 'Centre Y (across)',
      get: () => M().y,
      set: (v) => moveManhole(M(), st.project.sensors, M().x, v),
      change: ['sensors'],
    }),
    segmented(ctx, {
      id: fid('hby'),
      label: 'Cover height given as',
      options: [
        { value: 'neck', label: pit ? 'Above the wall top' : 'Neck above roof' },
        { value: 'zero', label: 'Above level zero' },
      ],
      get: () => M().heightBy,
      set: (v) => {
        const mh = M();
        const g = ctx.derived().manholes.find((x) => x.manhole.id === id);
        // Keep the cover where it is when switching how its height is given.
        if (g?.ok) {
          if (v === 'zero') mh.top = Math.round(g.coverHeight);
          else mh.neck = Math.round(g.neckHeight);
        }
        mh.heightBy = v;
      },
      change: ['sensors', 'structure'],
    }),
  );
  if (M().heightBy === 'neck') {
    items.push(
      lengthField(ctx, {
        id: fid('neck'),
        label: pit ? 'Cover top above the wall top' : 'Neck height (roof to cover top)',
        hint: pit
          ? 'From the top of the wall (the underside of the slab that covers the storage) up to the top of the closed cover: slab thickness + frame.'
          : 'From the outside of the roof at the manhole centre up to the top of the closed cover.',
        min: 0,
        get: () => M().neck,
        set: (v) => (M().neck = v),
        change: ['sensors'],
        note: () => {
          const g = ctx.derived().manholes.find((x) => x.manhole.id === id);
          return g?.ok ? `Cover top ${fmtLen(g.coverHeight, u())} above level zero` : '';
        },
      }),
    );
  } else {
    items.push(
      lengthField(ctx, {
        id: fid('top'),
        label: 'Cover top above level zero',
        min: 0,
        get: () => M().top,
        set: (v) => (M().top = v),
        change: ['sensors'],
        note: () => {
          const g = ctx.derived().manholes.find((x) => x.manhole.id === id);
          return g?.ok ? (pit ? `${fmtLen(g.neckHeight, u())} above the wall top` : `Neck ${fmtLen(g.neckHeight, u())} above the roof`) : '';
        },
      }),
    );
  }
  items.push(lengthField(ctx, { id: fid('cover'), label: 'Cover thickness', min: 0, get: () => M().cover, set: (v) => (M().cover = v), change: ['sensors'] }));

  const info = h('div', { class: 'sensor-info' });
  const infoField: Field = {
    el: info,
    refresh: () => {
      const g = ctx.derived().manholes.find((x) => x.manhole.id === id);
      info.replaceChildren();
      if (!g) return;
      if (!g.ok) {
        info.append(h('p', { class: 'panel-note note-error' }, g.error ?? 'Not placed.'));
        return;
      }
      const [hx, hy] = manholeHalf(g.manhole);
      const rows: [string, string][] = [
        ['Cover top above level zero', fmtLen(g.coverHeight, u())],
        [pit ? 'Cover top above the wall top' : 'Neck above the roof', fmtLen(g.neckHeight, u())],
        [pit ? 'Wall top (underside of the slab)' : 'Inside roof at the centre', fmtLen(g.roofLevel, u())],
        ['Clear opening', g.manhole.shape === 'round' ? `Ø ${fmtLen(2 * hx, u())}` : `${fmtLen(2 * hx, u(), false)} × ${fmtLen(2 * hy, u())}`],
        ['Liquid can stand in the neck', `${fmtLen(g.neckDepth, u())} high · ${fmtVol((g.area * g.neckDepth) / 1e6, st.project.units.volume)}`],
      ];
      const tags = onIt().map((s) => s.tag);
      rows.push(['Sensors on the cover', tags.length ? tags.join(', ') : 'none']);
      info.append(h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      for (const w of g.warnings) info.append(h('p', { class: 'panel-note note-warn' }, w));
    },
  };
  items.forEach((f) => fs.add(f));
  fs.add(infoField);
  card.append(h('div', { class: 'sensor-body' }, h('div', { class: 'field-grid' }, items.map((f) => f.el)), info));
  return card;
}
