import { describe, expect, it } from 'vitest';
import { defaultHead, defaultManhole, defaultSensor, emptyProject } from '../src/core/defaults';
import { derive } from '../src/core/derive';
import { defaultPit } from '../src/core/pit';
import { rectangle } from '../src/core/polygon';
import { PRESETS } from '../src/core/presets';
import { levelFromMeasure } from '../src/core/sensors';
import type { ManholeConfig, Project, SensorConfig, SensorKind } from '../src/core/types';
import { MM3_TO_L } from '../src/core/units';
import { cloudStudioConfig, cloudStudioModel, cloudStudioPayload, parseDeviceLines, type CsModel } from '../src/export/cloudstudio';
import { collect, type ExportData, type ExportOptions } from '../src/export/shared';

const opts: ExportOptions = {
  source: 'level',
  input: 'measure',
  table: { mode: 'compact', step: 10, rows: 100, tolerance: 0.05 },
  lengthUnit: 'mm',
  volumeUnit: 'L',
  pressureUnit: 'kPa',
};

// ---------------------------------------------------------------------------
// Enough of the Cloud Studio runtime to run the generated scripts.

interface Ep {
  address: string;
  name: string;
  type: number;
  variableTypeId?: number;
  value?: number;
}

interface Script {
  getEndpoints?: (address: string, endpoints: unknown) => void;
  validateDeviceAddress?: (address: string, result: { ok: boolean; errorMessage?: { en: string } }) => void;
  parseUplink?: (device: unknown, payload: unknown) => void;
  decodeReading?: (payload: unknown) => { model: string; distance: number | null; battery: unknown; temperature: number | null; invalid: string | null; skip: string | null; info: string | null };
  TANKS?: Record<string, Record<string, unknown>>;
}

function load(code: string, logs: string[] = []): Script {
  const names = ['getEndpoints', 'validateDeviceAddress', 'parseUplink', 'decodeReading', 'TANKS'];
  const body = `${code}\nreturn { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`;
  return new Function('endpointType', 'downlinkBuildResult', 'env', body)({ genericSensor: 28 }, { ok: 0, unsupported: 1 }, { log: (m: string) => logs.push(m) });
}

function endpointsFor(config: string, address: string): Ep[] {
  const list: Ep[] = [];
  load(config).getEndpoints!(address, {
    addEndpoint(a: string, name: string, type: number) {
      const e: Ep = { address: a, name, type };
      list.push(e);
      return e;
    },
  });
  return list;
}

function mockDevice(eps: Ep[]) {
  const device = {
    battery: null as unknown,
    endpoints: {
      byAddress: (a: string) => {
        const e = eps.find((x) => x.address === a);
        return e ? { updateGenericSensorStatus: (v: number) => (e.value = v), updateTemperatureSensorStatus: (v: number) => (e.value = v) } : null;
      },
    },
    updateDeviceBattery: (b: unknown) => (device.battery = b),
  };
  return device;
}

const val = (eps: Ep[], a: string) => eps.find((e) => e.address === a)?.value;
const bytes = (hex: string) => (hex.match(/../g) ?? []).map((x) => parseInt(x, 16));
const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];

/** Uplinks as each sensor model sends a distance (mm). */
const SEND: Record<string, (mm: number) => { port: number; asBytes: () => number[]; asParsedObject?: () => unknown }> = {
  dragino: (mm) => ({ port: 2, asBytes: () => [0x0c, 0xe4, ...be16(mm), 0x00, 0x01, 0x0e, 0x01] }),
  tek766: (mm) => ({ port: 16, asBytes: () => [0x10, 0x00, 0x00, 0x00, ...be16(Math.round(mm / 10)), 0x14, 0xaa, ...be16(Math.round(mm / 10)), 0x14, 0xaa, 0x01, 0x21, 0x14, 0xa9, 0x01, 0x20, 0x14, 0xaa] }),
  milesight: (mm) => ({ port: 85, asBytes: () => [0x01, 0x75, 0x5c, 0x03, 0x82, mm & 0xff, (mm >> 8) & 0xff] }),
  netvox: (mm) => ({ port: 6, asBytes: () => [0x01, 0xb1, 0x01, 0x24, 0x00, ...be16(mm), 0x32, 0x00, 0x00, 0x00] }),
  ttn: (mm) => ({ port: 1, asBytes: () => [], asParsedObject: () => ({ distance: mm }) }),
};

function top(kind: SensorKind, tag: string, o: Partial<ReturnType<typeof defaultSensor>> = {}) {
  const s = defaultSensor(kind, tag);
  Object.assign(s, { deadBand: 100, maxRange: 20000, ...o });
  return s;
}

function tankProject(name: string, height: number, sensors: ReturnType<typeof defaultSensor>[]): Project {
  const p = emptyProject();
  p.name = name;
  p.tank.orientation = 'vertical';
  p.tank.basis = 'inside';
  p.tank.body = { ...p.tank.body, type: 'cylinder', diameter: 2000, length: height, thickness: 5 };
  p.tank.start = { ...p.tank.start, type: 'flat', thickness: 5 };
  p.tank.end = { ...p.tank.end, type: 'flat', thickness: 5 };
  p.sensors = sensors;
  return p;
}

const eds = (ps: Project[]): ExportData[] => ps.map((p) => collect(p, derive(p), opts));

function site(ps: Project[], devices: { address: string; number?: number }[], family: 'auto' | 'lorawan' | 'tcp' = 'auto'): CsModel {
  return cloudStudioModel(eds(ps), {}, devices, family);
}

/** Creates the device from the configuration script and sends it one uplink. */
function send(m: CsModel, address: string, payload: unknown, logs: string[] = []): Ep[] {
  const eps = endpointsFor(cloudStudioConfig(m), address);
  load(cloudStudioPayload(m), logs).parseUplink!(mockDevice(eps), payload);
  return eps;
}

// ---------------------------------------------------------------------------

