import { checkValues } from '../core/pit';
import { centroid, perimeter, rectangle } from '../core/polygon';
import type { PitConfig, PitHeightRef, PitSump } from '../core/types';
import { LENGTH, VOLUME, fmtLen, fmtVol, plain } from '../core/units';
import { h, icon } from './dom';
import { FieldSet, cellInput, explain, infoField, lengthField, note, numField, plainField, segmented, selectField, toggleField, type Field } from './fields';
import { grid, installSection, kindField, section, type PanelCtx } from './sections';

/**
 * The designer of a concrete storage: the plan outline (any polygon), the floor (flat,
 * one slope, or heights at the corners) with sumps and batter, the wall height on the
 * drawing's own reference, drawing-only wall sizes, operation and alarm levels and the
 * drawing's capacity check values.
 */

const P = (ctx: PanelCtx): PitConfig => ctx.store.project.tank.pit!;

const DIRECTIONS: { value: string; label: string; deg: number }[] = [
  { value: '0', label: 'Rises toward +X (right)', deg: 0 },
  { value: '180', label: 'Rises toward −X (left)', deg: 180 },
  { value: '90', label: 'Rises toward +Y (back)', deg: 90 },
  { value: '270', label: 'Rises toward −Y (front)', deg: 270 },
  { value: 'custom', label: 'Any direction (angle below)', deg: NaN },
];

/** A length that may be unset: a switch, then the field. */
function optionalLength(ctx: PanelCtx, fs: FieldSet, o: { id: string; label: string; get: () => number | null; set: (v: number | null) => void; fallback: () => number; note?: () => string }): Field[] {
  const tog = toggleField(ctx, { id: o.id, label: o.label, get: () => o.get() !== null, set: (v) => o.set(v ? o.fallback() : null), change: ['tank', 'structure'] });
  fs.add(tog);
  if (o.get() === null) return [tog];
  const f = lengthField(ctx, { id: `${o.id}-v`, label: `${o.label} (on the drawing)`, get: () => o.get() ?? 0, set: (v) => o.set(v), change: ['tank'], note: o.note });
  fs.add(f);
  return [tog, f];
}

