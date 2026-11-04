import { describe, expect, it } from 'vitest';
import { normalizeSite, parseProjectDoc } from '../src/app/persist';
import { defaultSensor, emptyProject } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import { buildProjectFile } from '../src/export/projectFile';

function tank(name: string) {
  const p = emptyProject();
  p.name = name;
  p.sensors = [defaultSensor('radar', 'LT-101')];
  return p;
}

describe('a site of several tanks', () => {
  it('a project file keeps every tank, the one being edited, their levels and the devices', () => {
    const tanks = [tank('North'), tank('South'), tank('East')];
    tanks[2].sensors[0].number = 7;
    const devices = [{ address: 'A84041F359618158', number: 7 }, { address: 'A840411AFA618156' }];
    const text = buildProjectFile(tanks[1], derive(tanks[1]), { site: { tanks, active: 1, levels: [100, NaN, 300], devices } });
    const doc = parseProjectDoc(text);
    expect(doc.tanks.map((t) => t.name)).toEqual(['North', 'South', 'East']);
    expect(doc.active).toBe(1);
    expect(doc.project.name).toBe('South');
    expect(doc.levels).toEqual([100, 0, 300]);
    expect(doc.devices).toEqual(devices);
    expect(doc.tanks[2].sensors[0].number).toBe(7);
  });

  it('a file of one tank opens as a site of that tank', () => {
    const p = tank('Only');
    const doc = parseProjectDoc(buildProjectFile(p, derive(p)));
    expect(doc.tanks.map((t) => t.name)).toEqual(['Only']);
    expect(doc.active).toBe(0);
    expect(doc.devices).toBeNull();
  });

  it('older saves: the tank number goes to the first distance sensor, the devices keep their number', () => {
    const p = tank('Old');
    p.sensors.unshift(defaultSensor('pressure', 'PT-1'));
    p.cloud = {
      tank: 31,
      devices: [
        { address: 'a840-41f3-5961-8158', tank: '', sensor: '', name: 'North' },
        { address: 'A840411AFA618156', tank: '', sensor: '', name: '', number: 32 },
        { address: 'A840416AB9618157', tank: 'Another tank', sensor: '', name: '' },
      ],
    };
    const site = normalizeSite({ project: p });
    expect(site.tanks[0].sensors.map((s) => s.number)).toEqual([undefined, 31]);
    expect(site.tanks[0].cloud).toBeUndefined();
    expect(site.devices).toEqual([
      { address: 'A84041F359618158', number: 31 },
      { address: 'A840411AFA618156', number: 32 },
    ]);
  });

  it('the tank being edited stays inside the list', () => {
    expect(normalizeSite({ tanks: [tank('A'), tank('B')], active: 5 }).active).toBe(1);
    expect(normalizeSite({ tanks: [], active: 0 }).tanks).toHaveLength(1);
  });

  it('devices: hex digits only, upper case, no repeats', () => {
    const site = normalizeSite({ tanks: [tank('A')], devices: [{ address: 'a8:40:41:00:00:00:00:01', number: 2 }, { address: 'A840410000000001' }, { address: 5 }, null] });
    expect(site.devices).toEqual([{ address: 'A840410000000001', number: 2 }]);
  });
});
