import { sensorColor } from '../app/colors';
import { SENSOR_KINDS, defaultSensor, isPressureSensor, isTopSensor, nextColorSlot, nextTag } from '../core/defaults';
import type { Derived } from '../core/derive';
import { STATUS_TEXT, digitalFactor, verticalSpan } from '../core/sensors';
import type { SensorConfig, SensorKind } from '../core/types';
import { G, LENGTH, PRESSURE, fmtLen, fmtVol, plain, type LengthUnit } from '../core/units';
import { h, icon } from './dom';
import { calBadge, calibrationBlock, sensorConversion } from './calPanel';
import { manholeCards, manholesOf, newManhole } from './manholePanel';
import { FieldSet, explain, lengthField, numField, plainField, pressureField, segmented, selectField, textField, toggleField, type Field } from './fields';
import type { PlanView } from './planView';
import type { PanelCtx } from './tankPanel';

const KIND_OPTIONS: { value: SensorKind; label: string }[] = (Object.keys(SENSOR_KINDS) as SensorKind[]).map((k) => ({
  value: k,
  label: SENSOR_KINDS[k].label,
}));

/** ISA-style instrument balloon: function letters over loop number. */
export function isaBalloon(tag: string, color: string, size: 'sm' | 'md' = 'md'): HTMLElement {
  const [fn, ...rest] = tag.split('-');
  return h(
    'span',
    { class: `isa isa-${size}${rest.length ? '' : ' single'}`, style: `--tag-color:${color}`, 'aria-hidden': 'true' },
    h('span', { class: 'isa-fn' }, rest.length ? fn : tag),
    rest.length ? h('span', { class: 'isa-loop' }, rest.join('-')) : null,
  );
}

const MH2O_RANGES = [0.5, 1, 2, 3, 4, 5, 6, 10, 15, 20, 30, 50, 100];

/** Places a new sensor sensibly for this tank. */
export function newSensor(kind: SensorKind, d: Derived, existing: SensorConfig[]): SensorConfig {
  const s = defaultSensor(kind, nextTag(existing, kind));
  s.colorSlot = nextColorSlot(existing);
  const m = d.model;
  const A = m.base.A;
  const B = m.base.B;
  // Candidate spots across the plan; take the one farthest from sensors already there.
  const spots: [number, number][] =
    m.orientation === 'vertical'
      ? [[0, 0], [0.45 * A, 0], [-0.45 * A, 0], [0, 0.45 * B], [0, -0.45 * B], [0.32 * A, 0.32 * B], [-0.32 * A, -0.32 * B], [-0.32 * A, 0.32 * B], [0.32 * A, -0.32 * B]]
      : [[0, 0], [0.3 * m.L, 0], [-0.3 * m.L, 0], [0.15 * m.L, 0], [-0.15 * m.L, 0], [0.45 * m.L, 0], [-0.45 * m.L, 0]];
  const pick = () => {
    let best = spots[0];
    let bestD = -1;
    for (const p of spots) {
      if (!verticalSpan(m, p[0], p[1])) continue;
      const dmin = existing.length ? Math.min(...existing.map((e) => Math.hypot(e.x - p[0], e.y - p[1]))) : Infinity;
      if (dmin > bestD + 1e-6) {
        bestD = dmin;
        best = p;
      }
    }
    return best;
  };
  if (isTopSensor(kind)) {
    [s.x, s.y] = pick().map((v) => Math.round(v)) as [number, number];
    // On a tank with manholes, a new top sensor goes on the first cover that has no sensor yet.
    const free = d.manholes.find((mg) => mg.ok && !existing.some((e) => e.faceMode === 'manhole' && e.manhole === mg.manhole.id));
    if (free) {
      s.faceMode = 'manhole';
      s.manhole = free.manhole.id;
      s.nozzle = 0;
      s.x = free.manhole.x;
      s.y = free.manhole.y;
    }
    s.maxRange = Math.max(s.maxRange, Math.ceil((d.depth * 1.1) / 500) * 500);
    s.rangeMax = s.signal === 'digital' ? s.rangeMax : Math.ceil((d.depth * 1.1) / 500) * 500;
  } else if (isPressureSensor(kind)) {
    const head = (d.depth / 1000) * (d.density / 1000) * 1.05;
    const r = MH2O_RANGES.find((x) => x >= head) ?? 100;
    s.rangeMax = r * 9806.65;
    [s.x, s.y] = pick().map((v) => Math.round(v)) as [number, number];
  } else {
    s.elevation = Math.round(d.depth * 0.9);
    [s.x, s.y] = pick().map((v) => Math.round(v)) as [number, number];
  }
  return s;
}

