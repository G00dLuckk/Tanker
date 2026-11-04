import { LIQUIDS } from '../core/defaults';
import type { Derived } from '../core/derive';
import { MAX_TILT } from '../core/derive';
import { TORI_STANDARDS } from '../core/heads';
import { polygonWidthAcrossCorners } from '../core/shape';
import { bodyPerimeter, buildTank, canBeUniform, isRoundBody, overallOf, resolveBodySize, syncTankInputs, uniformBody } from '../core/tank';
import type { BodyType, HeadConfig, HeadType, Project, TankConfig, ToriBy } from '../core/types';
import { LENGTH, MM3_TO_L, VOLUME, fmtLen, fmtVol, plain } from '../core/units';
import { capacityOf } from '../core/volume';
import { h, icon } from './dom';
import {
  FieldSet,
  cellInput,
  explain,
  infoField,
  lengthField,
  note,
  numField,
  plainField,
  segmented,
  selectField,
  toggleField,
  type Ctx,
  type Field,
  type Option,
} from './fields';

export interface PanelCtx extends Ctx {
  derived(): Derived;
}

const T = (ctx: PanelCtx) => ctx.store.project.tank;

export interface HeadChoice {
  value: HeadType;
  label: string;
  /** Side view of the end as a top head (24 × 24, shell walls at x = 4 and 20). */
  svg: string;
}

/** End shapes that fit this body, in families, each with a side-view picture. */
export function headGroups(t: TankConfig): { title: string; items: HeadChoice[] }[] {
  const round = t.body.type === 'cylinder' || t.body.type === 'oval';
  const groups: { title: string; items: HeadChoice[] }[] = [
    {
      title: 'Flat',
      items: [
        { value: 'flat', label: 'Flat', svg: '<path d="M4 22v-8h16v8"/>' },
        { value: 'flanged', label: 'Flat + knuckle', svg: '<path d="M4 22v-6a3.5 3.5 0 0 1 3.5-3.5h9a3.5 3.5 0 0 1 3.5 3.5v6"/>' },
      ],
    },
    {
      title: 'Domed',
      items: [
        { value: 'dished', label: 'Shallow dome', svg: '<path d="M4 22v-7a14 14 0 0 1 16 0v7"/>' },
        { value: 'torispherical', label: 'Torispherical', svg: '<path d="M4 22v-7c0-1.8.9-2.9 2.4-3.5a15 15 0 0 1 11.2 0c1.5.6 2.4 1.7 2.4 3.5v7"/>' },
        { value: 'ellipsoidal', label: 'Ellipsoidal', svg: '<path d="M4 22v-7a8 4.5 0 0 1 16 0v7"/>' },
        { value: 'hemi', label: 'Hemispherical', svg: '<path d="M4 22v-7a8 8 0 0 1 16 0v7"/>' },
        { value: 'paraboloid', label: 'Paraboloidal', svg: '<path d="M4 22v-7Q12-1 20 15v7"/>' },
      ],
    },
    {
      title: round ? 'Conical' : 'Pyramid',
      items: [
        { value: 'cone', label: round ? 'Cone' : 'Pyramid / hopper', svg: '<path d="M4 22v-7l6.5-7h3l6.5 7v7"/>' },
        ...(round ? [{ value: 'toricone' as HeadType, label: 'Cone + knuckle', svg: '<path d="M4 22v-6c0-1.4.5-2.5 1.6-3.4L10.5 8h3l4.9 4.6c1.1.9 1.6 2 1.6 3.4v6"/>' }] : []),
      ],
    },
  ];
  if (!round && t.body.type !== 'sphere' && t.orientation === 'vertical') {
    groups.push({
      title: 'Sloped floor or roof',
      items: [
        { value: 'wedge', label: 'V-trough', svg: '<path d="M4 22v-7l5.5-6h5l5.5 6v7"/><path d="M9.5 9v6M14.5 9v6"/>' },
        { value: 'sloped', label: 'Single slope', svg: '<path d="M4 22V9l16 6v7"/>' },
      ],
    });
  }
  return groups;
}

export function headTypeOptions(t: TankConfig): Option<HeadType>[] {
  return headGroups(t).flatMap((g) => g.items.map((i) => ({ value: i.value, label: i.label })));
}

/** One-line plain descriptions of each end shape, shown under the choice. */
export const HEAD_INFO: Record<HeadType, string> = {
  flat: 'A flat plate. Common on plastic, steel and rectangular tanks.',
  dished: 'A low spherical dome (or dish). Give its depth, the dish radius from the drawing, or the arc length (a tape laid over it).',
  ellipsoidal: 'Half of an ellipse. A standard 2:1 head is a quarter of the diameter deep. You can also give the depth or the arc length (a tape laid over it) directly.',
  torispherical: 'A dish with a rounded knuckle at the edge, used on most pressure vessels. Pick the standard from the drawing (Klöpper, Korbbogen, ASME), or Measured sizes: the depth alone, the arc length alone, or any two of depth, crown radius, knuckle radius and arc length.',
  hemi: 'Half of a sphere: as deep as the radius. Used on high-pressure and LPG tanks.',
  cone: 'A cone (round tanks) or pyramid (box and polygon tanks). Give the wall angle or the depth, and the outlet size at the tip.',
  wedge: 'Two sloping walls that meet in a flat strip, like a V. Liquid runs to the middle strip.',
  sloped: 'The whole floor slopes one way, toward a drain side.',
  flanged: 'A flat plate with a rounded edge (knuckle) where it meets the shell. Give the knuckle radius; the head is that deep.',
  paraboloid: 'A dome shaped like a parabola: pointed more than a hemisphere at the same depth. Give the head depth.',
  toricone: 'A cone with a rounded knuckle where it meets the shell, as on most steel silos and process vessels. Give the wall angle or the depth, the outlet and the knuckle radius.',
};

/** Keeps head choices valid after body or orientation changes. */
export function sanitizeHeads(t: TankConfig): void {
  for (const k of ['start', 'end'] as const) {
    const ok = headTypeOptions(t).some((o) => o.value === t[k].type);
    if (!ok) t[k].type = 'cone';
  }
  if (t.body.type === 'sphere') t.orientation = 'vertical';
}

export function endLabels(p: Project): { start: string; end: string } {
  return p.tank.orientation === 'vertical'
    ? { start: 'Bottom (footer)', end: 'Top (head)' }
    : { start: 'Left end', end: 'Right end' };
}

function section(id: string, title: string, summary: () => string, open: Set<string>, ...children: (HTMLElement | null)[]) {
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
  return { el: det, refresh: () => (sum.textContent = summary()) } as Field;
}

export let onSectionToggle: (() => void) | null = null;
export function setSectionToggleHandler(fn: () => void) {
  onSectionToggle = fn;
}

function grid(...items: (Field | null)[]): HTMLElement {
  return h('div', { class: 'field-grid' }, items.filter(Boolean).map((f) => (f as Field).el));
}

interface BodyTile {
  type: BodyType;
  label: string;
  svg: string;
}

/** Body cross-sections in three families. */
const BODY_GROUPS: { title: string; tiles: BodyTile[] }[] = [
  {
    title: 'Round',
    tiles: [
      { type: 'cylinder', label: 'Cylinder', svg: '<circle cx="12" cy="12" r="8"/>' },
      { type: 'oval', label: 'Oval', svg: '<ellipse cx="12" cy="12" rx="10" ry="6.5"/>' },
      { type: 'sphere', label: 'Sphere', svg: '<circle cx="12" cy="12" r="8"/><path d="M4 12c2.5 3 13.5 3 16 0"/>' },
    ],
  },
  {
    title: 'Flat sides',
    tiles: [
      { type: 'rect', label: 'Box', svg: '<rect x="3" y="5.5" width="18" height="13" rx="1.5"/>' },
      { type: 'chamfer', label: 'Cut corners', svg: '<path d="M7 5.5h10l4 4v5l-4 4H7l-4-4v-5z"/>' },
      { type: 'polygon', label: 'Polygon', svg: '<path d="M8.7 3.5h6.6l4.7 4.7v6.6l-4.7 4.7H8.7L4 14.8V8.2z"/>' },
      { type: 'trapezoid', label: 'Trapezoid', svg: '<path d="M2.5 6h19l-4.5 12H7z"/>' },
    ],
  },
  {
    title: 'Round and flat',
    tiles: [
      { type: 'stadium', label: 'Stadium', svg: '<rect x="2.5" y="6" width="19" height="12" rx="6"/>' },
      { type: 'boxoval', label: 'Box-oval', svg: '<path d="M12 5.5c7.6 0 9.5.9 9.5 6.5s-1.9 6.5-9.5 6.5-9.5-.9-9.5-6.5S4.4 5.5 12 5.5z"/>' },
      { type: 'dshape', label: 'D-shape', svg: '<path d="M4 19v-7a8 8 0 0 1 16 0v7z"/>' },
      { type: 'trough', label: 'U-shape', svg: '<path d="M4 5v7a8 8 0 0 0 16 0V5z"/>' },
    ],
  },
];

