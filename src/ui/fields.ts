import type { AppState, Change } from '../app/store';
import type { Project } from '../core/types';
import { LENGTH, PRESSURE, lenFrom, lenTo, plain, presFrom, presTo, type LengthUnit, type PressureUnit } from '../core/units';
import { h, icon } from './dom';

export interface Field {
  el: HTMLElement;
  refresh(): void;
}

/** Collects the fields of a panel so they can refresh in place. */
export class FieldSet {
  readonly fields: Field[] = [];
  add<T extends Field>(f: T): T {
    this.fields.push(f);
    return f;
  }
  refresh(): void {
    for (const f of this.fields) f.refresh();
  }
}

export function parseNumber(text: string): number {
  let t = text.trim().replace(/\s+/g, '');
  if (!t) return NaN;
  if (t.includes(',') && t.includes('.')) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}

export interface NumOpts {
  id: string;
  label: string;
  /** Unit suffix shown inside the input. */
  unit: () => string;
  /** Value in display units. */
  get: () => number;
  /** Receives a value in display units. */
  set: (v: number) => void;
  dp: () => number;
  min?: () => number | undefined;
  max?: () => number | undefined;
  /** Arrow-key step in display units. */
  step?: () => number;
  disabled?: () => boolean;
  hint?: string;
  /** Extra line under the input, recomputed on refresh. */
  note?: () => string;
  wide?: boolean;
}

export function numField(o: NumOpts): Field {
  const input = h('input', {
    id: o.id,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    class: 'num-input',
  });
  const unit = h('span', { class: 'num-unit' });
  const note = h('div', { class: 'field-note', hidden: true });
  const err = h('div', { class: 'field-error', id: `${o.id}-err`, hidden: true });
  const label = h('label', { for: o.id, class: 'field-label' }, o.label);
  if (o.hint) label.title = o.hint;
  const el = h('div', { class: `field${o.wide ? ' field-wide' : ''}` }, label, h('div', { class: 'num-wrap' }, input, unit), err, note);
  let timer = 0;

  const bounds = (): [number | undefined, number | undefined] => [o.min?.(), o.max?.()];
  const validate = (v: number): string | null => {
    if (!Number.isFinite(v)) return 'Enter a number.';
    const [lo, hi] = bounds();
    if (lo !== undefined && v < lo - 1e-12) return `Minimum ${plain(lo, o.dp())} ${o.unit()}`.trim();
    if (hi !== undefined && v > hi + 1e-12) return `Maximum ${plain(hi, o.dp())} ${o.unit()}`.trim();
    return null;
  };
  const showError = (msg: string | null) => {
    err.hidden = !msg;
    err.textContent = msg ?? '';
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', err.id);
    else input.removeAttribute('aria-describedby');
  };
  const commit = (live: boolean) => {
    const v = parseNumber(input.value);
    const msg = validate(v);
    showError(msg);
    if (msg) return;
    if (Math.abs(v - o.get()) > 1e-12 * Math.max(1, Math.abs(v))) o.set(v);
    if (!live) input.value = plain(o.get(), o.dp());
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => commit(true), 120);
  });
  input.addEventListener('change', () => {
    clearTimeout(timer);
    commit(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      commit(false);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = o.step?.() ?? Math.pow(10, -Math.min(o.dp(), 2));
    const step = base * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    const cur = parseNumber(input.value);
    let v = (Number.isFinite(cur) ? cur : o.get()) + step;
    const [lo, hi] = bounds();
    if (lo !== undefined) v = Math.max(lo, v);
    if (hi !== undefined) v = Math.min(hi, v);
    input.value = plain(v, o.dp());
    commit(true);
  });

  const refresh = () => {
    unit.textContent = o.unit();
    input.disabled = !!o.disabled?.();
    if (document.activeElement !== input) {
      input.value = plain(o.get(), o.dp());
      showError(null);
    }
    if (o.note) {
      const t = o.note();
      note.hidden = !t;
      note.textContent = t;
    }
  };
  refresh();
  return { el, refresh };
}

/** The part of the store that form fields use. */
export interface StoreLike {
  readonly state: AppState;
  readonly project: Project;
  update(changes: Change | Change[], fn: (s: AppState) => void): void;
}

export interface Ctx {
  store: StoreLike;
}