function retag(tag: string, from: SensorKind, to: SensorKind, high: boolean): string {
  const prefixOf = (k: SensorKind) => (k === 'switch' ? (high ? 'LSH' : 'LSL') : SENSOR_KINDS[k].prefix);
  const m = tag.match(/^([A-Z]+)-(.*)$/);
  if (!m) return tag;
  const known = ['LT', 'PT', 'LSH', 'LSL', 'LS'];
  return known.includes(m[1]) && prefixOf(from) !== prefixOf(to) ? `${prefixOf(to)}-${m[2]}` : tag;
}

function changeKind(s: SensorConfig, kind: SensorKind, d: Derived): void {
  const fresh = newSensor(kind, d, []);
  const keep = { id: s.id, x: s.x, y: s.y, colorSlot: s.colorSlot, enabled: s.enabled };
  // Top to top keeps the mounting (roof, manhole cover or typed face height).
  const mounting = isTopSensor(s.kind) && isTopSensor(kind) ? { faceMode: s.faceMode, manhole: s.manhole, nozzle: s.nozzle, faceHeight: s.faceHeight } : {};
  const tag = retag(s.tag, s.kind, kind, true);
  Object.assign(s, fresh, keep, mounting, { tag });
}

export function buildSensorPanel(ctx: PanelCtx, fs: FieldSet, open: Set<string>, plan: PlanView, select: (id: string | null) => void): HTMLElement {
  const st = ctx.store;
  const sensors = st.project.sensors;

  const add = (kind: SensorKind) => {
    const s = newSensor(kind, ctx.derived(), st.project.sensors);
    st.update(['sensors', 'structure'], (state) => {
      state.project.sensors.push(s);
      state.selected = s.id;
    });
  };
  const addManhole = () => {
    const mh = newManhole(ctx.derived(), manholesOf(st.project.tank));
    st.update(['sensors', 'structure'], (state) => {
      manholesOf(state.project.tank).push(mh);
      state.selected = mh.id;
    });
  };
  const addRow = h(
    'div',
    { class: 'add-row' },
    h('span', { class: 'field-label' }, 'Add sensor'),
    h('div', { class: 'add-btns' }, [
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => add('ultrasonic') } }, icon('plus', 16), 'Top'),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => add('pressure') } }, icon('plus', 16), 'Bottom'),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => add('switch') } }, icon('plus', 16), 'Switch'),
      h('button', { type: 'button', class: 'btn btn-quiet', title: 'Add a manhole (hole door) on the roof', on: { click: addManhole } }, icon('plus', 16), 'Manhole'),
    ]),
  );

  const cards = sensors.map((s) => sensorCard(ctx, fs, s, select));
  const mhCards = manholeCards(ctx, fs, select);
  const empty = sensors.length
    ? null
    : h('p', { class: 'empty-note' }, 'No sensors yet. Add a top sensor (ultrasonic, radar, laser) or a bottom pressure sensor, then drag it in the top view.');

  const sum = h('span', { class: 'section-sum' });
  const det = h(
    'details',
    { class: 'section', id: 'sec-sensors', open: open.has('sensors') },
    h('summary', null, h('span', { class: 'section-title' }, 'Sensors'), sum, icon('chevron', 16)),
    h(
      'div',
      { class: 'section-body' },
      explain(
        'Which sensor type to choose',
        [
          'Top (ultrasonic, radar, laser): mounted on the roof, measures the distance down to the liquid. Level = face height − distance. It cannot measure close to its face (dead band) or below the floor right under it.',
          'Bottom (pressure): mounted at or near the floor, measures the weight of the liquid above it. Level = sensing point + pressure ÷ (density × g). 1 m of water ≈ 9.8 kPa ≈ 98 mbar.',
          'Switch: a float or point switch that only says wet or dry at one height. Use it for high or low alarms.',
          'Manhole: the hole door on the roof. If a top sensor sits on the manhole cover, add the manhole, set its neck height, then choose "On a manhole" in the sensor. The sensor face is then the cover top + the sensor height above it.',
        ],
        'Drag a sensor in the top view below, or type its X / Y position. Click a sensor card to open its settings and its calibration.',
      ),
      plan.el,
      addRow,
      empty,
      mhCards.length ? h('div', { class: 'sensor-list' }, mhCards) : null,
      h('div', { class: 'sensor-list' }, cards),
    ),
  );
  det.addEventListener('toggle', () => {
    if (det.open) {
      open.add('sensors');
      plan.draw();
    } else open.delete('sensors');
  });
  fs.add({
    el: det,
    refresh: () => {
      const n = st.project.sensors.length;
      const nm = manholesOf(st.project.tank).length;
      const parts = [n ? `${n} sensor${n === 1 ? '' : 's'}` : '', nm ? `${nm} manhole${nm === 1 ? '' : 's'}` : ''].filter(Boolean);
      sum.textContent = parts.length ? parts.join(' · ') : 'none';
    },
  });
  return det;
}