const BODY_TILES: BodyTile[] = BODY_GROUPS.flatMap((g) => g.tiles);

const BODY_INFO: Record<BodyType, string> = {
  cylinder: 'Round shell. Standing (vertical) or lying (horizontal).',
  oval: 'Elliptical shell, wider than high. Typical for road tankers and some trailers.',
  rect: 'Box with straight walls. Set a corner radius for rounded corners (IBC, plastic tanks).',
  stadium: 'Two flat sides joined by two half circles (obround).',
  polygon: 'Flat sides with sharp corners: hexagon, octagon, 10 or 12 sides. Set width and depth equal for a regular octagon.',
  sphere: 'Ball tank. Only the diameter and the wall matter.',
  chamfer: 'Box with the four corners cut off at 45°. Give the size of the cut along each side.',
  trapezoid: 'Two parallel sides of different width, like many fuel trailers and hoppers. Lying: give the top and bottom widths. Standing: the back and front widths.',
  boxoval: 'Between an oval and a box (superellipse), as on road tankers. Squareness 2 is an oval, 4 a typical tanker, 8 or more almost a box.',
  dshape: 'Flat on one side, half round on the other. Lying: flat floor, round roof. Standing: flat front, round back (for tanks against a wall).',
  trough: 'Flat on one side, half round on the other. Lying: round bottom, flat top, like a trough. Standing: round front, flat back.',
};

function bodyTiles(ctx: PanelCtx): Field {
  const btns = BODY_TILES.map((b) => {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'tile',
        id: `body-${b.type}`,
        on: {
          click: () =>
            ctx.store.update(['tank', 'structure'], (s) => {
              const t = s.project.tank;
              t.body.type = b.type;
              if (b.type === 'polygon' && ![6, 8, 10, 12].includes(t.body.sides)) t.body.sides = 8;
              if (b.type === 'sphere') {
                t.orientation = 'vertical';
                t.start.type = 'hemi';
                t.end.type = 'hemi';
              } else if (t.start.type === 'hemi' && t.end.type === 'hemi' && t.body.length <= 0) {
                t.body.length = resolveBodySize(t).body.diameter;
              }
              sanitizeHeads(t);
            }),
        },
      },
      svgEl(b.svg),
      h('span', null, b.label),
    );
    return btn;
  });
  const info = h('p', { class: 'field-note tiles-note' });
  const groupEls = BODY_GROUPS.map((g) =>
    h(
      'div',
      { class: 'tile-group', role: 'group', 'aria-label': g.title },
      h('span', { class: 'tile-group-title' }, g.title),
      h('div', { class: 'tiles tiles-4' }, g.tiles.map((t) => btns[BODY_TILES.indexOf(t)])),
    ),
  );
  const el = h(
    'div',
    { class: 'field field-wide' },
    h('span', { class: 'field-label', id: 'body-lbl' }, 'Body shape (cross-section)'),
    h('div', { class: 'tile-groups', role: 'group', 'aria-labelledby': 'body-lbl' }, groupEls),
    info,
  );
  const refresh = () => {
    const cur = T(ctx).body.type;
    BODY_TILES.forEach((b, i) => btns[i].setAttribute('aria-pressed', String(b.type === cur)));
    info.textContent = BODY_INFO[cur];
  };
  refresh();
  return { el, refresh };
}

function svgEl(inner: string, cls = 'tile-icon'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  svg.innerHTML = inner;
  return svg;
}

/**
 * Picture tiles for the end shapes, in families. The pictures turn to match the end:
 * up for a top head, down for a bottom, sideways for the ends of a lying tank.
 */
function headPicker(ctx: PanelCtx, o: { id: string; label: string; dir: 'up' | 'down' | 'left' | 'right'; get: () => HeadType; set: (v: HeadType) => void }): Field {
  const groups = headGroups(T(ctx));
  const btns: { value: HeadType; el: HTMLElement }[] = [];
  const groupEls = groups.map((g) =>
    h(
      'div',
      { class: 'tile-group', role: 'group', 'aria-label': g.title },
      h('span', { class: 'tile-group-title' }, g.title),
      h(
        'div',
        { class: 'tiles tiles-4' },
        g.items.map((it) => {
          const el = h(
            'button',
            {
              type: 'button',
              class: 'tile tile-sm',
              id: `${o.id}-${it.value}`,
              title: HEAD_INFO[it.value],
              on: { click: () => ctx.store.update(['tank', 'structure'], () => o.set(it.value)) },
            },
            svgEl(it.svg, `tile-icon head-${o.dir}`),
            h('span', null, it.label),
          );
          btns.push({ value: it.value, el });
          return el;
        }),
      ),
    ),
  );
  const el = h('div', { class: 'field field-wide' }, h('span', { class: 'field-label', id: `${o.id}-lbl` }, o.label), h('div', { class: 'tile-groups', role: 'group', 'aria-labelledby': `${o.id}-lbl` }, groupEls));
  const refresh = () => {
    const cur = o.get();
    for (const b of btns) b.el.setAttribute('aria-pressed', String(b.value === cur));
  };
  refresh();
  return { el, refresh };
}

/** Shape settings of one end, leaving its plate thickness alone. */
export function copyHeadShape(from: HeadConfig, to: HeadConfig): void {
  Object.assign(to, structuredClone({ ...from, thickness: to.thickness }));
}

const TORI_BY: Option<ToriBy>[] = [
  { value: 'depth', label: 'Head depth only' },
  { value: 'arc', label: 'Arc length only' },
  { value: 'depth-crown', label: 'Depth + crown radius' },
  { value: 'depth-knuckle', label: 'Depth + knuckle radius' },
  { value: 'crown-knuckle', label: 'Crown + knuckle radius' },
  { value: 'arc-depth', label: 'Arc length + depth' },
  { value: 'arc-crown', label: 'Arc length + crown radius' },
  { value: 'arc-knuckle', label: 'Arc length + knuckle radius' },
];

/**
 * Editor for one end shape. `which` is the end the fields show; with both ends
 * linked every change is written to both.
 */
