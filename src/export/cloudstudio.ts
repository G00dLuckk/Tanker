import { strapTable } from '../core/calibration';
import { SENSOR_KINDS, isTopSensor } from '../core/defaults';
import type { HeadProfile } from '../core/heads';
import { checkValues, pitTable } from '../core/pit';
import { levelFromMeasure, type SensorGeom } from '../core/sensors';
import type { HeadConfig } from '../core/types';
import { plain } from '../core/units';
import { decoderSource, type DecoderFamily } from './csDecoders';
import { withCal, type Conversion, type ExportData } from './shared';

/**
 * The configuration and payload scripts of the site on the Cloud Studio IoT platform
 * (iot.teknykar.com), in the layout of the scripts used on customer sites.
 *
 * Every distance sensor (ultrasonic, radar, laser) of every tank or storage on the site
 * is one numbered entry of TANKS in the payload script, with its tank's sizes (or, for a
 * concrete storage, its level → litres table) and the height of the sensor above the
 * inside floor. A device is given the number of the sensor it is; several devices can
 * share a number (identical tanks).
 *
 * There is one device model per sensor family, never both in one:
 *   LoRaWAN  devices by DevEUI (16 hex characters): TEK 766, Dragino, Milesight, Netvox…
 *   TCP      SIM card sensors by IMEI (15 digits): TEK 811 / 811 LR / 822, JSON text
 * The two families share the tank model, the level pipeline, the endpoints and the tests.
 *
 * Endpoints of a device with number n:
 *   "1"   Distance: the reading of the sensor (mm), as it sends it
 *   "2"   Temperature (°C), when the sensor reports one
 *   n1    Liquid level (mm)      n2  Fill level (%)      n3  Volume (L)
 *
 * The payload script finds the device's number from its endpoints, works out from
 * the uplink which sensor model sent it, and computes the level as
 * sensorHeight − distance + levelOffset and the volume from the tank's sizes.
 *
 * A sensor on a manhole cover carries that manhole in its entry, with its own sizes
 * (never the tank's): the script adds up the sensor height from them (inside roof at
 * the manhole + roof plate + neck + sensor above the cover) and, when the liquid stands
 * above the roof inside the neck, adds that column with the opening's own area.
 * Scripts are plain ES5 (var, function, for loops), as the platform runs them, and
 * carry no comments.
 */

/** Variable type ids of the platform, used on every site; the user can change them. */
export const DEFAULT_VAR_IDS: Record<string, number> = { mm: 1380, '%': 1406, L: 1371 };

/** Largest number of a sensor entry. */
export const MAX_NUMBER = 9999;

/** Sensor family of a device model: LoRaWAN (DevEUI) or SIM card sensors over TCP (IMEI). */
export type CsFamily = DecoderFamily;

export const FAMILY_LABEL: Record<CsFamily, string> = { lorawan: 'LoRaWAN (DevEUI)', tcp: 'TCP / SIM card (IMEI)' };

/** Level → litres table step of a concrete storage (mm), and the coarser step used when the script would grow past ~50 kB. */
export const PIT_TABLE_STEP = 10;
export const PIT_TABLE_STEP_COARSE = 50;
const PAYLOAD_SIZE_LIMIT = 50 * 1024;

/** A value in the script: number, text, or a nested object / list of them. */
type Lit = number | string | Lit[] | { [k: string]: Lit | undefined };

/** One numbered sensor entry: a distance sensor on a tank. */
export interface CsEntry {
  number: number;
  /** Name in the device log: the tank name, with the sensor tag when the tank has several sensors. */
  name: string;
  /** Tank in the site list (0 = first tank). */
  tankIndex: number;
  tankName: string;
  sensorId: string;
  tag: string;
  /** "Radar", "Ultrasonic"… */
  kind: string;
  /** Face of the sensor above the inside floor of the tank (level 0), mm. On a manhole: the sum of its parts. */
  sensorHeight: number;
  /** The manhole the sensor sits on, as the script holds it; null on the roof, a bracket or a typed height. */
  manhole: { [k: string]: Lit } | null;
  /** Correction of the level from field calibration (mm); 0 from the drawing. */
  levelOffset: number;
  /** Level change per mm of distance (1, or the calibrated / tilted value). */
  distanceScale: number;
  blindZone: number;
  maxRange: number;
  /** How the script computes the volume: from the tank's sizes, from a level → volume table, or a concrete storage's table. */
  shape: string;
  /** The tank part of the TANKS entry. */
  geometry: [string, Lit][];
  /** Capacity of the tank (L). */
  capacity: number;
  /** Height of the full tank above the inside floor (mm). */
  depth: number;
  conv: Conversion;
  ed: ExportData;
}

export interface CsDevice {
  /** DevEUI (16 hex digits, upper case) or IMEI (15 digits). */
  address: string;
  number: number;
}

export interface CsModel {
  family: CsFamily;
  entries: CsEntry[];
  devices: CsDevice[];
  /** Plain-language problems: duplicate addresses, numbers with no sensor, shapes computed from a table… */
  warnings: string[];
  /** Variable type id by unit (mm, %, L); 0 = not set. */
  varIds: Record<string, number>;
}

export function parseAddresses(text: string): string[] {
  return (text || '')
    .split(/[\s,;]+/)
    .map((a) => a.replace(/[^0-9A-Fa-f]/g, '').toUpperCase())
    .filter(Boolean);
}

/** A DevEUI or IMEI as the scripts store it: hex digits only, upper case. */
export function cleanAddress(text: string): string {
  return parseAddresses(text)[0] ?? '';
}

/**
 * Pasted device lines: one or more DevEUIs / IMEIs per line; a line with one address may carry
 * the sensor number after a comma, semicolon, tab or space ("A840417369618159, 3").
 */