function sensorCard(ctx: PanelCtx, fs: FieldSet, s0: SensorConfig, select: (id: string | null) => void): HTMLElement {
  const st = ctx.store;
  const id = s0.id;
  const S = () => st.project.sensors.find((x) => x.id === id)!;
  const selected = st.state.selected === id;
  const color = sensorColor(s0);
  const u = () => st.project.units.length as LengthUnit;
  const fid = (k: string) => `sn-${id}-${k}`;
  const top = isTopSensor(s0.kind);
  const pressure = isPressureSensor(s0.kind);

  const sub = h('span', { class: 'sensor-sub' });
  const statusDot = h('span', { class: 'status-dot' });
  const headBtn = h(
    'button',
    {
      type: 'button',
      class: 'sensor-select',
      'aria-expanded': String(selected),
      on: { click: () => select(selected ? null : id) },
    },
    isaBalloon(s0.tag, color),
    h('span', { class: 'sensor-titles' }, h('span', { class: 'sensor-name' }, SENSOR_KINDS[s0.kind].short), sub),
    statusDot,
  );
  const enabled = h('input', { type: 'checkbox', class: 'switch-input', id: fid('on'), role: 'switch', checked: s0.enabled });
  enabled.addEventListener('change', () => st.update(['sensors', 'structure'], () => (S().enabled = enabled.checked)));
  const actions = h(
    'div',
    { class: 'sensor-actions' },
    h('label', { class: 'switch mini', for: fid('on'), title: 'Sensor on / off' }, enabled, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, `${s0.tag} enabled`)),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        title: 'Duplicate sensor',
        'aria-label': `Duplicate ${s0.tag}`,
        on: {
          click: () => {
            const all = st.project.sensors;
            const copy: SensorConfig = { ...structuredClone(S()), id: defaultSensor(S().kind, '').id, tag: nextTag(all, S().kind, S().switchMode === 'high'), colorSlot: nextColorSlot(all) };
            copy.x = Math.round(copy.x + ctx.derived().model.size * 0.08);
            st.update(['sensors', 'structure'], (state) => {
              state.project.sensors.push(copy);
              state.selected = copy.id;
            });
          },
        },
      },
      icon('duplicate', 16),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        title: 'Remove sensor',
        'aria-label': `Remove ${s0.tag}`,
        on: { click: () => removeSensor?.(id) },
      },
      icon('trash', 16),
    ),
  );

  const card = h(
    'article',
    { class: `sensor-card${selected ? ' is-selected' : ''}${s0.enabled ? '' : ' is-off'}`, style: `--tag-color:${color}`, 'data-id': id },
    h('header', { class: 'sensor-head' }, headBtn, actions),
  );

  fs.add({
    el: card,
    refresh: () => {
      const s = S();
      if (!s) return;
      const g = ctx.derived().geoms.find((x) => x.sensor.id === id);
      const badge = calBadge(s, s.cal.method !== 'theory' ? sensorConversion(ctx, id) : null);
      sub.textContent = `${s.tag} · X ${fmtLen(s.x, u(), false, u() === 'mm' ? 0 : undefined)} · Y ${fmtLen(s.y, u(), false, u() === 'mm' ? 0 : undefined)}${badge ? ` · ${badge}` : ''}`;
      statusDot.className = `status-dot ${!s.enabled ? 'is-off' : g?.ok ? (g.warnings.length ? 'is-warn' : 'is-ok') : 'is-bad'}`;
      statusDot.title = !s.enabled ? 'Disabled' : g?.ok ? (g.warnings.length ? 'Placed, see notes' : 'Placed') : (g?.error ?? '');
    },
  });

  if (!selected) return card;

  // Expanded editor
  const items: Field[] = [];
  items.push(
    textField(ctx, { id: fid('tag'), label: 'Tag', get: () => S().tag, set: (v) => (S().tag = v), change: ['sensors'], maxLength: 16 }),
    selectField(ctx, {
      id: fid('kind'),
      label: 'Type',
      options: () => KIND_OPTIONS,
      get: () => S().kind,
      set: (v) => changeKind(S(), v, ctx.derived()),
      change: ['sensors', 'structure'],
    }),
  );
  const vert = st.project.tank.orientation === 'vertical';
  items.push(
    lengthField(ctx, { id: fid('x'), label: vert ? 'Position X (left–right)' : 'Position X (along length)', get: () => S().x, set: (v) => (S().x = v), change: ['sensors'] }),
    lengthField(ctx, { id: fid('y'), label: vert ? 'Position Y (front–back)' : 'Position Y (across)', get: () => S().y, set: (v) => (S().y = v), change: ['sensors'] }),
  );

  if (top) {
    items.push(
      segmented(ctx, {
        id: fid('facemode'),
        label: 'Sensor face height',
        options: [
          { value: 'auto', label: 'On the roof' },
          { value: 'manhole', label: 'On a manhole' },
          { value: 'manual', label: 'Type it in' },
        ],
        get: () => S().faceMode,
        set: (v) => {
          const s = S();
          const dd = ctx.derived();
          const g = dd.geoms.find((x) => x.sensor.id === id);
          if (v === 'manual' && s.faceMode !== 'manual') {
            if (g?.ok) s.faceHeight = Math.round(g.faceHeightUntilted);
          }
          if (v === 'auto' && s.faceMode === 'manhole' && g?.ok && g.manhole) {
            // Keep the face where it is: the nozzle now counts from the roof.
            s.nozzle = Math.round(g.manhole.neckHeight + s.nozzle);
          }
          if (v === 'manhole' && s.faceMode !== 'manhole') {
            const list = manholesOf(st.project.tank);
            let mh = list.find((m) => m.id === s.manhole);
            if (!mh && list.length) {
              // The manhole nearest to the sensor.
              mh = list.reduce((a, b) => (Math.hypot(b.x - s.x, b.y - s.y) < Math.hypot(a.x - s.x, a.y - s.y) ? b : a));
            }
            if (!mh) {
              mh = newManhole(dd, list, { x: s.x, y: s.y });
              list.push(mh);
            }
            s.manhole = mh.id;
            s.x = mh.x;
            s.y = mh.y;
            s.nozzle = 0;
          }
          s.faceMode = v;
        },
        change: ['sensors', 'structure'],
      }),
    );
    if (S().faceMode === 'manhole') {
      items.push(
        selectField(ctx, {
          id: fid('mh'),
          label: 'Manhole',
          options: () => manholesOf(st.project.tank).map((m) => ({ value: m.id, label: m.tag })),
          get: () => S().manhole ?? '',
          set: (v) => {
            const s = S();
            const mh = manholesOf(st.project.tank).find((m) => m.id === v);
            s.manhole = v;
            if (mh) {
              s.x = mh.x;
              s.y = mh.y;
            }
          },
          change: ['sensors'],
        }),
        lengthField(ctx, {
          id: fid('nozzle'),
          label: 'Sensor face above cover top',
          hint: 'Height of the sensor face above the top of the manhole cover. Negative when the face is below the cover top, for example −10 mm for a face flush with the underside of a 10 mm cover.',
          min: -5000,
          get: () => S().nozzle,
          set: (v) => (S().nozzle = v),
          change: ['sensors'],
          note: () => {
            const g = ctx.derived().geoms.find((x) => x.sensor.id === id);
            return g?.ok && g.manhole ? `Cover top ${fmtLen(g.manhole.coverHeight, u())} · face ${fmtLen(g.faceLevel, u())} above level zero` : '';
          },
        }),
      );
    } else if (S().faceMode === 'auto') {
      items.push(
        lengthField(ctx, {
          id: fid('nozzle'),
          label: 'Nozzle / stand-off',
          min: -5000,
          get: () => S().nozzle,
          set: (v) => (S().nozzle = v),
          change: ['sensors'],
          note: () => {
            const g = ctx.derived().geoms.find((x) => x.sensor.id === id);
            return g?.ok ? `Face ${fmtLen(g.faceLevel, u())} above level zero` : '';
          },
        }),
      );
    } else {
      items.push(
        lengthField(ctx, { id: fid('face'), label: 'Face above level zero', min: 0, get: () => S().faceHeight, set: (v) => (S().faceHeight = v), change: ['sensors'] }),
      );
    }
    items.push(
      lengthField(ctx, { id: fid('dead'), label: 'Dead band', min: 0, get: () => S().deadBand, set: (v) => (S().deadBand = v), change: ['sensors'] }),
      lengthField(ctx, { id: fid('range'), label: 'Max range', min: 1, get: () => S().maxRange, set: (v) => (S().maxRange = v), change: ['sensors'] }),
      plainField(ctx, { id: fid('beam'), label: 'Beam angle', unit: '°', dp: 1, min: 0.5, max: 170, step: 1, get: () => S().beamAngle, set: (v) => (S().beamAngle = v), change: ['sensors'] }),
    );
  } else if (s0.kind === 'pressure') {
    items.push(lengthField(ctx, { id: fid('elev'), label: 'Height above floor', min: 0, get: () => S().elevation, set: (v) => (S().elevation = v), change: ['sensors'] }));
  } else if (s0.kind === 'submersible') {
    items.push(lengthField(ctx, { id: fid('elev'), label: 'Probe above level zero', min: 0, get: () => S().elevation, set: (v) => (S().elevation = v), change: ['sensors'] }));
  } else {
    items.push(
      lengthField(ctx, { id: fid('elev'), label: 'Switch above level zero', min: 0, get: () => S().elevation, set: (v) => (S().elevation = v), change: ['sensors'] }),
      segmented(ctx, {
        id: fid('swmode'),
        label: 'Alarm when liquid is',
        options: [
          { value: 'high', label: 'At or above (high)' },
          { value: 'low', label: 'Below (low)' },
        ],
        get: () => S().switchMode,
        set: (v) => {
          const s = S();
          s.switchMode = v;
          s.tag = s.tag.replace(/^LS[HL]?-/, v === 'high' ? 'LSH-' : 'LSL-');
        },
        change: ['sensors', 'structure'],
      }),
    );
  }

  const outputItems: Field[] = [];
  if (s0.kind !== 'switch') {
    outputItems.push(
      segmented(ctx, {
        id: fid('signal'),
        label: 'Output signal',
        options: [
          { value: 'digital', label: 'Digital' },
          { value: 'current', label: '4–20 mA' },
          { value: 'voltage', label: 'Voltage' },
        ],
        get: () => S().signal,
        set: (v) => {
          const s = S();
          s.signal = v;
          if (v === 'current') {
            s.outMin = 4;
            s.outMax = 20;
            if (s.adcBits > 0) s.shunt = 150;
          } else if (v === 'voltage') {
            s.outMin = 0;
            s.outMax = 10;
            s.divider = 0.33;
          }
          if (v !== 'digital' && !isPressureSensor(s.kind) && s.rangeMax <= s.rangeMin) s.rangeMax = s.maxRange;
        },
        change: ['sensors', 'structure'],
      }),
    );
    const s = S();
    if (s.signal === 'digital') {
      const unitOpts = pressure
        ? (Object.keys(PRESSURE) as (keyof typeof PRESSURE)[]).map((k) => ({ value: k as string, label: PRESSURE[k].label }))
        : (Object.keys(LENGTH) as LengthUnit[]).map((k) => ({ value: k as string, label: LENGTH[k].label }));
      outputItems.push(
        selectField(ctx, {
          id: fid('dunit'),
          label: 'Reports in',
          options: () => unitOpts,
          get: () => S().digitalUnit,
          set: (v) => (S().digitalUnit = v),
          change: ['sensors'],
        }),
        numField({
          id: fid('res'),
          label: 'Resolution',
          unit: () => S().digitalUnit,
          get: () => S().resolution / digitalFactor(S()),
          set: (v) => st.update(['sensors'], () => (S().resolution = Math.max(0, v) * digitalFactor(S()))),
          dp: () => 6,
          min: () => 0,
          step: () => 1,
        }),
      );
    } else {
      const sigUnit = s.signal === 'current' ? 'mA' : 'V';
      const what = pressure ? 'Pressure' : 'Distance';
      if (pressure) {
        outputItems.push(
          pressureField(ctx, { id: fid('rmin'), label: `${what} at ${s.invert ? 'max' : 'min'} signal`, get: () => S().rangeMin, set: (v) => (S().rangeMin = v), change: ['sensors'] }),
          pressureField(ctx, { id: fid('rmax'), label: `${what} at ${s.invert ? 'min' : 'max'} signal`, get: () => S().rangeMax, set: (v) => (S().rangeMax = v), change: ['sensors'] }),
        );
      } else {
        outputItems.push(
          lengthField(ctx, { id: fid('rmin'), label: `${what} at ${s.invert ? 'max' : 'min'} signal`, get: () => S().rangeMin, set: (v) => (S().rangeMin = v), change: ['sensors'] }),
          lengthField(ctx, { id: fid('rmax'), label: `${what} at ${s.invert ? 'min' : 'max'} signal`, get: () => S().rangeMax, set: (v) => (S().rangeMax = v), change: ['sensors'] }),
        );
      }
      outputItems.push(
        plainField(ctx, { id: fid('omin'), label: 'Signal min', unit: sigUnit, dp: 3, step: 0.1, get: () => S().outMin, set: (v) => (S().outMin = v), change: ['sensors'] }),
        plainField(ctx, { id: fid('omax'), label: 'Signal max', unit: sigUnit, dp: 3, step: 0.1, get: () => S().outMax, set: (v) => (S().outMax = v), change: ['sensors'] }),
        toggleField(ctx, {
          id: fid('inv'),
          label: pressure ? 'Inverted (max signal at zero pressure)' : 'Inverted (max signal when close = full tank)',
          get: () => S().invert,
          set: (v) => (S().invert = v),
          change: ['sensors', 'structure'],
        }),
        toggleField(ctx, {
          id: fid('adc'),
          label: 'Read through an ADC',
          get: () => S().adcBits > 0,
          set: (v) => (S().adcBits = v ? 12 : 0),
          change: ['sensors', 'structure'],
        }),
      );
      if (s.adcBits > 0) {
        outputItems.push(
          plainField(ctx, { id: fid('bits'), label: 'ADC bits', unit: 'bit', dp: 0, min: 1, max: 24, step: 1, get: () => S().adcBits, set: (v) => (S().adcBits = Math.round(v)), change: ['sensors'] }),
          plainField(ctx, { id: fid('vref'), label: 'ADC reference', unit: 'V', dp: 3, min: 0.1, max: 50, step: 0.1, get: () => S().adcVref, set: (v) => (S().adcVref = v), change: ['sensors'] }),
        );
        if (s.signal === 'current') {
          outputItems.push(
            plainField(ctx, {
              id: fid('shunt'),
              label: 'Shunt resistor',
              unit: 'Ω',
              dp: 1,
              min: 1,
              max: 10000,
              step: 1,
              get: () => S().shunt,
              set: (v) => (S().shunt = v),
              change: ['sensors'],
              note: () => {
                const v = (S().outMax / 1000) * S().shunt;
                return v > S().adcVref ? `${plain(S().outMax, 1)} mA gives ${plain(v, 2)} V: above the ADC reference.` : `${plain(S().outMax, 1)} mA → ${plain(v, 3)} V at the pin`;
              },
            }),
          );
        } else {
          outputItems.push(
            plainField(ctx, {
              id: fid('div'),
              label: 'Divider ratio',
              unit: '×',
              dp: 4,
              min: 0.0001,
              max: 1,
              step: 0.01,
              get: () => S().divider,
              set: (v) => (S().divider = v),
              change: ['sensors'],
              note: () => `${plain(S().outMax, 2)} V → ${plain(S().outMax * S().divider, 3)} V at the pin`,
            }),
          );
        }
      }
    }
    outputItems.push(
      lengthField(ctx, {
        id: fid('noise'),
        label: 'Noise (1σ)',
        hint: 'Random reading noise used when "Noise" is on in the playback bar, as millimetres of liquid.',
        min: 0,
        get: () => S().noise,
        set: (v) => (S().noise = v),
        change: ['sensors'],
      }),
    );
  }

  const info = h('div', { class: 'sensor-info' });
  const infoField: Field = {
    el: info,
    refresh: () => {
      const dd = ctx.derived();
      const g = dd.geoms.find((x) => x.sensor.id === id);
      info.replaceChildren();
      if (!g) return;
      if (!g.ok) {
        info.append(h('p', { class: 'panel-note note-error' }, g.error ?? 'Not placed.'));
        return;
      }
      const vu = st.project.units.volume;
      const e = dd.engine;
      const rows: [string, string][] = [];
      if (g.mount === 'top') {
        if (g.manhole) rows.push([`${g.manhole.manhole.tag} cover top`, fmtLen(g.manhole.coverHeight, u())]);
        rows.push(['Face above level zero', fmtLen(g.faceLevel, u())], ['Floor below sensor', fmtLen(g.floorLevel, u())]);
      } else {
        rows.push(['Sensing point', fmtLen(g.faceLevel, u())]);
      }
      if (g.mount !== 'point') {
        rows.push(
          ['Measures levels', `${fmtLen(g.validMin, u(), false)} – ${fmtLen(g.validMax, u())}`],
          ['Volume range', `${fmtVol(e.litres(g.validMin), vu, false)} – ${fmtVol(e.litres(g.validMax), vu)}`],
        );
        if (isPressureSensor(g.sensor.kind)) {
          const pu = st.project.units.pressure;
          rows.push(['Pressure per mm', `${plain((dd.density * G) / 1000 / PRESSURE[pu].k, 6)} ${PRESSURE[pu].label}`]);
        }
      } else {
        rows.push(['Switch volume', fmtVol(e.litres(g.faceLevel), vu)]);
      }
      info.append(h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      for (const w of g.warnings) info.append(h('p', { class: 'panel-note note-warn' }, w));
    },
  };

  [...items, ...outputItems].forEach((f) => fs.add(f));
  fs.add(infoField);
  const placeHelp = top
    ? explain(
        'Face height, dead band and range',
        [
          'Face height: where the sensor measures from. On the roof it is the roof height at this position + roof plate + nozzle. A domed or cone roof is higher in the middle than at the edge.',
          'On a manhole: the face is the top of the manhole cover + the sensor height above it. Set the manhole neck height (roof to cover top) in its card, or its cover height above level zero.',
          'Dead band: the sensor cannot see liquid closer than this to its face (typical 150–300 mm for ultrasonic, 50–100 mm for radar). The top of the tank above that cannot be measured.',
          'Max range: the farthest it can measure. Beam angle: the width of the cone; a wide beam close to a wall can give false echoes.',
        ],
      )
    : pressure
      ? explain(
          'Sensing point and density',
          'The pressure sensor only feels liquid above its sensing point. If it sits 40 mm above the floor, the bottom 40 mm reads as zero. The density changes the reading: diesel (832 kg/m³) gives 17 % less pressure than water for the same level.',
        )
      : null;
  const outHelp =
    s0.kind !== 'switch'
      ? explain(
          'What your script reads',
          [
            'Digital: the sensor sends a number (for example distance in mm over RS-485 / Modbus).',
            '4–20 mA: the current is 4 mA at the start of the range and 20 mA at the end. Through a 150 Ω shunt this is 0.6–3.0 V at the ADC pin.',
            'Voltage: for example 0–10 V, often with a divider to bring it down to the ADC range.',
            'ADC: if your board reads the signal with an ADC, the script gets counts (0–4095 for 12 bit). The export then gives the formula directly in counts.',
          ],
        )
      : null;
  card.append(
    h(
      'div',
      { class: 'sensor-body' },
      placeHelp,
      h('div', { class: 'field-grid' }, items.map((f) => f.el)),
      s0.kind !== 'switch' ? h('h4', { class: 'sub-title' }, 'Output to your script') : null,
      outHelp,
      outputItems.length ? h('div', { class: 'field-grid' }, outputItems.map((f) => f.el)) : null,
      info,
      s0.kind !== 'switch' ? calibrationBlock(ctx, fs, id) : null,
    ),
  );
  return card;
}

export let removeSensor: ((id: string) => void) | null = null;
export function setRemoveSensor(fn: (id: string) => void) {
  removeSensor = fn;
}

export { STATUS_TEXT };