function headFields(ctx: PanelCtx, fs: FieldSet, which: 'start' | 'end', title: string, linked = false): HTMLElement | null {
  const hc = (): HeadConfig => T(ctx)[which];
  const each = (fn: (x: HeadConfig) => void) => (linked ? [T(ctx).start, T(ctx).end] : [hc()]).forEach(fn);
  const t = T(ctx);
  if (t.body.type === 'sphere') return null;
  const type = hc().type;
  const id = (k: string) => `${which}-${k}`;
  const items: (Field | null)[] = [];
  const outside = t.basis === 'outside';
  const model = () => ctx.derived().model[which];
  const u = () => ctx.store.project.units.length;
  const depthNote = () => {
    const m = model();
    const extra = m.meta.angle !== undefined ? ` · wall ${m.meta.angle.toFixed(1)}°` : '';
    return m.depth > 0 ? `Inside depth ${fmtLen(m.depth, u())}${extra}` : '';
  };
  /** Inside depth, radii and arc of the head as it is now, for a note under the fields. */
  const shapeNote = () => {
    const m = model();
    const parts = [`Inside depth ${fmtLen(m.depth, u())}`];
    if (m.meta.crownR) parts.push(`crown R ${fmtLen(m.meta.crownR, u())}`);
    if (m.meta.knuckleR) parts.push(`knuckle r ${fmtLen(m.meta.knuckleR, u())}`);
    if (m.meta.sphereR) parts.push(`dish R ${fmtLen(m.meta.sphereR, u())}`);
    if (m.meta.arc) parts.push(`arc ${fmtLen(m.meta.arc, u())}`);
    return `${parts.join(' · ')} (inside)`;
  };
  /**
   * Before switching how the head is sized, fill every size with the head as it is now
   * (on the dimension basis), so the shape does not jump.
   */
  const prefill = () => {
    const m = model();
    // Exact values (the fields show them rounded), so switching does not move the head at all.
    const w = T(ctx).basis === 'outside' ? Math.max(0, hc().thickness) : 0;
    each((x) => {
      if (m.depth > 0) x.depth = m.depth + w;
      if (m.meta.crownR) x.crownR = m.meta.crownR + w;
      if (m.meta.knuckleR) x.knuckleR = m.meta.knuckleR + w;
      if (m.meta.sphereR) x.dishRadius = m.meta.sphereR;
      // The outside arc is longer by the wall × the angle the arc turns through.
      if (m.meta.arc) x.arc = m.meta.arc + w * (m.meta.sphereR ? m.meta.arc / m.meta.sphereR : Math.PI);
    });
  };
  const issueNote = note(() => model().meta.issue ?? '', 'warn');

  const dir = linked || t.orientation === 'vertical' ? (which === 'end' || linked ? 'up' : 'down') : which === 'start' ? 'left' : 'right';
  items.push(
    headPicker(ctx, { id: id('type'), label: title, dir, get: () => hc().type, set: (v) => each((x) => (x.type = v)) }),
    note(() => HEAD_INFO[hc().type] ?? ''),
  );

  // Size of this end: the two sizes across come from the shell end, the depth is the head's.
  // Vertical tank: X width, Y depth, Z head depth. Horizontal tank: X head depth (along the length), Y width, Z height.
  const vertical = t.orientation === 'vertical';
  const locked = !!hc().uniform && canBeUniform(type);
  const endSizes = () => {
    const m = ctx.derived().model;
    const k = which === 'end' ? m.endScale : 1;
    const out = T(ctx).basis === 'outside';
    const wall = out ? m.t.shell : 0;
    const w = 2 * (m.base.A * k + wall);
    const dd = 2 * (m.base.B * k + wall);
    const z = model().depth + (out && model().depth > 0 ? Math.max(0, hc().thickness) : 0);
    // No-break spaces keep each axis with its size when the line wraps.
    const f = (axis: string, v: number) => `${axis}\u00a0${fmtLen(v, u()).replace(/ /g, '\u00a0')}`;
    return (vertical ? [f('X', w), f('Y', dd), f('Z', z)] : [f('X', z), f('Y', w), f('Z', dd)]).join('  ·  ');
  };
  items.push(infoField({ label: `Size, ${outside ? 'outside' : 'inside'} (${vertical ? 'X, Y' : 'Y, Z'} from the shell)`, value: endSizes }));
  if (canBeUniform(type)) {
    items.push(
      toggleField(ctx, {
        id: id('uniform'),
        label: `Same size (depth ${vertical ? 'Z' : 'X'} = width ${vertical ? 'X' : 'Y'})`,
        hint: 'On: the head is as deep as the shell is wide at this end, and follows the shell when you change its size. Off: size the head on its own.',
        get: () => !!hc().uniform,
        set: (v) => {
          if (!v) {
            // Keep the head as it is now: size it by its depth.
            prefill();
            each((x) => ((x.ratioBy = 'depth'), (x.sizeBy = 'depth')));
          }
          each((x) => (x.uniform = v));
        },
        change: ['tank', 'structure'],
      }),
    );
  }

  if (type === 'ellipsoidal' && !locked) {
    items.push(
      segmented(ctx, {
        id: id('ratioby'),
        label: 'Size by',
        options: [
          { value: 'ratio', label: 'Ratio' },
          { value: 'depth', label: 'Head depth' },
          { value: 'arc', label: 'Arc length' },
        ],
        get: () => hc().ratioBy,
        set: (v) => {
          if (v === hc().ratioBy) return;
          prefill();
          if (v === 'ratio') {
            const m = ctx.derived().model;
            const R = (m.round ? m.base.A : (m.base.A + m.base.B) / 2) * (which === 'end' ? m.endScale : 1);
            const d0 = model().depth;
            if (d0 > 0) each((x) => (x.ellipseRatio = Math.min(20, Math.max(0.5, Math.round((R / d0) * 100) / 100))));
          }
          each((x) => (x.ratioBy = v));
        },
        change: ['tank', 'structure'],
      }),
    );
    if (hc().ratioBy === 'arc') {
      items.push(
        lengthField(ctx, {
          id: id('earc'),
          label: `Arc length over the head, ${outside ? 'outside' : 'inside'}`,
          hint: 'Tape laid over the head from the tangent line on one side, through the centre, to the tangent line on the other side.',
          min: 0,
          get: () => hc().arc,
          set: (v) => each((x) => (x.arc = v)),
          change: ['tank'],
          note: shapeNote,
        }),
        issueNote,
      );
    } else if (hc().ratioBy === 'depth') {
      items.push(
        lengthField(ctx, {
          id: id('edepth'),
          label: outside ? 'Head depth (outside)' : 'Head depth (inside)',
          hint: 'From the tangent line (where the straight shell ends) to the tip of the head.',
          min: 0,
          get: () => hc().depth,
          set: (v) => each((x) => (x.depth = v)),
          change: ['tank'],
          note: () => {
            const m = model();
            return `${m.meta.label} · inside depth ${fmtLen(m.depth, ctx.store.project.units.length)}`;
          },
        }),
      );
    } else {
      items.push(
        plainField(ctx, {
          id: id('ratio'),
          label: 'Ratio R : depth',
          unit: ': 1',
          dp: 2,
          min: 0.5,
          max: 20,
          step: 0.1,
          hint: '2 means the head depth is half the radius (a quarter of the diameter).',
          get: () => hc().ellipseRatio,
          set: (v) => each((x) => (x.ellipseRatio = v)),
          change: ['tank'],
          note: depthNote,
        }),
      );
    }
  }
  if (type === 'hemi') items.push(infoField({ label: 'Inside depth', value: () => fmtLen(model().depth, ctx.store.project.units.length) }));
  if (type === 'paraboloid' && !locked) {
    items.push(
      lengthField(ctx, {
        id: id('pdepth'),
        label: outside ? 'Head depth (outside)' : 'Head depth (inside)',
        hint: 'From the tangent line (where the straight shell ends) to the tip of the head.',
        min: 0,
        get: () => hc().depth,
        set: (v) => each((x) => (x.depth = v)),
        change: ['tank'],
        note: depthNote,
      }),
    );
  }
  const knuckleField = () =>
    lengthField(ctx, {
      id: id('knuckle-r'),
      label: `Knuckle radius (${outside ? 'outside' : 'inside'})`,
      hint: 'Radius of the rounded edge where the end turns into the shell (r on the drawing).',
      min: 0,
      get: () => hc().knuckleR,
      set: (v) => each((x) => (x.knuckleR = v)),
      change: ['tank'],
      note: depthNote,
    });
  if (type === 'flanged') items.push(knuckleField());
  if (type === 'torispherical') {
    items.push(
      selectField(ctx, {
        id: id('tori'),
        label: 'Standard',
        hint: 'As in the standards, D is the outside diameter of the head (inside diameter + 2 × plate) and the crown and knuckle radii are inside radii.',
        options: () => [
          { value: 'klopper', label: 'Klöpper · DIN 28011' },
          { value: 'korbbogen', label: 'Korbbogen · DIN 28013' },
          { value: 'asme', label: 'ASME F&D' },
          { value: 'r8010', label: '80:10 (crown 0.8 D, knuckle 0.1 D)' },
          { value: 'custom', label: 'Custom radii (× D)' },
          { value: 'measured', label: 'Measured sizes' },
        ],
        get: () => hc().tori,
        set: (v) => {
          const was = hc().tori;
          if (v === 'measured' && was !== 'measured') {
            prefill();
            // Depth-only and arc-only keep the knuckle of the standard the head had.
            if (was !== 'custom') each((x) => (x.knuckle = TORI_STANDARDS[was].knuckle));
          }
          each((x) => (x.tori = v));
        },
        change: ['tank', 'structure'],
      }),
    );
    if (hc().tori === 'measured') {
      const by = hc().toriBy;
      const side = outside ? 'outside' : 'inside';
      items.push(
        selectField(ctx, {
          id: id('toriby'),
          label: 'Sizes you have',
          wide: true,
          options: () => TORI_BY,
          get: () => hc().toriBy,
          set: (v) => {
            prefill();
            each((x) => (x.toriBy = v));
          },
          change: ['tank', 'structure'],
        }),
      );
      if (by.includes('depth')) {
        items.push(
          lengthField(ctx, {
            id: id('tdepth'),
            label: `Head depth (${side})`,
            hint: 'From the tangent line (where the straight shell ends) to the tip of the head.',
            min: 0,
            get: () => hc().depth,
            set: (v) => each((x) => (x.depth = v)),
            change: ['tank'],
          }),
        );
      }
      if (by.includes('crown')) {
        items.push(
          lengthField(ctx, {
            id: id('tcrown'),
            label: `Crown (arc) radius, ${side}`,
            hint: 'Radius of the big curve in the middle of the head (R on the drawing). Larger than the shell radius.',
            min: 0,
            get: () => hc().crownR,
            set: (v) => each((x) => (x.crownR = v)),
            change: ['tank'],
          }),
        );
      }
      if (by.includes('knuckle')) {
        items.push(
          lengthField(ctx, {
            id: id('tknuckle'),
            label: `Knuckle radius, ${side}`,
            hint: 'Radius of the small curve at the edge, where the head turns into the shell (r on the drawing).',
            min: 0,
            get: () => hc().knuckleR,
            set: (v) => each((x) => (x.knuckleR = v)),
            change: ['tank'],
          }),
        );
      }
      if (by === 'depth' || by === 'arc') {
        items.push(
          plainField(ctx, {
            id: id('tkfrac'),
            label: 'Knuckle radius (assumed)',
            unit: '× D',
            dp: 3,
            min: 0.01,
            max: 0.5,
            step: 0.01,
            hint: 'With one measurement the knuckle follows the standard: 0.1 × D for DIN 28011 / Klöpper, 0.154 for Korbbogen, 0.06 for ASME F&D (D = outside diameter of the head). The crown radius is worked out.',
            get: () => hc().knuckle,
            set: (v) => each((x) => (x.knuckle = v)),
            change: ['tank'],
          }),
        );
      }
      if (by.startsWith('arc')) {
        items.push(
          lengthField(ctx, {
            id: id('tarc'),
            label: `Arc length over the head, ${side}`,
            hint: 'Tape laid over the head from the tangent line on one side, through the centre, to the tangent line on the other side.',
            min: 0,
            get: () => hc().arc,
            set: (v) => each((x) => (x.arc = v)),
            change: ['tank'],
          }),
        );
      }
      items.push(note(shapeNote), issueNote);
    }
    if (hc().tori === 'custom') {
      items.push(
        plainField(ctx, { id: id('crown'), label: 'Crown radius', unit: '× D', hint: 'Inside crown radius as a fraction of D, the outside diameter of the head.', dp: 3, min: 0.5, max: 5, step: 0.01, get: () => hc().crown, set: (v) => each((x) => (x.crown = v)), change: ['tank'] }),
        plainField(ctx, { id: id('knuckle'), label: 'Knuckle radius', unit: '× D', dp: 3, min: 0.01, max: 0.5, step: 0.01, get: () => hc().knuckle, set: (v) => each((x) => (x.knuckle = v)), change: ['tank'], note: depthNote }),
      );
    } else if (hc().tori !== 'measured') {
      items.push(infoField({ label: 'Inside depth', value: () => fmtLen(model().depth, ctx.store.project.units.length) }));
    }
  }
  if (type === 'dished') {
    items.push(
      segmented(ctx, {
        id: id('dishby'),
        label: 'Size by',
        options: [
          { value: 'depth', label: 'Depth' },
          { value: 'radius', label: 'Dish radius' },
          { value: 'arc', label: 'Arc length' },
        ],
        get: () => hc().dishBy,
        set: (v) => {
          if (v !== hc().dishBy) prefill();
          each((x) => (x.dishBy = v));
        },
        change: ['tank', 'structure'],
      }),
    );
    if (hc().dishBy === 'arc') {
      items.push(
        lengthField(ctx, {
          id: id('darc'),
          label: `Arc length over the dome, ${outside ? 'outside' : 'inside'}`,
          hint: 'Tape laid over the dome from the edge on one side, through the centre, to the edge on the other side. Longer than the diameter.',
          min: 0,
          get: () => hc().arc,
          set: (v) => each((x) => (x.arc = v)),
          change: ['tank'],
          note: shapeNote,
        }),
        issueNote,
      );
    } else if (hc().dishBy === 'radius') {
      items.push(
        lengthField(ctx, {
          id: id('dishr'),
          label: 'Dish radius (inside)',
          hint: 'Radius of the sphere the dome is cut from (often written as R on the drawing). It cannot be smaller than the shell radius.',
          min: 1,
          get: () => hc().dishRadius,
          set: (v) => each((x) => (x.dishRadius = v)),
          change: ['tank'],
          note: depthNote,
        }),
      );
    } else {
      items.push(
        lengthField(ctx, {
          id: id('depth'),
          label: outside ? 'Depth (outside)' : 'Depth (inside)',
          min: 0,
          get: () => hc().depth,
          set: (v) => each((x) => (x.depth = v)),
          change: ['tank'],
          note: depthNote,
        }),
      );
    }
  }
  if (type === 'cone' || type === 'wedge' || type === 'sloped' || type === 'toricone') {
    if (!locked) {
      items.push(
        segmented(ctx, {
          id: id('sizeby'),
          label: 'Size by',
          options: [
            { value: 'angle', label: 'Wall angle' },
            { value: 'depth', label: 'Depth' },
          ],
          get: () => hc().sizeBy,
          set: (v) => each((x) => (x.sizeBy = v)),
          change: ['tank', 'structure'],
        }),
      );
      if (hc().sizeBy === 'angle') {
        items.push(
          plainField(ctx, {
            id: id('angle'),
            label: 'Wall angle',
            unit: '°',
            dp: 2,
            min: 0.5,
            max: 89,
            step: 1,
            hint: 'Angle between the sloping wall and the flat end plane. 0° would be flat.',
            get: () => hc().angle,
            set: (v) => each((x) => (x.angle = v)),
            change: ['tank'],
            note: depthNote,
          }),
        );
      } else {
        items.push(
          lengthField(ctx, {
            id: id('depth'),
            label: outside ? 'Depth (outside)' : 'Depth (inside)',
            min: 0,
            get: () => hc().depth,
            set: (v) => each((x) => (x.depth = v)),
            change: ['tank'],
            note: depthNote,
          }),
        );
      }
    }
    const round = t.body.type === 'cylinder' || t.body.type === 'oval';
    if (type === 'toricone') {
      items.push(
        lengthField(ctx, { id: id('outlet'), label: 'Outlet diameter', min: 0, get: () => hc().outlet, set: (v) => each((x) => (x.outlet = v)), change: ['tank'] }),
        knuckleField(),
        issueNote,
      );
    }
    if (type === 'cone') {
      items.push(
        lengthField(ctx, {
          id: id('outlet'),
          label: round ? 'Outlet diameter' : 'Outlet width',
          min: 0,
          get: () => hc().outlet,
          set: (v) => each((x) => (x.outlet = v)),
          change: ['tank'],
        }),
      );
      if (!round) {
        items.push(
          lengthField(ctx, {
            id: id('outlet2'),
            label: 'Outlet depth',
            min: 0,
            get: () => hc().outlet2,
            set: (v) => each((x) => (x.outlet2 = v)),
            change: ['tank'],
          }),
        );
      }
      items.push(
        toggleField(ctx, {
          id: id('ecc'),
          label: 'Eccentric (one side straight)',
          get: () => hc().eccentric,
          set: (v) => each((x) => (x.eccentric = v)),
          change: ['tank', 'structure'],
        }),
      );
      if (hc().eccentric) {
        const vert = t.orientation === 'vertical';
        items.push(
          segmented(ctx, {
            id: id('side'),
            label: 'Straight side',
            options: vert
              ? [
                  { value: 'neg', label: 'Left (−X)' },
                  { value: 'pos', label: 'Right (+X)' },
                ]
              : [
                  { value: 'neg', label: 'Bottom' },
                  { value: 'pos', label: 'Top' },
                ],
            get: () => hc().side,
            set: (v) => each((x) => (x.side = v)),
            change: ['tank'],
          }),
        );
      }
    }
    if (type === 'wedge') {
      items.push(
        segmented(ctx, {
          id: id('axis'),
          label: 'Walls slope across',
          options: [
            { value: 'u', label: 'Width (X)' },
            { value: 'v', label: 'Depth (Y)' },
          ],
          get: () => hc().axis,
          set: (v) => each((x) => (x.axis = v)),
          change: ['tank'],
        }),
        lengthField(ctx, { id: id('outlet'), label: 'Flat strip width', min: 0, get: () => hc().outlet, set: (v) => each((x) => (x.outlet = v)), change: ['tank'] }),
      );
    }
    if (type === 'sloped') {
      items.push(
        segmented(ctx, {
          id: id('side'),
          label: 'Low side',
          options: [
            { value: 'neg', label: 'Left (−X)' },
            { value: 'pos', label: 'Right (+X)' },
          ],
          get: () => hc().side,
          set: (v) => each((x) => (x.side = v)),
          change: ['tank'],
        }),
        lengthField(ctx, { id: id('outlet'), label: 'Flat strip width', min: 0, get: () => hc().outlet, set: (v) => each((x) => (x.outlet = v)), change: ['tank'] }),
      );
    }
  }
  items.forEach((f) => f && fs.add(f));
  return h('div', { class: 'subsection' }, grid(...items));
}