export function buildPitPanel(ctx: PanelCtx, fs: FieldSet, open: Set<string>): HTMLElement {
  const st = ctx.store;
  const u = () => st.project.units.length;
  const vu = () => st.project.units.volume;
  const d = () => ctx.derived();
  const pit = () => (d().kind === 'pit' ? d().pit! : null);
  const mmLen = (v: number) => fmtLen(v, u(), true, u() === 'mm' ? 0 : undefined);

  // ---------------------------------------------------------------- Shape: plan and floor
  const shapeItems: Field[] = [fs.add(kindField(ctx))];
  const floor = P(ctx).floor;
  const floorItems: Field[] = [
    segmented(ctx, {
      id: 'pit-floor',
      label: 'Floor',
      options: [
        { value: 'flat', label: 'Flat' },
        { value: 'plane', label: 'One slope' },
        { value: 'vertices', label: 'Heights at the corners' },
      ],
      get: () => P(ctx).floor.type,
      set: (v) => {
        const p = P(ctx);
        if (v === p.floor.type) return;
        const m = pit();
        if (v === 'flat') p.floor = { type: 'flat' };
        else if (v === 'plane') p.floor = { type: 'plane', direction: 0, drop: Math.max(0, Math.round(m ? m.floorHigh - m.floorLow : 0)) || 200 };
        else p.floor = { type: 'vertices', heights: p.outline.map((q) => (m ? Math.round(m.mainFloorZ(q.x, q.y) - m.floorLow) : 0)) };
      },
      change: ['tank', 'structure'],
    }),
  ];
  if (floor.type === 'plane') {
    const known = DIRECTIONS.find((x) => Number.isFinite(x.deg) && Math.abs(((floor.direction % 360) + 360) % 360 - x.deg) < 1e-9);
    floorItems.push(
      selectField(ctx, {
        id: 'pit-dir',
        label: 'Slope direction',
        hint: 'The floor is lowest at the wall opposite to this direction and rises toward it. Liquid runs toward the low wall (outlet).',
        options: () => DIRECTIONS.map(({ value, label }) => ({ value, label })),
        get: () => known?.value ?? 'custom',
        set: (v) => {
          const f = P(ctx).floor;
          if (f.type !== 'plane') return;
          const dir = DIRECTIONS.find((x) => x.value === v);
          if (dir && Number.isFinite(dir.deg)) f.direction = dir.deg;
        },
        change: ['tank', 'structure'],
      }),
    );
    if (!known) {
      floorItems.push(
        plainField(ctx, {
          id: 'pit-angle',
          label: 'Direction angle in the plan',
          unit: '°',
          dp: 1,
          min: -360,
          max: 360,
          step: 5,
          hint: '0° = toward +X (right), 90° = toward +Y (back). The floor rises along this direction.',
          get: () => (P(ctx).floor as { direction: number }).direction,
          set: (v) => {
            const f = P(ctx).floor;
            if (f.type === 'plane') f.direction = v;
          },
          change: ['tank'],
        }),
      );
    }
    floorItems.push(
      lengthField(ctx, {
        id: 'pit-drop',
        label: 'Total drop (low wall to high wall)',
        hint: 'Difference in floor height between the lowest and the highest point of the floor.',
        min: 0,
        get: () => (P(ctx).floor as { drop: number }).drop,
        set: (v) => {
          const f = P(ctx).floor;
          if (f.type === 'plane') f.drop = v;
        },
        change: ['tank'],
        note: () => {
          const m = pit();
          return m ? `Floor from ${mmLen(m.floorLow)} to ${mmLen(m.floorHigh)} above the deepest point` : '';
        },
      }),
    );
  }
  floorItems.push(
    plainField(ctx, {
      id: 'pit-batter',
      label: 'Wall batter (inner face leans outward)',
      unit: 'mm per m',
      dp: 1,
      min: 0,
      max: 500,
      step: 5,
      hint: 'How much the inner wall face moves outward for every metre of height. 0 = vertical walls (usual).',
      get: () => P(ctx).batter,
      set: (v) => (P(ctx).batter = v),
      change: ['tank'],
    }),
  );
  floorItems.forEach((f) => fs.add(f));

  const shape = fs.add(
    section(
      'shape',
      'Shape',
      () => {
        const m = pit();
        const f = P(ctx).floor;
        const fl = f.type === 'plane' ? 'one slope' : f.type === 'vertices' ? 'corner heights' : 'flat floor';
        return m ? `${m.outline.length} corners · ${plain(m.area / 1e6, 2)} m² · ${fl}` : 'Concrete storage';
      },
      open,
      grid(...shapeItems),
      explain(
        'How to describe a concrete storage',
        'Type the corners of the inside of the walls as seen from above, like a drawing: X runs left–right, Y front–back, in mm. Any outline works (rectangle, trapezoid, L-shape, cut corners). Then choose how the floor runs and, if there is one, add the sump.',
        [
          'Rectangle: type its width and length under the table and press Make rectangle. Add or move corners afterwards for an L-shape or a cut corner.',
          'One slope: the whole floor is one plane that rises toward one wall. Give the direction and the total drop from the drawing.',
          'Heights at the corners: type the floor height at each corner (several slopes, a ridge, a step). Put extra corners on a straight side where the slope changes.',
          'Level zero (where every level starts) is always the deepest point of the floor, sump included. Heights you read off the drawing are typed on the drawing’s own reference in the Dimensions section.',
        ],
      ),
      outlineEditor(ctx, fs),
      h('div', { class: 'subsection' }, h('h4', { class: 'sub-title' }, 'Floor'), grid(...floorItems)),
      sumpEditor(ctx, fs),
    ),
  );

  // ---------------------------------------------------------------- Dimensions
  const REFS: { value: PitHeightRef; label: string }[] = [
    { value: 'floorHigh', label: 'Highest floor point (shallow end)' },
    { value: 'floorLow', label: 'Lowest point of the main floor' },
    { value: 'datum', label: 'Deepest point (sump bottom)' },
  ];
  const dims: Field[] = [
    selectField(ctx, {
      id: 'pit-ref',
      label: 'Heights on the drawing are measured from',
      wide: true,
      hint: 'Engineers often set 0 at the shallow end or at the outlet. Pick the same reference as your drawing and type the heights as they are written; the app works out the heights above the deepest point.',
      options: () => REFS,
      get: () => P(ctx).heightRef,
      set: (v) => {
        const p = P(ctx);
        const m = pit();
        if (!m || v === p.heightRef) return;
        // Keep every typed height where it is: move it to the new reference.
        const newRef = v === 'floorHigh' ? m.floorHigh : v === 'floorLow' ? m.floorLow : 0;
        const shift = m.refZ - newRef;
        p.wallHeight = Math.round((p.wallHeight + shift) * 1000) / 1000;
        if (p.operationLevel !== null) p.operationLevel += shift;
        if (p.alarmHigh !== null) p.alarmHigh += shift;
        if (p.alarmLow !== null) p.alarmLow += shift;
        for (const c of p.checks) c.level += shift;
        p.heightRef = v;
      },
      change: ['tank', 'structure'],
    }),
    lengthField(ctx, {
      id: 'pit-wall',
      label: 'Wall height (top of wall, on the drawing)',
      hint: 'Top of the inner wall face above the reference chosen above.',
      min: 0,
      get: () => P(ctx).wallHeight,
      set: (v) => (P(ctx).wallHeight = v),
      change: ['tank'],
      note: () => {
        const m = pit();
        return m ? `= ${mmLen(m.wallTop)} above the deepest point (level zero); the drawing's zero is ${mmLen(m.refZ)} above it` : '';
      },
    }),
  ];
  dims.forEach((f) => fs.add(f));
  const levelNote = (get: () => number | null) => () => {
    const m = pit();
    const v = get();
    return m && v !== null ? `= ${mmLen(m.toDatum(v))} above level zero · ${fmtVol(d().engine.litres(Math.min(Math.max(m.toDatum(v), 0), d().depth)), vu())}` : '';
  };
  const levels: Field[] = [
    ...optionalLength(ctx, fs, { id: 'pit-op', label: 'Operation level', get: () => P(ctx).operationLevel, set: (v) => (P(ctx).operationLevel = v), fallback: () => Math.round(P(ctx).wallHeight * 0.9), note: levelNote(() => P(ctx).operationLevel) }),
    ...optionalLength(ctx, fs, { id: 'pit-hi', label: 'High alarm', get: () => P(ctx).alarmHigh, set: (v) => (P(ctx).alarmHigh = v), fallback: () => Math.round(P(ctx).wallHeight * 0.95), note: levelNote(() => P(ctx).alarmHigh) }),
    ...optionalLength(ctx, fs, { id: 'pit-lo', label: 'Low alarm', get: () => P(ctx).alarmLow, set: (v) => (P(ctx).alarmLow = v), fallback: () => Math.round(P(ctx).wallHeight * 0.1), note: levelNote(() => P(ctx).alarmLow) }),
  ];
  const results = [
    infoField({ label: 'Capacity (to the wall top)', value: () => fmtVol(d().totalL, vu()) }),
    infoField({ label: 'Full liquid depth (at the deepest point)', value: () => fmtLen(d().depth, u()) }),
    infoField({ label: 'Plan area inside the walls', value: () => (pit() ? `${plain(pit()!.area / 1e6, 3)} m²` : '') }),
    infoField({
      label: 'Floor, lowest → highest',
      value: () => {
        const m = pit();
        return m ? `${fmtLen(m.floorLow, u(), false)} → ${fmtLen(m.floorHigh, u())}${m.sumps.length ? ` · sump bottom ${fmtLen(Math.min(...m.sumps.map((s) => s.bottom)), u())}` : ''}` : '';
      },
    }),
  ];
  results.forEach((f) => fs.add(f));
  const problems = fs.add(note(() => d().problems.join(' '), 'error'));
  const dimsSec = fs.add(
    section(
      'dims',
      'Dimensions',
      () => `${fmtVol(d().totalL, vu())} · wall ${mmLen(pit()?.wallTop ?? 0)}`,
      open,
      explain(
        'Wall height, levels and the drawing’s zero',
        'Drawings of concrete storages measure heights from their own zero: often the floor at the shallow end, sometimes the outlet. The scripts always count from the deepest point of the floor, so a level is never negative. Choose the reference your drawing uses, type the heights as written, and the app shows each one above the deepest point.',
        [
          'Wall height: the top of the inner wall face. The capacity is the volume up to it.',
          'Operation level and alarms are for information; they do not change the scripts.',
          'Check values: capacities printed on the drawing at given levels. The app compares them with the design and flags a difference of more than 0.5 %.',
        ],
      ),
      grid(...dims),
      h('div', { class: 'subsection' }, h('h4', { class: 'sub-title' }, 'Levels on the drawing (information)'), grid(...levels)),
      checksEditor(ctx, fs),
      h('div', { class: 'result-grid' }, results.map((r) => r.el)),
      problems.el,
    ),
  );

  // ---------------------------------------------------------------- Concrete (drawing only)
  const walls: Field[] = [
    lengthField(ctx, { id: 'pit-wtop', label: 'Wall width at the top', min: 0, get: () => P(ctx).wallTop, set: (v) => (P(ctx).wallTop = v), change: ['tank'] }),
    lengthField(ctx, { id: 'pit-wbase', label: 'Wall width at the base', min: 0, get: () => P(ctx).wallBase, set: (v) => (P(ctx).wallBase = v), change: ['tank'] }),
    lengthField(ctx, { id: 'pit-slab', label: 'Floor slab thickness', min: 0, get: () => P(ctx).slab, set: (v) => (P(ctx).slab = v), change: ['tank'] }),
  ];
  walls.forEach((f) => fs.add(f));
  const wallSec = fs.add(
    section(
      'wall',
      'Concrete walls',
      () => `${mmLen(P(ctx).wallTop)} top · ${mmLen(P(ctx).wallBase)} base`,
      open,
      explain('Drawing only', 'The wall widths and the slab are drawn in the 3D view so the storage looks like the drawing. They never change the volume: the plan outline is the inside of the walls.'),
      grid(...walls),
    ),
  );

  const instSec = installSection(ctx, fs, open, false);
  return h('div', { class: 'panel-sections' }, shape.el, dimsSec.el, wallSec.el, instSec.el);
}