describe('configuration script', () => {
  it('is the customer layout, with DEVICE_TANKS from the devices', () => {
    const ps = [1, 2, 3].map((i) => tankProject(`Tank ${i}`, 3000, [top('radar', 'LT-101')]));
    const m = site(ps, [
      { address: 'a8:40:41:f3:59:61:81:58', number: 1 },
      { address: 'A840411AFA618156', number: 2 },
      { address: 'A840416AB9618157', number: 3 },
    ]);
    expect(cloudStudioConfig(m)).toBe(`var MM_VARIABLE_ID      = 1380;
var PERCENT_VARIABLE_ID = 1406;
var LITRES_VARIABLE_ID  = 1371;

var DEVICE_TANKS = {
  "A84041F359618158": 1,
  "A840411AFA618156": 2,
  "A840416AB9618157": 3
};

function normaliseAddress(address)
{
  return String(address).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

function getConfiguration(config)
{
  config.addressLabel = { en: "DevEUI", es: "DevEUI" };
}

function getEndpoints(deviceAddress, endpoints)
{
  var distance = endpoints.addEndpoint("1", "Distance", endpointType.genericSensor);
  distance.variableTypeId = MM_VARIABLE_ID;

  endpoints.addEndpoint("2", "Temperature", endpointType.temperatureSensor);

  var tankNumber = DEVICE_TANKS[normaliseAddress(deviceAddress)];
  if (!tankNumber)
    return;

  var prefix = String(tankNumber);

  var level = endpoints.addEndpoint(prefix + "1", "Liquid level", endpointType.genericSensor);
  level.variableTypeId = MM_VARIABLE_ID;

  if (PERCENT_VARIABLE_ID > 0) {
    var percent = endpoints.addEndpoint(prefix + "2", "Fill level", endpointType.genericSensor);
    percent.variableTypeId = PERCENT_VARIABLE_ID;
  }

  if (LITRES_VARIABLE_ID > 0) {
    var volume = endpoints.addEndpoint(prefix + "3", "Volume", endpointType.genericSensor);
    volume.variableTypeId = LITRES_VARIABLE_ID;
  }
}

function validateDeviceAddress(address, result)
{
  var clean = normaliseAddress(address);

  if (clean.length != 16) {
    result.ok = false;
    result.errorMessage = {
      en: "The DevEUI must be 16 hexadecimal characters",
      es: "El DevEUI debe tener 16 caracteres hexadecimales"
    };
    return;
  }

  if (!DEVICE_TANKS[clean]) {
    result.ok = false;
    result.errorMessage = {
      en: "This DevEUI is not in DEVICE_TANKS. Add it to the configuration script first.",
      es: "Este DevEUI no está en DEVICE_TANKS. Agréguelo primero al script de configuración."
    };
  }
}

function updateDeviceUIRules(device, rules)
{
  rules.canCreateEndpoints = false;
}

function updateEndpointUIRules(endpoint, rules)
{
  rules.canDelete = true;
}
`);
  });

  it('makes Distance, then level, fill and volume for a listed DevEUI', () => {
    const m = site([tankProject('Tank 7', 9060, [top('radar', 'LT-101')])], [{ address: 'A84041F359618158', number: 1 }]);
    const eps = endpointsFor(cloudStudioConfig(m), 'a840-41f3-5961-8158');
    expect(eps.map((e) => [e.address, e.name, e.variableTypeId])).toEqual([
      ['1', 'Distance', 1380],
      ['2', 'Temperature', undefined],
      ['11', 'Liquid level', 1380],
      ['12', 'Fill level', 1406],
      ['13', 'Volume', 1371],
    ]);
    expect(endpointsFor(cloudStudioConfig(m), 'A840410000000000').map((e) => e.address)).toEqual(['1', '2']);
  });

  it('one model per sensor family: the LoRaWAN model checks DevEUIs, the TCP model IMEIs', () => {
    const p = tankProject('Tank 7', 9060, [top('radar', 'LT-101')]);
    const devices = [{ address: 'A84041F359618158', number: 1 }, { address: '866207058378443', number: 1 }];
    const check = (m: CsModel, a: string) => {
      const r: { ok: boolean; errorMessage?: { en: string } } = { ok: true };
      load(cloudStudioConfig(m)).validateDeviceAddress!(a, r);
      return r.ok ? 'ok' : r.errorMessage!.en;
    };
    // Mixed devices: LoRaWAN by default; the IMEI is left for the TCP model.
    const lora = site([p], devices);
    expect(lora.family).toBe('lorawan');
    expect(lora.devices.map((d) => d.address)).toEqual(['A84041F359618158']);
    expect(lora.warnings).toContain('866207058378443 is an IMEI (SIM card sensor over TCP): it belongs in the TCP model, not in this LoRaWAN one. Switch the sensor family to make that model.');
    expect(check(lora, 'A84041F359618158')).toBe('ok');
    expect(check(lora, 'a8:40:41:f3:59:61:81:58')).toBe('ok');
    expect(check(lora, 'A84041F3596181')).toBe('The DevEUI must be 16 hexadecimal characters');
    expect(check(lora, '866207058378443')).toBe('The DevEUI must be 16 hexadecimal characters');
    expect(check(lora, 'A840410000000000')).toBe('This DevEUI is not in DEVICE_TANKS. Add it to the configuration script first.');
    const tcp = site([p], devices, 'tcp');
    expect(tcp.family).toBe('tcp');
    expect(tcp.devices.map((d) => d.address)).toEqual(['866207058378443']);
    expect(cloudStudioConfig(tcp)).toContain('config.addressLabel = { en: "IMEI", es: "IMEI" };');
    expect(cloudStudioConfig(tcp)).toContain('return String(address).replace(/[^0-9]/g, "");');
    expect(check(tcp, '866207058378443')).toBe('ok');
    expect(check(tcp, '8662 0705 8378 443')).toBe('ok');
    expect(check(tcp, 'A84041F359618158')).toBe('The IMEI must be 15 digits');
    expect(check(tcp, '866207058378444')).toBe('This IMEI is not in DEVICE_TANKS. Add it to the configuration script first.');
    // Only IMEIs listed: the TCP model is chosen by itself.
    expect(site([p], [{ address: '866207058378443' }]).family).toBe('tcp');
  });

  it('leaves the percent and volume endpoints out without their ids', () => {
    const m = cloudStudioModel(eds([tankProject('T', 3000, [top('radar', 'LT-101')])]), { '%': 0, L: 0 }, [{ address: 'A84041F359618158' }]);
    expect(endpointsFor(cloudStudioConfig(m), 'A84041F359618158').map((e) => e.address)).toEqual(['1', '2', '11']);
  });
});

