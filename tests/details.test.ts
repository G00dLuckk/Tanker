import { describe, expect, it } from 'vitest';
import { defaultSensor, emptyProject } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import { PRESETS } from '../src/core/presets';
import type { Project } from '../src/core/types';
import { MM3_TO_L, plain } from '../src/core/units';
import { cloudStudioModel } from '../src/export/cloudstudio';
import { siteDetails } from '../src/export/details';
import { collect, type ExportOptions } from '../src/export/shared';

const opts: ExportOptions = {
  source: 'level',
  input: 'measure',
  table: { mode: 'compact', step: 10, rows: 100, tolerance: 0.05 },
  lengthUnit: 'mm',
  volumeUnit: 'L',
  pressureUnit: 'kPa',
};

function details(ps: Project[], devices: { address: string; number?: number }[] = [], family: 'auto' | 'lorawan' | 'tcp' = 'auto') {
  const eds = ps.map((p) => collect(p, derive(p), opts));
  return { eds, text: siteDetails(eds, cloudStudioModel(eds, {}, devices, family)) };
}

describe('tank details for an AI assistant', () => {
  for (const preset of PRESETS) {
    it(preset.id, () => {
      const p = preset.build();
      const { eds, text } = details([p]);
      const d = eds[0].d;
      expect(text).not.toMatch(/NaN|undefined|Infinity|\[object/);
      expect(text).toContain(`## Tank 1: ${p.name}`);
      expect(text).toContain(`Holds ${plain(d.totalL, 1)} L when full; the liquid is ${plain(d.depth, 1)} mm deep at full.`);
      for (const s of p.sensors) expect(text).toContain(`**${s.tag}**`);
      // The volume table is the tank's own volume at each level.
      const rows = [...text.matchAll(/^\| ([\d.]+) \| [\d.]+ % \| ([\d.]+) \| [\d.]+ % \|$/gm)];
      expect(rows).toHaveLength(21);
      for (const r of rows) expect(Math.abs(Number(r[2]) - d.engine.volume(Math.min(Number(r[1]), d.depth)) * MM3_TO_L)).toBeLessThan(0.06 + 1e-5 * d.totalL);
    });
  }

  it('a site: every tank, the sensor numbers and the devices', () => {
    const a = emptyProject();
    a.name = 'North';
    a.tank.basis = 'outside';
    a.tank.body = { ...a.tank.body, type: 'cylinder', sizeBy: 'perimeter', perimeter: 14380, length: 9060, thickness: 5 };
    a.tank.start = { ...a.tank.start, type: 'flat', thickness: 5 };
    a.tank.end = { ...a.tank.end, type: 'dished', dishBy: 'arc', arc: 4590.5, thickness: 5 };
    a.liquid = { preset: 'diesel', density: 832 };
    const s = defaultSensor('radar', 'LT-101');
    Object.assign(s, { deadBand: 200, maxRange: 12000 });
    a.sensors = [s];
    const b = structuredClone(a);
    b.name = 'South';
    b.sensors[0].id = 'other';
    const { text } = details([a, b], [{ address: 'A84041F359618158', number: 1 }, { address: '866207058378443', number: 2 }]);
    expect(text).toContain('This describes 2 tanks');
    expect(text).toContain('## Tank 1: North');
    expect(text).toContain('## Tank 2: South');
    expect(text).toContain('Typed (outside sizes, circumference (a tape around the shell)): circumference 14380 mm, straight shell height 9060 mm. Wall 5 mm.');
    expect(text).toContain('Sized by the arc over it: 4590.5 mm (outside, wall to wall).');
    expect(text).toContain('**Liquid:** Diesel, density 832 kg/m³.');
    expect(text).toContain('Sensor face 9215 mm above the inside floor (level zero)');
    expect(text).toContain('In the scripts: number 1 (endpoints 11 level, 12 fill %, 13 volume); devices A84041F359618158.');
    // Devices of the other family are not in this model: the LoRaWAN details say so, the TCP details list them.
    expect(text).toContain('These scripts are the LoRaWAN (by DevEUI) device model');
    expect(text).not.toContain('| 866207058378443 (IMEI)');
    expect(text).toContain('866207058378443 is an IMEI (SIM card sensor over TCP): it belongs in the TCP model');
    expect(text).toContain('The payload script computes the volume from the sizes above as a standing cylinder.');
    const tcp = details([a, b], [{ address: 'A84041F359618158', number: 1 }, { address: '866207058378443', number: 2 }], 'tcp').text;
    expect(tcp).toContain('These scripts are the TCP (SIM card sensors, by IMEI) device model');
    expect(tcp).toContain('| 866207058378443 (IMEI) | 2 | South · LT-101 |');
  });

  it('a concrete storage: plan, floor, drawing reference, checks and the sensor on the wall top', () => {
    const p = PRESETS.find((x) => x.id === 'asphalt-storage')!.build();
    const { text } = details([p], [{ address: '244E7B0000004656', number: 1 }]);
    expect(text).toContain('Concrete storage, open at the top, 4-corner plan, floor sloping one way');
    expect(text).toContain('Plan area 355.78 m²');
    expect(text).toContain('**Heights on the drawing** are measured from the highest point of the floor (shallow end), which is 300 mm above level zero');
    expect(text).toContain('**Wall top:** 4000 mm on the drawing = 4300 mm above level zero.');
    expect(text).toContain('**Floor:** one plane, rising 300 mm along the direction 180° in the plan');
    expect(text).toContain('**Drawing check:** 53367 L at 0 mm on the drawing (300 mm above level zero); the design gives 53367 L');
    expect(text).toContain('on a bracket on the wall top.');
    expect(text).toContain('Sensor face 4550 mm above the deepest point of the floor (level zero), 250 mm above the wall top.');
    expect(text).toContain('The floor under the sensor is 277.5 mm above level zero, 4272.5 mm from the face');
    expect(text).toContain('takes the volume from the level → litres table of this storage');
  });
});
