import type { ViewMode, ViewState } from '../core/types';
import { FLOW, MM3_TO_L, flowFrom, flowTo, plain } from '../core/units';
import { h, icon } from './dom';
import { numField } from './fields';
import type { PanelCtx } from './tankPanel';

export interface StageActions {
  fit(view: 'iso' | 'front' | 'side' | 'top'): void;
  screenshot(): void;
  setLevel(mm: number): void;
}

export interface Stage {
  el: HTMLElement;
  viewport: HTMLElement;
  gaugeHost: HTMLElement;
  banner: HTMLElement;
  refresh(): void;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min ${Math.round(sec - m * 60)} s`;
  const hr = Math.floor(m / 60);
  return `${hr} h ${m - hr * 60} min`;
}

export function buildStage(ctx: PanelCtx, actions: StageActions): Stage {
  const st = ctx.store;
  const viewport = h('div', { class: 'viewport', id: 'viewport' });
  const gaugeHost = h('div', { class: 'gauge-host' });
  const banner = h('div', { class: 'stage-banner', hidden: true, role: 'alert' });

  const view = () => st.state.view;
  const setView = (fn: (v: ViewState) => void) => st.update('view', (s) => fn(s.view));

  const modes: { id: ViewMode; label: string; ic: string; tip: string }[] = [
    { id: 'cutaway', label: 'Cutaway', ic: 'cutaway', tip: 'Front half removed: shows walls, thickness and liquid' },
    { id: 'xray', label: 'X-ray', ic: 'xray', tip: 'See-through shell' },
    { id: 'solid', label: 'Solid', ic: 'solid', tip: 'Outside only' },
  ];
  const modeBtns = modes.map((m) =>
    h('button', { type: 'button', class: 'seg-btn', title: m.tip, on: { click: () => setView((v) => (v.mode = m.id)) } }, icon(m.ic, 16), h('span', null, m.label)),
  );
  const toggles: { key: 'dims' | 'beams' | 'labels' | 'grid'; ic: string; label: string }[] = [
    { key: 'dims', ic: 'dims', label: 'Dimensions' },
    { key: 'beams', ic: 'beam', label: 'Sensor beams' },
    { key: 'labels', ic: 'tag', label: 'Sensor tags' },
    { key: 'grid', ic: 'grid', label: 'Floor grid' },
  ];
  const toggleBtns = toggles.map((t) =>
    h('button', { type: 'button', class: 'tool-btn', title: t.label, 'aria-label': t.label, on: { click: () => setView((v) => (v[t.key] = !v[t.key])) } }, icon(t.ic, 17)),
  );
  const cams: { id: 'iso' | 'front' | 'side' | 'top'; ic: string; label: string }[] = [
    { id: 'iso', ic: 'iso', label: '3D view' },
    { id: 'front', ic: 'front', label: 'Front view' },
    { id: 'side', ic: 'side', label: 'Side view' },
    { id: 'top', ic: 'top', label: 'Top view' },
  ];
  const camBtns = cams.map((c) => h('button', { type: 'button', class: 'tool-btn', title: c.label, 'aria-label': c.label, on: { click: () => actions.fit(c.id) } }, icon(c.ic, 17)));
  const shot = h('button', { type: 'button', class: 'tool-btn', title: 'Save picture (PNG)', 'aria-label': 'Save picture', on: { click: () => actions.screenshot() } }, icon('camera', 17));

  const toolbar = h(
    'div',
    { class: 'stage-tools' },
    h('div', { class: 'seg seg-glass', role: 'group', 'aria-label': 'View mode' }, modeBtns),
    h('div', { class: 'tool-group', role: 'group', 'aria-label': 'Show' }, toggleBtns),
  );
  const camBar = h('div', { class: 'stage-cams' }, h('div', { class: 'tool-group', role: 'group', 'aria-label': 'Camera' }, camBtns, shot));

  // Playback
  const sim = () => st.state.sim;
  const setDir = (dir: -1 | 0 | 1) => st.update('sim', (s) => (s.sim.direction = s.sim.direction === dir ? 0 : dir));
  const fillBtn = h('button', { type: 'button', class: 'play-btn', title: 'Fill at the flow rate', on: { click: () => setDir(1) } }, icon('fill', 17), h('span', null, 'Fill'));
  const drainBtn = h('button', { type: 'button', class: 'play-btn', title: 'Drain at the flow rate', on: { click: () => setDir(-1) } }, icon('drain', 17), h('span', null, 'Drain'));
  const pauseBtn = h('button', { type: 'button', class: 'play-btn icon-only', title: 'Pause', 'aria-label': 'Pause', on: { click: () => st.update('sim', (s) => (s.sim.direction = 0)) } }, icon('pause', 17));
  const emptyBtn = h('button', { type: 'button', class: 'play-btn icon-only', title: 'Empty the tank', 'aria-label': 'Empty the tank', on: { click: () => (st.update('sim', (s) => (s.sim.direction = 0)), actions.setLevel(0)) } }, icon('empty', 17));
  const fullBtn = h('button', { type: 'button', class: 'play-btn icon-only', title: 'Fill to the top', 'aria-label': 'Fill to the top', on: { click: () => (st.update('sim', (s) => (s.sim.direction = 0)), actions.setLevel(ctx.derived().depth)) } }, icon('full', 17));

  const flow = numField({
    id: 'flow-rate',
    label: 'Flow',
    unit: () => FLOW[st.project.units.flow].label,
    get: () => flowTo(sim().flow, st.project.units.flow),
    set: (v) => st.update('sim', (s) => (s.sim.flow = Math.max(0, flowFrom(v, st.project.units.flow)))),
    dp: () => FLOW[st.project.units.flow].dp,
    min: () => 0,
    step: () => 1,
  });
  const speed = h('select', { id: 'sim-speed', class: 'select select-sm', 'aria-label': 'Playback speed' }, [1, 10, 60, 600, 3600].map((x) => h('option', { value: String(x) }, `×${x}`)));
  speed.addEventListener('change', () => st.update('sim', (s) => (s.sim.speed = Number(speed.value))));
  const noise = h('button', { type: 'button', class: 'play-btn', title: 'Add each sensor’s noise to its reading', on: { click: () => st.update('sim', (s) => (s.sim.noise = !s.sim.noise)) } }, icon('noise', 17), h('span', null, 'Noise'));
  const status = h('span', { class: 'play-status', 'aria-live': 'polite' });

  const transport = h(
    'div',
    { class: 'transport' },
    h('div', { class: 'transport-group' }, emptyBtn, drainBtn, pauseBtn, fillBtn, fullBtn),
    h('div', { class: 'transport-group flow' }, flow.el, h('div', { class: 'select-wrap select-wrap-sm' }, speed, icon('chevron', 14))),
    h('div', { class: 'transport-group' }, noise, status),
  );

  const el = h('section', { class: 'stage', 'aria-label': '3D tank view' }, viewport, toolbar, camBar, gaugeHost, banner, transport);

  const refresh = () => {
    const v = view();
    modes.forEach((m, i) => modeBtns[i].setAttribute('aria-pressed', String(v.mode === m.id)));
    toggles.forEach((t, i) => toggleBtns[i].setAttribute('aria-pressed', String(v[t.key])));
    const s = sim();
    fillBtn.setAttribute('aria-pressed', String(s.direction === 1));
    drainBtn.setAttribute('aria-pressed', String(s.direction === -1));
    noise.setAttribute('aria-pressed', String(s.noise));
    speed.value = String(s.speed);
    flow.refresh();
    const d = ctx.derived();
    const e = d.engine;
    const vNow = e.quickVolume(s.level) * MM3_TO_L;
    const rate = (s.flow * s.speed) / 60; // L per second of screen time
    const marks = st.project.marks;
    if (s.direction === 1) {
      const target = marks.overflow !== null ? Math.min(marks.overflow, e.depth) : e.depth;
      const left = e.quickVolume(target) * MM3_TO_L - vNow;
      status.textContent = rate > 0 ? `Filling · ${marks.overflow !== null ? 'overflow' : 'full'} in ${fmtDuration(left / (s.flow / 60))}` : 'Set a flow rate';
    } else if (s.direction === -1) {
      const target = marks.outlet !== null ? Math.max(marks.outlet, 0) : 0;
      const left = vNow - e.quickVolume(target) * MM3_TO_L;
      status.textContent = rate > 0 ? `Draining · ${marks.outlet !== null ? 'outlet' : 'empty'} in ${fmtDuration(left / (s.flow / 60))}` : 'Set a flow rate';
    } else {
      const left = d.totalL - vNow;
      status.textContent = s.flow > 0 ? `Full in ${fmtDuration(left / (s.flow / 60))} at ${plain(flowTo(s.flow, st.project.units.flow), FLOW[st.project.units.flow].dp)} ${FLOW[st.project.units.flow].label}` : 'Paused';
    }
  };
  refresh();
  return { el, viewport, gaugeHost, banner, refresh };
}
