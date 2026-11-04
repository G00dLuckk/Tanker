import { describe, expect, it } from 'vitest';
import { derive } from '../src/core/derive';
import { PRESETS } from '../src/core/presets';
import { MM3_TO_L } from '../src/core/units';
import { csv, tableView } from '../src/export/data';
import { collect, type ExportOptions } from '../src/export/shared';

const opts: ExportOptions = {
  source: 'level',
  input: 'measure',
  table: { mode: 'step', step: 50, rows: 10, tolerance: 1 },
  lengthUnit: 'mm',
  volumeUnit: 'L',
  pressureUnit: 'kPa',
};

describe('table for every preset', () => {
  it('level and sensor tables are complete and the CSV matches the table', () => {
    for (const preset of PRESETS) {
      const p = preset.build();
      const d = derive(p);
      for (const source of ['level', ...p.sensors.map((s) => s.id)]) {
        const ed = collect(p, d, { ...opts, source });
        const t = tableView(ed);
        expect(t.rows.length).toBeGreaterThan(1);
        for (const r of t.rows) {
          expect(r.length).toBe(t.columns.length);
          for (const cell of r) expect(cell).not.toMatch(/NaN|undefined|Infinity/);
        }
        expect(csv(ed).split('\n').length).toBe(t.rows.length + 2);
      }
    }
  });

  it('the level table is the tank volume at each printed level, from empty to full', () => {
    for (const preset of PRESETS) {
      const p = preset.build();
      const d = derive(p);
      const ed = collect(p, d, opts);
      const t = tableView(ed);
      expect(Number(t.rows[0][0])).toBe(0);
      // The last level is printed to 0.01 mm, so it can sit a hair under full.
      expect(Math.abs(Number(t.rows[t.rows.length - 1][1]) - d.totalL)).toBeLessThan(0.02);
      for (const r of t.rows) {
        const level = Number(r[0]);
        expect(Math.abs(Number(r[1]) - d.engine.volume(Math.min(level, d.depth)) * MM3_TO_L)).toBeLessThan(0.0006);
      }
    }
  });
});