describe('payload script layout', () => {
  const p = tankProject('Tank 7', 9060, [top('radar', 'LT-101', { faceMode: 'auto', nozzle: 0 })]);
  const m = site([p], [{ address: 'A84041F359618158' }]);
  const js = cloudStudioPayload(m);

  it('starts with TANKS: the sensor, the tank sizes and the sensor height', () => {
    expect(js.startsWith(`var TANKS = {
  1: {
    name: "Tank 7",
    sensor: "Radar LT-101",
    blindZone: 100,
    maxRange: 20000,

    shape: "standing cylinder",
    insideDiameter: 2000,
    shellHeight: 9060,
    bottom: { shape: "flat", depth: 0 },
    top: { shape: "flat", depth: 0 },
    wallThickness: 5,
    bottomThickness: 5,
    topThickness: 5,

    sensorHeight: 9065,
    levelOffset: 0
  }
};

var SHOW_ALL_READINGS = true;
var LOG = true;
`)).toBe(true);
  });

  it('has no comments and no level table for shapes it computes', () => {
    expect(js.split('\n').filter((l) => l.trim().startsWith('//'))).toEqual([]);
    expect(js).not.toMatch(/level: \[/);
  });

  it('is plain ES5', () => {
    expect(js).not.toMatch(/\b(let|const|class)\s|=>|`/);
  });
});

describe('the sensor reading on Distance, the level from the sensor height', () => {
  // Inside 9060 mm, roof plate 5 mm, sensor on the roof: face 9065 mm above the inside floor.
  const p = tankProject('Tank 7', 9060, [top('radar', 'LT-101', { deadBand: 200, maxRange: 12000 })]);
  const d = derive(p);
  const m = site([p], [{ address: 'A84041F359618158' }]);

  it('Distance is what the sensor sends; level = sensorHeight − distance', () => {
    const logs: string[] = [];
    const eps = send(m, 'A84041F359618158', SEND.dragino(2890), logs);
    expect(val(eps, '1')).toBe(2890);
    expect(val(eps, '11')).toBe(9065 - 2890);
    const litres = d.engine.volume(9065 - 2890) * MM3_TO_L;
    expect(val(eps, '13')).toBe(Math.round(litres));
    expect(val(eps, '12')).toBeCloseTo((100 * litres) / d.totalL, 1);
    expect(logs[0]).toBe(`Tank 7: Dragino, battery 3.3 V, distance 2890 mm, level 6175 mm, ${val(eps, '12')} %, ${val(eps, '13')} L of ${Math.round(d.totalL)} L`);
  });

  it('a reading in the blind zone or past the range shows on Distance but leaves the level', () => {
    for (const mm of [150, 200, 12001]) {
      const logs: string[] = [];
      const eps = send(m, 'A84041F359618158', SEND.dragino(mm), logs);
      expect(val(eps, '1')).toBe(mm);
      expect(val(eps, '11')).toBeUndefined();
      expect(logs[0]).toMatch(/is INVALID \(.*\)\. Level not updated\.$/);
    }
  });

  it('the level stays inside the tank', () => {
    // Up to 100 mm below the floor is rounding and reads as empty.
    expect(val(send(m, 'A84041F359618158', SEND.dragino(9150)), '11')).toBe(0);
    // A sensor on a 1 m stand-pipe: 300 mm from it is above the inside top.
    const high = site([tankProject('Tank 7', 9060, [top('radar', 'LT-101', { nozzle: 1000, deadBand: 200 })])], [{ address: 'A84041F359618158' }]);
    expect(val(send(high, 'A84041F359618158', SEND.dragino(300)), '11')).toBe(9060);
  });

  it('a reading more than 100 mm deeper than the floor is invalid', () => {
    const logs: string[] = [];
    const eps = send(m, 'A84041F359618158', SEND.dragino(10000), logs);
    expect(val(eps, '1')).toBe(10000);
    expect(val(eps, '11')).toBeUndefined();
    expect(logs[0]).toMatch(/is INVALID \(distance is 935 mm deeper than the floor\)\. Level not updated\.$/);
  });

  it('the temperature of a Tekelek frame goes to endpoint 2', () => {
    const eps = send(m, 'A84041F359618158', { port: 48, asBytes: () => bytes('300000010106360063006300040600181BAA') });
    expect(val(eps, '2')).toBe(27);
    expect(val(eps, '1')).toBe(240);
  });

  it('a field calibration moves the level by levelOffset', () => {
    const q = tankProject('Tank 7', 9060, [top('radar', 'LT-101')]);
    const s = q.sensors[0];
    Object.assign(s, { signal: 'digital', digitalUnit: 'mm' });
    // A dip of 5000 mm when the sensor read 4000 mm: the sensor sits 65 mm lower than drawn.
    s.cal = { method: 'offset', ref: 'level', points: [{ raw: 4000, ref: 5000 }] };
    const mm = site([q], [{ address: 'A84041F359618158' }]);
    expect(load(cloudStudioPayload(mm)).TANKS![1]).toMatchObject({ sensorHeight: 9065, levelOffset: -65 });
    expect(val(send(mm, 'A84041F359618158', SEND.dragino(4000)), '11')).toBe(5000);
  });

  it('a device that is not in DEVICE_TANKS only gets its Distance', () => {
    const logs: string[] = [];
    const eps = send(m, 'A840410000000000', SEND.dragino(1234), logs);
    expect(eps.map((e) => [e.address, e.value])).toEqual([['1', 1234], ['2', undefined]]);
    expect(logs[0]).toMatch(/No tank endpoints on this device/);
  });
});

describe('any ultrasonic or radar sensor, found from its uplink', () => {
  const p = tankProject('Tank 7', 4000, [top('ultrasonic', 'LT-101', { deadBand: 100, maxRange: 6000 })]);
  const m = site([p], [{ address: 'A84041F359618158' }]);

  for (const [model, make] of Object.entries(SEND)) {
    it(`${model}: distance and level`, () => {
      const eps = send(m, 'A84041F359618158', make(2890));
      expect(val(eps, '1')).toBe(2890);
      expect(val(eps, '11')).toBe(4005 - 2890);
    });
  }

  it('the Tekelek manual frames', () => {
    const s = load(cloudStudioPayload(m));
    const meas = s.decodeReading!({ port: 16, asBytes: () => bytes('1000000001121B7701131BAA01121BA90114F274') });
    expect(meas).toMatchObject({ model: 'Tekelek TEK 766', distance: 2740, temperature: 27, invalid: 'SRC 7 = reflection from near the sensor, possible obstruction' });
    const status = s.decodeReading!({ port: 48, asBytes: () => bytes('300000010106360063006300040600181BAA') });
    expect(status).toMatchObject({ distance: 240, battery: { percentage: 99 }, invalid: null });
    const alarm = s.decodeReading!({ port: 69, asBytes: () => bytes('45000100001E17AA001E16A9') });
    expect(alarm).toMatchObject({ distance: 300, invalid: null });
    expect(s.decodeReading!({ port: 67, asBytes: () => bytes('43000002400164480240011600') }).skip).toMatch(/^parameter read response/);
  });

  it('an SRC 7 Tekelek reading is shown on Distance, the level is kept', () => {
    const logs: string[] = [];
    const eps = send(m, 'A84041F359618158', { port: 16, asBytes: () => bytes('1000000001121B7701131BAA01121BA90114F274') }, logs);
    expect(val(eps, '1')).toBe(2740);
    expect(val(eps, '11')).toBeUndefined();
    expect(logs[0]).toMatch(/^Tank 7: Tekelek TEK 766, measurement, ullage 274 cm, SRC 7, SRSSI 7, temperature 27 C, distance 2740 mm is INVALID \(SRC 7/);
  });

  it('Dragino status and datalog packets, Milesight errors, unknown payloads: logged, nothing stored', () => {
    const cases: [unknown, RegExp][] = [
      [{ port: 5, asBytes: () => bytes('2A0110000B0CE4') }, /Dragino MR-xx-LB, battery 3\.3 V, device status packet, firmware 1\.1\.0$/],
      [{ port: 3, asBytes: () => bytes('0CE40B5400') }, /datalog/],
      [{ port: 2, asBytes: () => bytes('0CE40B5400010000') }, /INVALID \(sensor flag = 0/],
      [{ port: 85, asBytes: () => bytes('0382fdff') }, /no target \/ out of range$/],
      [{ port: 9, asBytes: () => bytes('deadbeef') }, /FPORT 9, payload deadbeef is not a known distance sensor$/],
    ];
    for (const [payload, msg] of cases) {
      const logs: string[] = [];
      const eps = send(m, 'A84041F359618158', payload, logs);
      expect(logs[0]).toMatch(msg);
      expect(val(eps, '11')).toBeUndefined();
    }
  });

  it('an object decoded by TTN, with nested keys or cm', () => {
    const s = load(cloudStudioPayload(m));
    expect(s.decodeReading!({ port: 1, asBytes: () => [], asParsedObject: () => ({ decoded_payload: { Distance: '1500', Bat: 3.6 } }) })).toMatchObject({ distance: 1500, battery: { voltage: 3.6 } });
    expect(s.decodeReading!({ port: 1, asBytes: () => [], asParsedObject: () => ({ ullage_cm: 150 }) })).toMatchObject({ distance: 1500 });
  });
});

describe('many tanks, many sensors', () => {
  const two = [top('radar', 'LT-101'), top('ultrasonic', 'LT-102', { x: 400 })];
  const ps = [
    tankProject('North', 3000, [top('radar', 'LT-101')]),
    tankProject('South', 5000, two),
    tankProject('East', 2000, [top('ultrasonic', 'LT-101'), top('ultrasonic', 'LT-102', { x: 300 }), top('radar', 'LT-103', { x: -300 })]),
  ];

  it('every distance sensor of every tank is a numbered entry', () => {
    const m = site(ps, []);
    expect(m.entries.map((e) => [e.number, e.name])).toEqual([
      [1, 'North'],
      [2, 'South LT-101'],
      [3, 'South LT-102'],
      [4, 'East LT-101'],
      [5, 'East LT-102'],
      [6, 'East LT-103'],
    ]);
    expect(Object.keys(load(cloudStudioPayload(m)).TANKS!)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('numbers set on the sensors are kept; a repeated one moves to a free number', () => {
    const q = structuredClone(ps);
    q[0].sensors[0].number = 31;
    q[1].sensors[0].number = 32;
    q[1].sensors[1].number = 31;
    const m = site(q, []);
    expect(m.entries.map((e) => [e.number, e.name])).toEqual([
      [1, 'South LT-102'],
      [2, 'East LT-101'],
      [3, 'East LT-102'],
      [4, 'East LT-103'],
      [31, 'North'],
      [32, 'South LT-101'],
    ]);
    expect(m.warnings).toContain('South · LT-102: number 31 is already used, so it is 1 here.');
  });

  it('each device gets the endpoints of its number and updates its own tank', () => {
    const devices = [1, 2, 3, 4, 5, 6].map((n) => ({ address: `A8404100000000${String(n).padStart(2, '0')}`, number: n }));
    const m = site(ps, devices);
    for (const e of m.entries) {
      const address = devices[e.number - 1].address;
      const eps = send(m, address, SEND.dragino(1000));
      expect(eps.map((x) => x.address)).toEqual(['1', '2', `${e.number}1`, `${e.number}2`, `${e.number}3`]);
      const level = e.sensorHeight - 1000;
      expect(val(eps, `${e.number}1`)).toBe(Math.round(level));
      expect(val(eps, `${e.number}3`)).toBe(Math.round(e.ed.d.engine.volume(level) * MM3_TO_L));
    }
  });

  it('two sensors on one tank differ by where they sit', () => {
    const q = structuredClone(ps);
    q[1].sensors[1].nozzle = 300;
    const m = site(q, []);
    expect(m.entries[2].sensorHeight - m.entries[1].sensorHeight).toBeCloseTo(300, 6);
  });

  it('as many sensors as you like', () => {
    const many = Array.from({ length: 40 }, (_, i) => tankProject(`Tank ${i + 1}`, 2000 + 10 * i, [top('radar', 'LT-101')]));
    const devices = many.map((_, i) => ({ address: `A84041000000${String(1000 + i)}`, number: i + 1 }));
    const m = site(many, devices);
    expect(m.entries).toHaveLength(40);
    const eps = send(m, devices[39].address, SEND.ttn(1000));
    expect(val(eps, '401')).toBe(2000 + 390 + 5 - 1000);
  });

  it('several devices can share a number (identical tanks)', () => {
    const m = site([ps[0]], [{ address: 'A840410000000001', number: 1 }, { address: 'A840410000000002', number: 1 }]);
    expect(cloudStudioConfig(m)).toContain('"A840410000000001": 1,\n  "A840410000000002": 1\n');
  });

  it('warns about devices it cannot place', () => {
    const m = site(ps, [{ address: 'A840410000000001', number: 9 }, { address: 'A840410000000003', number: 2 }, { address: 'a840410000000003', number: 3 }, { address: 'A8404100000001' }]);
    expect(m.devices.map((d) => d.address)).toEqual(['A840410000000003', 'A8404100000001']);
    expect(m.warnings).toEqual(
      expect.arrayContaining([
        'A840410000000001: there is no sensor number 9 on the site; it is left out.',
        'A840410000000003 is listed twice; it stays with number 2.',
        'A8404100000001 is 14 characters. A DevEUI has 16 hexadecimal characters, an IMEI 15 digits.',
      ]),
    );
  });

  it('a device without a number goes into the scripts at once, on the next sensor without a device', () => {
    const m = site(ps, [{ address: 'A840410000000001', number: 1 }, { address: 'A840410000000002' }, { address: 'A840410000000003' }]);
    expect(m.devices).toEqual([
      { address: 'A840410000000001', number: 1 },
      { address: 'A840410000000002', number: 2 },
      { address: 'A840410000000003', number: 3 },
    ]);
    expect(cloudStudioConfig(m)).toContain('"A840410000000003": 3');
    const t = site(ps, [{ address: '866207058378443' }, { address: '866207058378444', number: 4 }]);
    expect(t.family).toBe('tcp');
    expect(t.devices).toEqual([
      { address: '866207058378443', number: 1 },
      { address: '866207058378444', number: 4 },
    ]);
  });

  it('bottom sensors and switches are left out with a note', () => {
    const q = structuredClone(ps[0]);
    q.sensors.push(defaultSensor('pressure', 'PT-1'), defaultSensor('switch', 'LSH-1'));
    const m = site([q], []);
    expect(m.entries).toHaveLength(1);
    expect(m.warnings[0]).toBe('North: PT-1, LSH-1 left out. The scripts read distance sensors (ultrasonic, radar, laser) on the roof.');
  });
});

describe('SIM card sensors over TCP, by IMEI', () => {
  const p = tankProject('Tank 7', 4000, [top('ultrasonic', 'LT-101', { deadBand: 100, maxRange: 6000 })]);
  const m = site([p], [{ address: '866207058378443' }]);
  // The TEK 811 manual sample: ullage 119 cm, SRC 10, SRSSI 10, 19.5 C, battery (30 + 20) / 10 V.
  const sample = '072102018B06340866425030672135047B00018D03DC3C8201000A632877';

  it('the IMEI device gets its endpoints', () => {
    expect(m.family).toBe('tcp');
    expect(endpointsFor(cloudStudioConfig(m), '866207058378443').map((e) => e.address)).toEqual(['1', '2', '11', '12', '13']);
  });

  it('the TCP model carries only the TCP decoders; the LoRaWAN model only the LoRaWAN ones', () => {
    const tcp = cloudStudioPayload(m);
    expect(tcp).toContain('function decodeTek811');
    expect(tcp).not.toContain('function decodeDragino');
    expect(tcp).not.toContain('function decodeMilesight');
    const lora = cloudStudioPayload(site([p], [{ address: 'A84041F359618158' }]));
    expect(lora).toContain('function decodeTekelek');
    expect(lora).toContain('function decodeDragino');
    expect(lora).not.toContain('function decodeTek811');
  });

  it('TEK 811 as bytes and as hex text', () => {
    const s = load(cloudStudioPayload(m));
    const want = { model: 'Tekelek TEK 811', distance: 1190, temperature: 19.5, battery: { voltage: 5 }, invalid: null };
    expect(s.decodeReading!({ asBytes: () => bytes(sample) })).toMatchObject(want);
    expect(s.decodeReading!({ asBytes: () => [...sample].map((c) => c.charCodeAt(0)) })).toMatchObject(want);
    const logs: string[] = [];
    const eps = send(m, '866207058378443', { asBytes: () => bytes(sample) }, logs);
    expect(val(eps, '1')).toBe(1190);
    expect(val(eps, '11')).toBe(4005 - 1190);
    expect(logs[0]).toMatch(/^Tank 7: Tekelek TEK 811, battery 5 V, scheduled reading, ullage 119 cm, SRC 10, SRSSI 10, temperature 19\.5 C, distance 1190 mm, level 2815 mm/);
  });

  it('a TEK 811 settings message is logged, nothing stored', () => {
    const settings = sample.slice(0, 30) + '0A' + sample.slice(32);
    const logs: string[] = [];
    const eps = send(m, '866207058378443', { asBytes: () => bytes(settings) }, logs);
    expect(val(eps, '11')).toBeUndefined();
    expect(logs[0]).toMatch(/message type 10 \(settings, diagnostics or GPS\), ignored$/);
  });

  // A frame a sensor sent to the platform (product byte 0x22): IMEI in bytes 9-16, 6-byte readings
  // from byte 46 (status, status, temperature, SRC / SRSSI, ullage mm), CRC-16/XMODEM at the end.
  const cellHead = '2205270800000544600868206088952001005800002000091900007fb50005121326004604500106000000000000';
  const crc16 = (b: number[]) => {
    let c = 0;
    for (const x of b) {
      c ^= x << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  };
  const cellFrame = (readings: string[], head = cellHead) => {
    const body = bytes(head + readings.join('') + '000000000000'.repeat(10 - readings.length));
    return [...body, ...be16(crc16(body))];
  };
  const cellSeen = ['001019aa0220', '001019aa023a', '001019a8023d', '000119a802c4'];
  const cellHex = `${cellHead}${cellSeen.join('')}${'00'.repeat(36)}c683`;

  it('the newer Tekelek cellular frame (product 0x22), exactly as the platform logged it', () => {
    expect(cellFrame(cellSeen)).toEqual(bytes(cellHex));
    const s = load(cloudStudioPayload(m));
    const want = { model: 'Tekelek sensor 0x22', distance: 544, temperature: 25, battery: null, invalid: null, skip: null, info: 'ullage 544 mm, SRC 10, SRSSI 10, temperature 25 C' };
    expect(s.decodeReading!({ asBytes: () => bytes(cellHex) })).toEqual(want);
    expect(s.decodeReading!({ asBytes: () => [...cellHex.toUpperCase()].map((c) => c.charCodeAt(0)) })).toEqual(want);
    const logs: string[] = [];
    const eps = send(m, '866207058378443', { asBytes: () => bytes(cellHex) }, logs);
    expect(val(eps, '1')).toBe(544);
    expect(val(eps, '2')).toBe(25);
    expect(val(eps, '11')).toBe(4005 - 544);
    expect(logs[0]).toMatch(/^Tank 7: Tekelek sensor 0x22, ullage 544 mm, SRC 10, SRSSI 10, temperature 25 C, distance 544 mm, level 3461 mm, /);
  });

  it('cellular frame: the newest reading with data is used, a weak echo is refused', () => {
    const s = load(cloudStudioPayload(m));
    const read = (b: number[]) => s.decodeReading!({ asBytes: () => b });
    expect(read(cellFrame(['000000000000', '0010e7a80bb8']))).toMatchObject({ distance: 3000, temperature: -25, invalid: null, info: 'ullage 3000 mm, SRC 10, SRSSI 8, temperature -25 C' });
    expect(read(cellFrame(['0010193a0220'])).invalid).toBe('SRC 3 = noisy reflections, check alignment or obstructions');
    expect(read(cellFrame(['001019a20220'])).invalid).toBe('SRSSI 2 is below 4, weak echo');
    expect(read(cellFrame(['001019aa0000'])).invalid).toBe('0 = no reading');
    const logs: string[] = [];
    const eps = send(m, '866207058378443', { asBytes: () => cellFrame(['0010193a0220']) }, logs);
    expect(val(eps, '11')).toBeUndefined();
    expect(logs[0]).toMatch(/distance 544 mm is INVALID \(SRC 3 = noisy reflections/);
  });

  it('cellular frame: no reading, a text message, a cut frame', () => {
    const s = load(cloudStudioPayload(m));
    const read = (b: number[]) => s.decodeReading!({ asBytes: () => b });
    expect(read(cellFrame([]))).toMatchObject({ model: 'Tekelek sensor 0x22', distance: null, skip: 'no measurement in the frame (108 bytes)' });
    const text = [...'S0=80,S1=05,S2=7F0038,S3=64,S4=081E,S5=8832'].map((c) => c.charCodeAt(0));
    const settings = [...bytes(cellHead.slice(0, 38)), ...text];
    expect(read([...settings, ...be16(crc16(settings))])).toMatchObject({ distance: null, skip: 'settings or information message, ignored' });
    // Cut after the second reading: the first one is still whole, the checksum can no longer match.
    const cut = bytes(cellHex).slice(0, 58);
    expect(read(cut)).toMatchObject({ distance: 544, info: 'ullage 544 mm, SRC 10, SRSSI 10, temperature 25 C, checksum does not match (frame cut short or joined)' });
    // A TEK 811 frame is still read by its own layout.
    expect(read(bytes(sample))).toMatchObject({ model: 'Tekelek TEK 811', distance: 1190 });
  });

  it('JSON text from a SIM card device', () => {
    const text = JSON.stringify({ imei: '866207058378443', distance: 1500, battery: 3.6 });
    const eps = send(m, '866207058378443', { asBytes: () => [...text].map((c) => c.charCodeAt(0)), asJsonObject: () => { throw new Error('no'); } });
    expect(val(eps, '1')).toBe(1500);
    expect(val(eps, '11')).toBe(4005 - 1500);
  });
});

describe('a sensor on a manhole: the script holds the manhole with its own sizes', () => {
  const address = 'A840410000000001';
  /** Puts a manhole on the project and a radar on its cover. */
  function onManhole(p: Project, mh: Partial<ManholeConfig>, sensor: Partial<SensorConfig> = {}): Project {
    const m: ManholeConfig = { ...defaultManhole('MH-1'), ...mh };
    p.tank.manholes = [m];
    p.sensors = [top('radar', 'LT-1', { x: m.x, y: m.y, faceMode: 'manhole', manhole: m.id, nozzle: 0, deadBand: 80, ...sensor })];
    return p;
  }
  const model = (p: Project) => site([p], [{ address, number: 1 }]);
  const run = (m: CsModel, distance: number, logs: string[] = []) => send(m, address, SEND.ttn(distance), logs);
  const litresOf = (mm3: number) => mm3 * MM3_TO_L;

  // Inside Ø 2000 × 4000 with a 5 mm flat roof; manhole Ø 600 with a 600 mm neck and a 10 mm cover.
  const steel = () => onManhole(tankProject('Tank M', 4000, []), { diameter: 600, neck: 600, cover: 10 });
  const tankFull = Math.PI * 1000 * 1000 * 4000;
  const neckArea = Math.PI * 300 * 300;

  it('the entry lists the manhole, not the tank size, and the sensor height is the sum of its parts', () => {
    const m = model(steel());
    const e = m.entries[0];
    expect(e.manhole).toEqual({ name: 'MH-1', shape: 'round', insideDiameter: 600, roofHeight: 4000, roofThickness: 5, neckHeight: 600, coverThickness: 10, sensorAboveCover: 0 });
    expect(e.sensorHeight).toBe(4000 + 5 + 600 + 0);
    expect(e.levelOffset).toBe(0);
    const payload = cloudStudioPayload(m);
    const tank = load(payload).TANKS![1];
    expect(tank.manhole).toEqual(e.manhole);
    expect(tank.sensorHeight).toBeUndefined();
    expect(tank).toMatchObject({ shape: 'standing cylinder', insideDiameter: 2000, shellHeight: 4000 });
    expect(payload).toContain('function sensorHeight(tank)');
    expect(payload).toContain('return m.roofHeight + m.roofThickness + m.neckHeight + m.sensorAboveCover;');
    expect(payload).toContain('var level = sensorHeight(tank) - distance');
    expect(payload).not.toContain('//');
  });

  it('below the roof the manhole changes nothing but the sensor height', () => {
    const eps = run(model(steel()), 1605);
    expect(val(eps, '11')).toBe(3000);
    expect(val(eps, '12')).toBe(75);
    expect(val(eps, '13')).toBe(Math.round(litresOf(Math.PI * 1000 * 1000 * 3000)));
  });

  it('liquid in the neck is added with the area of the opening, not of the tank', () => {
    const m = model(steel());
    const logs: string[] = [];
    let eps = run(m, 405, logs);
    expect(val(eps, '11')).toBe(4200);
    expect(val(eps, '12')).toBe(100);
    expect(val(eps, '13')).toBe(Math.round(litresOf(tankFull + neckArea * 200)));
    expect(logs[0]).toMatch(/level 4200 mm, 100 %, 12623 L of 12566 L, 57 L of it in the neck of manhole MH-1$/);
    eps = run(m, 100);
    expect(val(eps, '11')).toBe(4505);
    expect(val(eps, '13')).toBe(Math.round(litresOf(tankFull + neckArea * 505)));
    // At the roof itself nothing is added yet.
    const at = run(m, 605, logs);
    expect(val(at, '11')).toBe(4000);
    expect(val(at, '13')).toBe(Math.round(litresOf(tankFull)));
    expect(logs[1]).toMatch(/12566 L of 12566 L$/);
  });

  it('the level stops at the underside of the cover', () => {
    const p = steel();
    p.sensors[0].deadBand = 0;
    const eps = run(model(p), 2);
    expect(val(eps, '11')).toBe(4000 + 5 + 600 - 10);
    expect(val(eps, '13')).toBe(Math.round(litresOf(tankFull + neckArea * 595)));
  });

  it('a sensor hanging below the cover top, and a cover height given above level zero', () => {
    const p = onManhole(tankProject('Tank M', 4000, []), { diameter: 600, heightBy: 'zero', top: 4405, cover: 10 }, { nozzle: -10 });
    const m = model(p);
    expect(m.entries[0].manhole).toMatchObject({ roofHeight: 4000, roofThickness: 5, neckHeight: 400, coverThickness: 10, sensorAboveCover: -10 });
    expect(m.entries[0].sensorHeight).toBe(4395);
    expect(val(run(m, 1395), '11')).toBe(3000);
  });

  it('a rectangular manhole in the slab over a concrete storage', () => {
    const p = emptyProject();
    p.name = 'Covered storage';
    p.tank = { ...p.tank, kind: 'pit', pit: { ...defaultPit(), outline: rectangle(10000, 6000), wallHeight: 3000, heightRef: 'floorHigh', floor: { type: 'plane', direction: 0, drop: 200 } } };
    onManhole(p, { shape: 'rect', diameter: 800, length: 600, x: 1000, y: 500, neck: 450, cover: 50 });
    const d = derive(p);
    expect(d.kind).toBe('pit');
    expect(d.manholes[0].ok).toBe(true);
    expect(d.manholes[0].coverHeight).toBe(3200 + 450);
    expect(d.geoms[0].ok).toBe(true);
    expect(d.geoms[0].manhole).toBe(d.manholes[0]);
    expect(d.geoms[0].faceLevel).toBe(3650);
    const m = model(p);
    const e = m.entries[0];
    expect(e.shape).toBe('concretePit');
    expect(e.manhole).toEqual({ name: 'MH-1', shape: 'rectangular', insideWidth: 800, insideLength: 600, roofHeight: 3200, roofThickness: 0, neckHeight: 450, coverThickness: 50, sensorAboveCover: 0 });
    expect(e.sensorHeight).toBe(3650);
    const near = (got: number | undefined, want: number) => expect(Math.abs(got! - want)).toBeLessThan(0.5 + 0.06 + 2e-5 * d.totalL);
    let eps = run(m, 650);
    expect(val(eps, '11')).toBe(3000);
    near(val(eps, '13'), d.engine.litres(3000));
    // 200 mm up the neck: the storage is full, plus 800 × 600 × 200 mm.
    eps = run(m, 250);
    expect(val(eps, '11')).toBe(3400);
    expect(val(eps, '12')).toBe(100);
    near(val(eps, '13'), d.totalL + (800 * 600 * 200) / 1e6);
    // Up to the underside of the cover, 400 mm above the wall top.
    p.sensors[0].deadBand = 0;
    eps = run(model(p), 1);
    expect(val(eps, '11')).toBe(3600);
    near(val(eps, '13'), d.totalL + (800 * 600 * 400) / 1e6);
  });

  it('on a domed roof the neck starts at the roof under the manhole, below the top of the dome', () => {
    const p = tankProject('Dome', 3000, []);
    p.tank.end = { ...defaultHead('ellipsoidal', 5) };
    onManhole(p, { x: 700, diameter: 500, neck: 700, cover: 10 }, { deadBand: 0 });
    const d = derive(p);
    const g = d.geoms[0];
    const mg = d.manholes[0];
    const m = model(p);
    const e = m.entries[0];
    const mh = e.manhole as Record<string, number>;
    expect(e.shape).toBe('standing cylinder');
    expect(mh.roofHeight).toBeCloseTo(mg.roofLevel, 2);
    expect(mh.roofHeight).toBeLessThan(d.depth - 50);
    expect(mh.roofThickness).toBeGreaterThan(5);
    expect(e.sensorHeight).toBeCloseTo(g.faceHeightUntilted, 1);
    expect(Math.abs(e.levelOffset)).toBeLessThan(0.05);
    // Between the roof at the manhole and the top of the dome: the dome is still filling, and the neck too.
    const level = Math.round((mh.roofHeight + d.depth) / 2);
    const eps = run(m, Math.round((e.sensorHeight + e.levelOffset - level) * 10) / 10);
    const got = val(eps, '11')!;
    expect(Math.abs(got - level)).toBeLessThanOrEqual(1);
    const lv = e.sensorHeight + e.levelOffset - Math.round((e.sensorHeight + e.levelOffset - level) * 10) / 10;
    const want = litresOf(d.engine.volume(lv)) + (Math.PI * 250 * 250 * (lv - mh.roofHeight)) / 1e6;
    expect(Math.abs(val(eps, '13')! - want)).toBeLessThan(0.5 + 0.06 + 2e-5 * d.totalL);
    // Above the dome: the whole tank, plus the neck up to that level.
    const high = Math.round(d.depth + 100);
    const eps2 = run(m, Math.round(e.sensorHeight + e.levelOffset - high));
    expect(val(eps2, '11')).toBe(high);
    const want2 = d.totalL + (Math.PI * 250 * 250 * (high - mh.roofHeight)) / 1e6;
    expect(Math.abs(val(eps2, '13')! - want2)).toBeLessThan(0.5 + 0.06 + 2e-5 * d.totalL);
  });

  it('a tilted tank: the level follows the tilted sensor and the neck column is measured along the neck', () => {
    const p = tankProject('Tilted', 4000, []);
    p.tank.tilt = 4;
    onManhole(p, { x: -300, diameter: 600, neck: 800, cover: 10 }, { deadBand: 0 });
    const d = derive(p);
    const g = d.geoms[0];
    const mg = d.manholes[0];
    const m = model(p);
    const e = m.entries[0];
    const mh = e.manhole as Record<string, number>;
    expect(e.shape).toBe('table');
    expect(mh.tilt).toBeCloseTo(4, 3);
    expect(mh.roofHeight).toBeCloseTo(mg.roofLevel, 2);
    for (const distance of [500, 1500, 3000]) {
      const eps = run(m, distance);
      expect(Math.abs(val(eps, '11')! - Math.min(levelFromMeasure(g, distance, d.density), d.depth + 1e9))).toBeLessThanOrEqual(0.52);
    }
    // 300 mm (in level) above the inside roof under the manhole.
    const level = mg.roofLevel + 300;
    const distance = (g.faceLevel - level) / g.cosTilt;
    const eps = run(m, Math.round(distance * 10) / 10);
    const lv = levelFromMeasure(g, Math.round(distance * 10) / 10, d.density);
    const want = litresOf(d.engine.volume(Math.min(lv, d.depth))) + (Math.PI * 300 * 300 * ((lv - mg.roofLevel) / g.cosTilt)) / 1e6;
    expect(Math.abs(val(eps, '13')! - want)).toBeLessThan(0.5 + 0.06 + 2e-4 * d.totalL);
    expect((Math.PI * 300 * 300 * 300) / g.cosTilt / 1e6).toBeGreaterThan(84);
  });

  it('a site without a sensor on a manhole keeps the plain script', () => {
    const p = tankProject('Plain', 4000, [top('radar', 'LT-1')]);
    p.tank.manholes = [defaultManhole('MH-1')];
    const m = model(p);
    expect(m.entries[0].manhole).toBeNull();
    const payload = cloudStudioPayload(m);
    expect(payload).not.toContain('neckVolume');
    expect(payload).toContain('var level = tank.sensorHeight - distance');
    expect(load(payload).TANKS![1].sensorHeight).toBe(4005);
  });

  it('two sensors of one site: one on a manhole, one on the roof', () => {
    const a = steel();
    const b = tankProject('Roof', 3000, [top('radar', 'LT-2')]);
    const m = site([a, b], [{ address, number: 1 }, { address: 'A840410000000002', number: 2 }]);
    const payload = load(cloudStudioPayload(m));
    expect(payload.TANKS![1].manhole).toBeDefined();
    expect(payload.TANKS![2]).toMatchObject({ sensorHeight: 3005 });
    expect(payload.TANKS![2].manhole).toBeUndefined();
    expect(val(send(m, 'A840410000000002', SEND.ttn(1005)), '21')).toBe(2000);
    expect(val(send(m, address, SEND.ttn(405)), '13')).toBe(Math.round(litresOf(tankFull + neckArea * 200)));
  });
});

describe('pasted devices', () => {
  it('one DevEUI per line, with an optional number', () => {
    expect(parseDeviceLines('A840417369618159\nA840-410E-A662-7E5C, 3\na8 40 41 00 00 00 00 01 ; no. 12\n866207058378443')).toEqual([
      { address: 'A840417369618159' },
      { address: 'A840410EA6627E5C', number: 3 },
      { address: 'A840410000000001', number: 12 },
      { address: '866207058378443' },
    ]);
  });
});

describe('every preset: the payload script against the 3D tank', { timeout: 60000 }, () => {
  for (const preset of PRESETS) {
    it(preset.id, () => {
      const p = preset.build();
      p.sensors = p.sensors.filter((s) => s.kind === 'ultrasonic' || s.kind === 'radar' || s.kind === 'laser');
      if (!p.sensors.length) p.sensors = [defaultSensor('radar', 'LT-1')];
      for (const s of p.sensors) Object.assign(s, { deadBand: 0, maxRange: 1e6, cal: { method: 'theory', ref: 'level', points: [] } });
      const d = derive(p);
      const m = cloudStudioModel(eds([p]), {}, []);
      if (!m.entries.length) return;
      const script = load(cloudStudioPayload(m));
      for (const e of m.entries) {
        const g = d.geoms.find((x) => x.sensor.id === e.sensorId)!;
        const eps = [{ address: '1' }, { address: `${e.number}1` }, { address: `${e.number}2` }, { address: `${e.number}3` }] as Ep[];
        for (let i = 1; i < 30; i++) {
          const level = g.validMin + ((g.validMax - g.validMin) * i) / 30;
          const distance = Math.round(((e.sensorHeight + e.levelOffset - level) / e.distanceScale) * 10) / 10;
          const lv = e.sensorHeight + e.levelOffset - distance * e.distanceScale;
          script.parseUplink!(mockDevice(eps), SEND.ttn(distance));
          expect(Math.abs(val(eps, `${e.number}1`)! - lv), `${preset.id} ${e.tag} level`).toBeLessThanOrEqual(0.52);
          const want = d.engine.volume(Math.min(Math.max(lv, 0), d.depth)) * MM3_TO_L;
          expect(Math.abs(val(eps, `${e.number}3`)! - want), `${preset.id} ${e.tag} at ${lv.toFixed(1)} mm (${e.shape})`).toBeLessThan(0.5 + 0.06 + 2e-5 * d.totalL);
        }
      }
    });
  }
});
