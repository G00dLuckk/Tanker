export type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  style?: string;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: any) => void>>;
  [attr: string]: unknown;
}

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'tabIndex']);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) {
      if (PROPS.has(k)) (el as any)[k] = false;
      continue;
    }
    if (k === 'on') {
      for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (PROPS.has(k)) {
      (el as any)[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const PATHS: Record<string, string> = {
  cutaway: 'M5 5.5C5 4.1 7.2 3 10 3s5 1.1 5 2.5v9c0 1.4-2.2 2.5-5 2.5s-5-1.1-5-2.5zM10 3v14M10 11h5',
  xray: 'M5 5.5C5 4.1 7.2 3 10 3s5 1.1 5 2.5v9c0 1.4-2.2 2.5-5 2.5s-5-1.1-5-2.5zM5 11c1.5 1 8.5 1 10 0',
  solid: 'M5 5.5C5 4.1 7.2 3 10 3s5 1.1 5 2.5v9c0 1.4-2.2 2.5-5 2.5s-5-1.1-5-2.5zM5 5.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5',
  dims: 'M3 14h14M3 11v6M17 11v6M2 15.5l2-3M16 15.5l2-3M6 3h8v6H6z',
  beam: 'M8 2.5h4v3.5H8zM10 6l-5.5 11h11z',
  tag: 'M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14M3 10h14',
  grid: 'M3 7h14M3 13h14M7 3v14M13 3v14',
  iso: 'M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5zM10 10l6.5-3.75M10 10L3.5 6.25M10 10v7.5',
  front: 'M4 4h12v12H4zM4 10h12',
  side: 'M3 6h14v8H3zM7 6v8',
  top: 'M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14M10 7v6M7 10h6',
  camera: 'M3 7h3l1.7-2h4.6L14 7h3v9H3zM10 8.5a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  fill: 'M10 16V5M5.5 9.5L10 5l4.5 4.5M4 18h12',
  drain: 'M10 4v11M5.5 10.5L10 15l4.5-4.5M4 2h12',
  pause: 'M7 4v12M13 4v12',
  empty: 'M4 17h12M10 3v10M6 9l4 4 4-4',
  full: 'M4 3h12M10 17V7M6 11l4-4 4 4',
  copy: 'M7 7h9v10H7zM4 13V3h9',
  download: 'M10 3v10M6 9l4 4 4-4M4 16h12',
  upload: 'M10 14V4M6 8l4-4 4 4M4 16h12',
  plus: 'M10 4v12M4 10h12',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11',
  duplicate: 'M7 7h9v9H7zM4 4h9v2M4 4v9h2',
  close: 'M5 5l10 10M15 5L5 15',
  chevron: 'M6 8l4 4 4-4',
  sun: 'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
  moon: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
  auto: 'M10 3a7 7 0 1 0 0 14zM10 3a7 7 0 1 1 0 14',
  ruler: 'M3 13.5L13.5 3 17 6.5 6.5 17zM6 10.5l1.5 1.5M8.5 8l1.5 1.5M11 5.5l1.5 1.5',
  folder: 'M3 5h5l2 2h7v9H3z',
  save: 'M4 3h10l3 3v11H4zM7 3v4h6V3M7 17v-5h7v5',
  library: 'M4 3h3v14H4zM9 3h3v14H9zM14 4l2.8-.7 2.2 13.6-2.8.7z',
  doc: 'M5 2.5h7l3.5 3.5v11.5H5zM12 2.5V6h3.5M7.5 10h5M7.5 13h5',
  crosshair: 'M10 3v4M10 13v4M3 10h4M13 10h4M10 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  warn: 'M10 3l7.5 13.5h-15zM10 8v4M10 14.2v.3',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  noise: 'M2 10h2l1.5-4 2 9 2-11 2 12 2-8 1.5 3H18',
  sensor: 'M7 3h6v4H7zM10 7v3M4 13a6 6 0 0 1 12 0M6.5 15.5a3.5 3.5 0 0 1 7 0',
  help: 'M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14M7.8 8a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.4M10 14.2v.3',
  open: 'M3 6h5l2 2h7v8H3zM3 6v10',
  guide: 'M4 3.5h5.5a2 2 0 0 1 .5 1.3V17a2 2 0 0 0-2-1.5H4zM16 3.5h-5.5a2 2 0 0 0-.5 1.3V17a2 2 0 0 1 2-1.5h4z',
  target: 'M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7M10 9.5v1',
};

export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name] ?? '');
  svg.appendChild(p);
  return svg;
}

let uid = 0;
export function uniqueId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

/** Download text or a data URL as a file (local builds). */
export function download(name: string, content: string | Blob, type = 'text/plain'): void {
  const blob = typeof content === 'string' && content.startsWith('data:') ? null : content instanceof Blob ? content : new Blob([content], { type });
  const url = blob ? URL.createObjectURL(blob) : (content as string);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (blob) setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text: string, fallbackEl?: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return false;
  }
}
