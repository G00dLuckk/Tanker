import { hasAdc, hasAnalog, signalUnit } from '../core/sensors';
import { plain } from '../core/units';
import { expectedRaw } from './context';
import { L, V, lenLabel, rawDp, volLabel, type ExportData } from './shared';

export interface TableView {
  title: string;
  columns: string[];
  rows: string[][];
}

const pct = (v: number, total: number) => plain((100 * v) / total, 3);

export function tableView(ed: ExportData): TableView {
  const total = ed.d.totalL;
  const u = lenLabel(ed);
  const vu = volLabel(ed);
  const g = ed.sourceGeom;
  if (!g) {
    const cols = ed.conversions;
    return {
      title: 'Level → volume with expected raw readings',
      columns: [`Level (${u})`, `Volume (${vu})`, 'Fill (%)', ...cols.map((c) => `${c.sensor.tag} (${c.rawUnit})`)],
      rows: ed.strap.map((r) => [
        L(ed, r.level),
        V(ed, r.litres),
        pct(r.litres, total),
        ...cols.map((c) => {
          const raw = expectedRaw(c, r.level);
          return raw === null ? '' : plain(raw, rawDp(c));
        }),
      ]),
    };
  }
  const s = g.sensor;
  const analog = hasAnalog(s);
  const adc = hasAdc(s);
  const measureCol = `${s.kind === 'pressure' || s.kind === 'submersible' ? 'Pressure' : 'Distance'} (${s.digitalUnit})`;
  const cols: { name: string; get: (i: number) => string; key: 'measure' | 'signal' | 'adc' | 'other' }[] = [
    { name: measureCol, key: 'measure', get: (i) => plain(ed.sourceRows[i].digital, measureDp(s.digitalUnit) + 1) },
  ];
  if (analog) {
    cols.push({ name: `Signal (${signalUnit(s)})`, key: 'signal', get: (i) => plain(ed.sourceRows[i].signal ?? NaN, 6) });
  }
  if (adc) cols.push({ name: 'ADC counts', key: 'adc', get: (i) => plain(ed.sourceRows[i].adc ?? NaN, 3) });
  const first = cols.find((c) => c.key === ed.opt.input) ?? cols[0];
  const rest = cols.filter((c) => c !== first);
  return {
    title: `${s.tag}: ${first.name.toLowerCase()} → volume`,
    columns: [first.name, `Volume (${vu})`, `Level (${u})`, 'Fill (%)', ...rest.map((c) => c.name)],
    rows: ed.sourceRows.map((r, i) => [first.get(i), V(ed, r.litres), L(ed, r.level), pct(r.litres, total), ...rest.map((c) => c.get(i))]),
  };
}

function measureDp(unit: string): number {
  return { mm: 2, cm: 3, m: 5, in: 3, ft: 4, Pa: 1, kPa: 4, bar: 6, mbar: 3, psi: 5, mH2O: 5, cmH2O: 3, mmH2O: 2, inH2O: 4 }[unit] ?? 4;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(ed: ExportData): string {
  const t = tableView(ed);
  return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
