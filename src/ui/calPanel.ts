import { CAL_METHODS } from '../core/fieldcal';
import type { SensorGeom } from '../core/sensors';
import type { CalMethod, SensorConfig } from '../core/types';
import { LENGTH, VOLUME, fmtLen, fmtVol, plain } from '../core/units';
import { conversionFor, rawDp, type Conversion } from '../export/shared';
import { h, icon } from './dom';
import { FieldSet, cellInput, explain, note, segmented, type Field } from './fields';
import type { PanelCtx } from './tankPanel';

/** The sensor's raw → level conversion with its field calibration, or null when it cannot measure. */
export function sensorConversion(ctx: PanelCtx, id: string): Conversion | null {
  const d = ctx.derived();
  const g = d.geoms.find((x) => x.sensor.id === id);
  if (!g || !g.ok || g.mount === 'point' || !(g.validMax > g.validMin)) return null;
  const c = conversionFor(g, d.density, 'sensor', d.engine);
  return Number.isFinite(c.A) && Number.isFinite(c.B) && c.B !== 0 ? c : null;
}

/** Short status for the sensor card subtitle. */
export function calBadge(s: SensorConfig, c: Conversion | null): string {
  if (s.kind === 'switch' || s.cal.method === 'theory') return '';
  const m = CAL_METHODS.find((x) => x.value === s.cal.method)!;
  return c?.cal?.active ? `${m.short} calibrated` : `${m.short}: needs points`;
}

export function calibrationBlock(ctx: PanelCtx, fs: FieldSet, id: string): HTMLElement {
  const st = ctx.store;
  const S = () => st.project.sensors.find((x) => x.id === id)!;
  const cal = () => S().cal;
  const method = cal().method;
  const fid = (k: string) => `sn-${id}-cal-${k}`;
  const items: Field[] = [];

  items.push(
    segmented(ctx, {
      id: fid('method'),
      label: 'Calibration type',
      options: CAL_METHODS.map((m) => ({ value: m.value, label: m.short })),
      get: () => cal().method,
      set: (v: CalMethod) => (cal().method = v),
      change: ['sensors', 'structure'],
    }),
    note(() => CAL_METHODS.find((m) => m.value === cal().method)?.text ?? ''),
  );

  const help = explain(
    'How to take a reference point',
    'A reference point is one moment where you know the true liquid level (or the true volume) and you also read the raw value your script gets from the sensor.',
    [
      'Stop filling and wait until the surface is calm (no foam, no waves).',
      'Measure the true level from level zero (the lowest inside point) with a dipstick, tape or sight glass. Or use a known volume: for example, fill exactly 500 L through a flow meter into the empty tank.',
      'At the same time write down the raw value: distance, pressure, mA, V or ADC counts, in the same unit your script reads.',
      'Take points low and high in the range. For a 2-point calibration use about 10–20 % and 80–90 % of the level.',
    ],
    'Tip: set the sight glass in the 3D view to the true level and press “Add point at the simulated level”. The app fills in the raw value a perfect sensor would read there; change it to what your real sensor shows.',
  );

  const conv = sensorConversion(ctx, id);
  const body: (HTMLElement | null)[] = [];
  if (method !== 'theory') {
    items.push(
      segmented(ctx, {
        id: fid('ref'),
        label: 'True value measured as',
        options: [
          { value: 'level', label: 'Level' },
          { value: 'volume', label: 'Volume' },
        ],
        get: () => cal().ref,
        set: (v) => {
          // Keep the points meaning the same physical state when switching.
          const e = ctx.derived().engine;
          const c = cal();
          if (v === c.ref) return;
          c.points = c.points.map((p) => ({
            raw: p.raw,
            ref: !Number.isFinite(p.ref) ? NaN : v === 'volume' ? e.litres(Math.min(Math.max(p.ref, 0), e.depth)) : e.levelOf(Math.max(0, p.ref) * 1e6),
          }));
          c.ref = v;
        },
        change: ['sensors', 'structure'],
      }),
      note(() =>
        cal().ref === 'level'
          ? 'Level: height of the liquid above level zero (the lowest inside point), from a dipstick, tape or sight glass.'
          : 'Volume: liquid in the tank, from a flow meter or known fills (for example 10 × 200 L drums). The app turns it into a level with the tank shape.',
      ),
    );
    if (!conv) {
      body.push(h('p', { class: 'panel-note note-warn' }, 'Place the sensor so it can measure first: calibration needs a working formula from the drawing.'));
    } else {
      body.push(pointsTable(ctx, fs, id, conv));
    }
  }
  items.forEach((f) => fs.add(f));
  return h(
    'div',
    { class: 'cal-block' },
    h('h4', { class: 'sub-title' }, 'Calibration'),
    h('div', { class: 'field-grid' }, items.map((f) => f.el)),
    method !== 'theory' ? help : null,
    body,
  );
}

