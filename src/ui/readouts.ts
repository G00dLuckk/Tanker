import { sensorColor } from '../app/colors';
import { SENSOR_KINDS, isPressureSensor } from '../core/defaults';
import { STATUS_TEXT, digitalFactor, hasAdc, hasAnalog, signalUnit, type Reading, type SensorStatus } from '../core/sensors';
import { MM3_TO_L, PRESSURE, fmt, fmtLen, fmtPres, fmtVol, plain } from '../core/units';
import { h, icon } from './dom';
import { isaBalloon } from './sensorPanel';
import type { PanelCtx } from './tankPanel';

interface LiveCard {
  id: string;
  el: HTMLElement;
  pill: HTMLElement;
  main: HTMLElement;
  mainUnit: HTMLElement;
  what: HTMLElement;
  rows: Record<string, HTMLElement>;
}

const STATUS_KIND: Record<SensorStatus, 'good' | 'warning' | 'critical' | 'neutral'> = {
  ok: 'good',
  deadband: 'warning',
  floor: 'warning',
  range: 'warning',
  over: 'warning',
  submerged: 'critical',
  dry: 'neutral',
  wet: 'neutral',
  off: 'neutral',
  error: 'critical',
};

export class Readouts {
  readonly el: HTMLElement;
  private heroValue = h('span', { class: 'hero-num' });
  private heroUnit = h('span', { class: 'hero-unit' });
  private heroSub = h('div', { class: 'hero-sub' });
  private meterFill = h('div', { class: 'meter-fill' });
  private meterMark = h('div', { class: 'meter-mark', hidden: true });
  private meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Fill level', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.meterFill, this.meterMark);
  private stat: Record<string, HTMLElement> = {};
  private list = h('div', { class: 'live-list' });
  private cards: LiveCard[] = [];

  constructor(
    private ctx: PanelCtx,
    private onSelect: (id: string) => void,
  ) {
    const stat = (k: string, label: string) => {
      this.stat[k] = h('dd', null);
      return h('div', null, h('dt', null, label), this.stat[k]);
    };
    const hero = h(
      'section',
      { class: 'card hero', 'aria-live': 'off' },
      h('div', { class: 'card-label' }, 'Liquid in the tank'),
      h('div', { class: 'hero-value' }, this.heroValue, this.heroUnit),
      this.heroSub,
      this.meter,
      h('dl', { class: 'stats' }, stat('level', 'Level'), stat('fill', 'Fill'), stat('ullage', 'Space left'), stat('mass', 'Liquid mass')),
    );
    this.el = h('div', { class: 'readouts' }, hero, h('section', { class: 'card' }, h('div', { class: 'card-label' }, 'Sensor readings'), this.list));
  }