export function lengthField(
  ctx: Ctx,
  o: {
    id: string;
    label: string;
    get: () => number;
    set: (mm: number) => void;
    change: Change[];
    min?: number | (() => number);
    max?: number | (() => number);
    disabled?: () => boolean;
    hint?: string;
    note?: () => string;
    wide?: boolean;
  },
): Field {
  const u = () => ctx.store.project.units.length as LengthUnit;
  const val = (x: number | (() => number) | undefined) => (typeof x === 'function' ? x() : x);
  return numField({
    id: o.id,
    label: o.label,
    hint: o.hint,
    note: o.note,
    wide: o.wide,
    unit: () => LENGTH[u()].label,
    get: () => lenTo(o.get(), u()),
    set: (v) => ctx.store.update(o.change, () => o.set(lenFrom(v, u()))),
    dp: () => LENGTH[u()].dp,
    step: () => ({ mm: 1, cm: 0.1, m: 0.001, in: 0.05, ft: 0.01 })[u()],
    min: () => {
      const m = val(o.min);
      return m === undefined ? undefined : lenTo(m, u());
    },
    max: () => {
      const m = val(o.max);
      return m === undefined ? undefined : lenTo(m, u());
    },
    disabled: o.disabled,
  });
}

export function pressureField(
  ctx: Ctx,
  o: { id: string; label: string; get: () => number; set: (pa: number) => void; change: Change[]; min?: number; unit?: () => PressureUnit },
): Field {
  const u = () => o.unit?.() ?? (ctx.store.project.units.pressure as PressureUnit);
  return numField({
    id: o.id,
    label: o.label,
    unit: () => PRESSURE[u()].label,
    get: () => presTo(o.get(), u()),
    set: (v) => ctx.store.update(o.change, () => o.set(presFrom(v, u()))),
    dp: () => PRESSURE[u()].dp,
    min: () => (o.min === undefined ? undefined : presTo(o.min, u())),
  });
}

export function plainField(
  ctx: Ctx,
  o: {
    id: string;
    label: string;
    unit: string | (() => string);
    get: () => number;
    set: (v: number) => void;
    change: Change[];
    dp: number;
    min?: number;
    max?: number;
    step?: number;
    hint?: string;
    note?: () => string;
    disabled?: () => boolean;
  },
): Field {
  return numField({
    id: o.id,
    label: o.label,
    hint: o.hint,
    note: o.note,
    unit: typeof o.unit === 'function' ? o.unit : () => o.unit as string,
    get: o.get,
    set: (v) => ctx.store.update(o.change, () => o.set(v)),
    dp: () => o.dp,
    min: () => o.min,
    max: () => o.max,
    step: () => o.step ?? 1,
    disabled: o.disabled,
  });
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function selectField<T extends string>(
  ctx: Ctx,
  o: { id: string; label: string; options: () => Option<T>[]; get: () => T; set: (v: T) => void; change: Change[]; hint?: string; wide?: boolean },
): Field {
  const sel = h('select', { id: o.id, class: 'select' });
  const el = h(
    'div',
    { class: `field${o.wide ? ' field-wide' : ''}` },
    h('label', { for: o.id, class: 'field-label', title: o.hint }, o.label),
    h('div', { class: 'select-wrap' }, sel, icon('chevron', 16)),
  );
  sel.addEventListener('change', () => ctx.store.update(o.change, () => o.set(sel.value as T)));
  const refresh = () => {
    const opts = o.options();
    const cur = o.get();
    const sig = opts.map((x) => x.value + x.label).join('|');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(...opts.map((x) => h('option', { value: x.value }, x.label)));
    }
    sel.value = cur;
  };
  refresh();
  return { el, refresh };
}

export function segmented<T extends string>(
  ctx: Ctx,
  o: { id: string; label: string; options: Option<T>[]; get: () => T; set: (v: T) => void; change: Change[]; wide?: boolean },
): Field {
  const buttons = o.options.map((opt) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        id: `${o.id}-${opt.value}`,
        on: { click: () => ctx.store.update(o.change, () => o.set(opt.value)) },
      },
      opt.label,
    ),
  );
  const group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': `${o.id}-lbl` }, buttons);
  const el = h('div', { class: `field${o.wide === false ? '' : ' field-wide'}` }, h('span', { class: 'field-label', id: `${o.id}-lbl` }, o.label), group);
  const refresh = () => {
    const cur = o.get();
    o.options.forEach((opt, i) => buttons[i].setAttribute('aria-pressed', String(opt.value === cur)));
  };
  refresh();
  return { el, refresh };
}