export function buildTankPanel(ctx: PanelCtx, fs: FieldSet, open: Set<string>): HTMLElement {
  const p = ctx.store.project;
  const t = p.tank;
  const sphere = t.body.type === 'sphere';
  const outside = t.basis === 'outside';
  const names = endLabels(p);
  const vert = t.orientation === 'vertical';
  const u = () => ctx.store.project.units.length;
  const d = () => ctx.derived();

  // Shape
  const shapeItems: Field[] = [];
  if (!sphere) {
    shapeItems.push(
      segmented(ctx, {
        id: 'orientation',
        label: 'Orientation',
        options: [
          { value: 'vertical', label: 'Vertical' },
          { value: 'horizontal', label: 'Horizontal' },
        ],
        get: () => T(ctx).orientation,
        set: (v) => {
          T(ctx).orientation = v;
          sanitizeHeads(T(ctx));
        },
        change: ['tank', 'structure', 'sensors'],
      }),
    );
  }
  shapeItems.push(bodyTiles(ctx));
  const linked = !sphere && !!t.sameEnds;
  if (!sphere) {
    shapeItems.push(
      toggleField(ctx, {
        id: 'same-ends',
        label: vert ? 'Same shape at top and bottom' : 'Same shape at both ends',
        hint: 'On: one set of fields sizes both ends, and both get the same inside shape. Off: set each end on its own. Plate thickness stays separate (Wall thickness).',
        get: () => !!T(ctx).sameEnds,
        set: (v) => {
          const tk = T(ctx);
          // Turning on keeps the end shown first; turning off keeps both ends as they are now.
          if (v) {
            if (vert) copyHeadShape(tk.end, tk.start);
            else copyHeadShape(tk.start, tk.end);
          } else {
            copyHeadShape(tk.start, tk.end);
            // Outside sizes are read through each end's own plate, so shift them by the plate difference.
            const dt = tk.basis === 'outside' ? Math.max(0, tk.end.thickness) - Math.max(0, tk.start.thickness) : 0;
            if (dt !== 0) {
              const meta = d().model.end.meta;
              tk.end.depth += dt;
              tk.end.crownR += dt;
              tk.end.knuckleR += dt;
              tk.end.arc += dt * (meta.sphereR && meta.arc ? meta.arc / meta.sphereR : Math.PI);
            }
          }
          tk.sameEnds = v;
        },
        change: ['tank', 'structure'],
      }),
    );
  }
  shapeItems.forEach((f) => fs.add(f));
  const bothTitle = vert ? 'Top and bottom (both ends)' : 'Left and right ends';
  const headEls = linked
    ? [headFields(ctx, fs, 'start', bothTitle, true)]
    : vert
      ? [headFields(ctx, fs, 'end', names.end), headFields(ctx, fs, 'start', names.start)]
      : [headFields(ctx, fs, 'start', names.start), headFields(ctx, fs, 'end', names.end)];
  const shape = fs.add(
    section(
      'shape',
      'Tank shape',
      () => {
        const m = d().model;
        if (m.bodyType === 'sphere') return 'Sphere';
        const o = T(ctx).orientation === 'vertical' ? 'Vertical' : 'Horizontal';
        return `${o} · ${BODY_TILES.find((b) => b.type === m.bodyType)?.label.toLowerCase()}`;
      },
      open,
      explain(
        'How to describe the shape',
        'A tank has three parts: the straight body (shell) in the middle and one end shape at each side. For a standing tank the ends are the bottom (footer) and the top (head); for a lying tank they are the left and right ends.',
        ['Pick the body shape first, then the end shapes.', 'If your tank is close to one in the Tank library, start from it and change the sizes.', 'The 3D view and the capacity update while you type, so you can check each step.'],
      ),
      grid(...shapeItems),
      ...headEls,
    ),
  );

  // Dimensions
  const pre = outside ? 'Outside' : 'Inside';
  const dims: (Field | null)[] = [
    segmented(ctx, {
      id: 'basis',
      label: 'Dimensions measured on the',
      options: [
        { value: 'outside', label: 'Outside' },
        { value: 'inside', label: 'Inside' },
      ],
      get: () => T(ctx).basis,
      set: (v) => (T(ctx).basis = v),
      change: ['tank', 'structure'],
    }),
  ];
  const b = () => T(ctx).body;
  const minSize = () => (T(ctx).basis === 'outside' ? 2 * b().thickness + 1 : 1);
  const poly = t.body.type === 'polygon';
  // Axes as in the 3D view. Vertical: X width, Y depth, Z height. Horizontal: X length, Y width, Z height.
  const ax = vert ? { w: 'X', d: 'Y', l: 'Z', round: 'X = Y' } : { w: 'Y', d: 'Z', l: 'X', round: 'Y = Z' };
  const locked = !sphere && !!t.body.uniform;
  /** Same size: one value for width, depth and length. */
  const setAll = (v: number) => Object.assign(b(), uniformBody({ ...b(), diameter: v, width: v }));
  if (!sphere) {
    dims.push(
      toggleField(ctx, {
        id: 'body-uniform',
        label: 'Same size (X = Y = Z)',
        hint: 'On: the width, depth and straight shell length are one size. Type any of them and the others follow. Off: type each size on its own.',
        get: () => !!b().uniform,
        set: (v) => {
          if (v) {
            // Start from the width (or diameter) the tank has now.
            syncTankInputs(T(ctx));
            Object.assign(b(), uniformBody(b()));
          }
          b().uniform = v;
        },
        change: ['tank', 'structure'],
      }),
    );
  }
  if (poly) {
    dims.push(
      segmented(ctx, {
        id: 'sides',
        label: 'Number of sides (6 = hexagon, 8 = octagon)',
        options: [
          { value: '6', label: '6' },
          { value: '8', label: '8' },
          { value: '10', label: '10' },
          { value: '12', label: '12' },
        ],
        get: () => String(b().sides),
        set: (v) => (b().sides = Number(v)),
        change: ['tank', 'structure'],
      }),
    );
  }
  const corners = poly && polygonWidthAcrossCorners(t.body.sides);
  const roundBody = isRoundBody(t.body.type);
  const byPerimeter = !locked && t.body.sizeBy === 'perimeter';
  /** Body with the diameter / width worked out from the circumference when it is given that way. */
  const eb = () => resolveBodySize(T(ctx)).body;
  const circumferenceNote = () => `Circumference ${fmtLen(bodyPerimeter(eb()), u())}`;
  if (!locked) dims.push(
    segmented(ctx, {
      id: 'sizeby',
      label: roundBody ? 'Shell size given as' : 'Width given as',
      options: [
        { value: 'size', label: roundBody ? 'Diameter' : 'Width' },
        { value: 'perimeter', label: 'Circumference (tape around)' },
      ],
      get: () => (b().sizeBy === 'perimeter' ? 'perimeter' : 'size'),
      set: (v) => {
        syncTankInputs(T(ctx));
        b().sizeBy = v;
      },
      change: ['tank', 'structure'],
    }),
  );
  if (byPerimeter) {
    dims.push(
      lengthField(ctx, {
        id: 'perimeter',
        label: `${pre} circumference`,
        hint: 'Distance once around the shell, for example a tape measure around the tank.',
        min: () => (roundBody ? Math.PI * minSize() : 0),
        get: () => b().perimeter,
        set: (v) => (b().perimeter = v),
        change: ['tank'],
        note: () => {
          const e = eb();
          return roundBody ? `${pre} diameter (${ax.round}) ${fmtLen(e.diameter, u())}` : `${pre} width (${ax.w}) ${fmtLen(e.width, u())}`;
        },
      }),
    );
  }
  if (roundBody) {
    if (!byPerimeter) {
      dims.push(
        lengthField(ctx, {
          id: 'diameter',
          label: sphere ? `${pre} diameter` : `${pre} diameter (${ax.round})`,
          min: minSize,
          get: () => b().diameter,
          set: (v) => (locked ? setAll(v) : (b().diameter = v)),
          change: ['tank'],
          note: circumferenceNote,
        }),
      );
    }
  } else {
    dims.push(
      byPerimeter
        ? null
        : lengthField(ctx, {
            id: 'width',
            label: poly
              ? `${pre} width (${ax.w}), across ${corners ? 'corners' : 'flats'}`
              : t.body.type === 'trapezoid'
                ? vert
                  ? `${pre} width at the back (X)`
                  : `${pre} width at the top (Y)`
                : `${pre} width (${ax.w})`,
            min: minSize,
            get: () => b().width,
            set: (v) => (locked ? setAll(v) : (b().width = v)),
            change: ['tank'],
            note: () => {
              if (!poly) return circumferenceNote();
              const n = b().sides;
              const regular = corners ? b().width * Math.cos(Math.PI / n) : b().width;
              return `Regular ${n}-sided: ${vert ? 'depth' : 'height'} = ${fmtLen(regular, u())} · ${circumferenceNote().toLowerCase()}`;
            },
          }),
      lengthField(ctx, {
        id: 'depth',
        label: `${pre} ${vert ? 'depth' : 'height'} (${ax.d})${poly ? ', across flats' : ''}`,
        min: minSize,
        get: () => b().depth,
        set: (v) => (locked ? setAll(v) : (b().depth = v)),
        change: ['tank'],
      }),
    );
    if (t.body.type === 'rect') {
      dims.push(lengthField(ctx, { id: 'corner', label: 'Corner radius', min: 0, get: () => b().corner, set: (v) => (b().corner = v), change: ['tank'] }));
    }
    if (t.body.type === 'trapezoid') {
      dims.push(
        lengthField(ctx, {
          id: 'width2',
          label: vert ? `${pre} width at the front (X)` : `${pre} width at the bottom (Y)`,
          hint: 'The other parallel side. The width above is the top (lying tank) or the back (standing tank).',
          min: minSize,
          get: () => b().width2,
          set: (v) => (b().width2 = v),
          change: ['tank'],
        }),
      );
    }
    if (t.body.type === 'chamfer') {
      dims.push(
        lengthField(ctx, {
          id: 'chamfer',
          label: 'Corner cut (along each side)',
          hint: 'Each corner is cut at 45°. Measure from the corner, where the two sides would meet, along one side to the start of the cut.',
          min: 0,
          get: () => b().chamfer,
          set: (v) => (b().chamfer = v),
          change: ['tank'],
        }),
      );
    }
    if (t.body.type === 'boxoval') {
      dims.push(
        plainField(ctx, {
          id: 'squareness',
          label: 'Squareness',
          unit: 'n',
          dp: 1,
          min: 2,
          max: 12,
          step: 0.5,
          hint: '2 = oval (ellipse), 4 = typical road tanker, 8 or more = almost a box with round corners.',
          get: () => b().squareness,
          set: (v) => (b().squareness = v),
          change: ['tank'],
        }),
      );
    }
    if (t.body.type === 'dshape' || t.body.type === 'trough') {
      dims.push(note(() => `Round part: radius = half the width (${fmtLen(eb().width / 2, u())}). If the ${vert ? 'depth' : 'height'} is less than that, it becomes a flatter half oval.`));
    }
  }
  if (!sphere) {
    const word = vert ? 'height' : 'length';
    const shellL = () => d().model.L;
    if (locked) {
      dims.push(
        lengthField(ctx, {
          id: 'length',
          label: `Straight shell ${word} (${ax.l})`,
          hint: 'Length of the straight part between the two heads (tangent to tangent). With Same size it equals the width.',
          min: 0,
          get: () => b().length,
          set: (v) => setAll(v),
          change: ['tank'],
          note: () => `${pre} overall ${word} ${fmtLen(overallOf(d().model, T(ctx).basis), u())}`,
        }),
      );
    }
    dims.push(
      ...(locked ? [] : [segmented(ctx, {
        id: 'lengthby',
        label: vert ? 'Height given as' : 'Length given as',
        options: [
          { value: 'shell', label: `Straight shell` },
          { value: 'overall', label: `Overall ${word} (end to end)` },
        ],
        get: () => (b().lengthBy === 'overall' ? 'overall' : 'shell'),
        set: (v) => {
          syncTankInputs(T(ctx));
          b().lengthBy = v;
        },
        change: ['tank', 'structure'],
      }),
      t.body.lengthBy === 'overall'
        ? lengthField(ctx, {
            id: 'overall',
            label: `${pre} overall ${word} (${ax.l})`,
            hint: `From the tip of one end to the tip of the other, including both ends${outside ? ' and their plates' : ''}. The straight shell is what is left.`,
            min: 0,
            get: () => b().overall,
            set: (v) => (b().overall = v),
            change: ['tank'],
            note: () => `Straight shell ${word} ${fmtLen(shellL(), u())}`,
          })
        : lengthField(ctx, {
            id: 'length',
            label: `Straight shell ${word} (${ax.l})`,
            hint: 'Length of the straight part between the two heads (tangent to tangent).',
            min: 0,
            get: () => b().length,
            set: (v) => (b().length = v),
            change: ['tank'],
            note: () => `${pre} overall ${word} ${fmtLen(overallOf(d().model, T(ctx).basis), u())}`,
          }),
      ]),
      segmented(ctx, {
        id: 'shellmode',
        label: 'Shell along its length',
        options: [
          { value: 'straight', label: 'Straight' },
          { value: 'tapered', label: 'Tapered' },
          { value: 'profile', label: 'Stepped' },
        ],
        get: () => (b().profileOn ? 'profile' : b().endScale !== 1 ? 'tapered' : 'straight'),
        set: (v) => {
          const bb = b();
          bb.profileOn = v === 'profile';
          if (v === 'straight') bb.endScale = 1;
          if (v === 'tapered' && bb.endScale === 1) bb.endScale = 0.85;
          if (v === 'profile' && !bb.profile.length) {
            const e = eb();
            const ref = e.type === 'cylinder' ? e.diameter : e.width;
            const L0 = Math.max(shellL(), 100);
            bb.profile = [
              { at: Math.round(L0 * 0.5), size: ref },
              { at: Math.round(L0 * 0.6), size: Math.round(ref * 0.7) },
              { at: Math.round(L0), size: Math.round(ref * 0.7) },
            ];
          }
        },
        change: ['tank', 'structure'],
      }),
    );
    if (t.body.endScale !== 1 && !t.body.profileOn) {
      const ref = () => (eb().type === 'cylinder' ? eb().diameter : eb().width);
      dims.push(
        lengthField(ctx, {
          id: 'endsize',
          label: `${vert ? 'Top' : 'Right-end'} ${b().type === 'cylinder' ? 'diameter' : 'width'}`,
          min: () => ref() * 0.05,
          max: () => ref() * 20,
          get: () => ref() * b().endScale,
          set: (v) => (b().endScale = Math.max(v / ref(), 0.05)),
          change: ['tank'],
        }),
      );
    }
  }
  dims.forEach((f) => f && fs.add(f));
  const profileEl = !sphere && t.body.profileOn ? profileEditor(ctx, fs) : null;
  const fitEl = fitTool(ctx, fs);
  const sizeSummary = () => {
    const m = d().model;
    return `${fmtVol(d().totalL, ctx.store.project.units.volume)} · ${fmtLen(m.outer.length, u(), true, u() === 'mm' ? 0 : undefined)} ${vert ? 'tall' : 'long'}`;
  };
  const results = [
    infoField({ label: 'Capacity', value: () => fmtVol(d().totalL, ctx.store.project.units.volume) }),
    infoField({ label: 'Full liquid depth', value: () => fmtLen(d().depth, u()) }),
    infoField({ label: vert ? 'Overall height (outside)' : 'Overall length (outside)', value: () => fmtLen(d().model.outer.length, u()) }),
    infoField({
      label: 'Inside size',
      value: () => {
        const m = d().model;
        return m.base.kind === 'ellipse' && m.round ? `Ø ${fmtLen(2 * m.base.A, u())}` : `${fmtLen(2 * m.base.A, u(), false)} × ${fmtLen(2 * m.base.B, u())}`;
      },
    }),
  ];
  results.forEach((f) => fs.add(f));
  const problems = fs.add(note(() => d().problems.join(' '), 'error'));
  const dimsSec = fs.add(
    section(
      'dims',
      'Dimensions',
      sizeSummary,
      open,
      explain(
        'Which sizes to type',
        'Type the sizes from the drawing or from a tape measure. Choose Outside if you measured the outside of the tank, Inside if the drawing gives inside sizes.',
        [
          'Straight shell height / length: only the straight part, from where one end shape starts to where the other starts (tangent to tangent). Do not include the dome or cone depth.',
          'Tapered: the shell gets wider or narrower in a straight line. Stepped: give the size at several points, for tanks with two diameters or a bulge.',
          'Capacity is the full inside volume. Check it against the nameplate: a difference of more than 1–2 % usually means a size or a head type is wrong.',
        ],
      ),
      grid(...dims),
      profileEl,
      h('div', { class: 'result-grid' }, results.map((r) => r.el)),
      problems.el,
      fitEl,
    ),
  );

  // Wall thickness
  const thick: Field[] = [
    lengthField(ctx, { id: 't-shell', label: sphere ? 'Wall' : 'Shell wall', min: 0, get: () => b().thickness, set: (v) => (b().thickness = v), change: ['tank'] }),
  ];
  if (!sphere) {
    const first = vert ? 'end' : 'start';
    const second = vert ? 'start' : 'end';
    thick.push(
      lengthField(ctx, {
        id: `t-${first}`,
        label: vert ? 'Top plate' : 'Left end plate',
        min: 0,
        get: () => T(ctx)[first].thickness,
        set: (v) => (T(ctx)[first].thickness = v),
        change: ['tank'],
      }),
      lengthField(ctx, {
        id: `t-${second}`,
        label: vert ? 'Bottom plate' : 'Right end plate',
        min: 0,
        get: () => T(ctx)[second].thickness,
        set: (v) => (T(ctx)[second].thickness = v),
        change: ['tank'],
      }),
    );
  }
  thick.forEach((f) => fs.add(f));
  const thickNote = fs.add(
    note(() =>
      T(ctx).basis === 'outside'
        ? 'Inside size = outside size − 2 × wall. Head depths you type are outside depths.'
        : 'Walls only change the outside shape and where top sensors sit; volumes use the inside sizes you typed.',
    ),
  );
  const thickSec = fs.add(
    section(
      'wall',
      'Wall thickness',
      () => `${fmtLen(b().thickness, u(), true, u() === 'mm' ? 1 : undefined)} shell`,
      open,
      explain(
        'Why the wall matters',
        'The wall makes the inside smaller than the outside, and it sets where a top sensor sits: on the outside of the roof plate. Example: a 1,850 mm outside diameter with an 8 mm wall is 1,834 mm inside, about 1.7 % less volume.',
      ),
      grid(...thick),
      thickNote.el,
    ),
  );

  // Installation & liquid
  const liquidOpts = LIQUIDS.map((l) => ({ value: l.id, label: l.id === 'custom' ? 'Custom' : `${l.label} · ${plain(l.density, 1)}` }));
  const inst: Field[] = [
    plainField(ctx, {
      id: 'tilt',
      label: vert ? 'Lean (top toward +X)' : 'Slope (right end up)',
      unit: '°',
      dp: 2,
      min: -MAX_TILT,
      max: MAX_TILT,
      step: 0.1,
      hint: 'Installation tilt. Sensors measure along the tank axis, the liquid stays level.',
      get: () => T(ctx).tilt,
      set: (v) => (T(ctx).tilt = v),
      change: ['tank'],
    }),
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
  ];
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
  const instSec = fs.add(
    section(
      'install',
      'Installation & liquid',
      () => {
        const l = LIQUIDS.find((x) => x.id === ctx.store.project.liquid.preset);
        return `${l && l.id !== 'custom' ? l.label.split(',')[0] : 'Custom'} · tilt ${plain(T(ctx).tilt, 2)}°`;
      },
      open,
      explain(
        'Tilt, liquid and levels',
        [
          'Tilt: a tank that is not level holds liquid differently. A horizontal tank 10 m long with a 0.5° slope has one end 87 mm lower than the other.',
          'Density: only pressure sensors need it (pressure = density × g × liquid height). Distance sensors do not care.',
          'Overflow level: the highest level you can really fill to. Outlet level: liquid below it cannot be pumped out.',
        ],
      ),
      grid(...inst),
    ),
  );

  return h('div', { class: 'panel-sections' }, shape.el, dimsSec.el, thickSec.el, instSec.el);
}