export function parseDeviceLines(text: string): { address: string; number?: number }[] {
  const out: { address: string; number?: number }[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((x) => x.trim()).filter(Boolean);
    const isAddr = (x: string) => /^[0-9A-Fa-f:\-\s]+$/.test(x) && x.replace(/[^0-9A-Fa-f]/g, '').length >= 12;
    // Addresses on one line are split by spaces, unless the spaces are inside one address ("A8 40 41 …").
    const split = (x: string) => {
      const words = x.split(/\s+/).filter(Boolean);
      return words.every((w) => w.replace(/[^0-9A-Fa-f]/g, '').length < 12) ? [x.replace(/[^0-9A-Fa-f]/g, '')] : words;
    };
    const addrs = parts.flatMap((x) => (isAddr(x) ? split(x) : [])).map(cleanAddress).filter(Boolean);
    const rest = parts.filter((x) => !isAddr(x)).join(' ');
    const m = rest.match(/^(?:no\.?|#|tank|sensor)?\s*(\d{1,4})$/i);
    const number = addrs.length === 1 && m ? Number(m[1]) : undefined;
    for (const a of addrs) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(number ? { address: a, number } : { address: a });
    }
  }
  return out;
}

const q = (s: string) => JSON.stringify(s);
const n2 = (v: number) => Number(plain(v, 2));

/** Head of a round tank as the script computes it, or null when the script cannot. */
function headLit(h: HeadProfile, cfg: HeadConfig): { [k: string]: Lit } | null {
  const d = n2(h.depth);
  switch (h.type) {
    case 'flat':
      return { shape: 'flat', depth: 0 };
    case 'hemi':
      return { shape: 'hemispherical', depth: d };
    case 'ellipsoidal':
      return { shape: 'ellipsoidal', depth: d };
    case 'paraboloid':
      return { shape: 'paraboloid', depth: d };
    case 'dished':
      return h.meta.sphereR ? { shape: 'dished', depth: d, crownRadius: n2(h.meta.sphereR) } : null;
    case 'torispherical':
      return h.meta.crownR && h.meta.knuckleR ? { shape: 'torispherical', depth: d, crownRadius: n2(h.meta.crownR), knuckleRadius: n2(h.meta.knuckleR) } : null;
    case 'flanged':
      return h.meta.knuckleR ? { shape: 'flanged', depth: d, knuckleRadius: n2(h.meta.knuckleR) } : null;
    case 'cone':
      if (cfg.eccentric || h.meta.outletU === undefined) return null;
      return { shape: 'cone', depth: d, outletDiameter: n2(h.meta.outletU) };
    case 'toricone':
      if (h.meta.angle === undefined || !h.meta.knuckleR || h.meta.outletU === undefined) return null;
      return { shape: 'toricone', depth: d, knuckleRadius: n2(h.meta.knuckleR), angle: Number(h.meta.angle.toFixed(6)), outletDiameter: n2(h.meta.outletU) };
    default:
      return null;
  }
}

/**
 * The tank part of a TANKS entry: the sizes the script computes the volume from, a
 * level → volume table for shapes it cannot compute (tilted, tapered, oval, eccentric
 * cones…), or the level → litres table of a concrete storage.
 */
function tankGeometry(ed: ExportData, pitStep: number): { shape: string; fields: [string, Lit][]; why?: string } {
  const d = ed.d;
  if (d.kind === 'pit') {
    const table = pitTable(d.engine, pitStep);
    return {
      shape: 'concretePit',
      fields: [
        ['shape', 'concretePit'],
        ['maxLevel', n2(d.engine.depth)],
        ['fullLitres', table[table.length - 1][1]],
        ['table', table],
      ],
    };
  }
  const m = d.model;
  const p = ed.project;
  const vertical = m.orientation === 'vertical';
  const walls: [string, Lit][] = vertical
    ? [
        ['wallThickness', m.t.shell],
        ['bottomThickness', m.t.start],
        ['topThickness', m.t.end],
      ]
    : [
        ['wallThickness', m.t.shell],
        ['leftEndThickness', m.t.start],
        ['rightEndThickness', m.t.end],
      ];
  const table = (why: string) => {
    const rows = strapTable(d.engine, { mode: 'compact', step: 10, rows: 50, tolerance: 0.05 });
    const shape = `${vertical ? 'standing' : 'lying'} ${m.bodyType}`;
    return {
      shape: 'table',
      why,
      fields: [
        ['shape', 'table'],
        ['drawnAs', shape],
        ...walls,
        ['level', rows.map((r) => n2(r.level))],
        ['litres', rows.map((r) => Number(plain(r.litres, 3)))],
      ] as [string, Lit][],
    };
  };
  if (Math.abs(d.tilt) > 1e-9) return table('the tank is tilted');
  if (m.profile || Math.abs(m.endScale - 1) > 1e-9) return table('the shell is tapered or stepped');
  if (m.bodyType === 'sphere') {
    return { shape: 'sphere', fields: [['shape', 'sphere'], ['insideDiameter', n2(2 * m.base.A)], ['wallThickness', m.t.shell]] };
  }
  if (m.bodyType === 'rect' && m.start.type === 'flat' && m.end.type === 'flat') {
    const c = m.base.kind === 'roundrect' ? m.base.rho : 0;
    if (vertical) {
      return {
        shape: 'standing box',
        fields: [['shape', 'standing box'], ['insideWidth', n2(2 * m.base.A)], ['insideDepth', n2(2 * m.base.B)], ['cornerRadius', n2(c)], ['shellHeight', n2(m.L)], ...walls],
      };
    }
    if (c <= 1e-9) {
      return {
        shape: 'lying box',
        fields: [['shape', 'lying box'], ['insideWidth', n2(2 * m.base.A)], ['insideHeight', n2(2 * m.base.B)], ['shellLength', n2(m.L)], ...walls],
      };
    }
    return table('the box has rounded corners and lies on its side');
  }
  if (m.bodyType !== 'cylinder') return table(`the script computes cylinders, spheres and boxes; this is a ${m.bodyType}`);
  const a = headLit(m.start, p.tank.start);
  const b = headLit(m.end, p.tank.end);
  if (!a || !b) return table(`the script cannot compute the ${!a ? (vertical ? 'bottom' : 'left end') : vertical ? 'top' : 'right end'} (${(!a ? m.start : m.end).meta.label})`);
  if (vertical) {
    return {
      shape: 'standing cylinder',
      fields: [['shape', 'standing cylinder'], ['insideDiameter', n2(2 * m.base.A)], ['shellHeight', n2(m.L)], ['bottom', a], ['top', b], ...walls],
    };
  }
  return {
    shape: 'lying cylinder',
    fields: [['shape', 'lying cylinder'], ['insideDiameter', n2(2 * m.base.A)], ['shellLength', n2(m.L)], ['leftEnd', a], ['rightEnd', b], ...walls],
  };
}

/** The parts the script adds up to the sensor height on a manhole, in this order. */
const MANHOLE_HEIGHT_PARTS = ['roofHeight', 'roofThickness', 'neckHeight', 'sensorAboveCover'] as const;

/**
 * The manhole a sensor sits on, with its own sizes: the opening, the inside roof under its
 * centre (the wall top on a concrete storage), the roof plate there, the neck up to the
 * top of the cover, the cover plate and the sensor face above the cover.
 */
function manholeLit(g: SensorGeom): { [k: string]: Lit } | null {
  const mg = g.manhole;
  if (!mg) return null;
  const mh = mg.manhole;
  const out: { [k: string]: Lit } = { name: mh.tag };
  if (mh.shape === 'round') {
    out.shape = 'round';
    out.insideDiameter = n2(mh.diameter);
  } else {
    out.shape = 'rectangular';
    out.insideWidth = n2(mh.diameter);
    out.insideLength = n2(mh.length);
  }
  out.roofHeight = n2(mg.roofLevel);
  out.roofThickness = n2(mg.roofThickness);
  out.neckHeight = n2(mg.neckHeight);
  out.coverThickness = n2(Math.max(0, mh.cover));
  out.sensorAboveCover = n2(g.sensor.nozzle);
  // A tilted tank tilts its neck too: the liquid column in it is measured along the neck.
  if (Math.abs(1 - g.cosTilt) > 1e-9) out.tilt = Number(((Math.acos(Math.min(1, Math.abs(g.cosTilt))) * 180) / Math.PI).toFixed(4));
  return out;
}

/** Level (mm) = A + B × distance (mm) of a top sensor, with its field calibration. */
function distanceFormula(c: Conversion, ed: ExportData): { A: number; B: number } {
  const g = c.geom;
  const A0 = levelFromMeasure(g, 0, ed.d.density);
  return withCal(c, A0, levelFromMeasure(g, 1, ed.d.density) - A0);
}

/** A DevEUI (16 hex characters) or an IMEI (15 digits). */
export function isAddress(a: string): boolean {
  return addressKind(a) !== null;
}

/** What kind of address a cleaned string is: a DevEUI (LoRaWAN), an IMEI (TCP) or neither. */
export function addressKind(a: string): 'deveui' | 'imei' | null {
  if (a.length === 16 && /^[0-9A-F]+$/i.test(a)) return 'deveui';
  if (a.length === 15 && /^\d+$/.test(a)) return 'imei';
  return null;
}

/** The family a device belongs to, by its address kind. */
export function familyOfAddress(a: string): CsFamily | null {
  const k = addressKind(a);
  return k === 'deveui' ? 'lorawan' : k === 'imei' ? 'tcp' : null;
}

/** The family to generate when none is chosen: TCP when every device is an IMEI, else LoRaWAN. */
export function resolveFamily(choice: CsFamily | 'auto' | undefined, devices: { address: string }[]): CsFamily {
  if (choice === 'lorawan' || choice === 'tcp') return choice;
  const kinds = devices.map((d) => familyOfAddress(cleanAddress(d.address))).filter((k): k is CsFamily => k !== null);
  return kinds.length && kinds.every((k) => k === 'tcp') ? 'tcp' : 'lorawan';
}

const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER;

/**
 * The site: every distance sensor of every tank, numbered, and the devices of one
 * sensor family. A sensor keeps the number it was given unless another sensor has it
 * already; sensors without a number take the lowest free one.
 */
export function cloudStudioModel(
  tanks: ExportData[],
  varIds: Record<string, number> = {},
  devices: { address: string; number?: number }[] = [],
  familyChoice: CsFamily | 'auto' = 'auto',
): CsModel {
  const family = resolveFamily(familyChoice, devices);
  const warnings: string[] = [];
  const entries: CsEntry[] = [];
  const used = new Set<number>();
  const pending: { ed: ExportData; ti: number; c: Conversion; many: boolean }[] = [];
  tanks.forEach((ed, ti) => {
    const convs = ed.conversions.filter((c) => c.geom.mount === 'top' && isTopSensor(c.sensor.kind));
    const left = ed.project.sensors.filter((s) => s.enabled && !isTopSensor(s.kind));
    if (left.length) warnings.push(`${ed.project.name}: ${left.map((s) => s.tag).join(', ')} left out. The scripts read distance sensors (ultrasonic, radar, laser) on the roof.`);
    for (const c of convs) pending.push({ ed, ti, c, many: convs.length > 1 });
    if (!convs.length) warnings.push(`${ed.project.name}: no distance sensor that can read a level, so it is not in the scripts.`);
    if (ed.d.kind === 'pit') {
      for (const r of checkValues(ed.d.engine)) {
        if (r.ok) continue;
        warnings.push(
          Number.isFinite(r.errorPct)
            ? `${ed.project.name}: the drawing gives ${Math.round(r.check.litres).toLocaleString('en-US')} L at ${Math.round(r.check.level)} mm, the design ${Math.round(r.litres).toLocaleString('en-US')} L (${r.errorPct > 0 ? '+' : ''}${r.errorPct.toFixed(2)} %). Check the plan, the floor slope and the wall height.`
            : `${ed.project.name}: a drawing check value is 0 L and cannot be compared.`,
        );
      }
    }
  });
  // Numbers set by the user first, in order; a repeated number is moved.
  const wanted = pending.map((x) => (validNumber(x.c.sensor.number) ? x.c.sensor.number : null));
  const given: (number | null)[] = wanted.map((n) => {
    if (n === null || used.has(n)) return null;
    used.add(n);
    return n;
  });
  // Concrete storages carry a 10 mm table; 50 mm when the whole script would grow past ~50 kB
  // (about 16 characters per table pair on top of a 12 kB script).
  const tableBytes = pending.reduce((s, x) => s + (x.ed.d.kind === 'pit' ? (x.ed.d.engine.depth / PIT_TABLE_STEP + 1) * 16 : 0), 0);
  const pitStep = 12000 + tableBytes > PAYLOAD_SIZE_LIMIT ? PIT_TABLE_STEP_COARSE : PIT_TABLE_STEP;
  let next = 1;
  pending.forEach((x, i) => {
    let n = given[i];
    if (n === null) {
      while (used.has(next)) next++;
      n = next;
      used.add(n);
      if (wanted[i] !== null) warnings.push(`${x.ed.project.name} · ${x.c.sensor.tag}: number ${wanted[i]} is already used, so it is ${n} here.`);
    }
    const { ed, c } = x;
    const g = c.geom;
    const s = c.sensor;
    const { A, B } = distanceFormula(c, ed);
    const geo = tankGeometry(ed, pitStep);
    if (geo.why) warnings.push(`${ed.project.name}: the volume comes from a level → volume table in the script because ${geo.why}.`);
    const manhole = manholeLit(g);
    const sensorHeight = manhole ? n2(MANHOLE_HEIGHT_PARTS.reduce((sum, k) => sum + (manhole[k] as number), 0)) : n2(g.faceHeightUntilted);
    entries.push({
      number: n,
      name: x.many ? `${ed.project.name} ${s.tag}` : ed.project.name,
      tankIndex: x.ti,
      tankName: ed.project.name,
      sensorId: s.id,
      tag: s.tag,
      kind: SENSOR_KINDS[s.kind].short,
      sensorHeight,
      manhole,
      levelOffset: n2(A - sensorHeight),
      distanceScale: Math.abs(B + 1) < 1e-9 ? 1 : Number((-B).toPrecision(10)),
      blindZone: Math.round(s.deadBand),
      maxRange: Math.round(s.maxRange),
      shape: geo.shape,
      geometry: geo.fields,
      capacity: ed.d.totalL,
      depth: ed.d.depth,
      conv: c,
      ed,
    });
  });
  entries.sort((a, b) => a.number - b.number);

  const out: CsDevice[] = [];
  const seen = new Map<string, number>();
  // A device without a number takes the next sensor that has no device yet.
  const taken = new Set(devices.map((d) => d.number).filter(validNumber));
  const free = () => entries.find((e) => !taken.has(e.number))?.number ?? entries[0]?.number ?? null;
  for (const d of devices) {
    const address = cleanAddress(d.address);
    if (!address) continue;
    const kind = familyOfAddress(address);
    if (kind !== null && kind !== family) {
      warnings.push(
        kind === 'tcp'
          ? `${address} is an IMEI (SIM card sensor over TCP): it belongs in the TCP model, not in this LoRaWAN one. Switch the sensor family to make that model.`
          : `${address} is a DevEUI (LoRaWAN sensor): it belongs in the LoRaWAN model, not in this TCP one. Switch the sensor family to make that model.`,
      );
      continue;
    }
    let number = validNumber(d.number) ? d.number : null;
    if (number === null) {
      number = free();
      if (number === null) continue;
      taken.add(number);
      warnings.push(`${address} has no sensor number, so it is number ${number} here.`);
    }
    if (!entries.some((e) => e.number === number)) {
      warnings.push(`${address}: there is no sensor number ${number} on the site; it is left out.`);
      continue;
    }
    if (seen.has(address)) {
      warnings.push(`${address} is listed twice; it stays with number ${seen.get(address)}.`);
      continue;
    }
    if (kind === null) warnings.push(`${address} is ${address.length} characters. A DevEUI has 16 hexadecimal characters, an IMEI 15 digits.`);
    seen.set(address, number);
    out.push({ address, number });
  }
  for (const e of entries) if (!out.some((d) => d.number === e.number)) warnings.push(`${e.name} (number ${e.number}): no ${family === 'tcp' ? 'IMEI' : 'DevEUI'} yet.`);
  const ids = { ...DEFAULT_VAR_IDS, ...varIds };
  return { family, entries, devices: out, warnings, varIds: { mm: ids.mm ?? 0, '%': ids['%'] ?? 0, L: ids.L ?? 0 } };
}

// ---------------------------------------------------------------------------
// Script text

function wrapList(items: string[], indent: string, perLine: number): string {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) lines.push(indent + items.slice(i, i + perLine).join(', '));
  return lines.join(',\n');
}

