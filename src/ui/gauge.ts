import { token } from '../app/colors';
import { LENGTH, MM3_TO_L, fmt, fmtLen, fmtVol, lenTo, niceStep } from '../core/units';
import { h } from './dom';
import { withAlpha } from './planView';
import type { PanelCtx } from './tankPanel';

/**
 * Sight glass: the level scale on the left is uniform; the volume scale on the
 * right is a dipstick scale whose marks bunch up where the tank is wide.
 */
export class Gauge {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private bubble: HTMLElement;
  private dragging = false;
  private ro: ResizeObserver;
  private top = 22;
  private bottom = 30;
  private pctFor: unknown = null;
  private pctLevels: number[] = [];

  constructor(
    private ctx: PanelCtx,
    private onLevel: (mm: number) => void,
  ) {
    this.canvas = h('canvas', { class: 'gauge-canvas', 'aria-hidden': 'true' });
    this.el = h(
      'div',
      {
        class: 'gauge',
        role: 'slider',
        tabindex: '0',
        'aria-orientation': 'vertical',
        'aria-label': 'Liquid level',
      },
      this.canvas,
    );
    // The level value rides next to the handle and may spill left over the 3D view.
    this.bubble = h('div', { class: 'gauge-bubble', 'aria-hidden': 'true' });
    this.el.append(this.bubble);
    this.el.addEventListener('pointerdown', this.down);
    this.el.addEventListener('pointermove', this.move);
    this.el.addEventListener('pointerup', this.up);
    this.el.addEventListener('pointercancel', this.up);
    this.el.addEventListener('keydown', this.key);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  private levelFromY(y: number): number {
    const H = this.el.clientHeight;
    const depth = this.ctx.derived().engine.depth;
    const f = (H - this.bottom - y) / Math.max(H - this.top - this.bottom, 1);
    return Math.min(Math.max(f, 0), 1) * depth;
  }

  private down = (e: PointerEvent) => {
    this.dragging = true;
    this.el.setPointerCapture(e.pointerId);
    this.el.focus();
    this.onLevel(this.levelFromY(e.clientY - this.el.getBoundingClientRect().top));
  };

  private move = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.onLevel(this.levelFromY(e.clientY - this.el.getBoundingClientRect().top));
  };

  private up = (e: PointerEvent) => {
    if (this.dragging) this.el.releasePointerCapture(e.pointerId);
    this.dragging = false;
  };

  private key = (e: KeyboardEvent) => {
    const depth = this.ctx.derived().engine.depth;
    const cur = this.ctx.store.state.sim.level;
    const small = depth / 100;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = cur + (e.shiftKey ? 10 * small : small);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = cur - (e.shiftKey ? 10 * small : small);
    if (e.key === 'PageUp') next = cur + 10 * small;
    if (e.key === 'PageDown') next = cur - 10 * small;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = depth;
    if (next === null) return;
    e.preventDefault();
    this.onLevel(Math.min(Math.max(next, 0), depth));
  };

  draw() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (W < 10 || H < 60) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this.canvas;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const st = this.ctx.store;
    const d = this.ctx.derived();
    const e = d.engine;
    const depth = e.depth;
    const lu = st.project.units.length;
    const level = Math.min(Math.max(st.state.sim.level, 0), depth);
    const y0 = this.top;
    const y1 = H - this.bottom;
    const yOf = (mm: number) => y1 - (mm / depth) * (y1 - y0);
    const tubeX = Math.round(W * 0.42);
    const tubeW = 20;

    const ink2 = token('--ink-2') || '#3c4a54';
    const ink3 = token('--ink-3') || '#7b8a93';
    const line = token('--line-strong') || '#b9c5cc';
    const water = token('--water') || '#2a78d6';
    const glass = token('--glass') || '#eef3f6';
    const critical = token('--critical') || '#d03b3b';
    const warning = token('--warning') || '#c98500';
    const font = (wt: number, size: number) => `${wt} ${size}px "JetBrains Mono", ui-monospace, monospace`;

    // Tube
    const r = tubeW / 2;
    const tube = () => {
      g.beginPath();
      g.roundRect(tubeX, y0 - 6, tubeW, y1 - y0 + 12, r);
    };
    tube();
    g.fillStyle = glass;
    g.fill();
    // Liquid column
    g.save();
    tube();
    g.clip();
    const yl = yOf(level);
    const grad = g.createLinearGradient(tubeX, 0, tubeX + tubeW, 0);
    grad.addColorStop(0, withAlpha(water, 0.95));
    grad.addColorStop(0.55, withAlpha(water, 0.7));
    grad.addColorStop(1, withAlpha(water, 0.92));
    g.fillStyle = grad;
    g.fillRect(tubeX, yl, tubeW, y1 + 6 - yl);
    g.fillStyle = withAlpha('#ffffff', 0.35);
    g.fillRect(tubeX + 4, y0 - 6, 3, y1 - y0 + 12);
    g.restore();
    tube();
    g.strokeStyle = line;
    g.lineWidth = 1.5;
    g.stroke();