/** Rows of (distance along the shell, size) for the stepped / custom shell. */
function profileEditor(ctx: PanelCtx, fs: FieldSet): HTMLElement {
  const st = ctx.store;
  const b = () => T(ctx).body;
  const u = () => st.project.units.length;
  const k = () => LENGTH[u()].k;
  const dp = () => LENGTH[u()].dp;
  const vert = T(ctx).orientation === 'vertical';
  const sizeWord = b().type === 'cylinder' ? 'Diameter' : 'Width';
  /** Start size of the shell and its straight length, as worked out from however they were given. */
  const ref = () => {
    const e = resolveBodySize(T(ctx)).body;
    return e.type === 'cylinder' ? e.diameter : e.width;
  };
  const shellL = () => buildTank(T(ctx)).L;
  const basis = T(ctx).basis === 'outside' ? 'outside' : 'inside';
  const rows = b().profile.map((_, i) => {
    const pt = () => b().profile[i];
    const at = cellInput({ label: `Point ${i + 1} distance`, dp, get: () => pt().at / k(), set: (v) => st.update(['tank'], () => (pt().at = v * k())) });
    const size = cellInput({ label: `Point ${i + 1} ${sizeWord.toLowerCase()}`, dp, get: () => pt().size / k(), set: (v) => st.update(['tank'], () => (pt().size = v * k())) });
    fs.add(at);
    fs.add(size);
    const del = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `Remove point ${i + 1}`,
        on: { click: () => st.update(['tank', 'structure'], () => b().profile.splice(i, 1)) },
      },
      icon('trash', 15),
    );
    return h('tr', null, h('td', { class: 'num' }, String(i + 1)), h('td', null, at.el), h('td', null, size.el), h('td', null, del));
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
            const P = b().profile;
            const last = P[P.length - 1];
            const L = shellL();
            P.push({ at: Math.round(Math.min(L, (last?.at ?? 0) + Math.max(100, L * 0.1))), size: last?.size ?? ref() });
          }),
      },
    },
    icon('plus', 15),
    'Add point',
  );
  const startNote = note(() => {
    return `Point 0 is the ${vert ? 'bottom' : 'left end'} of the shell: ${sizeWord.toLowerCase()} ${fmtLen(ref(), u())} (from the fields above). Between points the wall is straight. After the last point the size stays the same up to the shell ${vert ? 'height' : 'length'} (${fmtLen(shellL(), u())}).`;
  });
  fs.add(startNote);
  return h(
    'div',
    { class: 'subsection profile-editor' },
    h('h4', { class: 'sub-title' }, 'Shell profile'),
    h(
      'table',
      { class: 'mini-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, '#'), h('th', null, `From ${vert ? 'bottom' : 'left'} (${unitLabel()})`), h('th', null, `${sizeWord}, ${basis} (${unitLabel()})`), h('th', null, h('span', { class: 'sr-only' }, 'Remove'))),
      ),
      h('tbody', null, rows),
    ),
    rows.length ? null : h('p', { class: 'field-note' }, 'No points yet: the shell is straight.'),
    add,
    startNote.el,
  );
}

