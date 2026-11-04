import { sensorColor, seriesColor } from '../app/colors';
import { LENGTH, MM3_TO_L, VOLUME, fmt, lenTo, niceStep, volTo } from '../core/units';
import { h } from './dom';
import type { PanelCtx } from './tankPanel';

const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function ticks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0];
  const step = niceStep(max / target);
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(v);
  return out;
}

/** Level (vertical) against volume (horizontal): the tank's calibration curve. */
export class LevelChart {
  readonly el: HTMLElement;
  private host: HTMLElement;
  private svgEl: SVGSVGElement;
  private tip: HTMLElement;
  private legend: HTMLElement;
  private marker: SVGGElement;
  private hover: SVGGElement;
  private W = 300;
  private H = 236;
  private m = { l: 46, r: 12, t: 16, b: 30 };
  private xMax = 1;
  private yMax = 1;
  private ro: ResizeObserver;
  private level = 0;

  constructor(private ctx: PanelCtx) {
    this.svgEl = svg('svg', { class: 'chart-svg', role: 'img', tabindex: 0 });
    this.tip = h('div', { class: 'chart-tip', hidden: true, role: 'status' });
    this.legend = h('ul', { class: 'legend' });
    this.marker = svg('g', { class: 'chart-marker' });
    this.hover = svg('g', { class: 'chart-hover' });
    this.host = h('div', { class: 'chart-host' }, this.svgEl, this.tip);
    this.el = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'Level ↔ volume'),
      this.host,
      this.legend,
    );
    this.svgEl.addEventListener('pointermove', this.onMove);
    this.svgEl.addEventListener('pointerleave', () => this.hideHover());
    this.svgEl.addEventListener('focus', () => this.showHover(this.level));
    this.svgEl.addEventListener('blur', () => this.hideHover());
    this.svgEl.addEventListener('keydown', this.onKey);
    this.ro = new ResizeObserver(() => {
      const w = Math.round(this.host.clientWidth);
      if (w > 0 && Math.abs(w - this.W) > 1) this.rebuild();
    });
    this.ro.observe(this.host);
  }

  private xs = (v: number) => this.m.l + (v / this.xMax) * (this.W - this.m.l - this.m.r);
  private ys = (lv: number) => this.H - this.m.b - (lv / this.yMax) * (this.H - this.m.t - this.m.b);

  rebuild() {
    const st = this.ctx.store;
    const d = this.ctx.derived();
    const e = d.engine;
    const lu = st.project.units.length;
    const vu = st.project.units.volume;
    const geoms = d.geoms.filter((g) => g.ok && g.sensor.enabled);
    const bars = geoms.filter((g) => g.mount !== 'point');
    this.W = Math.max(220, Math.round(this.host.clientWidth || 300));
    this.m.r = 12 + bars.length * 12 + (geoms.some((g) => g.mount === 'point') ? 12 : 0);
    this.yMax = lenTo(e.depth, lu);
    this.xMax = volTo(d.totalL, vu);
    const svgEl = this.svgEl;
    svgEl.replaceChildren();
    svgEl.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    svgEl.setAttribute('width', String(this.W));
    svgEl.setAttribute('height', String(this.H));
    svgEl.setAttribute(
      'aria-label',
      `Tank calibration curve: level from 0 to ${fmt(this.yMax, LENGTH[lu].dp)} ${LENGTH[lu].label} against volume from 0 to ${fmt(this.xMax, VOLUME[vu].dp)} ${VOLUME[vu].label}.`,
    );

    const grid = svg('g', { class: 'chart-grid' });
    const axis = svg('g', { class: 'chart-axis' });
    for (const t of ticks(this.yMax)) {
      const y = this.ys(t);
      grid.append(svg('line', { x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }));
      const lab = svg('text', { x: this.m.l - 6, y: y + 3.5, 'text-anchor': 'end' });
      lab.textContent = fmt(t, t % 1 ? 2 : 0);
      axis.append(lab);
    }
    const xt = ticks(this.xMax, Math.max(2, Math.floor((this.W - 80) / 70)));
    for (const t of xt) {
      const x = this.xs(t);
      grid.append(svg('line', { x1: x, x2: x, y1: this.m.t, y2: this.H - this.m.b }));
      const lab = svg('text', { x, y: this.H - this.m.b + 15, 'text-anchor': 'middle' });
      lab.textContent = fmt(t, t % 1 ? 2 : 0);
      axis.append(lab);
    }
    const yTitle = svg('text', { x: 4, y: 10, class: 'chart-title' });
    yTitle.textContent = `Level (${LENGTH[lu].label})`;
    const xTitle = svg('text', { x: this.W - this.m.r, y: this.H - 2, 'text-anchor': 'end', class: 'chart-title' });
    xTitle.textContent = `Volume (${VOLUME[vu].label})`;
    axis.append(yTitle, xTitle);
    const base = svg('line', { class: 'chart-base', x1: this.m.l, x2: this.W - this.m.r, y1: this.H - this.m.b, y2: this.H - this.m.b });

    // Curve, thinned to about one point per pixel row.
    const Ls = e.curveLevels;
    const Vs = e.curveVolumes;
    const step = Math.max(1, Math.floor(Ls.length / 260));
    let dLine = '';
    for (let i = 0; i < Ls.length; i += step) dLine += `${i ? 'L' : 'M'}${this.xs(volTo(Vs[i] * MM3_TO_L, vu)).toFixed(1)},${this.ys(lenTo(Ls[i], lu)).toFixed(1)}`;
    dLine += `L${this.xs(this.xMax).toFixed(1)},${this.ys(this.yMax).toFixed(1)}`;
    const color = seriesColor(0);
    const area = svg('path', { d: `${dLine}L${this.m.l},${this.ys(this.yMax)}Z`, fill: color, 'fill-opacity': 0.1, stroke: 'none' });
    const line = svg('path', { d: dLine, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });

    // Overflow and outlet thresholds.
    const marks = svg('g', { class: 'chart-marks' });
    const addMark = (lv: number | null, label: string) => {
      if (lv === null || !(lv > 0) || lv > e.depth) return;
      const y = this.ys(lenTo(lv, lu));
      marks.append(svg('line', { x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }));
      const t = svg('text', { x: this.W - this.m.r - 2, y: y - 3, 'text-anchor': 'end' });
      t.textContent = label;
      marks.append(t);
    };
    addMark(st.project.marks.overflow, 'Overflow');
    addMark(st.project.marks.outlet, 'Outlet');

    // Sensor measuring ranges as bars right of the plot.
    const ranges = svg('g', { class: 'chart-ranges' });
    bars.forEach((g, i) => {
      const x = this.W - this.m.r + 8 + i * 12;
      const y0 = this.ys(lenTo(g.validMax, lu));
      const y1 = this.ys(lenTo(g.validMin, lu));
      ranges.append(svg('rect', { x, y: y0, width: 6, height: Math.max(2, y1 - y0), rx: 3, fill: sensorColor(g.sensor) }));
    });
    const sw = geoms.filter((g) => g.mount === 'point');
    sw.forEach((g) => {
      const x = this.W - this.m.r + 11 + bars.length * 12;
      const y = this.ys(lenTo(g.faceLevel, lu));
      ranges.append(svg('path', { d: `M${x},${y - 5}L${x + 5},${y}L${x},${y + 5}L${x - 5},${y}Z`, fill: sensorColor(g.sensor) }));
    });

    svgEl.append(grid, area, base, line, marks, ranges, axis, this.hover, this.marker);
    this.drawMarker();

    // Legend: the curve plus each sensor's range.
    this.legend.replaceChildren(
      h('li', null, h('span', { class: 'key key-line', style: `--key:${color}` }), 'Tank curve'),
      ...bars.map((g) =>
        h(
          'li',
          null,
          h('span', { class: 'key key-bar', style: `--key:${sensorColor(g.sensor)}` }),
          `${g.sensor.tag} measures ${fmt(lenTo(g.validMin, lu), LENGTH[lu].dp === 1 ? 0 : 2)}–${fmt(lenTo(g.validMax, lu), LENGTH[lu].dp === 1 ? 0 : 2)} ${LENGTH[lu].label}`,
        ),
      ),
      ...sw.map((g) => h('li', null, h('span', { class: 'key key-diamond', style: `--key:${sensorColor(g.sensor)}` }), `${g.sensor.tag} switch`)),
    );
  }

  setLevel(level: number) {
    this.level = level;
    this.drawMarker();
  }

  private drawMarker() {
    const st = this.ctx.store;
    const d = this.ctx.derived();
    const lu = st.project.units.length;
    const vu = st.project.units.volume;
    const lv = Math.min(Math.max(this.level, 0), d.engine.depth);
    const x = this.xs(volTo(d.engine.quickVolume(lv) * MM3_TO_L, vu));
    const y = this.ys(lenTo(lv, lu));
    this.marker.replaceChildren(
      svg('line', { class: 'chart-guide', x1: this.m.l, x2: x, y1: y, y2: y }),
      svg('line', { class: 'chart-guide', x1: x, x2: x, y1: y, y2: this.H - this.m.b }),
      svg('circle', { cx: x, cy: y, r: 5, fill: seriesColor(0), class: 'chart-dot' }),
    );
  }

  private levelAtY(py: number): number {
    const d = this.ctx.derived();
    const f = (this.H - this.m.b - py) / (this.H - this.m.t - this.m.b);
    return Math.min(Math.max(f, 0), 1) * d.engine.depth;
  }

  private onMove = (ev: PointerEvent) => {
    const r = this.svgEl.getBoundingClientRect();
    const py = ((ev.clientY - r.top) / r.height) * this.H;
    this.showHover(this.levelAtY(py));
  };

  private hoverLevel = 0;
  private onKey = (ev: KeyboardEvent) => {
    const d = this.ctx.derived();
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    const stepL = d.engine.depth / 50;
    this.showHover(Math.min(Math.max(this.hoverLevel + (ev.key === 'ArrowUp' ? stepL : -stepL), 0), d.engine.depth));
  };

  private showHover(level: number) {
    this.hoverLevel = level;
    const st = this.ctx.store;
    const d = this.ctx.derived();
    const lu = st.project.units.length;
    const vu = st.project.units.volume;
    const litres = d.engine.quickVolume(level) * MM3_TO_L;
    const x = this.xs(volTo(litres, vu));
    const y = this.ys(lenTo(level, lu));
    this.hover.replaceChildren(
      svg('line', { class: 'chart-cross', x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }),
      svg('circle', { cx: x, cy: y, r: 4, fill: seriesColor(0), class: 'chart-dot' }),
    );
    const pct = d.totalL > 0 ? (100 * litres) / d.totalL : 0;
    const valid = d.geoms.filter((g) => g.ok && g.sensor.enabled && g.mount !== 'point' && level >= g.validMin - 1e-6 && level <= g.validMax + 1e-6);
    this.tip.replaceChildren(
      h('div', { class: 'tip-main' }, `${fmt(volTo(litres, vu), VOLUME[vu].dp)} ${VOLUME[vu].label}`),
      h('div', { class: 'tip-sub' }, `at ${fmt(lenTo(level, lu), LENGTH[lu].dp)} ${LENGTH[lu].label} · ${fmt(pct, 1)} %`),
      valid.length
        ? h('div', { class: 'tip-sensors' }, valid.map((g) => h('span', null, h('span', { class: 'key key-line', style: `--key:${sensorColor(g.sensor)}` }), g.sensor.tag)))
        : h('div', { class: 'tip-sub' }, 'No sensor reads this level'),
    );
    this.tip.hidden = false;
    const hostW = this.host.clientWidth;
    const scale = hostW / this.W;
    const left = Math.min(Math.max(x * scale + 12, 4), hostW - 160);
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.max(0, y * scale - 52)}px`;
  }

  private hideHover() {
    this.hover.replaceChildren();
    this.tip.hidden = true;
  }
}
