import * as THREE from 'three';
import type { PitModel } from '../core/pit';
import { crossings, offset, signedArea, type Pt } from '../core/polygon';
import type { TankGeometry } from './tankGeometry';

/**
 * Render geometry of a concrete storage. Plan X and Y and the height above level
 * zero map to the group's local frame as x = X, y = height, z = −Y (the same proper
 * rotation as a vertical tank), so the cut-away plane z = 0 is the plan line Y = 0.
 *
 * The concrete is one closed solid (outer faces, wall top, inner faces, floor with its
 * sumps, slab bottom); the liquid is the cavity (floor, inner faces, a lid at the wall
 * top) that the viewer clips at the level, like a tank.
 */

type V3 = [number, number, number];

/** Plan point and height → local coordinates. */
function local(x: number, y: number, z: number): V3 {
  return [x, z, -y];
}

class Builder {
  private pos: number[] = [];

  /** A planar polygon, given as plan points with heights, oriented so its normal points along `wanted` (local frame). */
  face(pts: V3[], wanted: V3, tris?: number[]): void {
    if (pts.length < 3) return;
    const l = pts.map((p) => local(p[0], p[1], p[2]));
    const idx = tris ?? fan(l.length);
    // Orientation from the first triangle with a usable normal.
    let flip = false;
    for (let t = 0; t < idx.length; t += 3) {
      const n = normal(l[idx[t]], l[idx[t + 1]], l[idx[t + 2]]);
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-9) continue;
      flip = n[0] * wanted[0] + n[1] * wanted[1] + n[2] * wanted[2] < 0;
      break;
    }
    for (let t = 0; t < idx.length; t += 3) {
      const a = l[idx[t]];
      const b = l[flip ? idx[t + 2] : idx[t + 1]];
      const c = l[flip ? idx[t + 1] : idx[t + 2]];
      this.pos.push(...a, ...b, ...c);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    return g;
  }
}

function fan(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
  return out;
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Outward unit normal (plan) of edge i of a counter-clockwise outline, as a local direction. */
function edgeOut(o: Pt[], i: number): V3 {
  const a = o[i];
  const b = o[(i + 1) % o.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  // Right of the direction of travel: (dy, -dx) in plan → local (dy, 0, dx).
  return [dy / l, 0, dx / l];
}

function ccw(p: Pt[]): Pt[] {
  return signedArea(p) < 0 ? [...p].reverse() : p;
}

/** The main floor triangulated around the sump holes: plan points and index triples. */
function floorMesh(pit: PitModel): { pts: Pt[]; tris: number[] } {
  const contour = ccw(pit.outline).map((q) => new THREE.Vector2(q.x, q.y));
  const holes = pit.sumps.filter((s) => !s.outside).map((s) => ccw(s.outline).map((q) => new THREE.Vector2(q.x, q.y)));
  const pts: Pt[] = [...contour, ...holes.flat()].map((v) => ({ x: v.x, y: v.y }));
  let tris: number[] = [];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, holes).flat();
  } catch {
    tris = fan(contour.length);
  }
  return { pts, tris };
}