let fitTarget = NaN;
let fitWhat: 'length' | 'size' = 'length';

/**
 * Runs `fn` on the tank as plain diameter / width and straight shell length, then
 * works the circumference and overall length out again from the result, so a
 * change made in plain sizes also holds when the sizes are given the other way.
 */
export function editInPlainSizes(t: TankConfig, fn: (t: TankConfig) => void): void {
  const { sizeBy, lengthBy } = t.body;
  syncTankInputs(t);
  t.body.sizeBy = 'size';
  t.body.lengthBy = 'shell';
  fn(t);
  syncTankInputs(t);
  t.body.sizeBy = sizeBy;
  t.body.lengthBy = lengthBy;
}

/** Solves one dimension (straight shell length, or diameter / width) so the tank holds a wanted capacity. */
export function fitToCapacity(t0: TankConfig, litres: number, what: 'length' | 'size'): { value: number; litres: number } | { error: string } {
  const t = structuredClone(t0);
  editInPlainSizes(t, () => {});
  t.body.sizeBy = 'size';
  t.body.lengthBy = 'shell';
  const apply = (c: TankConfig, x: number) => {
    if (what === 'length') {
      const f = c.body.length > 0 ? x / c.body.length : 1;
      c.body.profile = c.body.profile.map((pt) => ({ ...pt, at: pt.at * f }));
      c.body.length = x;
    } else {
      const ref = c.body.type === 'cylinder' || c.body.type === 'sphere' ? c.body.diameter : c.body.width;
      const f = ref > 0 ? x / ref : 1;
      c.body.diameter *= f;
      c.body.width *= f;
      c.body.depth *= f;
      c.body.corner *= f;
      c.body.width2 *= f;
      c.body.chamfer *= f;
      c.body.profile = c.body.profile.map((pt) => ({ ...pt, size: pt.size * f }));
    }
  };
  const cap = (x: number) => {
    const c = structuredClone(t);
    apply(c, x);
    const m = buildTank(c);
    return m.problems.length ? NaN : capacityOf(m) * MM3_TO_L;
  };
  if (!(litres > 0)) return { error: 'Type the capacity you want first.' };
  let lo = what === 'length' ? 0 : t.basis === 'outside' ? 2 * t.body.thickness + 2 : 2;
  const atLo = what === 'length' ? cap(0) : 0;
  if (what === 'length' && Number.isFinite(atLo) && atLo >= litres) {
    return { error: `The end shapes alone already hold ${fmtVol(atLo, 'L')}. Make the tank narrower or choose flatter ends.` };
  }
  let hi = Math.max(lo + 1, what === 'length' ? t.body.length || 1000 : (t.body.type === 'cylinder' || t.body.type === 'sphere' ? t.body.diameter : t.body.width) || 1000);
  for (let i = 0; i < 60 && !(cap(hi) >= litres); i++) {
    lo = hi;
    hi *= 2;
  }
  if (!(cap(hi) >= litres)) return { error: 'Could not reach that capacity with this shape.' };
  for (let i = 0; i < 80 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    const v = cap(mid);
    if (Number.isFinite(v) && v < litres) lo = mid;
    else hi = mid;
  }
  const value = Math.round((lo + hi) / 2);
  return { value, litres: cap(value) };
}