/** Table of the plan corners (X, Y and, for a corner-height floor, the floor height), with a rectangle tool. */
function outlineEditor(ctx: PanelCtx, fs: FieldSet): HTMLElement {
  const st = ctx.store;
  const u = () => st.project.units.length;
  const k = () => LENGTH[u()].k;
  const dp = () => LENGTH[u()].dp;
  const p = P(ctx);
  const byVertex = p.floor.type === 'vertices';
  const heights = () => {
    const f = P(ctx).floor;
    return f.type === 'vertices' ? f.heights : null;
  };
  const rows = p.outline.map((_, i) => {
    const pt = () => P(ctx).outline[i];
    const x = cellInput({ label: `Corner ${i + 1} X`, dp, get: () => pt().x / k(), set: (v) => st.update(['tank'], () => (pt().x = v * k())) });
    const y = cellInput({ label: `Corner ${i + 1} Y`, dp, get: () => pt().y / k(), set: (v) => st.update(['tank'], () => (pt().y = v * k())) });
    fs.add(x);
    fs.add(y);
    const cells = [h('td', { class: 'num' }, String(i + 1)), h('td', null, x.el), h('td', null, y.el)];
    if (byVertex) {
      const z = cellInput({
        label: `Corner ${i + 1} floor height`,
        dp,
        get: () => (heights()?.[i] ?? 0) / k(),
        set: (v) =>
          st.update(['tank'], () => {
            const hs = heights();
            if (hs) hs[i] = v * k();
          }),
      });
      fs.add(z);
      cells.push(h('td', null, z.el));
    }
    const del = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `Remove corner ${i + 1}`,
        on: {
          click: () =>
            st.update(['tank', 'structure'], () => {
              const pp = P(ctx);
              pp.outline.splice(i, 1);
              const hs = heights();
              if (hs) hs.splice(i, 1);
            }),
        },
      },
      icon('trash', 15),
    );
    cells.push(h('td', null, del));
    return h('tr', null, cells);
  });
  const unitLabel = () => LENGTH[u()].label;
  const add = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      on: {
        click: () =>
          st.update(['tank', 'structure'], () => {
            const pp = P(ctx);
            const n = pp.outline.length;
            // A new corner halfway along the last side, so the outline stays simple.
            const a = pp.outline[n - 1] ?? { x: 0, y: 0 };
            const b = pp.outline[0] ?? { x: 1000, y: 0 };
            pp.outline.push({ x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
            const hs = heights();
            if (hs) hs.push(Math.round(((hs[n - 1] ?? 0) + (hs[0] ?? 0)) / 2));
          }),
      },
    },
    icon('plus', 15),
    'Add corner',
  );
  // Rectangle tool: width × length centred on the origin.
  let rw = Math.round(Math.max(...p.outline.map((q) => q.x)) - Math.min(...p.outline.map((q) => q.x))) || 10000;
  let rl = Math.round(Math.max(...p.outline.map((q) => q.y)) - Math.min(...p.outline.map((q) => q.y))) || 6000;
  const wField = numField({ id: 'pit-rect-w', label: 'Width (X)', unit: unitLabel, get: () => rw / k(), set: (v) => (rw = v * k()), dp, min: () => 0.001 });
  const lField = numField({ id: 'pit-rect-l', label: 'Length (Y)', unit: unitLabel, get: () => rl / k(), set: (v) => (rl = v * k()), dp, min: () => 0.001 });
  fs.add(wField);
  fs.add(lField);
  const makeRect = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm',
      on: {
        click: () =>
          st.update(['tank', 'structure'], () => {
            const pp = P(ctx);
            pp.outline = rectangle(Math.max(1, rw), Math.max(1, rl));
            if (pp.floor.type === 'vertices') pp.floor.heights = [0, 0, 0, 0];
          }),
      },
    },
    icon('target', 15),
    'Make rectangle',
  );
  const areaNote = note(() => {
    const dd = ctx.derived();
    if (dd.kind !== 'pit') return '';
    const m = dd.pit;
    const c = centroid(m.outline);
    return `Plan area ${plain(m.area / 1e6, 3)} m², perimeter ${fmtLen(perimeter(m.outline), u())}, centre at X ${fmtLen(c.x, u(), false, u() === 'mm' ? 0 : undefined)}, Y ${fmtLen(c.y, u(), true, u() === 'mm' ? 0 : undefined)}. Corners go around the outline in order; the top view below the sensors shows it.`;
  });
  fs.add(areaNote);
  return h(
    'div',
    { class: 'subsection profile-editor' },
    h('h4', { class: 'sub-title' }, 'Plan outline (inside of the walls)'),
    h(
      'table',
      { class: 'mini-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, '#'), h('th', null, `X (${unitLabel()})`), h('th', null, `Y (${unitLabel()})`), byVertex ? h('th', null, `Floor (${unitLabel()})`) : null, h('th', null, h('span', { class: 'sr-only' }, 'Remove'))),
      ),
      h('tbody', null, rows),
    ),
    rows.length < 3 ? h('p', { class: 'field-note is-error' }, 'At least three corners are needed.') : null,
    h('div', { class: 'add-btns' }, add),
    h('div', { class: 'field-grid' }, wField.el, lField.el),
    makeRect,
    areaNote.el,
  );
}

