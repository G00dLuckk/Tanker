import { LIQUIDS, SENSOR_KINDS } from '../core/defaults';
import type { HeadProfile } from '../core/heads';
import { checkValues } from '../core/pit';
import { upOf } from '../core/sensors';
import type { HeadConfig } from '../core/types';
import { MM3_TO_L, plain } from '../core/units';
import type { CsModel } from './cloudstudio';
import { bodyName, endNames } from './context';
import type { ExportData } from './shared';

/**
 * A plain description of every tank of the site, written for an AI assistant (or a
 * person) to understand each tank exactly: its shape and sizes, inside and outside,
 * its ends and walls, the liquid, the sensors and where they sit, the devices, the
 * volume at many levels and how the payload script turns a reading into a volume.
 * Markdown, lengths in mm, volumes in litres.
 */

const mm = (v: number) => `${plain(v, 1)} mm`;
const litres = (v: number) => `${plain(v, 1)} L`;
const pct = (v: number) => `${plain(v, 1)} %`;

const BODY_SIZE_BY: Record<string, string> = { size: 'diameter / width', perimeter: 'circumference (a tape around the shell)' };

/** The ways a head's size can be given, in words. */
function headInput(cfg: HeadConfig, h: HeadProfile, outside: boolean): string {
  const side = outside ? 'outside' : 'inside';
  switch (h.type) {
    case 'flat':
      return 'flat plate';
    case 'hemi':
      return 'half sphere on the shell';
    case 'ellipsoidal':
      return cfg.ratioBy === 'arc'
        ? `sized by the arc over it: ${mm(cfg.arc)} (${side})`
        : cfg.ratioBy === 'depth'
          ? `sized by its depth: ${mm(cfg.depth)} (${side})`
          : `ratio ${plain(cfg.ellipseRatio, 2)}:1 (radius : depth)`;
    case 'dished':
      return cfg.dishBy === 'arc'
        ? `sized by the arc over it: ${mm(cfg.arc)} (${side}, wall to wall)`
        : cfg.dishBy === 'radius'
          ? `sized by its dish radius: ${mm(cfg.dishRadius)}`
          : `sized by its depth: ${mm(cfg.depth)} (${side})`;
    case 'torispherical':
      return cfg.tori === 'measured' ? `measured sizes (${cfg.toriBy})` : cfg.tori === 'custom' ? `custom radii: crown ${plain(cfg.crown, 3)} × D, knuckle ${plain(cfg.knuckle, 3)} × D` : 'standard radii';
    case 'cone':
    case 'wedge':
    case 'sloped':
    case 'toricone':
      return cfg.sizeBy === 'angle' ? `sized by its wall angle: ${plain(cfg.angle, 2)}° from the end plane` : `sized by its depth: ${mm(cfg.depth)} (${side})`;
    default:
      return `depth ${mm(cfg.depth)} (${side})`;
  }
}

function headLines(name: string, h: HeadProfile, cfg: HeadConfig, wall: number, outside: boolean): string[] {
  const how = h.type === 'flat' ? '' : ` ${headInput(cfg, h, outside).replace(/^./, (c) => c.toUpperCase())}.`;
  const out = [`- **${name}:** ${h.meta.label}.${how}`];
  const parts: string[] = [`inside depth ${mm(h.depth)}`, `plate ${mm(wall)}`];
  if (h.meta.crownR) parts.push(`crown (dish) radius ${mm(h.meta.crownR)}`);
  if (h.meta.sphereR) parts.push(`sphere radius ${mm(h.meta.sphereR)}`);
  if (h.meta.knuckleR) parts.push(`knuckle radius ${mm(h.meta.knuckleR)}`);
  if (h.meta.angle !== undefined) parts.push(`wall angle ${plain(h.meta.angle, 2)}° from the end plane`);
  if (h.meta.outletU !== undefined && h.meta.outletU > 0) parts.push(`outlet ${mm(h.meta.outletU)}${h.meta.outletV && Math.abs(h.meta.outletV - h.meta.outletU) > 0.5 ? ` × ${mm(h.meta.outletV)}` : ''}`);
  if (h.meta.arc) parts.push(`inside arc over it ${mm(h.meta.arc)}`);
  if (cfg.eccentric && (h.type === 'cone' || h.type === 'sloped')) parts.push('one side straight (eccentric)');
  out.push(`  - ${parts.join(', ')}.`);
  if (h.meta.issue) out.push(`  - Note: ${h.meta.issue}`);
  return out;
}