function fitTool(ctx: PanelCtx, fs: FieldSet): HTMLElement {
  const st = ctx.store;
  const t = T(ctx);
  const vu = () => st.project.units.volume;
  const sphere = t.body.type === 'sphere';
  if (sphere) fitWhat = 'size';
  const vert = t.orientation === 'vertical';
  const target = numField({
    id: 'fit-target',
    label: 'Wanted capacity',
    unit: () => VOLUME[vu()].label,
    get: () => (Number.isFinite(fitTarget) ? fitTarget / VOLUME[vu()].k : Math.round(ctx.derived().totalL / VOLUME[vu()].k)),
    set: (v) => (fitTarget = v * VOLUME[vu()].k),
    dp: () => VOLUME[vu()].dp,
    min: () => 0,
  });
  const whatSel = h('select', { id: 'fit-what', class: 'select' });
  const opts: [typeof fitWhat, string][] = sphere
    ? [['size', 'Diameter']]
    : [
        ['length', vert ? 'Straight shell height' : 'Straight shell length'],
        ['size', t.body.type === 'cylinder' ? 'Diameter' : 'Width and depth (same ratio)'],
      ];
  whatSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
  whatSel.value = fitWhat;
  whatSel.addEventListener('change', () => (fitWhat = whatSel.value as typeof fitWhat));
  const result = h('p', { class: 'field-note', role: 'status' });
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm',
      on: {
        click: () => {
          const want = Number.isFinite(fitTarget) ? fitTarget : ctx.derived().totalL;
          const r = fitToCapacity(T(ctx), want, fitWhat);
          if ('error' in r) {
            result.textContent = r.error;
            result.classList.add('is-error');
            return;
          }
          result.classList.remove('is-error');
          st.update(['tank'], (s) =>
            editInPlainSizes(s.project.tank, (c) => {
              if (fitWhat === 'length') {
                const f = c.body.length > 0 ? r.value / c.body.length : 1;
                c.body.profile = c.body.profile.map((pt) => ({ ...pt, at: Math.round(pt.at * f) }));
                c.body.length = r.value;
              } else {
                const ref = c.body.type === 'cylinder' || c.body.type === 'sphere' ? c.body.diameter : c.body.width;
                const f = ref > 0 ? r.value / ref : 1;
                c.body.diameter = Math.round(c.body.diameter * f);
                c.body.width = Math.round(c.body.width * f);
                c.body.depth = Math.round(c.body.depth * f);
                c.body.corner = Math.round(c.body.corner * f);
                c.body.profile = c.body.profile.map((pt) => ({ ...pt, size: Math.round(pt.size * f) }));
              }
            }),
          );
          const bb = st.project.tank.body;
          const lu = st.project.units.length;
          const also =
            fitWhat === 'length' && bb.lengthBy === 'overall'
              ? ` (overall ${fmtLen(bb.overall, lu)})`
              : fitWhat === 'size' && bb.sizeBy === 'perimeter'
                ? ` (circumference ${fmtLen(bb.perimeter, lu)})`
                : '';
          result.textContent = `Set to ${fmtLen(r.value, lu)}${also} (rounded to 1 mm) → capacity ${fmtVol(r.litres, vu())}.`;
        },
      },
    },
    icon('target', 15),
    'Fit',
  );
  fs.add(target);
  return h(
    'details',
    { class: 'subsection fit-tool' },
    h('summary', { class: 'sub-title' }, icon('target', 15), 'Fit the size to a capacity'),
    h('p', { class: 'field-note' }, 'Know the capacity but not one size? Type the capacity, choose which size may change, and press Fit. Everything else stays as it is.'),
    h(
      'div',
      { class: 'field-grid' },
      target.el,
      h('div', { class: 'field' }, h('label', { for: 'fit-what', class: 'field-label' }, 'Change'), h('div', { class: 'select-wrap' }, whatSel, icon('chevron', 16))),
    ),
    btn,
    result,
  );
}