  /** Recreates the sensor cards (after sensors change). */
  rebuild() {
    const st = this.ctx.store;
    this.cards = [];
    const sensors = st.project.sensors;
    if (!sensors.length) {
      this.list.replaceChildren(h('p', { class: 'empty-note' }, 'Add a sensor in the Sensors section to see what it reads at this level.'));
      return;
    }
    this.list.replaceChildren(
      ...sensors.map((s) => {
        const pill = h('span', { class: 'pill' });
        const main = h('span', { class: 'live-num' });
        const mainUnit = h('span', { class: 'live-unit' });
        const what = h('span', { class: 'live-what' });
        const rows: Record<string, HTMLElement> = {};
        const row = (k: string, label: string) => {
          rows[k] = h('dd', null);
          return h('div', { class: 'live-row', 'data-k': k }, h('dt', null, label), rows[k]);
        };
        const el = h(
          'article',
          {
            class: `live-card${st.state.selected === s.id ? ' is-selected' : ''}`,
            style: `--tag-color:${sensorColor(s)}`,
            tabindex: '0',
            'aria-label': `${s.tag} readings`,
            on: {
              click: () => this.onSelect(s.id),
              keydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  this.onSelect(s.id);
                }
              },
            },
          },
          h('header', { class: 'live-head' }, isaBalloon(s.tag, sensorColor(s), 'sm'), h('span', { class: 'live-kind' }, SENSOR_KINDS[s.kind].short), pill),
          h('div', { class: 'live-main' }, main, mainUnit, what),
          h(
            'dl',
            { class: 'live-rows' },
            s.kind === 'switch' ? [row('alarm', 'Alarm'), row('at', 'Switch level')] : [row('signal', 'Signal'), row('adc', 'ADC'), row('level', 'Level'), row('volume', 'Volume'), row('err', 'Error')],
          ),
        );
        this.cards.push({ id: s.id, el, pill, main, mainUnit, what, rows });
        return el;
      }),
    );
  }

  update(level: number, readings: Map<string, Reading>) {
    const st = this.ctx.store;
    const d = this.ctx.derived();
    const e = d.engine;
    const units = st.project.units;
    const litres = e.volume(level) * MM3_TO_L;
    const total = d.totalL;
    const pct = total > 0 ? (100 * litres) / total : 0;
    const vText = fmtVol(litres, units.volume, false);
    this.heroValue.textContent = vText;
    this.heroUnit.textContent = fmtVol(0, units.volume).split(' ').slice(1).join(' ');
    this.heroSub.textContent = `of ${fmtVol(total, units.volume)} capacity`;
    this.meterFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    this.meter.setAttribute('aria-valuenow', pct.toFixed(1));
    const ovf = st.project.marks.overflow;
    if (ovf !== null && total > 0) {
      const vp = (100 * e.litres(Math.min(Math.max(ovf, 0), e.depth))) / total;
      this.meterMark.hidden = false;
      this.meterMark.style.left = `${vp}%`;
      this.meterMark.title = `Overflow ${fmt(vp, 1)} %`;
    } else this.meterMark.hidden = true;
    this.stat.level.textContent = fmtLen(level, units.length);
    this.stat.fill.textContent = `${fmt(pct, 1)} %`;
    this.stat.ullage.textContent = fmtVol(total - litres, units.volume);
    this.stat.mass.textContent = `${fmt((litres / 1000) * d.density, 0)} kg`;

    for (const c of this.cards) {
      const g = d.geoms.find((x) => x.sensor.id === c.id);
      const r = readings.get(c.id);
      if (!g) continue;
      const s = g.sensor;
      const status: SensorStatus = r?.status ?? (s.enabled ? 'error' : 'off');
      c.el.classList.toggle('is-selected', st.state.selected === c.id);
      c.el.classList.toggle('is-off', !s.enabled);
      if (s.kind === 'switch') {
        const wet = r?.digital === 1;
        const alarm = s.enabled && g.ok && (s.switchMode === 'high' ? wet : !wet);
        c.pill.className = `pill pill-${!s.enabled || !g.ok ? 'neutral' : alarm ? 'critical' : 'good'}`;
        c.pill.replaceChildren(alarm ? icon('warn', 13) : icon('check', 13), !s.enabled ? 'Disabled' : !g.ok ? 'Not placed' : alarm ? 'Alarm' : 'Normal');
        c.main.textContent = !g.ok || !s.enabled ? '—' : wet ? 'Wet' : 'Dry';
        c.mainUnit.textContent = '';
        c.what.textContent = s.switchMode === 'high' ? 'high-level switch' : 'low-level switch';
        c.rows.alarm.textContent = alarm ? 'On' : 'Off';
        c.rows.at.textContent = g.ok ? fmtLen(g.faceLevel, units.length) : '—';
        continue;
      }
      const kind = STATUS_KIND[status];
      c.pill.className = `pill pill-${kind}`;
      c.pill.replaceChildren(kind === 'good' ? icon('check', 13) : kind === 'neutral' ? '' : icon('warn', 13), !g.ok && s.enabled ? 'Not placed' : STATUS_TEXT[status]);
      const pressure = isPressureSensor(s.kind);
      if (!r || !Number.isFinite(r.value)) {
        c.main.textContent = '—';
        c.mainUnit.textContent = '';
      } else if (s.signal === 'digital' && r.digital !== null) {
        // Show as many decimals as the sensor's resolution carries.
        const resU = s.resolution > 0 ? s.resolution / digitalFactor(s) : 0;
        const dp = resU > 0 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(resU) - 1e-9))) : pressure ? 3 : 1;
        c.main.textContent = fmt(r.digital, dp);
        c.mainUnit.textContent = pressure ? (PRESSURE[s.digitalUnit as keyof typeof PRESSURE]?.label ?? s.digitalUnit) : s.digitalUnit;
      } else if (pressure) {
        const t = fmtPres(r.value, units.pressure);
        const [num, ...unit] = t.split(' ');
        c.main.textContent = num;
        c.mainUnit.textContent = unit.join(' ');
      } else {
        const t = fmtLen(r.value, units.length);
        const [num, ...unit] = t.split(' ');
        c.main.textContent = num;
        c.mainUnit.textContent = unit.join(' ');
      }
      c.what.textContent = pressure ? 'pressure' : 'distance';
      const analog = hasAnalog(s);
      c.rows.signal.parentElement!.hidden = !analog;
      c.rows.adc.parentElement!.hidden = !hasAdc(s);
      if (analog) c.rows.signal.textContent = r?.signal !== null && r?.signal !== undefined ? `${plain(r.signal, 3)} ${signalUnit(s)}` : '—';
      if (hasAdc(s)) c.rows.adc.textContent = r?.adc !== null && r?.adc !== undefined ? fmt(r.adc, 0) : '—';
      const lv = r && r.valid ? r.level : NaN;
      c.rows.level.textContent = Number.isFinite(lv) ? fmtLen(lv, units.length) : '—';
      const vol = Number.isFinite(lv) ? e.volume(Math.min(Math.max(lv, 0), e.depth)) * MM3_TO_L : NaN;
      c.rows.volume.textContent = Number.isFinite(vol) ? fmtVol(vol, units.volume) : '—';
      const err = vol - litres;
      c.rows.err.parentElement!.hidden = !st.state.sim.noise;
      c.rows.err.textContent = Number.isFinite(err) ? `${err >= 0 ? '+' : '−'}${fmtVol(Math.abs(err), units.volume)}` : '—';
    }
  }
}