function shellLines(ed: ExportData): string[] {
  const p = ed.project;
  const t = p.tank;
  const b = t.body;
  const m = ed.d.model;
  const vertical = t.orientation === 'vertical';
  const out: string[] = [];
  const typed: string[] = [];
  if (b.type === 'cylinder' || b.type === 'sphere') typed.push(b.sizeBy === 'perimeter' ? `circumference ${mm(b.perimeter)}` : `diameter ${mm(b.diameter)}`);
  else {
    if (b.sizeBy === 'perimeter') typed.push(`circumference ${mm(b.perimeter)}`);
    else typed.push(`width ${mm(b.width)}`, `${vertical ? 'depth (front to back)' : 'height'} ${mm(b.depth)}`);
  }
  if (b.type === 'rect' && b.corner > 0) typed.push(`corner radius ${mm(b.corner)}`);
  if (b.type === 'trapezoid') typed.push(`${vertical ? 'front' : 'bottom'} width ${mm(b.width2)}`);
  if (b.type === 'chamfer') typed.push(`corner cut ${mm(b.chamfer)}`);
  if (b.type === 'polygon') typed.push(`${b.sides} sides`);
  if (b.type === 'boxoval') typed.push(`squareness ${plain(b.squareness, 2)}`);
  if (b.type !== 'sphere') typed.push(b.lengthBy === 'overall' ? `overall ${vertical ? 'height' : 'length'} ${mm(b.overall)} (end to end)` : `straight shell ${vertical ? 'height' : 'length'} ${mm(b.length)}`);
  out.push(`- **Shell:** ${bodyName(p, m)}. Typed (${t.basis} sizes, ${BODY_SIZE_BY[b.sizeBy] ?? 'size'}): ${typed.join(', ')}. Wall ${mm(m.t.shell)}.`);
  if (m.profile) out.push(`  - The shell changes size along its ${vertical ? 'height' : 'length'}: ${m.profile.map((pt) => `${plain(2 * m.base.A * pt.k, 1)} mm at ${plain(pt.a, 1)} mm`).join(', ')} (inside widths from the ${vertical ? 'bottom' : 'left end'} of the shell).`);
  else if (Math.abs(m.endScale - 1) > 1e-9) out.push(`  - Tapered: the ${vertical ? 'top' : 'right end'} of the shell is ${plain(m.endScale, 4)} times the size of the ${vertical ? 'bottom' : 'left end'}.`);
  return out;
}