export function buildPitGeometry(pit: PitModel): TankGeometry {
  const o = ccw(pit.outline);
  const n = o.length;
  const top = pit.wallTop;
  const wTop = Math.max(0, pit.cfg.wallTop);
  const wBase = Math.max(wTop, pit.cfg.wallBase);
  const slab = Math.max(0, pit.cfg.slab);
  const bottom = pit.floorLow - slab - (pit.sumps.length ? Math.max(0, pit.floorLow - Math.min(...pit.sumps.map((s) => s.bottom))) : 0);
  const innerTop = pit.outlineAt(top);
  const outerTop = offset(o, wTop + pit.batterK * top);
  const outerBase = offset(o, wBase);

  const concrete = new Builder();
  const water = new Builder();
  const UP: V3 = [0, 1, 0];
  const DOWN: V3 = [0, -1, 0];

  // Walls: outer face, top ring, inner face (from the floor at the wall up to the battered top).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const out = edgeOut(o, i);
    const inn: V3 = [-out[0], -out[1], -out[2]];
    concrete.face([[outerBase[i].x, outerBase[i].y, bottom], [outerBase[j].x, outerBase[j].y, bottom], [outerTop[j].x, outerTop[j].y, top], [outerTop[i].x, outerTop[i].y, top]], out);
    concrete.face([[innerTop[i].x, innerTop[i].y, top], [innerTop[j].x, innerTop[j].y, top], [outerTop[j].x, outerTop[j].y, top], [outerTop[i].x, outerTop[i].y, top]], UP);
    const zi = pit.mainFloorZ(o[i].x, o[i].y);
    const zj = pit.mainFloorZ(o[j].x, o[j].y);
    const innerFace: V3[] = [[o[i].x, o[i].y, zi], [o[j].x, o[j].y, zj], [innerTop[j].x, innerTop[j].y, top], [innerTop[i].x, innerTop[i].y, top]];
    concrete.face(innerFace, inn);
    water.face(innerFace, out);
  }
  // Floor around the sumps, the sump floors and walls.
  const fm = floorMesh(pit);
  const floorPts: V3[] = fm.pts.map((q) => [q.x, q.y, pit.mainFloorZ(q.x, q.y)]);
  concrete.face(floorPts, UP, fm.tris);
  water.face(floorPts, DOWN, fm.tris);
  for (const s of pit.sumps) {
    if (s.outside) continue;
    const so = ccw(s.outline);
    const base: V3[] = so.map((q) => [q.x, q.y, s.bottom]);
    concrete.face(base, UP);
    water.face(base, DOWN);
    for (let i = 0; i < so.length; i++) {
      const j = (i + 1) % so.length;
      const out = edgeOut(so, i);
      const wall: V3[] = [[so[i].x, so[i].y, s.bottom], [so[j].x, so[j].y, s.bottom], [so[j].x, so[j].y, pit.mainFloorZ(so[j].x, so[j].y)], [so[i].x, so[i].y, pit.mainFloorZ(so[i].x, so[i].y)]];
      concrete.face(wall, [-out[0], -out[1], -out[2]]);
      water.face(wall, out);
    }
  }
  // Slab bottom plate and the liquid's lid.
  concrete.face(outerBase.map((q) => [q.x, q.y, bottom] as V3), DOWN, THREE.ShapeUtils.triangulateShape(outerBase.map((q) => new THREE.Vector2(q.x, q.y)), []).flat());
  water.face(innerTop.map((q) => [q.x, q.y, top] as V3), UP, THREE.ShapeUtils.triangulateShape(innerTop.map((q) => new THREE.Vector2(q.x, q.y)), []).flat());

  // Cut sections along the plan line Y = 0: the liquid's section and the concrete's section.
  const wallCut = new Builder();
  const cavityCut = new Builder();
  const edges: number[] = [];
  const seg = (a: V3, b: V3) => {
    const p = local(a[0], a[1], a[2]);
    const q = local(b[0], b[1], b[2]);
    edges.push(p[0], p[1], p[2] + 0.5, q[0], q[1], q[2] + 0.5);
  };
  const xs = crossings(o, 'y', 0);
  const FLAT: V3 = [0, 0, 1];
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const x0 = xs[k];
    const x1 = xs[k + 1];
    if (x1 - x0 < 1) continue;
    // Floor profile under the chord, sampled finely so sumps and slopes show.
    const profile: V3[] = [];
    const steps = 160;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      profile.push([x, 0, pit.floorZ(x, 0)]);
    }
    const cavity: V3[] = [[x0, 0, top], ...profile, [x1, 0, top]];
    cavityCut.face(cavity, FLAT, THREE.ShapeUtils.triangulateShape(cavity.map((p) => new THREE.Vector2(p[0], p[2])), []).flat());
    const slabPoly: V3[] = [...profile, [x1, 0, bottom], [x0, 0, bottom]];
    wallCut.face(slabPoly, FLAT, THREE.ShapeUtils.triangulateShape(slabPoly.map((p) => new THREE.Vector2(p[0], p[2])), []).flat());
    const leftWall: V3[] = [[x0, 0, top], [x0 - wTop - pit.batterK * top, 0, top], [x0 - wBase, 0, bottom], [x0, 0, bottom]];
    const rightWall: V3[] = [[x1, 0, top], [x1 + wTop + pit.batterK * top, 0, top], [x1 + wBase, 0, bottom], [x1, 0, bottom]];
    wallCut.face(leftWall, FLAT);
    wallCut.face(rightWall, FLAT);
    for (let i = 0; i + 1 < profile.length; i++) seg(profile[i], profile[i + 1]);
    seg([x0, 0, top], [x0, 0, profile[0][2]]);
    seg([x1, 0, top], [x1, 0, profile[profile.length - 1][2]]);
    for (const w of [leftWall, rightWall]) for (let i = 0; i < 4; i++) seg(w[i], w[(i + 1) % 4]);
    seg([x0, 0, bottom], [x1, 0, bottom]);
  }

  const outerGeo = concrete.build();
  outerGeo.computeBoundingBox();
  const sectionEdges = new THREE.BufferGeometry();
  sectionEdges.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  return {
    outline: null,
    inner: new THREE.BufferGeometry(),
    water: water.build(),
    outer: outerGeo,
    wallCut: wallCut.build(),
    cavityCut: cavityCut.build(),
    outerBox: outerGeo.boundingBox!.clone(),
    sectionEdges,
  };
}

/** The liquid surface at a level: the parts of the floor below it, and the sumps it has filled into. */
export function buildPitSurface(pit: PitModel, level: number): THREE.BufferGeometry | null {
  if (level <= 1e-9 || level >= pit.wallTop - 1e-9) return null;
  const pos: number[] = [];
  const push = (x: number, y: number) => {
    const l = local(x, y, level);
    pos.push(l[0], l[1], l[2]);
  };
  const fm = floorMesh(pit);
  const z = fm.pts.map((q) => pit.mainFloorZ(q.x, q.y));
  for (let t = 0; t < fm.tris.length; t += 3) {
    const ids = [fm.tris[t], fm.tris[t + 1], fm.tris[t + 2]];
    // Clip the triangle to the wet part (floor at or below the level).
    const poly: Pt[] = [];
    for (let i = 0; i < 3; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % 3];
      const za = z[a];
      const zb = z[b];
      if (za <= level) poly.push(fm.pts[a]);
      if (za <= level !== zb <= level) {
        const f = (level - za) / (zb - za);
        poly.push({ x: fm.pts[a].x + (fm.pts[b].x - fm.pts[a].x) * f, y: fm.pts[a].y + (fm.pts[b].y - fm.pts[a].y) * f });
      }
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      push(poly[0].x, poly[0].y);
      push(poly[i].x, poly[i].y);
      push(poly[i + 1].x, poly[i + 1].y);
    }
  }
  for (const s of pit.sumps) {
    if (s.outside || level <= s.bottom) continue;
    const so = ccw(s.outline);
    const tris = THREE.ShapeUtils.triangulateShape(so.map((q) => new THREE.Vector2(q.x, q.y)), []).flat();
    for (let t = 0; t < tris.length; t += 3) for (const i of [tris[t], tris[t + 1], tris[t + 2]]) push(so[i].x, so[i].y);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nn = new Float32Array(pos.length);
  for (let i = 1; i < nn.length; i += 3) nn[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  return g;
}
