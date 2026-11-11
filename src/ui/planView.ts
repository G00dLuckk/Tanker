import { sensorColor, token } from '../app/colors';
import { SENSOR_KINDS } from '../core/defaults';
import type { PitModel } from '../core/pit';
import { centroid, offset } from '../core/polygon';
import { makeOutline } from '../core/shape';
import { manholeClearance, manholeEdge } from '../core/sensors';
import type { Sec } from '../core/tank';
import { fmtLen, niceStep } from '../core/units';
import { h } from './dom';
import { manholesOf, moveManhole } from './manholePanel';
import type { PanelCtx } from './tankPanel';

interface Frame {
  cx: number;
  cy: number;
  k: number;
}

/** Top view of the tank with draggable sensor markers. */
export class PlanView {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private frame: Frame = { cx: 0, cy: 0, k: 1 };
  private drag: { id: string; kind: 'sensor' | 'manhole'; dx: number; dy: number } | null = null;
  private ro: ResizeObserver;

  constructor(
    private ctx: PanelCtx,
    private onSelect: (id: string | null) => void,
  ) {
    this.canvas = h('canvas', {
      class: 'plan-canvas',
      role: 'img',
      'aria-label': 'Top view of the tank. Drag a sensor or a manhole to move it; X and Y fields give exact positions.',
    });
    this.el = h(
      'figure',
      { class: 'plan' },
      this.canvas,
      h('figcaption', { class: 'plan-caption' }, 'Top view · drag a sensor or manhole to place it'),
    );
    this.canvas.addEventListener('pointerdown', this.down);
    this.canvas.addEventListener('pointermove', this.move);
    this.canvas.addEventListener('pointerup', this.up);
    this.canvas.addEventListener('pointercancel', this.up);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  dispose() {
    this.ro.disconnect();
  }

  /** Plan extents (mm): [xmin, xmax, ymin, ymax]. */
  private extents(): [number, number, number, number] {
    const d = this.ctx.derived();
    if (d.kind === 'pit') {
      const b = d.pit.box;
      const grow = Math.max(0, d.pit.cfg.wallTop) + d.pit.batterK * d.pit.wallTop;
      return [b.x0 - grow, b.x1 + grow, b.y0 - grow, b.y1 + grow];
    }
    const m = d.model;
    const w = m.base.A * m.maxScale + m.t.shell;
    if (m.orientation === 'vertical') {
      const d = m.base.B * m.maxScale + m.t.shell;
      return [-w, w, -d, d];
    }
    const half = w;
    return [m.aMin - m.L / 2 - m.t.start, m.aMax - m.L / 2 + m.t.end, -half, half];
  }

  private toPx(x: number, y: number): [number, number] {
    return [this.frame.cx + x * this.frame.k, this.frame.cy - y * this.frame.k];
  }

  private toPlan(px: number, py: number): [number, number] {
    return [(px - this.frame.cx) / this.frame.k, -(py - this.frame.cy) / this.frame.k];
  }

  draw() {
    const c = this.canvas;
    const w = Math.max(this.el.clientWidth, 120);
    const [x0, x1, y0, y1] = this.extents();
    const aspect = (y1 - y0) / Math.max(x1 - x0, 1);
    const hgt = Math.round(Math.min(Math.max(w * aspect + 44, 150), 280));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${hgt}px`;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const pad = 26;
    const k = Math.min((w - 2 * pad) / Math.max(x1 - x0, 1), (hgt - 2 * pad) / Math.max(y1 - y0, 1));
    this.frame = { k, cx: w / 2 - ((x0 + x1) / 2) * k, cy: hgt / 2 + ((y0 + y1) / 2) * k };

    const ink = token('--ink') || '#13212b';
    const ink3 = token('--ink-3') || '#7b8a93';
    const line = token('--line') || '#d3dce0';
    const water = token('--water') || '#2a78d6';
    const surface = token('--surface') || '#fff';
    const d = this.ctx.derived();
    const m = d.model;
    const font = '500 11px "Barlow Condensed", "Arial Narrow", sans-serif';

    // Axes through the tank centre line.
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.setLineDash([]);
    const [ax0, ay] = this.toPx(x0, 0);
    const [ax1] = this.toPx(x1, 0);
    const [bx, by0] = this.toPx(0, y0);
    const [, by1] = this.toPx(0, y1);
    g.beginPath();
    g.moveTo(ax0 - 10, ay);
    g.lineTo(ax1 + 10, ay);
    g.moveTo(bx, by0 + 10);
    g.lineTo(bx, by1 - 10);
    g.stroke();
    g.fillStyle = ink3;
    g.font = font;
    g.textAlign = 'right';
    g.fillText('+X', ax1 + 12, ay - 5);
    g.textAlign = 'left';
    g.fillText('+Y back', bx + 5, by1 - 2);

    // Tank outline.
    const sec: Sec = { ku: 0, kv: 0, cu: 0, cv: 0 };
    g.lineJoin = 'round';
    if (d.kind === 'pit') {
      this.drawPit(g, d.pit, { ink, ink3, line, water, surface, font });
    } else if (m.orientation === 'vertical') {
      const o = makeOutline(m.base, 96);
      const ring = (scaleU: number, scaleV: number, cu = 0, cv = 0, grow = 0) => {
        g.beginPath();
        for (let j = 0; j <= o.n; j++) {
          const i = j % o.n;
          const [px, py] = this.toPx(cu + o.u[i] * scaleU + o.nu[i] * grow, cv + o.v[i] * scaleV + o.nv[i] * grow);
          if (j === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
      };
      ring(m.maxScale, m.maxScale, 0, 0, m.t.shell);
      g.fillStyle = withAlpha(water, 0.08);
      g.fill();
      g.strokeStyle = ink;
      g.lineWidth = 1.5;
      g.stroke();
      ring(1, 1);
      g.strokeStyle = ink3;
      g.lineWidth = 1;
      g.stroke();
      // Top opening (flat roof area of a truncated cone) and bottom outlet.
      if (m.end.depth > 0 && m.end.closed) {
        m.section(m.aMax, sec);
        ring(sec.ku, sec.kv, sec.cu, sec.cv);
        g.setLineDash([4, 3]);
        g.stroke();
        g.setLineDash([]);
      }
      if (m.start.depth > 0) {
        m.section(m.aMin, sec);
        const [px, py] = this.toPx(sec.cu, sec.cv);
        g.strokeStyle = ink3;
        g.beginPath();
        g.moveTo(px - 5, py - 5);
        g.lineTo(px + 5, py + 5);
        g.moveTo(px + 5, py - 5);
        g.lineTo(px - 5, py + 5);
        g.stroke();
      }
    } else {
      const n = 220;
      const top: [number, number][] = [];
      const bottom: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const a = m.aMin + ((m.aMax - m.aMin) * i) / n;
        m.section(a, sec);
        top.push([a - m.L / 2, sec.cu + sec.ku * m.base.A]);
        bottom.push([a - m.L / 2, sec.cu - sec.ku * m.base.A]);
      }
      g.beginPath();
      [...top, ...bottom.reverse()].forEach(([x, y], i) => {
        const [px, py] = this.toPx(x, y);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
      g.fillStyle = withAlpha(water, 0.08);
      g.fill();
      g.strokeStyle = ink;
      g.lineWidth = 1.5;
      g.stroke();
      g.strokeStyle = ink3;
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      for (const a of [0, m.L]) {
        if (m.L <= 0 && a > 0) continue;
        m.section(a, sec);
        const [px, py0] = this.toPx(a - m.L / 2, sec.cu + sec.ku * m.base.A);
        const [, py1] = this.toPx(a - m.L / 2, sec.cu - sec.ku * m.base.A);
        g.beginPath();
        g.moveTo(px, py0);
        g.lineTo(px, py1);
        g.stroke();
      }
      g.setLineDash([]);
    }

    // Scale bar.
    const u = this.ctx.store.project.units.length;
    const span = niceStep((x1 - x0) / 4);
    const [sx0, sy] = [10, hgt - 10];
    const sx1 = sx0 + span * k;
    g.strokeStyle = ink3;
    g.beginPath();
    g.moveTo(sx0, sy);
    g.lineTo(sx1, sy);
    g.moveTo(sx0, sy - 3);
    g.lineTo(sx0, sy + 3);
    g.moveTo(sx1, sy - 3);
    g.lineTo(sx1, sy + 3);
    g.stroke();
    g.fillStyle = ink3;
    g.textAlign = 'left';
    g.fillText(fmtLen(span, u, true, u === 'mm' ? 0 : undefined), sx1 + 6, sy + 4);

    // Manholes: the opening, a ring for the neck wall and the tag.
    const sel = this.ctx.store.state.selected;
    for (const mg of d.manholes) {
      const mh = mg.manhole;
      const path = (grow: number) => {
        g.beginPath();
        manholeEdge(mh, 48, grow).forEach(([x, y], i) => {
          const [px, py] = this.toPx(x, y);
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        });
        g.closePath();
      };
      if (mh.id === sel) {
        path(Math.max(m.t.shell, 2) + 8 / k);
        g.fillStyle = withAlpha(ink3, 0.18);
        g.fill();
      }
      path(Math.max(m.t.shell, 2));
      g.fillStyle = withAlpha(ink3, 0.16);
      g.fill();
      g.strokeStyle = mg.ok ? ink : token('--critical') || '#d03b3b';
      g.lineWidth = 1.25;
      g.stroke();
      path(0);
      g.fillStyle = surface;
      g.fill();
      g.strokeStyle = ink3;
      g.lineWidth = 1;
      g.stroke();
      const [, ylo] = this.toPx(mh.x, mh.y - (mh.shape === 'round' ? mh.diameter : mh.length) / 2);
      const [cx] = this.toPx(mh.x, mh.y);
      g.fillStyle = mg.ok ? ink3 : token('--critical') || '#d03b3b';
      g.font = font;
      g.textAlign = 'center';
      g.fillText(mg.ok ? mh.tag : `${mh.tag} · outside`, cx, ylo + 13);
    }

    // Sensors.
    for (const geom of d.geoms) {
      const s = geom.sensor;
      const [px, py] = this.toPx(s.x, s.y);
      const color = sensorColor(s);
      const mount = SENSOR_KINDS[s.kind].mount;
      const r = s.id === sel ? 7.5 : 6;
      g.globalAlpha = s.enabled ? 1 : 0.4;
      if (s.id === sel) {
        g.beginPath();
        g.arc(px, py, r + 5, 0, Math.PI * 2);
        g.fillStyle = withAlpha(color, 0.22);
        g.fill();
      }
      g.lineWidth = 2;
      g.strokeStyle = surface;
      g.beginPath();
      if (mount === 'point') {
        g.moveTo(px, py - r - 1);
        g.lineTo(px + r + 1, py);
        g.lineTo(px, py + r + 1);
        g.lineTo(px - r - 1, py);
        g.closePath();
      } else {
        g.arc(px, py, r, 0, Math.PI * 2);
      }
      if (mount === 'bottom') {
        g.fillStyle = surface;
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = color;
        g.stroke();
      } else {
        g.fillStyle = color;
        g.fill();
        g.stroke();
      }
      g.globalAlpha = 1;
      g.fillStyle = geom.ok ? ink : token('--critical') || '#d03b3b';
      g.font = font;
      g.textAlign = 'left';
      g.fillText(geom.ok ? s.tag : `${s.tag} · outside`, px + r + 5, py - r + 2);
    }
  }

  /** A concrete storage: the walls, the inner outline, the floor slope and the sumps. */
  private drawPit(g: CanvasRenderingContext2D, pit: PitModel, c: { ink: string; ink3: string; line: string; water: string; surface: string; font: string }) {
    const path = (pts: { x: number; y: number }[]) => {
      g.beginPath();
      pts.forEach((q, i) => {
        const [px, py] = this.toPx(q.x, q.y);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
    };
    // Concrete wall: the outer face (wall top width) filled, then the inner outline.
    const wall = Math.max(0, pit.cfg.wallTop);
    path(offset(pit.outline, wall + pit.batterK * pit.wallTop));
    g.fillStyle = withAlpha(c.ink3, 0.22);
    g.fill();
    g.strokeStyle = c.ink;
    g.lineWidth = 1.5;
    g.stroke();
    path(pit.outline);
    g.fillStyle = withAlpha(c.water, 0.1);
    g.fill();
    g.strokeStyle = c.ink;
    g.lineWidth = 1.25;
    g.stroke();
    // Sumps.
    for (const s of pit.sumps) {
      path(s.outline);
      g.fillStyle = withAlpha(c.water, 0.22);
      g.fill();
      g.strokeStyle = c.ink3;
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);
    }
    // Floor: an arrow from the low side to the high side of a sloping floor, or the corner heights.
    g.fillStyle = c.ink3;
    g.font = c.font;
    const f = pit.cfg.floor;
    const u = this.ctx.store.project.units.length;
    const lab = (v: number) => fmtLen(v, u, true, u === 'mm' ? 0 : undefined);
    if (f.type === 'plane' && f.drop > 0) {
      const th = (f.direction * Math.PI) / 180;
      const cen = centroid(pit.outline);
      const len = 0.28 * Math.min(pit.box.x1 - pit.box.x0, pit.box.y1 - pit.box.y0);
      const a = { x: cen.x - Math.cos(th) * len, y: cen.y - Math.sin(th) * len };
      const b = { x: cen.x + Math.cos(th) * len, y: cen.y + Math.sin(th) * len };
      const [ax, ay] = this.toPx(a.x, a.y);
      const [bx, by] = this.toPx(b.x, b.y);
      g.strokeStyle = c.ink3;
      g.lineWidth = 1.25;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      const ang = Math.atan2(by - ay, bx - ax);
      g.moveTo(bx, by);
      g.lineTo(bx - 8 * Math.cos(ang - 0.45), by - 8 * Math.sin(ang - 0.45));
      g.moveTo(bx, by);
      g.lineTo(bx - 8 * Math.cos(ang + 0.45), by - 8 * Math.sin(ang + 0.45));
      g.stroke();
      g.textAlign = 'center';
      g.fillText(`floor rises ${lab(f.drop)}`, (ax + bx) / 2, Math.min(ay, by) - 6);
      g.fillText('low', ax, ay + 12);
      g.fillText('high', bx, by + 12);
    } else if (f.type === 'vertices') {
      g.textAlign = 'center';
      pit.outline.forEach((q, i) => {
        const [px, py] = this.toPx(q.x, q.y);
        g.fillText(lab(pit.vertexZ[i]), px, py - 5);
      });
    }
  }

  private hit(px: number, py: number): { id: string; kind: 'sensor' | 'manhole' } | null {
    const d = this.ctx.derived();
    let best: string | null = null;
    let bestD = 14;
    for (const g of d.geoms) {
      const [sx, sy] = this.toPx(g.sensor.x, g.sensor.y);
      const dist = Math.hypot(sx - px, sy - py);
      if (dist < bestD) {
        bestD = dist;
        best = g.sensor.id;
      }
    }
    if (best) return { id: best, kind: 'sensor' };
    // Sensors win over the manhole they sit on; otherwise any point on the opening picks the manhole.
    const [x, y] = this.toPlan(px, py);
    for (const mh of manholesOf(this.ctx.store.project.tank)) {
      if (manholeClearance(mh, x, y) >= -6 / this.frame.k) return { id: mh.id, kind: 'manhole' };
    }
    return null;
  }

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private down = (e: PointerEvent) => {
    const [px, py] = this.local(e);
    const hit = this.hit(px, py);
    if (!hit) return;
    // Keep the grab offset so a manhole does not jump to the pointer.
    const [x, y] = this.toPlan(px, py);
    const p = this.ctx.store.project;
    const obj = hit.kind === 'sensor' ? p.sensors.find((s) => s.id === hit.id) : manholesOf(p.tank).find((m) => m.id === hit.id);
    this.drag = { ...hit, dx: hit.kind === 'manhole' && obj ? obj.x - x : 0, dy: hit.kind === 'manhole' && obj ? obj.y - y : 0 };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private move = (e: PointerEvent) => {
    const [px, py] = this.local(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.hit(px, py) ? 'grab' : 'default';
      return;
    }
    this.canvas.style.cursor = 'grabbing';
    const d = this.ctx.derived();
    const hull = d.hull;
    let [x, y] = this.toPlan(px, py);
    x += this.drag.dx;
    y += this.drag.dy;
    const snap = niceStep(hull.size / 300);
    x = Math.round(x / snap) * snap;
    y = Math.round(y / snap) * snap;
    if (!hull.span(x, y)) {
      // Pull the point back toward a point inside (the plan origin, or the middle of a storage) until it fits.
      const c = d.kind === 'pit' ? centroid(d.pit.outline) : { x: 0, y: 0 };
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const t = (lo + hi) / 2;
        if (hull.span(c.x + (x - c.x) * t, c.y + (y - c.y) * t)) lo = t;
        else hi = t;
      }
      x = Math.round((c.x + (x - c.x) * lo) / snap) * snap;
      y = Math.round((c.y + (y - c.y) * lo) / snap) * snap;
      if (!hull.span(x, y)) return;
    }
    const { id, kind } = this.drag;
    this.ctx.store.update('sensors', (s) => {
      if (kind === 'manhole') {
        const mh = manholesOf(s.project.tank).find((q) => q.id === id);
        if (mh) moveManhole(mh, s.project.sensors, x, y);
        return;
      }
      const sensor = s.project.sensors.find((q) => q.id === id);
      if (sensor) {
        sensor.x = x;
        sensor.y = y;
      }
    });
  };

  private up = (e: PointerEvent) => {
    const id = this.drag?.id;
    this.drag = null;
    this.canvas.style.cursor = 'default';
    if (!id) return;
    this.canvas.releasePointerCapture(e.pointerId);
    // Select on release so the panel re-render does not interrupt the drag.
    if (e.type === 'pointerup') this.onSelect(id);
  };
}

export function withAlpha(hex: string, a: number): string {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
