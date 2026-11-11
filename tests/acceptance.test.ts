import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derive } from '../src/core/derive';
import { PRESETS } from '../src/core/presets';
import { rectangle } from '../src/core/polygon';
import type { Project } from '../src/core/types';
import { cloudStudioConfig, cloudStudioModel, cloudStudioPayload, type CsModel } from '../src/export/cloudstudio';
import { collect, type ExportOptions } from '../src/export/shared';

/**
 * The acceptance tests of the site brief (§7), run on the scripts the generator makes
 * for the Asphalt Storage 7 + 8 site (§10): ES5 syntax, the Cloud Studio harness (§9)
 * for both sensor families, the volume spot checks of §6.5, monotonic curves, invalid
 * readings, the device round trip and the no-comment rule.
 */

const opts: ExportOptions = { source: 'level', input: 'measure', table: { mode: 'compact', step: 10, rows: 100, tolerance: 0.05 }, lengthUnit: 'mm', volumeUnit: 'L', pressureUnit: 'kPa' };

/**
 * Storage 7 from the library preset; Storage 8 is the same design with its own plan area.
 * The sensor is given a range that reaches the floor (4 272 mm under it), so the empty
 * storage reads as a level and the floor rule, not the range rule, decides deeper readings.
 */
function storages(): Project[] {
  const s7 = PRESETS.find((p) => p.id === 'asphalt-storage')!.build();
  s7.sensors[0].number = 7;
  s7.sensors[0].maxRange = 6000;
  const s8 = structuredClone(s7);
  s8.name = 'Asphalt storage 8';
  s8.tank.pit!.outline = rectangle(20000, 17770);
  s8.tank.pit!.checks = [];
  s8.sensors[0].id = 's8-sensor';
  s8.sensors[0].number = 8;
  return [s7, s8];
}

const LORA = [
  { address: '244E7B0000004656', number: 7 },
  { address: '244E7B0000004645', number: 8 },
];
const TCP = [
  { address: '866207058378443', number: 7 },
  { address: '866207058378444', number: 8 },
];

function model(devices: { address: string; number: number }[], family: 'lorawan' | 'tcp'): CsModel {
  return cloudStudioModel(
    storages().map((p) => collect(p, derive(p), opts)),
    {},
    devices,
    family,
  );
}

interface Ep {
  address: string;
  name: string;
  type: unknown;
  variableTypeId?: number;
  value?: number;
}

interface Script {
  getEndpoints: (address: string, endpoints: unknown) => void;
  validateDeviceAddress: (address: string, result: { ok: boolean; errorMessage?: { en: string } }) => void;
  parseUplink: (device: unknown, payload: unknown) => void;
  TANKS: Record<string, Record<string, unknown>>;
}

function load(code: string, logs: string[]): Script {
  const names = ['getEndpoints', 'validateDeviceAddress', 'parseUplink', 'TANKS'];
  const body = `${code}\nreturn { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`;
  return new Function('endpointType', 'downlinkBuildResult', 'env', body)({ genericSensor: 'genericSensor', temperatureSensor: 'temperatureSensor' }, { ok: 0, unsupported: 1 }, { log: (m: string) => logs.push(m) });
}

function endpointsFor(config: string, address: string): Ep[] {
  const list: Ep[] = [];
  load(config, []).getEndpoints(address, {
    addEndpoint(a: string, name: string, type: unknown) {
      const e: Ep = { address: a, name, type };
      list.push(e);
      return e;
    },
  });
  return list;
}

function device(eps: Ep[]) {
  const dev = {
    battery: null as unknown,
    endpoints: {
      byAddress: (a: string) => {
        const e = eps.find((x) => x.address === a);
        return e ? { updateGenericSensorStatus: (v: number) => (e.value = v), updateTemperatureSensorStatus: (v: number) => (e.value = v) } : null;
      },
    },
    updateDeviceBattery: (b: unknown) => (dev.battery = b),
  };
  return dev;
}