function pointsTable(ctx: PanelCtx, fs: FieldSet, id: string, conv0: Conversion): HTMLElement {
  const st = ctx.store;
  const S = () => st.project.sensors.find((x) => x.id === id)!;
  const cal = () => S().cal;
  const lu = () => st.project.units.length;
  const vu = () => st.project.units.volume;
  const byLevel = cal().ref === 'level';
  const refK = () => (byLevel ? LENGTH[lu()].k : VOLUME[vu()].k);
  const refDp = () => (byLevel ? LENGTH[lu()].dp : VOLUME[vu()].dp);
  const refUnit = () => (byLevel ? LENGTH[lu()].label : VOLUME[vu()].label);
  const rawUnit = conv0.rawUnit;
  const conv = () => sensorConversion(ctx, id);

  const rows = cal().points.map((_, i) => {
    const pt = () => cal().points[i];
    const raw = cellInput({ label: `Point ${i + 1} raw value`, dp: () => rawDp(conv0) + 1, placeholder: rawUnit, get: () => pt().raw, set: (v) => st.update(['sensors'], () => (pt().raw = v)) });
    const ref = cellInput({ label: `Point ${i + 1} true ${byLevel ? 'level' : 'volume'}`, dp: refDp, placeholder: refUnit(), get: () => pt().ref / refK(), set: (v) => st.update(['sensors'], () => (pt().ref = v * refK())) });
    const drawing = h('td', { class: 'num' });
    const err = h('td', { class: 'num' });
    const row = h(
      'tr',
      null,
      h('td', { class: 'num' }, String(i + 1)),
      h('td', null, raw.el),
      h('td', null, ref.el),
      drawing,
      err,
      h(
        'td',
        null,
        h(
          'button',
          { type: 'button', class: 'icon-btn', 'aria-label': `Remove point ${i + 1}`, on: { click: () => st.update(['sensors', 'structure'], () => cal().points.splice(i, 1)) } },
          icon('trash', 15),
        ),
      ),
    );
    fs.add(raw);
    fs.add(ref);
    fs.add({
      el: row,
      refresh: () => {
        const c = conv();
        const p = pt();
        if (!c || !p) return;
        const th = c.theoryA + c.theoryB * p.raw;
        drawing.textContent = Number.isFinite(th) ? fmtLen(th, lu(), false) : '—';
        const r = c.cal?.residuals.find((x) => x.index === i);
        const used = !!r?.used;
        row.classList.toggle('is-unused', !!c.cal?.active && !used);
        err.textContent = r && Number.isFinite(r.error) && c.cal?.active ? `${r.error >= 0 ? '+' : ''}${fmtLen(r.error, lu(), false)}` : '—';
        err.title = r && Number.isFinite(r.volumeError) ? `${fmtVol(r.volumeError, vu())} at this point` : '';
      },
    });
    return row;
  });

  const add = h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-sm', on: { click: () => st.update(['sensors', 'structure'], () => cal().points.push({ raw: NaN, ref: NaN })) } },
    icon('plus', 15),
    'Add point',
  );
  const addSim = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      on: {
        click: () => {
          const c = conv();
          if (!c) return;
          const e = ctx.derived().engine;
          const level = st.state.sim.level;
          // Raw value a sensor exactly as drawn would give at this level.
          const raw = (level - c.theoryA) / c.theoryB;
          const ref = cal().ref === 'level' ? level : e.litres(level);
          st.update(['sensors', 'structure'], () => cal().points.push({ raw: Number(plain(raw, rawDp(c) + 2)), ref }));
        },
      },
    },
    icon('crosshair', 15),
    'Add point at the simulated level',
  );

  const result = h('div', { class: 'cal-result', role: 'status' });
  fs.add({
    el: result,
    refresh: () => {
      const c = conv();
      result.replaceChildren();
      if (!c || !c.cal) return;
      const f = c.cal;
      const g: SensorGeom = c.geom;
      if (!f.active) {
        result.append(h('p', { class: 'panel-note note-warn' }, `${f.error} Until then the exports use the formula from the drawing.`));
      } else {
        const k = 1 / LENGTH[lu()].k;
        const shift = f.shiftAtMid;
        const lines: [string, string][] = [
          [
            'Correction at mid range',
            Math.abs(shift) < 0.05 ? 'none: the sensor agrees with the drawing' : `${shift > 0 ? '+' : ''}${fmtLen(shift, lu())} (${shift > 0 ? 'higher' : 'lower'} than the drawing)`,
          ],
          ['Span', `${plain(f.beta * 100, 2)} % of the drawing`],
          ['Largest error left', `${fmtLen(f.maxError, lu())} ≈ ${fmtVol(f.maxVolumeError, vu())}`],
          ['Calibrated formula', `level = ${sig(c.A * k)} + (${sig(c.B * k)}) × raw  (${LENGTH[lu()].label}, raw in ${c.rawUnit})`],
          ['Drawing formula', `level = ${sig(c.theoryA * k)} + (${sig(c.theoryB * k)}) × raw`],
        ];
        result.append(h('dl', { class: 'kv' }, lines.map(([a, b]) => [h('dt', null, a), h('dd', null, b)])));
        if (g.mount === 'top' && Math.abs(f.beta - 1) < 0.002 && Math.abs(shift) >= 0.5) {
          result.append(
            h('p', { class: 'panel-note' }, `In plain words: the sensor face is about ${fmtLen(Math.abs(shift), lu())} ${shift >= 0 ? 'higher' : 'lower'} than the drawing shows (or the level zero is off by that much).`),
          );
        }
        result.append(h('p', { class: 'panel-note' }, 'The configuration and payload scripts and the table now use the calibrated formula.'));
      }
      for (const w of f.warnings) result.append(h('p', { class: 'panel-note note-warn' }, w));
    },
  });

  return h(
    'div',
    { class: 'subsection cal-points' },
    h(
      'table',
      { class: 'mini-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, '#'),
          h('th', null, `Raw (${rawUnit})`),
          h('th', null, `True ${byLevel ? 'level' : 'volume'} (${refUnit()})`),
          h('th', { title: 'Level the formula from the drawing gives for this raw value' }, `Drawing (${LENGTH[lu()].label})`),
          h('th', { title: 'Calibrated level minus true level' }, `Error (${LENGTH[lu()].label})`),
          h('th', null, h('span', { class: 'sr-only' }, 'Remove')),
        ),
      ),
      h('tbody', null, rows),
    ),
    rows.length ? null : h('p', { class: 'field-note' }, 'No reference points yet.'),
    h('div', { class: 'btn-row' }, add, addSim),
    result,
  );
}

function sig(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return String(Number(v.toPrecision(7)));
}