/** The plan, walls and floor of a concrete storage in words. */
function pitLines(ed: ExportData): string[] {
  const d = ed.d;
  if (d.kind !== 'pit') return [];
  const pit = d.pit;
  const c = pit.cfg;
  const out: string[] = [];
  const corners = pit.outline.map((q, i) => `${i + 1} (${plain(q.x, 1)}, ${plain(q.y, 1)})`).join(', ');
  out.push(`- **Plan (inner wall faces):** ${pit.outline.length} corners, X and Y in mm seen from above: ${corners}. Plan area ${plain(pit.area / 1e6, 3)} m².`);
  const ref = c.heightRef === 'floorHigh' ? 'the highest point of the floor (shallow end)' : c.heightRef === 'floorLow' ? 'the lowest point of the main floor' : 'the deepest point';
  out.push(`- **Heights on the drawing** are measured from ${ref}, which is ${mm(pit.refZ)} above level zero (the deepest point of the floor, sumps included). The scripts and every level below use level zero.`);
  out.push(`- **Wall top:** ${mm(c.wallHeight)} on the drawing = ${mm(pit.wallTop)} above level zero. ${c.batter > 0 ? `The inner faces lean outward ${plain(c.batter, 1)} mm per metre of height.` : 'The inner faces are vertical.'}`);
  if (c.floor.type === 'plane') out.push(`- **Floor:** one plane, rising ${mm(c.floor.drop)} along the direction ${plain(c.floor.direction, 1)}° in the plan (0° = +X, 90° = +Y): from ${mm(pit.floorLow)} to ${mm(pit.floorHigh)} above level zero.`);
  else if (c.floor.type === 'vertices') out.push(`- **Floor:** given at each corner and interpolated between them: ${pit.vertexZ.map((z, i) => `corner ${i + 1} ${mm(z)}`).join(', ')} above level zero.`);
  else out.push(`- **Floor:** flat, ${mm(pit.floorLow)} above level zero${pit.sumps.length ? ' (the sumps go deeper)' : ''}.`);
  for (const s of pit.sumps) {
    const cs = s.cfg;
    const where = cs.outline ? `${s.outline.length}-corner outline ${s.outline.map((q) => `(${plain(q.x, 1)}, ${plain(q.y, 1)})`).join(', ')}` : `${mm(cs.width)} × ${mm(cs.length)} centred at X ${plain(cs.x, 1)}, Y ${plain(cs.y, 1)}`;
    out.push(`- **Sump:** ${where}, ${mm(cs.depth)} deep: bottom at ${mm(s.bottom)}, floor around it at ${mm(s.rim)} above level zero.`);
  }
  out.push(`- **Concrete (drawing only, not in the volume):** wall ${mm(c.wallTop)} wide at the top, ${mm(c.wallBase)} at the base, floor slab ${mm(c.slab)}.`);
  const marks: string[] = [];
  if (c.operationLevel != null) marks.push(`operation level ${mm(c.operationLevel)} on the drawing = ${mm(pit.toDatum(c.operationLevel))} above level zero`);
  if (c.alarmHigh != null) marks.push(`high alarm ${mm(c.alarmHigh)} = ${mm(pit.toDatum(c.alarmHigh))}`);
  if (c.alarmLow != null) marks.push(`low alarm ${mm(c.alarmLow)} = ${mm(pit.toDatum(c.alarmLow))}`);
  if (marks.length) out.push(`- **Levels on the drawing:** ${marks.join('; ')}.`);
  const checks = checkValues(d.engine);
  for (const r of checks) {
    out.push(
      `- **Drawing check:** ${litres(r.check.litres)} at ${mm(r.check.level)} on the drawing (${mm(r.level)} above level zero); the design gives ${litres(r.litres)}${Number.isFinite(r.errorPct) ? ` (${r.errorPct > 0 ? '+' : ''}${plain(r.errorPct, 2)} %${r.ok ? '' : ', more than 0.5 % off'})` : ''}.`,
    );
  }
  out.push(`- The volume curve is computed numerically over the plan on a grid ${d.engine.cellsAcross} cells across; the payload script carries it as a level → litres table.`);
  for (const w of pit.warnings) out.push(`- Note: ${w}`);
  for (const pr of pit.problems) out.push(`- Problem: ${pr}`);
  return out;
}