const val = (eps: Ep[], a: string) => eps.find((e) => e.address === a)?.value;
const hexBytes = (hex: string) => (hex.match(/../g) ?? []).map((x) => parseInt(x, 16));
/** A TEK 766 measurement frame with one reading: ullage (cm), temperature and the SRC / SRSSI nibbles. */
const tek766 = (ullageCm: number, src = 10, srssi = 10, temp = 20) => ({ port: 16, asBytes: () => [0x10, 0x00, 0x00, 0x00, (ullageCm >> 8) & 0xff, ullageCm & 0xff, temp, (src << 4) | srssi] });
/** A reading already decoded by the network server: distance in mm. */
const decoded = (mm: number) => ({ port: 1, asBytes: () => [], asParsedObject: () => ({ distance: mm }) });

const FORBIDDEN: [RegExp, string][] = [
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\blet\b/, 'let'],
  [/\bconst\b/, 'const'],
  [/\bclass\s/, 'class'],
  [/\.\.\./, 'spread'],
  [/\bincludes\(/, 'Array.prototype.includes'],
];

describe('acceptance: Asphalt Storage 7 + 8, LoRaWAN model', () => {
  const m = model(LORA, 'lorawan');
  const config = cloudStudioConfig(m);
  const payload = cloudStudioPayload(m);
  const dir = mkdtempSync(join(tmpdir(), 'tanker-time-'));
  writeFileSync(join(dir, 'config.js'), config);
  writeFileSync(join(dir, 'payload.js'), payload);

  it('1. both scripts are plain ES5 (node --check and no forbidden tokens)', () => {
    for (const f of ['config.js', 'payload.js']) {
      const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
    for (const text of [config, payload]) for (const [re, what] of FORBIDDEN) expect(text, what).not.toMatch(re);
  });

  it('2. the Cloud Studio harness passes with the manual frames', () => {
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'tools', 'cloudstudio-test-harness.js'), join(dir, 'payload.js'), join(dir, 'config.js'), '244E7B0000004656'], { encoding: 'utf8' });
    const oks = r.stdout.split('\n').filter((l) => l.startsWith('ok: '));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/FAIL/);
    expect(oks).toHaveLength(8);
  });

  it('3. volume spot checks: 0, 53 367, 1 405 331 and 1 476 487 L', () => {
    const logs: string[] = [];
    const eps = endpointsFor(config, '244E7B0000004656');
    const s = load(payload, logs);
    const tank = s.TANKS[7];
    expect(tank).toMatchObject({ shape: 'concretePit', maxLevel: 4300, fullLitres: 1476487, sensorHeight: 4550, levelOffset: 0, name: 'Asphalt storage 7' });
    expect((tank.table as number[][]).length).toBe(431);
    const at = (level: number) => {
      s.parseUplink(device(eps), tek766((4550 - level) / 10));
      return { level: val(eps, '71'), percent: val(eps, '72'), litres: val(eps, '73') };
    };
    const tol = (want: number) => Math.max(1, want * 0.001);
    expect(at(0)).toEqual({ level: 0, percent: 0, litres: 0 });
    expect(Math.abs(at(300).litres! - 53367)).toBeLessThanOrEqual(tol(53367));
    expect(Math.abs(at(4100).litres! - 1405331)).toBeLessThanOrEqual(tol(1405331));
    expect(at(4300)).toEqual({ level: 4300, percent: 100, litres: 1476487 });
    expect(logs[logs.length - 1]).toMatch(/^Asphalt storage 7: Tekelek TEK 766, measurement, ullage 25 cm, SRC 10, SRSSI 10, temperature 20 C, distance 250 mm, level 4300 mm, 100 %, 1476487 L of 1476487 L$/);
    // Storage 8 from its own device: 355.40 m² plan.
    const eps8 = endpointsFor(config, '244E7B0000004645');
    s.parseUplink(device(eps8), tek766(25));
    expect(Math.abs(val(eps8, '83')! - 1474910)).toBeLessThanOrEqual(tol(1474910));
  });

  it('4. volume and percent never decrease with the level, 10 mm steps', () => {
    const eps = endpointsFor(config, '244E7B0000004656');
    const s = load(payload, []);
    let litres = -1;
    let percent = -1;
    for (let level = 0; level <= 4300; level += 10) {
      s.parseUplink(device(eps), decoded(4550 - level));
      expect(val(eps, '71')).toBe(level);
      expect(val(eps, '73')).toBeGreaterThanOrEqual(litres);
      expect(val(eps, '72')).toBeGreaterThanOrEqual(percent);
      litres = val(eps, '73')!;
      percent = val(eps, '72')!;
    }
    expect(litres).toBe(1476487);
  });

  it('5. SRC < 8, SRSSI < 4, ullage 0 and deeper than the floor leave 71 / 72 / 73 untouched', () => {
    const cases: [ReturnType<typeof tek766>, RegExp][] = [
      [tek766(300, 7, 10), /INVALID \(SRC 7 = reflection from near the sensor, possible obstruction\)/],
      [tek766(300, 10, 3), /INVALID \(SRSSI 3 is below 4, weak echo\)/],
      [tek766(0, 10, 10), /INVALID \(0 = no reading\)/],
      [tek766(470, 10, 10), /INVALID \(distance is 150 mm deeper than the floor\)/],
    ];
    for (const [frame, re] of cases) {
      const logs: string[] = [];
      const eps = endpointsFor(config, '244E7B0000004656');
      load(payload, logs).parseUplink(device(eps), frame);
      expect(val(eps, '71')).toBeUndefined();
      expect(val(eps, '72')).toBeUndefined();
      expect(val(eps, '73')).toBeUndefined();
      expect(logs[0]).toMatch(re);
      expect(logs[0]).toMatch(/Level not updated\.$/);
    }
  });

  it('6. round trip: every DevEUI gets 1, 2, n1, n2, n3; unknown ones are rejected; the payload finds the same id', () => {
    expect(config).toContain('"244E7B0000004656": 7,\n  "244E7B0000004645": 8\n');
    const s = load(config, []);
    for (const d of LORA) {
      const eps = endpointsFor(config, d.address);
      expect(eps.map((e) => e.address)).toEqual(['1', '2', `${d.number}1`, `${d.number}2`, `${d.number}3`]);
      const r: { ok: boolean } = { ok: true };
      s.validateDeviceAddress(d.address, r);
      expect(r.ok).toBe(true);
      const logs: string[] = [];
      load(payload, logs).parseUplink(device(eps), decoded(1000));
      expect(logs[0].startsWith(`Asphalt storage ${d.number}: `)).toBe(true);
      expect(val(eps, `${d.number}1`)).toBe(3550);
    }
    const r: { ok: boolean; errorMessage?: { en: string } } = { ok: true };
    s.validateDeviceAddress('0000000000000000', r);
    expect(r.ok).toBe(false);
    expect(r.errorMessage!.en).toBe('This DevEUI is not in DEVICE_TANKS. Add it to the configuration script first.');
  });

  it('7. no comment lines; endpoint names, types and variable ids exactly as the layout', () => {
    for (const text of [config, payload]) {
      expect(text.split('\n').filter((l) => l.trimStart().startsWith('//'))).toEqual([]);
      expect(text).not.toMatch(/\/\*/);
    }
    expect(endpointsFor(config, '244E7B0000004656').map((e) => [e.address, e.name, e.type, e.variableTypeId])).toEqual([
      ['1', 'Distance', 'genericSensor', 1380],
      ['2', 'Temperature', 'temperatureSensor', undefined],
      ['71', 'Liquid level', 'genericSensor', 1380],
      ['72', 'Fill level', 'genericSensor', 1406],
      ['73', 'Volume', 'genericSensor', 1371],
    ]);
    expect(config).toMatch(/^var MM_VARIABLE_ID {6}= 1380;\nvar PERCENT_VARIABLE_ID = 1406;\nvar LITRES_VARIABLE_ID {2}= 1371;\n/);
    expect(payload).toContain('function pitVolume(tank, level)');
    expect(payload).not.toContain('function headRadius');
    expect(payload).not.toContain('function tableVolume');
  });

  it('8. gives the same level, percent and litres as the hand-written reference for the same distance', () => {
    // The reference script keeps the drawing's shallow-end datum (level −300 … 4000, sensorHeight 4000 above it);
    // here the same sensor face is 4300 above the deepest point. The litres and percent must agree.
    const ps = storages();
    ps[0].sensors[0].faceMode = 'manual';
    ps[0].sensors[0].faceHeight = 4300;
    const mm = cloudStudioModel(ps.map((p) => collect(p, derive(p), opts)), {}, LORA, 'lorawan');
    const cfg = cloudStudioConfig(mm);
    const pl = cloudStudioPayload(mm);
    const reference = (distance: number) => {
      const floorArea = 355.78;
      const drop = 0.3;
      const h = Math.min(Math.max((4000 - distance) / 1000, -drop), 4);
      const slope = (floorArea * drop) / 2;
      const m3 = h < 0 ? (floorArea * (h + drop) * (h + drop)) / (2 * drop) : slope + floorArea * h;
      const full = slope + floorArea * 4;
      return { level: Math.round((4000 - distance) * 1) + 300, percent: Math.round((m3 / full) * 1000) / 10, litres: Math.round(m3 * 1000) };
    };
    const eps = endpointsFor(cfg, '244E7B0000004656');
    const s = load(pl, []);
    // Distances past the 220 mm dead band of the sensor (the reference has no dead-band rule).
    for (const distance of [250, 300, 1000, 2345, 3990, 4000, 4150, 4290, 4300]) {
      s.parseUplink(device(eps), decoded(distance));
      const want = reference(distance);
      expect(val(eps, '71')).toBe(Math.min(Math.max(want.level, 0), 4300));
      expect(Math.abs(val(eps, '73')! - want.litres)).toBeLessThanOrEqual(Math.max(1, want.litres * 0.001));
      expect(Math.abs(val(eps, '72')! - want.percent)).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('acceptance: the same storages on SIM card sensors (TCP model)', () => {
  const m = model(TCP, 'tcp');
  const config = cloudStudioConfig(m);
  const payload = cloudStudioPayload(m);
  const dir = mkdtempSync(join(tmpdir(), 'tanker-time-tcp-'));
  writeFileSync(join(dir, 'config.js'), config);
  writeFileSync(join(dir, 'payload.js'), payload);

  it('is plain ES5 without comments and passes the TCP harness (TEK 811 manual frame, the newer cellular frame, hex text, JSON)', () => {
    for (const f of ['config.js', 'payload.js']) expect(spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' }).status).toBe(0);
    for (const text of [config, payload]) {
      for (const [re, what] of FORBIDDEN) expect(text, what).not.toMatch(re);
      expect(text.split('\n').filter((l) => l.trimStart().startsWith('//'))).toEqual([]);
    }
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'tools', 'cloudstudio-test-harness-tcp.js'), join(dir, 'payload.js'), join(dir, 'config.js'), '866207058378443'], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.split('\n').filter((l) => l.startsWith('ok: '))).toHaveLength(14);
  });

  it('the TEK 811 reading goes through the same pipeline: level, percent and litres of Storage 7', () => {
    const eps = endpointsFor(config, '866207058378443');
    expect(eps.map((e) => e.address)).toEqual(['1', '2', '71', '72', '73']);
    const logs: string[] = [];
    // Manual sample: ullage 119 cm → distance 1190 mm → level 4550 − 1190 = 3360 mm.
    load(payload, logs).parseUplink(device(eps), { port: null, asBytes: () => hexBytes('072102018B06340866425030672135047B00018D03DC3C8201000A632877') });
    expect(val(eps, '1')).toBe(1190);
    expect(val(eps, '2')).toBe(19.5);
    expect(val(eps, '71')).toBe(3360);
    const want = (355.78 * 0.3) / 2 + 355.78 * 3.06;
    expect(Math.abs(val(eps, '73')! - want * 1000)).toBeLessThanOrEqual(want);
    expect(logs[0]).toMatch(/^Asphalt storage 7: Tekelek TEK 811, battery 5 V, scheduled reading, ullage 119 cm, SRC 10, SRSSI 10, temperature 19\.5 C, distance 1190 mm, level 3360 mm/);
    // The invalid-reading rules are the same: a frame deeper than the floor.
    const deep = hexBytes('072102018B06340866425030672135047B00018D03DC3C8201000A632877');
    deep[28] = (10 << 2) | ((470 >> 8) & 0x03);
    deep[29] = 470 & 0xff;
    const eps2 = endpointsFor(config, '866207058378443');
    const logs2: string[] = [];
    load(payload, logs2).parseUplink(device(eps2), { port: null, asBytes: () => deep });
    expect(val(eps2, '71')).toBeUndefined();
    expect(logs2[0]).toMatch(/INVALID \(distance is 150 mm deeper than the floor\)/);
  });
});
