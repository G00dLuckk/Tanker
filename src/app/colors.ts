import type { SensorConfig } from '../core/types';

/** Validated categorical palette (light / dark steps). Slot 0 is the tank curve and liquid. */
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function seriesColor(slot: number): string {
  const pal = isDark() ? DARK : LIGHT;
  return pal[((slot % pal.length) + pal.length) % pal.length];
}

export function sensorColor(s: SensorConfig): string {
  const slot = Math.min(Math.max(Math.round(s.colorSlot || 1), 1), 7);
  return seriesColor(slot);
}

/** Reads a CSS custom property from the root element. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