function tankSection(ed: ExportData, index: number, model: CsModel): string[] {
  const p = ed.project;
  const d = ed.d;
  const m = d.model;
  const vertical = p.tank.orientation === 'vertical';
  const n = endNames(p);
  const outside = p.tank.basis === 'outside';
  const out: string[] = [];
  out.push(`## Tank ${index + 1}: ${p.name}`, '');
  if (d.kind === 'pit') {
    out.push(`${bodyName(p, m)}. Holds ${litres(d.totalL)} when full; the liquid is ${mm(d.depth)} deep at full. Full means up to the wall top, and the depth is measured at the deepest point of the floor.`, '');
    out.push('### Plan, walls and floor', '');
    out.push(...pitLines(ed));
    out.push('');
  } else {
    const ends = m.bodyType === 'sphere' ? '' : `, ${n.start.toLowerCase()}: ${m.start.meta.label.toLowerCase()}, ${n.end.toLowerCase()}: ${m.end.meta.label.toLowerCase()}`;
    out.push(
      `${bodyName(p, m)}${ends}. ${vertical ? 'Standing upright' : 'Lying on its side'}${d.tilt ? `, tilted ${plain(d.tilt, 2)}° (${vertical ? 'the top leans toward +X' : 'the right end is raised'})` : ''}. Holds ${litres(d.totalL)} when full; the liquid is ${mm(d.depth)} deep at full.`,
      '',
    );
    out.push('### Shape and sizes', '');
    out.push(...shellLines(ed));
    if (m.bodyType !== 'sphere') {
      out.push(...headLines(n.startLong, m.start, p.tank.start, m.t.start, outside));
      out.push(...headLines(n.endLong, m.end, p.tank.end, m.t.end, outside));
    }
    const dims = (o: { width: number; depth: number; length: number }) =>
      vertical ? `${mm(o.width)} wide × ${mm(o.depth)} front to back × ${mm(o.length)} high` : `${mm(o.length)} long × ${mm(o.width)} wide × ${mm(o.depth)} high`;
    out.push(`- **Inside:** ${dims(m.innerDims)}${m.bodyType !== 'sphere' ? `; straight shell ${mm(m.L)} between the ends` : ''}.`);
    out.push(`- **Outside:** ${dims(m.outer)}.`);
    if (m.bodyType === 'cylinder' || m.bodyType === 'sphere') out.push(`- **Inside diameter:** ${mm(2 * m.base.A)}; outside circumference ${mm(Math.PI * m.outer.width)}.`);
    for (const w of m.warnings) out.push(`- Note: ${w}`);
    for (const pr of m.problems) out.push(`- Problem: ${pr}`);
    out.push('');
  }

  out.push('### Liquid and levels', '');
  const liquid = LIQUIDS.find((x) => x.id === p.liquid.preset);
  out.push(`- **Liquid:** ${liquid && liquid.id !== 'custom' ? liquid.label : 'custom liquid'}, density ${plain(d.density, 1)} kg/m³.`);
  out.push(d.kind === 'pit' ? '- **Level zero** is the deepest point of the floor (the bottom of the deepest sump); levels go straight up from there.' : '- **Level zero** is the lowest point inside the tank; levels go straight up from there.');
  if (p.marks.overflow != null) out.push(`- **Overflow / maximum fill:** level ${mm(p.marks.overflow)} = ${litres(d.engine.litres(Math.min(p.marks.overflow, d.depth)))}.`);
  if (p.marks.outlet != null) out.push(`- **Outlet:** level ${mm(p.marks.outlet)}; ${litres(d.engine.litres(Math.max(p.marks.outlet, 0)))} below it cannot be drawn off.`);
  out.push('');

  const mhs = d.manholes;
  if (mhs.length) {
    out.push('### Manholes', '');
    for (const g of mhs) {
      const mh = g.manhole;
      const size = mh.shape === 'round' ? `round, ${mm(mh.diameter)} opening` : `rectangular, ${mm(mh.diameter)} × ${mm(mh.length)} opening`;
      const under = d.kind === 'pit' ? 'the wall top (the underside of the slab)' : 'the inside roof under it';
      out.push(
        `- **${mh.tag}** at X ${mm(mh.x)}, Y ${mm(mh.y)}: ${size}, cover plate ${mm(mh.cover)}${
          g.ok
            ? `, top of the cover ${mm(g.coverHeight)} above level zero, ${mm(g.neckHeight)} above ${d.kind === 'pit' ? 'the wall top' : 'the outside roof'}; ${under} is at ${mm(g.roofLevel)}. Liquid above that stands in the neck, up to ${mm(g.neckDepth)} high (${litres((g.area * g.neckDepth) / 1e6)}): the scripts add it for a sensor on this manhole, with the opening's own area`
            : ` (${g.error})`
        }.`,
      );
    }
    out.push('');
  }

  out.push('### Sensors', '');
  out.push(`Positions are seen from above: ${vertical ? 'X left to right and Y front to back, from the middle of the tank' : 'X along the length from the middle, Y across'}.`, '');
  if (!d.geoms.length) out.push('- No sensors.');
  for (const g of d.geoms) {
    const s = g.sensor;
    const kind = SENSOR_KINDS[s.kind].label;
    const entry = model.entries.find((e) => e.tankIndex === index && e.sensorId === s.id);
    const head = `- **${s.tag}** (${kind}${s.enabled ? '' : ', switched off'}) at X ${mm(s.x)}, Y ${mm(s.y)}`;
    if (!g.ok) {
      out.push(`${head}: not placed (${g.error}).`);
      continue;
    }
    const lines: string[] = [];
    if (g.mount === 'top') {
      const pit = d.kind === 'pit';
      const on = s.faceMode === 'manhole' ? `on manhole ${g.manhole?.manhole.tag ?? ''}`.trim() : s.faceMode === 'manual' ? 'with its face height typed' : pit ? 'on a bracket on the wall top' : 'on the roof';
      lines.push(`${head}, ${on}.`);
      const toTop = g.faceLevel - d.depth;
      const top = toTop >= 0 ? `${mm(toTop)} above the ${pit ? 'wall top' : 'inside top'}` : `${mm(-toTop)} below the ${pit ? 'wall top' : 'highest point inside'}`;
      lines.push(`  - Sensor face ${mm(g.faceHeightUntilted)} above ${pit ? 'the deepest point of the floor' : 'the inside floor'} (level zero), ${top}${g.roofOuter && !pit ? `, ${mm(upOf(m, g.face) - upOf(m, g.roofOuter))} above the outside ${s.faceMode === 'manhole' ? 'cover' : 'roof'}` : ''}.`);
      if (g.manhole) {
        const mg = g.manhole;
        lines.push(
          `  - Its height comes from the manhole ${mg.manhole.tag}, not from the ${pit ? 'storage' : 'tank'} size: ${pit ? 'wall top' : 'inside roof under the manhole'} ${mm(mg.roofLevel)}${pit ? '' : ` + roof plate ${mm(mg.roofThickness)}`} + ${pit ? 'cover top above the wall top' : 'neck'} ${mm(mg.neckHeight)} + sensor face ${mm(s.nozzle)} above the cover top. The scripts hold these sizes and add them up.`,
        );
      }
      if (pit) lines.push(`  - The floor under the sensor is ${mm(g.floorLevel)} above level zero, ${mm(g.floorDist)} from the face: that is what the sensor reads when the storage is empty.`);
      lines.push(`  - Measures the distance down to the liquid: blind zone ${mm(s.deadBand)}, range ${mm(s.maxRange)}, beam ${plain(s.beamAngle, 1)}°. It can read levels from ${mm(g.validMin)} to ${mm(g.validMax)}.`);
      lines.push(`  - Level = ${plain(g.faceHeightUntilted, 1)} − distance${entry && entry.levelOffset ? ` + ${plain(entry.levelOffset, 1)} (field calibration)` : ''}${entry && entry.distanceScale !== 1 ? ` (distance × ${plain(entry.distanceScale, 6)})` : ''}. Empty: the sensor reads about ${mm(pit ? g.floorDist : g.faceHeightUntilted)}; full: about ${mm(Math.max(0, g.faceLevel - d.depth))}.`);
    } else if (g.mount === 'bottom') {
      lines.push(`${head}, at the bottom: sensing point ${mm(g.faceHeightUntilted)} above level zero; reads levels from ${mm(g.validMin)} to ${mm(g.validMax)}.`);
    } else {
      lines.push(`${head}: level switch at ${mm(g.faceLevel)} above level zero (${litres(d.engine.litres(g.faceLevel))}), alarm when the liquid is ${s.switchMode === 'high' ? 'at or above' : 'below'} it.`);
    }
    if (s.cal && s.cal.method !== 'theory') lines.push(`  - Field calibration: ${s.cal.method}, ${s.cal.points.length} point${s.cal.points.length === 1 ? '' : 's'} measured as ${s.cal.ref}.`);
    if (entry) {
      const devs = model.devices.filter((x) => x.number === entry.number).map((x) => x.address);
      lines.push(`  - In the scripts: number ${entry.number} (endpoints ${entry.number}1 level, ${entry.number}2 fill %, ${entry.number}3 volume)${devs.length ? `; devices ${devs.join(', ')}` : '; no device yet'}.`);
    } else if (s.enabled) lines.push('  - Not in the scripts (they read distance sensors on the roof).');
    for (const w of g.warnings) lines.push(`  - Note: ${w}`);
    out.push(...lines);
  }
  out.push('');

  out.push('### Volume at each level', '');
  out.push('| Level (mm) | Fill of the height | Volume (L) | Fill of the volume |', '|---:|---:|---:|---:|');
  for (let i = 0; i <= 20; i++) {
    // The volume at the level exactly as printed, so every row is exact as written.
    const level = Math.min(Number(plain((d.depth * i) / 20, 1)), d.depth);
    const v = d.engine.volume(level) * MM3_TO_L;
    out.push(`| ${plain(level, 1)} | ${pct(i * 5)} | ${plain(v, 1)} | ${pct((100 * v) / d.totalL)} |`);
  }
  out.push('');
  const shape = model.entries.find((e) => e.tankIndex === index)?.shape;
  if (shape) {
    out.push(
      shape === 'table'
        ? 'The payload script takes the volume from a level → litres table of this tank (its shape has no simple formula).'
        : shape === 'concretePit'
          ? 'The payload script takes the volume from the level → litres table of this storage (every 10 mm, or 50 mm on a very large site), interpolating between rows.'
          : `The payload script computes the volume from the sizes above as a ${shape}.`,
      '',
    );
  }
  return out;
}

export function siteDetails(tanks: ExportData[], model: CsModel): string {
  const out: string[] = [];
  out.push('# Tank site', '');
  out.push(
    `This describes ${tanks.length === 1 ? 'one tank' : `${tanks.length} tanks`} exactly as they are drawn in Tanker Time, so that anyone (or an AI assistant) can picture each tank, check its sizes and work out levels and volumes. All lengths are in millimetres (mm), volumes in litres (L). "Inside" sizes are the space that holds the liquid; "outside" sizes include the plates. Level zero is the lowest point inside each tank.`,
    '',
  );
  out.push('| # | Tank | Shape | Capacity | Full depth | Sensors (script numbers) |', '|---:|---|---|---:|---:|---|');
  tanks.forEach((ed, i) => {
    const m = ed.d.model;
    const n = endNames(ed.project);
    const shape = ed.d.kind === 'pit' ? bodyName(ed.project, m) : m.bodyType === 'sphere' ? 'Sphere' : `${bodyName(ed.project, m)}, ${n.start.toLowerCase()} ${m.start.meta.label.toLowerCase()}, ${n.end.toLowerCase()} ${m.end.meta.label.toLowerCase()}`;
    const sensors = ed.d.geoms
      .filter((g) => g.sensor.enabled)
      .map((g) => {
        const e = model.entries.find((x) => x.tankIndex === i && x.sensorId === g.sensor.id);
        return `${g.sensor.tag} ${SENSOR_KINDS[g.sensor.kind].short.toLowerCase()}${e ? ` (no. ${e.number})` : ''}`;
      });
    out.push(`| ${i + 1} | ${ed.project.name} | ${shape} | ${plain(ed.d.totalL, 1)} L | ${plain(ed.d.depth, 1)} mm | ${sensors.join(', ') || 'none'} |`);
  });
  out.push('');
  tanks.forEach((ed, i) => out.push(...tankSection(ed, i, model)));

  out.push('## Devices and scripts', '');
  out.push(
    `These scripts are the ${model.family === 'tcp' ? 'TCP (SIM card sensors, by IMEI)' : 'LoRaWAN (by DevEUI)'} device model; a site with both kinds of sensor has one model per kind. Each device is one sensor, found by its number. On the platform a device with number n has the endpoints "1" Distance (the sensor reading, mm), "2" Temperature (°C, when the sensor reports one), n1 Liquid level (mm), n2 Fill level (%) and n3 Volume (L). The payload script computes level = sensorHeight − distance + levelOffset, keeps it between the floor and the top, then the volume from the tank sizes or the storage's table. For a sensor on a manhole the script holds the manhole's own sizes, adds up the sensor height from them (inside roof under the manhole + roof plate + neck + sensor above the cover) and, when the level is above that roof, adds the liquid standing in the neck with the area of the opening, up to the underside of the cover. Readings in the blind zone, past the range, more than 100 mm below the floor, or marked bad by the sensor do not change the level.`,
    '',
  );
  if (model.devices.length) {
    out.push('| Device | Number | Tank and sensor |', '|---|---:|---|');
    for (const dv of model.devices) {
      const e = model.entries.find((x) => x.number === dv.number);
      out.push(`| ${dv.address} (${dv.address.length === 15 ? 'IMEI' : 'DevEUI'}) | ${dv.number} | ${e ? `${e.tankName} · ${e.tag}` : '—'} |`);
    }
  } else out.push('No devices listed yet.');
  out.push('');
  if (model.warnings.length) {
    out.push('## Notes', '');
    for (const w of model.warnings) out.push(`- ${w}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