    // Level scale (left)
    const span = lenTo(depth, lu);
    const major = niceStep(span / Math.max(3, Math.floor((y1 - y0) / 56)));
    const minor = major / 5;
    g.strokeStyle = ink3;
    g.fillStyle = ink2;
    g.font = font(500, 10);
    g.textAlign = 'right';
    g.lineWidth = 1;
    for (let v = 0, i = 0; v <= span + minor * 1e-6; v += minor, i++) {
      const isMajor = i % 5 === 0;
      const y = Math.round(yOf(v * LENGTH[lu].k)) + 0.5;
      g.beginPath();
      g.moveTo(tubeX - (isMajor ? 9 : 5), y);
      g.lineTo(tubeX - 2, y);
      g.stroke();
      if (isMajor) g.fillText(fmt(v, major % 1 ? 2 : 0), tubeX - 12, y + 3.5);
    }
    g.fillStyle = ink3;
    g.font = font(500, 9);
    g.fillText(LENGTH[lu].label, tubeX - 12, y0 - 10);

    // Volume scale (right): where 0, 5 … 100 % of capacity sit.
    if (this.pctFor !== e) {
      this.pctFor = e;
      this.pctLevels = Array.from({ length: 21 }, (_, i) => e.levelOf((i / 20) * e.total));
    }

    // Overflow and outlet marks; their labels take priority over nearby % labels.
    const markYs: number[] = [];
    const mark = (lv: number | null, color: string, text: string) => {
      if (lv === null || lv < 0 || lv > depth) return;
      const y = Math.round(yOf(lv)) + 0.5;
      markYs.push(y);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(tubeX - 3, y);
      g.lineTo(tubeX + tubeW + 3, y);
      g.stroke();
      g.fillStyle = color;
      g.font = font(600, 9.5);
      g.textAlign = 'left';
      g.fillText(text, tubeX + tubeW + 12, y + 3.5);
      g.lineWidth = 1;
    };
    mark(st.project.marks.overflow, critical, 'OVF');
    mark(st.project.marks.outlet, warning, 'OUT');

    g.textAlign = 'left';
    for (let p = 0; p <= 100; p += 5) {
      const lv = this.pctLevels[p / 5];
      const y = Math.round(yOf(lv)) + 0.5;
      const isMajor = p % 25 === 0;
      g.strokeStyle = ink3;
      g.beginPath();
      g.moveTo(tubeX + tubeW + 2, y);
      g.lineTo(tubeX + tubeW + (isMajor ? 9 : p % 10 === 0 ? 6 : 4), y);
      g.stroke();
      if (isMajor && !markYs.some((my) => Math.abs(my - y) < 11)) {
        g.fillStyle = ink2;
        g.font = font(500, 10);
        g.fillText(`${p}%`, tubeX + tubeW + 12, y + 3.5);
      }
    }

    // Handle: pointer and value on the left.
    const yh = Math.round(yl);
    g.fillStyle = ink2;
    g.beginPath();
    g.moveTo(tubeX - 1, yh);
    g.lineTo(tubeX - 9, yh - 5.5);
    g.lineTo(tubeX - 9, yh + 5.5);
    g.closePath();
    g.fill();
    g.strokeStyle = withAlpha('#ffffff', 0.9);
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(tubeX + 2, yh + 0.5);
    g.lineTo(tubeX + tubeW - 2, yh + 0.5);
    g.stroke();

    const litres = e.volume(level) * MM3_TO_L;
    const pct = e.total > 0 ? (100 * litres) / d.totalL : 0;
    this.bubble.textContent = fmtLen(level, lu, true, lu === 'mm' ? 0 : undefined);
    this.bubble.style.top = `${yh}px`;
    this.bubble.style.right = `${W - tubeX + 11}px`;
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', fmt(lenTo(depth, lu), LENGTH[lu].dp));
    this.el.setAttribute('aria-valuenow', fmt(lenTo(level, lu), LENGTH[lu].dp));
    this.el.setAttribute('aria-valuetext', `${fmtLen(level, lu)}, ${fmtVol(litres, st.project.units.volume)}, ${pct.toFixed(1)} percent`);
  }
}