export function toggleField(
  ctx: Ctx,
  o: { id: string; label: string; get: () => boolean; set: (v: boolean) => void; change: Change[]; hint?: string; wide?: boolean },
): Field {
  const input = h('input', { type: 'checkbox', id: o.id, class: 'switch-input', role: 'switch' });
  input.addEventListener('change', () => ctx.store.update(o.change, () => o.set(input.checked)));
  const el = h(
    'div',
    { class: `field field-toggle${o.wide === false ? '' : ' field-wide'}` },
    h('label', { class: 'switch', for: o.id, title: o.hint }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'switch-label' }, o.label)),
  );
  const refresh = () => {
    input.checked = o.get();
  };
  refresh();
  return { el, refresh };
}

export function textField(
  ctx: Ctx,
  o: { id: string; label: string; get: () => string; set: (v: string) => void; change: Change[]; maxLength?: number; wide?: boolean },
): Field {
  const input = h('input', { id: o.id, type: 'text', class: 'text-input', maxlength: o.maxLength ?? 40, autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (v) ctx.store.update(o.change, () => o.set(v));
  });
  input.addEventListener('change', () => {
    if (!input.value.trim()) input.value = o.get();
  });
  const el = h('div', { class: `field${o.wide ? ' field-wide' : ''}` }, h('label', { for: o.id, class: 'field-label' }, o.label), input);
  const refresh = () => {
    if (document.activeElement !== input) input.value = o.get();
  };
  refresh();
  return { el, refresh };
}

/** A read-only computed value shown like a field. */
export function infoField(o: { label: string; value: () => string; wide?: boolean }): Field {
  const v = h('div', { class: 'info-value' });
  const el = h('div', { class: `field field-info${o.wide ? ' field-wide' : ''}` }, h('span', { class: 'field-label' }, o.label), v);
  const refresh = () => {
    v.textContent = o.value();
  };
  refresh();
  return { el, refresh };
}

export function note(text: () => string, kind: 'info' | 'warn' | 'error' = 'info'): Field {
  const el = h('p', { class: `panel-note note-${kind}`, role: kind === 'info' ? undefined : 'status' });
  const refresh = () => {
    const t = text();
    el.hidden = !t;
    el.textContent = t;
  };
  refresh();
  return { el, refresh };
}

/**
 * Collapsible plain-language help: a "?" line that opens a short explanation.
 * Paragraphs are strings; an array of strings becomes a bullet list.
 */
export function explain(title: string, ...body: (string | string[] | HTMLElement)[]): HTMLElement {
  return h(
    'details',
    { class: 'explain' },
    h('summary', null, icon('help', 15), h('span', null, title)),
    h(
      'div',
      { class: 'explain-body' },
      body.map((b) => (typeof b === 'string' ? h('p', null, b) : Array.isArray(b) ? h('ul', null, b.map((li) => h('li', null, li))) : b)),
    ),
  );
}

/** Compact number input for table cells. Commits on change, Enter and after a short pause while typing. */
export function cellInput(o: { label: string; get: () => number; set: (v: number) => void; dp: () => number; placeholder?: string }): Field {
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'cell-input', autocomplete: 'off', spellcheck: 'false', 'aria-label': o.label, placeholder: o.placeholder ?? '' });
  let timer = 0;
  const commit = (final: boolean) => {
    const raw = input.value.trim();
    const v = raw === '' ? NaN : parseNumber(raw);
    const bad = raw !== '' && !Number.isFinite(v);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) return;
    const cur = o.get();
    const same = (Number.isNaN(v) && Number.isNaN(cur)) || Math.abs(v - cur) <= 1e-12 * Math.max(1, Math.abs(v));
    if (!same) o.set(v);
    if (final && Number.isFinite(v)) input.value = plain(o.get(), o.dp());
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => commit(false), 250);
  });
  input.addEventListener('change', () => {
    clearTimeout(timer);
    commit(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      commit(true);
    }
  });
  const refresh = () => {
    if (document.activeElement === input) return;
    const v = o.get();
    input.value = Number.isFinite(v) ? plain(v, o.dp()) : '';
    input.setAttribute('aria-invalid', 'false');
  };
  refresh();
  return { el: input, refresh };
}