/** A value as ES5 source; short objects stay on one line, lists wrap. */
function lit(v: Lit, indent: string): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'string') return q(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => lit(x, indent + '  '));
    const nested = v.some((x) => Array.isArray(x));
    return items.length > 10 ? `[\n${wrapList(items, indent + '  ', nested ? 6 : 10)}\n${indent}]` : `[${items.join(', ')}]`;
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  return `{ ${keys.map((k) => `${k}: ${lit(v[k] as Lit, indent)}`).join(', ')} }`;
}

/** Drops blank runs, trailing spaces and any comment lines. */
function tidy(out: string[]): string {
  const lines = out
    .join('\n')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'));
  const kept: string[] = [];
  for (const l of lines) {
    const blank = l.trim() === '';
    if (blank && (!kept.length || kept[kept.length - 1] === '')) continue;
    kept.push(blank ? '' : l.replace(/\s+$/, ''));
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n') + '\n';
}

/** What differs between the two device models in the configuration script. */
const FAMILY_TEXT: Record<CsFamily, { label: string; normalise: string; bad: string; badEn: string; badEs: string; missingEn: string; missingEs: string }> = {
  lorawan: {
    label: 'DevEUI',
    normalise: 'return String(address).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();',
    bad: 'clean.length != 16',
    badEn: 'The DevEUI must be 16 hexadecimal characters',
    badEs: 'El DevEUI debe tener 16 caracteres hexadecimales',
    missingEn: 'This DevEUI is not in DEVICE_TANKS. Add it to the configuration script first.',
    missingEs: 'Este DevEUI no está en DEVICE_TANKS. Agréguelo primero al script de configuración.',
  },
  tcp: {
    label: 'IMEI',
    normalise: 'return String(address).replace(/[^0-9]/g, "");',
    bad: 'clean.length != 15',
    badEn: 'The IMEI must be 15 digits',
    badEs: 'El IMEI debe tener 15 dígitos',
    missingEn: 'This IMEI is not in DEVICE_TANKS. Add it to the configuration script first.',
    missingEs: 'Este IMEI no está en DEVICE_TANKS. Agréguelo primero al script de configuración.',
  },
};

export function cloudStudioConfig(m: CsModel): string {
  const out: string[] = [];
  const id = (u: string) => m.varIds[u] ?? 0;
  const F = FAMILY_TEXT[m.family];
  out.push(`var MM_VARIABLE_ID      = ${id('mm')};`, `var PERCENT_VARIABLE_ID = ${id('%')};`, `var LITRES_VARIABLE_ID  = ${id('L')};`, '');
  if (m.devices.length) {
    out.push('var DEVICE_TANKS = {');
    m.devices.forEach((d, i) => out.push(`  ${q(d.address)}: ${d.number}${i < m.devices.length - 1 ? ',' : ''}`));
    out.push('};', '');
  } else out.push('var DEVICE_TANKS = {', '};', '');
  out.push('function normaliseAddress(address)', '{', `  ${F.normalise}`, '}', '');
  out.push('function getConfiguration(config)', '{', `  config.addressLabel = { en: ${q(F.label)}, es: ${q(F.label)} };`, '}', '');
  out.push(
    'function getEndpoints(deviceAddress, endpoints)',
    '{',
    '  var distance = endpoints.addEndpoint("1", "Distance", endpointType.genericSensor);',
    '  distance.variableTypeId = MM_VARIABLE_ID;',
    '',
    '  endpoints.addEndpoint("2", "Temperature", endpointType.temperatureSensor);',
    '',
    '  var tankNumber = DEVICE_TANKS[normaliseAddress(deviceAddress)];',
    '  if (!tankNumber)',
    '    return;',
    '',
    '  var prefix = String(tankNumber);',
    '',
    '  var level = endpoints.addEndpoint(prefix + "1", "Liquid level", endpointType.genericSensor);',
    '  level.variableTypeId = MM_VARIABLE_ID;',
    '',
    '  if (PERCENT_VARIABLE_ID > 0) {',
    '    var percent = endpoints.addEndpoint(prefix + "2", "Fill level", endpointType.genericSensor);',
    '    percent.variableTypeId = PERCENT_VARIABLE_ID;',
    '  }',
    '',
    '  if (LITRES_VARIABLE_ID > 0) {',
    '    var volume = endpoints.addEndpoint(prefix + "3", "Volume", endpointType.genericSensor);',
    '    volume.variableTypeId = LITRES_VARIABLE_ID;',
    '  }',
    '}',
    '',
  );
  out.push(
    'function validateDeviceAddress(address, result)',
    '{',
    '  var clean = normaliseAddress(address);',
    '',
    `  if (${F.bad}) {`,
    '    result.ok = false;',
    '    result.errorMessage = {',
    `      en: ${q(F.badEn)},`,
    `      es: ${q(F.badEs)}`,
    '    };',
    '    return;',
    '  }',
    '',
    '  if (!DEVICE_TANKS[clean]) {',
    '    result.ok = false;',
    '    result.errorMessage = {',
    `      en: ${q(F.missingEn)},`,
    `      es: ${q(F.missingEs)}`,
    '    };',
    '  }',
    '}',
    '',
  );
  out.push('function updateDeviceUIRules(device, rules)', '{', '  rules.canCreateEndpoints = false;', '}', '');
  out.push('function updateEndpointUIRules(endpoint, rules)', '{', '  rules.canDelete = true;', '}');
  return tidy(out);
}

/**
 * One TANKS entry, grouped like the customer scripts: sensor, tank sizes, sensor height.
 * A sensor on a manhole has the manhole's own sizes in place of a fixed sensor height.
 */
function entrySource(e: CsEntry, last: boolean): string[] {
  const out: string[] = [`  ${e.number}: {`];
  const groups: [string, Lit][][] = [
    [
      ['name', e.name],
      ['sensor', `${e.kind} ${e.tag}`],
      ['blindZone', e.blindZone],
      ['maxRange', e.maxRange],
    ],
    e.geometry,
    ...(e.manhole ? [[['manhole', e.manhole]] as [string, Lit][]] : []),
    [
      ...(e.manhole ? [] : ([['sensorHeight', e.sensorHeight]] as [string, Lit][])),
      ['levelOffset', e.levelOffset],
      ...(e.distanceScale !== 1 ? ([['distanceScale', e.distanceScale]] as [string, Lit][]) : []),
    ],
  ];
  groups.forEach((g, gi) => {
    g.forEach(([k, v], i) => {
      const comma = gi === groups.length - 1 && i === g.length - 1 ? '' : ',';
      if (k === 'manhole' && typeof v === 'object' && !Array.isArray(v)) {
        // One size per line: this block is the one a fitter checks against the manhole.
        const keys = Object.keys(v).filter((x) => v[x] !== undefined);
        out.push('    manhole: {', ...keys.map((x, j) => `      ${x}: ${lit(v[x] as Lit, '      ')}${j < keys.length - 1 ? ',' : ''}`), `    }${comma}`);
      } else out.push(`    ${k}: ${lit(v, '    ')}${comma}`);
    });
    if (gi < groups.length - 1) out.push('');
  });
  out.push(`  }${last ? '' : ','}`);
  if (!last) out.push('');
  return out;
}

// Volume code, in pieces: a script only carries the functions of the shapes it holds.

const HEAD_CODE = `function simpson(f, a, b, n)
{
  if (b <= a)
    return 0;
  var h = (b - a) / n;
  var s = f(a) + f(b);
  for (var i = 1; i < n; i++)
    s += f(a + i * h) * ((i % 2) ? 4 : 2);
  return s * h / 3;
}

function headBreak(head)
{
  if (head.shape == "torispherical") {
    var tc = head.depth - head.crownRadius;
    return -tc * head.knuckleRadius / (head.crownRadius - head.knuckleRadius);
  }
  if (head.shape == "toricone")
    return head.knuckleRadius * Math.cos(head.angle * Math.PI / 180);
  return 0;
}

function headRadius(head, R, t)
{
  var d = head.depth;
  if (t <= 0 || d <= 0)
    return R;
  if (t > d)
    t = d;
  var s = head.shape;
  if (s == "hemispherical" || s == "ellipsoidal")
    return R * Math.sqrt(Math.max(0, 1 - (t / d) * (t / d)));
  if (s == "paraboloid")
    return R * Math.sqrt(Math.max(0, 1 - t / d));
  if (s == "dished") {
    var y = t + head.crownRadius - d;
    return Math.sqrt(Math.max(0, head.crownRadius * head.crownRadius - y * y));
  }
  if (s == "torispherical") {
    var rk = head.knuckleRadius;
    if (t <= headBreak(head))
      return R - rk + Math.sqrt(Math.max(0, rk * rk - t * t));
    var yc = t - (d - head.crownRadius);
    return Math.sqrt(Math.max(0, head.crownRadius * head.crownRadius - yc * yc));
  }
  if (s == "flanged") {
    var kf = head.knuckleRadius;
    return R - kf + Math.sqrt(Math.max(0, kf * kf - t * t));
  }
  if (s == "cone")
    return R - (R - head.outletDiameter / 2) * t / d;
  if (s == "toricone") {
    var a = head.angle * Math.PI / 180;
    var kc = head.knuckleRadius;
    var tK = kc * Math.cos(a);
    if (t <= tK)
      return R - kc + Math.sqrt(Math.max(0, kc * kc - t * t));
    return Math.max(head.outletDiameter / 2, R - kc * (1 - Math.sin(a)) - (t - tK) * Math.cos(a) / Math.sin(a));
  }
  return R;
}

function headIntegral(head, f, from, to, n)
{
  var b = headBreak(head);
  if (b > from && b < to)
    return simpson(f, from, b, n) + simpson(f, b, to, n);
  return simpson(f, from, to, n);
}
`;

const SEGMENT_CODE = `function segmentArea(r, y)
{
  if (y <= 0 || r <= 0)
    return 0;
  if (y >= 2 * r)
    return Math.PI * r * r;
  var c = r - y;
  return r * r * Math.acos(c / r) - c * Math.sqrt(Math.max(0, 2 * r * y - y * y));
}
`;

const TABLE_CODE = `function tableVolume(tank, level)
{
  var xs = tank.level, ys = tank.litres, n = xs.length;
  if (level >= xs[n - 1])
    return ys[n - 1] * 1000000;
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (xs[mid] <= level) lo = mid;
    else hi = mid;
  }
  return (ys[lo] + (ys[hi] - ys[lo]) * (level - xs[lo]) / (xs[hi] - xs[lo])) * 1000000;
}
`;

const PIT_CODE = `function pitVolume(tank, level)
{
  var t = tank.table;
  if (level <= t[0][0])
    return t[0][1];
  for (var i = 1; i < t.length; i++) {
    if (level <= t[i][0]) {
      var a = t[i - 1], b = t[i];
      return a[1] + (b[1] - a[1]) * (level - a[0]) / (b[0] - a[0]);
    }
  }
  return t[t.length - 1][1];
}
`;

/**
 * Sensors on a manhole: the sensor height from the manhole's parts, and the liquid that
 * stands in the neck above the inside roof, with the opening's own area. The neck runs
 * from the inside roof under the manhole centre to the underside of the cover.
 */
const MANHOLE_CODE = `function manholeArea(m)
{
  if (m.shape == "round")
    return Math.PI * m.insideDiameter * m.insideDiameter / 4;
  return m.insideWidth * m.insideLength;
}

function sensorHeight(tank)
{
  var m = tank.manhole;
  if (m == null)
    return tank.sensorHeight;
  return ${MANHOLE_HEIGHT_PARTS.map((k) => `m.${k}`).join(' + ')};
}

function neckTop(tank)
{
  var m = tank.manhole;
  if (m == null)
    return 0;
  var c = Math.cos((m.tilt || 0) * Math.PI / 180);
  return m.roofHeight + Math.max(0, m.roofThickness + m.neckHeight - m.coverThickness) * c;
}

function neckVolume(tank, level)
{
  var m = tank.manhole;
  if (m == null)
    return 0;
  var rise = Math.min(level, neckTop(tank)) - m.roofHeight;
  if (rise <= 0)
    return 0;
  return manholeArea(m) * rise / Math.cos((m.tilt || 0) * Math.PI / 180);
}
`;

/** Shapes the payload script can hold, in the order their branches are written. */
const SHAPES = ['standing cylinder', 'lying cylinder', 'sphere', 'standing box', 'lying box', 'table', 'concretePit'] as const;
type Shape = (typeof SHAPES)[number];

const GEOMETRY_BRANCH: Record<Shape, string[]> = {
  'standing cylinder': ['    g.R = tank.insideDiameter / 2;', '    g.maxLevel = tank.bottom.depth + tank.shellHeight + tank.top.depth;'],
  'lying cylinder': ['    g.R = tank.insideDiameter / 2;', '    g.maxLevel = tank.insideDiameter;'],
  sphere: ['    g.R = tank.insideDiameter / 2;', '    g.maxLevel = tank.insideDiameter;'],
  'standing box': ['    g.maxLevel = tank.shellHeight;'],
  'lying box': ['    g.maxLevel = tank.insideHeight;'],
  table: ['    g.maxLevel = tank.level[tank.level.length - 1];'],
  concretePit: ['    g.maxLevel = tank.maxLevel;'],
};

const VOLUME_BRANCH: Record<Shape, string[]> = {
  'standing cylinder': [
    '  if (tank.shape == "standing cylinder") {',
    '    var hb = tank.bottom.depth;',
    '    var area = function (t) { var r = headRadius(tank.bottom, R, t); return Math.PI * r * r; };',
    '    var v = headIntegral(tank.bottom, area, Math.max(0, hb - level), hb, 64);',
    '    v += Math.PI * R * R * Math.max(0, Math.min(level - hb, tank.shellHeight));',
    '    var up = level - hb - tank.shellHeight;',
    '    if (up > 0) {',
    '      var areaTop = function (t) { var r = headRadius(tank.top, R, t); return Math.PI * r * r; };',
    '      v += headIntegral(tank.top, areaTop, 0, Math.min(up, tank.top.depth), 64);',
    '    }',
    '    return v;',
    '  }',
  ],
  'lying cylinder': [
    '  if (tank.shape == "lying cylinder") {',
    '    var vl = tank.shellLength * segmentArea(R, level);',
    '    var ends = [tank.leftEnd, tank.rightEnd];',
    '    for (var i = 0; i < 2; i++) {',
    '      var head = ends[i];',
    '      if (head.depth <= 0)',
    '        continue;',
    '      var slice = function (t) { var r = headRadius(head, R, t); return segmentArea(r, level - (R - r)); };',
    '      vl += headIntegral(head, slice, 0, head.depth, 400);',
    '    }',
    '    return vl;',
    '  }',
  ],
  sphere: ['  if (tank.shape == "sphere")', '    return Math.PI * level * level * (3 * R - level) / 3;'],
  'standing box': [
    '  if (tank.shape == "standing box") {',
    '    var c = tank.cornerRadius || 0;',
    '    return (tank.insideWidth * tank.insideDepth - (4 - Math.PI) * c * c) * level;',
    '  }',
  ],
  'lying box': ['  if (tank.shape == "lying box")', '    return tank.insideWidth * tank.shellLength * level;'],
  table: ['  if (tank.shape == "table")', '    return tableVolume(tank, level);'],
  concretePit: ['  if (tank.shape == "concretePit")', '    return pitVolume(tank, level) * 1000000;'],
};

/**
 * The volume functions for the shapes in the script: liquidVolume works in mm³ for every shape.
 * With manholes, the highest level a tank can show (topLevel) is the underside of the cover
 * when that is above the tank's own top.
 */
export function volumeCode(used: Set<string>, manholes = false): string {
  const shapes = SHAPES.filter((s) => used.has(s));
  const out: string[] = [];
  const cylinders = shapes.includes('standing cylinder') || shapes.includes('lying cylinder');
  if (cylinders) out.push(HEAD_CODE);
  if (shapes.includes('lying cylinder')) out.push(SEGMENT_CODE);
  if (shapes.includes('table')) out.push(TABLE_CODE);
  if (shapes.includes('concretePit')) out.push(PIT_CODE);
  const usesR = cylinders || shapes.includes('sphere');
  out.push('function tankGeometry(tank)', '{', '  if (tank._geo)', '    return tank._geo;', `  var g = { maxLevel: 0${usesR ? ', R: 0' : ''} };`);
  shapes.forEach((s, i) => {
    const body = GEOMETRY_BRANCH[s];
    const cond = `${i === 0 ? '  if' : '  else if'} (tank.shape == ${q(s)})`;
    if (body.length === 1) out.push(cond, body[0]);
    else out.push(`${cond} {`, ...body, '  }');
  });
  out.push('  tank._geo = g;', '  g.fullLitres = liquidVolume(tank, g.maxLevel) / 1000000;');
  if (manholes) out.push('  g.topLevel = Math.max(g.maxLevel, neckTop(tank));');
  out.push('  return g;', '}', '');
  out.push('function liquidVolume(tank, level)', '{', '  var g = tankGeometry(tank);', '  if (level <= 0)', '    return 0;', '  if (level > g.maxLevel)', '    level = g.maxLevel;');
  if (usesR) out.push('  var R = g.R;');
  out.push('');
  shapes.forEach((s) => out.push(...VOLUME_BRANCH[s], ''));
  out.push('  return 0;', '}');
  return out.join('\n');
}

export function cloudStudioPayload(m: CsModel): string {
  const out: string[] = [];
  out.push('var TANKS = {');
  m.entries.forEach((e, i) => out.push(...entrySource(e, i === m.entries.length - 1)));
  out.push('};', '');
  out.push('var SHOW_ALL_READINGS = true;', 'var LOG = true;', '');
  out.push('function log(message)', '{', '  if (LOG)', '    env.log(message);', '}', '');
  out.push('function updateEndpoint(device, address, value)', '{', '  var ep = device.endpoints.byAddress(address);', '  if (ep != null)', '    ep.updateGenericSensorStatus(value);', '}', '');
  out.push('function updateTemperature(device, value)', '{', '  var ep = device.endpoints.byAddress("2");', '  if (ep != null)', '    ep.updateTemperatureSensorStatus(value);', '}', '');
  out.push(
    'function findTank(device)',
    '{',
    '  for (var id in TANKS) {',
    '    if (device.endpoints.byAddress(String(id) + "1") != null)',
    '      return { id: String(id), tank: TANKS[id] };',
    '  }',
    '  return null;',
    '}',
    '',
  );
  const used = new Set(m.entries.map((e) => e.shape));
  if (!used.size) used.add('standing cylinder');
  const manholes = m.entries.some((e) => e.manhole);
  if (manholes) out.push(MANHOLE_CODE);
  out.push(volumeCode(used, manholes), '');
  out.push(decoderSource(m.family));
  out.push(
    'function invalidReason(tank, distance, invalid)',
    '{',
    '  if (invalid != null)',
    '    return invalid;',
    '  if (distance <= 0)',
    '    return "0 = no reading";',
    '  if (tank.blindZone && distance <= tank.blindZone)',
    '    return tank.blindZone + " mm or less = sensor blind zone / invalid reading";',
    '  if (tank.maxRange && distance > tank.maxRange)',
    '    return "above " + tank.maxRange + " mm = outside sensor range";',
    '  return null;',
    '}',
    '',
  );
  out.push(
    'function parseUplink(device, payload)',
    '{',
    '  var found = findTank(device);',
    '  var r = decodeReading(payload);',
    '  var text = r.model + ", ";',
    '',
    '  if (r.battery != null) {',
    '    device.updateDeviceBattery(r.battery);',
    '    text += (r.battery.voltage != null) ? "battery " + r.battery.voltage + " V, " : "battery " + r.battery.percentage + " %, ";',
    '  }',
    '  if (r.temperature != null)',
    '    updateTemperature(device, r.temperature);',
    '  if (r.info != null)',
    '    text += r.info + ", ";',
    '',
    '  var name = (found != null) ? found.tank.name : "Device without tank endpoints";',
    '  if (r.skip != null || r.distance == null) {',
    '    log(name + ": " + text + ((r.skip != null) ? r.skip : "no reading"));',
    '    return;',
    '  }',
    '',
    '  var distance = r.distance;',
    '  if (found == null) {',
    '    updateEndpoint(device, "1", distance);',
    '    log(text + "distance " + distance +',
    '        " mm. No tank endpoints on this device - check DEVICE_TANKS and recreate the device.");',
    '    return;',
    '  }',
    '',
    '  var tank = found.tank;',
    '  var g = tankGeometry(tank);',
    `  var level = ${manholes ? 'sensorHeight(tank)' : 'tank.sensorHeight'} - distance * (tank.distanceScale || 1) + (tank.levelOffset || 0);`,
    '  var reason = invalidReason(tank, distance, r.invalid);',
    '  if (reason == null && level < -100)',
    '    reason = "distance is " + Math.round(-level) + " mm deeper than the floor";',
    '',
    '  if (reason == null || SHOW_ALL_READINGS)',
    '    updateEndpoint(device, "1", distance);',
    '',
    '  if (reason != null) {',
    '    log(tank.name + ": " + text + "distance " + distance +',
    '        " mm is INVALID (" + reason + "). Level not updated.");',
    '    return;',
    '  }',
    '',
    '  if (level < 0) level = 0;',
    ...(manholes
      ? [
          '  if (level > g.topLevel) level = g.topLevel;',
          '',
          '  var neck = neckVolume(tank, level) / 1000000;',
          '  var litres = liquidVolume(tank, level) / 1000000 + neck;',
          '  var percent = (g.fullLitres > 0) ? (litres / g.fullLitres) * 100 : 0;',
          '  if (percent > 100) percent = 100;',
        ]
      : ['  if (level > g.maxLevel) level = g.maxLevel;', '', '  var litres = liquidVolume(tank, level) / 1000000;', '  var percent = (g.fullLitres > 0) ? (litres / g.fullLitres) * 100 : 0;']),
    '',
    '  var levelOut = Math.round(level);',
    '  var percentOut = Math.round(percent * 10) / 10;',
    '  var litresOut = Math.round(litres);',
    '',
    '  updateEndpoint(device, found.id + "1", levelOut);',
    '  updateEndpoint(device, found.id + "2", percentOut);',
    '  updateEndpoint(device, found.id + "3", litresOut);',
    '',
    '  log(tank.name + ": " + text + "distance " + distance +',
    '      " mm, level " + levelOut + " mm, " + percentOut + " %, " + litresOut +',
    ...(manholes
      ? ['      " L of " + Math.round(g.fullLitres) + " L" +', '      ((neck > 0) ? ", " + Math.round(neck) + " L of it in the neck of manhole " + tank.manhole.name : ""));']
      : ['      " L of " + Math.round(g.fullLitres) + " L");']),
    '}',
    '',
  );
  out.push('function buildDownlink(device, endpoint, command, payload)', '{', '  payload.buildResult = downlinkBuildResult.unsupported;', '}');
  return tidy(out);
}