/** Sumps: rectangular pits in the floor, each with its position, size and depth. */
function sumpEditor(ctx: PanelCtx, fs: FieldSet): HTMLElement {
  const st = ctx.store;
  const u = () => st.project.units.length;
  const k = () => LENGTH[u()].k;
  const dp = () => LENGTH[u()].dp;
  const unitLabel = () => LENGTH[u()].label;
  const rows = P(ctx).sumps.map((_, i) => {
    const s = () => P(ctx).sumps[i];
    const cell = (label: string, key: keyof PitSump) =>
      cellInput({ label: `Sump ${i + 1} ${label}`, dp, get: () => (s()[key] as number) / k(), set: (v) => st.update(['tank'], () => ((s()[key] as number) = v * k())) });
    const cells = [cell('X', 'x'), cell('Y', 'y'), cell('size X', 'width'), cell('size Y', 'length'), cell('depth', 'depth')];
    cells.forEach((c) => fs.add(c));
    const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove sump ${i + 1}`, on: { click: () => st.update(['tank', 'structure'], () => P(ctx).sumps.splice(i, 1)) } }, icon('trash', 15));
    const poly = s().outline ? h('span', { class: 'field-note' }, 'polygon') : null;
    return h('tr', null, h('td', { class: 'num' }, String(i + 1)), ...cells.map((c) => h('td', null, c.el)), h('td', null, poly, del));
  });
  const add = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      on: {
        click: () =>
          st.update(['tank', 'structure'], () => {
            const dd = ctx.derived();
            const c = dd.kind === 'pit' ? centroid(dd.pit.outline) : { x: 0, y: 0 };
            P(ctx).sumps.push({ x: Math.round(c.x), y: Math.round(c.y), width: 1000, length: 1000, depth: 300 });
          }),
      },
    },
    icon('plus', 15),
    'Add sump',
  );
  const noteEl = note(() => {
    const dd = ctx.derived();
    if (dd.kind !== 'pit' || !dd.pit.sumps.length) return '';
    return dd.pit.sumps.map((s, i) => `Sump ${i + 1}: bottom ${fmtLen(s.bottom, u())}, floor around it ${fmtLen(s.rim, u())} above the deepest point.`).join(' ');
  });
  fs.add(noteEl);
  return h(
    'div',
    { class: 'subsection profile-editor' },
    h('h4', { class: 'sub-title' }, 'Sumps'),
    rows.length
      ? h(
          'table',
          { class: 'mini-table' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, `X (${unitLabel()})`), h('th', null, `Y (${unitLabel()})`), h('th', null, `Size X`), h('th', null, `Size Y`), h('th', null, `Depth`), h('th', null, h('span', { class: 'sr-only' }, 'Remove')))),
          h('tbody', null, rows),
        )
      : h('p', { class: 'field-note' }, 'No sump: the floor goes straight to the walls. A sump is a pit in the floor, its depth below the floor around it; the deepest point of the storage is its bottom.'),
    h('div', { class: 'add-btns' }, add),
    noteEl.el,
  );
}

/** Capacities printed on the drawing at given levels, against the design. */
function checksEditor(ctx: PanelCtx, fs: FieldSet): HTMLElement {
  const st = ctx.store;
  const u = () => st.project.units.length;
  const vu = () => st.project.units.volume;
  const k = () => LENGTH[u()].k;
  const dp = () => LENGTH[u()].dp;
  const rows = P(ctx).checks.map((_, i) => {
    const c = () => P(ctx).checks[i];
    const level = cellInput({ label: `Check ${i + 1} level`, dp, get: () => c().level / k(), set: (v) => st.update(['tank'], () => (c().level = v * k())) });
    const litres = cellInput({ label: `Check ${i + 1} capacity`, dp: () => VOLUME[vu()].dp, get: () => c().litres / VOLUME[vu()].k, set: (v) => st.update(['tank'], () => (c().litres = v * VOLUME[vu()].k)) });
    fs.add(level);
    fs.add(litres);
    const design = h('td', { class: 'num' });
    const diff = h('td', { class: 'num' });
    fs.add({
      el: design,
      refresh: () => {
        const dd = ctx.derived();
        const r = dd.kind === 'pit' ? checkValues(dd.engine)[i] : undefined;
        design.textContent = r ? fmtVol(r.litres, vu(), false) : '—';
        diff.textContent = r && Number.isFinite(r.errorPct) ? `${r.errorPct > 0 ? '+' : ''}${plain(r.errorPct, 2)} %` : '—';
        diff.className = `num${r && !r.ok ? ' is-bad' : ''}`;
      },
    });
    const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove check ${i + 1}`, on: { click: () => st.update(['tank', 'structure'], () => P(ctx).checks.splice(i, 1)) } }, icon('trash', 15));
    return h('tr', null, h('td', { class: 'num' }, String(i + 1)), h('td', null, level.el), h('td', null, litres.el), design, diff, h('td', null, del));
  });
  const add = h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-sm', on: { click: () => st.update(['tank', 'structure'], () => P(ctx).checks.push({ level: P(ctx).wallHeight, litres: Math.round(ctx.derived().totalL) })) } },
    icon('plus', 15),
    'Add check value',
  );
  const warn = note(() => {
    const dd = ctx.derived();
    if (dd.kind !== 'pit') return '';
    const bad = checkValues(dd.engine).filter((r) => !r.ok);
    return bad.length ? `${bad.length} check value${bad.length === 1 ? ' differs' : 's differ'} from the design by more than 0.5 %. Check the plan corners, the floor slope and the wall height against the drawing.` : '';
  }, 'warn');
  fs.add(warn);
  return h(
    'div',
    { class: 'subsection profile-editor' },
    h('h4', { class: 'sub-title' }, 'Check values from the drawing'),
    rows.length
      ? h(
          'table',
          { class: 'mini-table' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, `Level (${LENGTH[u()].label})`), h('th', null, `Drawing (${VOLUME[vu()].label})`), h('th', null, 'Design'), h('th', null, 'Diff.'), h('th', null, h('span', { class: 'sr-only' }, 'Remove')))),
          h('tbody', null, rows),
        )
      : h('p', { class: 'field-note' }, 'No check values. If the drawing gives the capacity at some levels (for example at the operation level), type them here to check the design.'),
    h('div', { class: 'add-btns' }, add),
    warn.el,
  );
}
