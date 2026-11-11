import * as THREE from 'three';
import { makeOutline, type Outline } from '../core/shape';
import type { Sec, TankModel } from '../core/tank';
import type { VolumeEngine } from '../core/volume';

/**
 * Builds render geometry from the tank model.
 *
 * Tank frame (a, u, v) maps to the group's local frame with a proper rotation:
 *   vertical:   x = u, y = a, z = −v
 *   horizontal: x = a − L/2, y = v, z = −u
 * so local +y is always "up" in the untilted tank and the cut-away plane
 * z = 0 is a symmetry plane of the cavity.
 */

export type V3 = [number, number, number];

export function tankToLocal(m: TankModel, a: number, u: number, v: number): V3 {
  return m.orientation === 'vertical' ? [u, a, -v] : [a - m.L / 2, v, -u];
}

/** Tank-frame direction to local direction (no offset). */
export function dirToLocal(m: TankModel, a: number, u: number, v: number): V3 {
  return m.orientation === 'vertical' ? [u, a, -v] : [a, v, -u];
}

interface Part {
  kind: 'cap' | 'loft';
  /** Rings ordered by increasing a. */
  rings: { a: number; s: Sec; ds: Sec }[];
  thickness: number;
  /** Cap only: outward axial direction (−1 start, +1 end). */
  dir?: -1 | 1;
}

export interface TankGeometry {
  /** Section outline of a tank; null for a concrete storage (its surface is built from the plan). */
  outline: Outline | null;
  inner: THREE.BufferGeometry;
  water: THREE.BufferGeometry;
  outer: THREE.BufferGeometry;
  wallCut: THREE.BufferGeometry;
  cavityCut: THREE.BufferGeometry;
  /** Bounding box of the outer shell (local coordinates). */
  outerBox: THREE.Box3;
  /** Outline of the cut wall section (inner and outer edges), as line segments. */
  sectionEdges: THREE.BufferGeometry;
}

const sec = (): Sec => ({ ku: 0, kv: 0, cu: 0, cv: 0 });

function sectionWithDerivative(m: TankModel, a: number, lo: number, hi: number): { s: Sec; ds: Sec } {
  const s = m.section(a, sec());
  const h = Math.max((hi - lo) * 1e-4, 1e-6);
  let a0 = a - h;
  let a1 = a + h;
  if (a0 < lo) {
    a0 = a;
    a1 = Math.min(hi, a + h);
  }
  if (a1 > hi) {
    a1 = a;
    a0 = Math.max(lo, a - h);
  }
  const s0 = m.section(a0, sec());
  const s1 = m.section(a1, sec());
  const k = a1 > a0 ? 1 / (a1 - a0) : 0;
  return {
    s,
    ds: { ku: (s1.ku - s0.ku) * k, kv: (s1.kv - s0.kv) * k, cu: (s1.cu - s0.cu) * k, cv: (s1.cv - s0.cv) * k },
  };
}

/** Ring positions along a head, spaced evenly by arc length of its profile. */
function headStations(m: TankModel, which: 'start' | 'end'): number[] {
  const h = which === 'start' ? m.start : m.end;
  const lo = which === 'start' ? m.aMin : m.L;
  const hi = which === 'start' ? 0 : m.aMax;
  const linear = h.type === 'cone' || h.type === 'wedge' || h.type === 'sloped';
  if (linear) return [lo, hi];
  const R = (m.base.A + m.base.B) / 2;
  const n = 400;
  const as: number[] = [];
  const len: number[] = [0];
  let prevR = 0;
  for (let i = 0; i <= n; i++) {
    const a = lo + ((hi - lo) * i) / n;
    const s = m.section(a, sec());
    const r = ((s.ku + s.kv) / 2) * R;
    if (i > 0) len.push(len[i - 1] + Math.hypot((hi - lo) / n, r - prevR));
    as.push(a);
    prevR = r;
  }
  const rings = 44;
  const out: number[] = [];
  let k = 0;
  for (let j = 0; j <= rings; j++) {
    const target = (len[n] * j) / rings;
    while (k < n - 1 && len[k + 1] < target) k++;
    const f = len[k + 1] > len[k] ? (target - len[k]) / (len[k + 1] - len[k]) : 0;
    out.push(as[k] + (as[k + 1] - as[k]) * Math.min(1, Math.max(0, f)));
  }
  out[0] = lo;
  out[rings] = hi;
  return out;
}

function buildParts(m: TankModel): Part[] {
  const parts: Part[] = [];
  const ring = (a: number, lo: number, hi: number) => ({ a, ...sectionWithDerivative(m, a, lo, hi) });
  if (m.start.closed) {
    const s = m.section(m.aMin, sec());
    parts.push({ kind: 'cap', rings: [{ a: m.aMin, s, ds: sec() }], thickness: m.t.start, dir: -1 });
  }
  if (m.start.depth > 0) {
    parts.push({
      kind: 'loft',
      rings: headStations(m, 'start').map((a) => ring(a, m.aMin, 0)),
      thickness: m.t.start,
    });
  }
  if (m.L > 0) {
    // One loft per straight piece of the shell, so a stepped profile keeps sharp creases.
    const stations = m.profile ? m.profile.map((pt) => pt.a) : [0, m.L];
    for (let i = 0; i < stations.length - 1; i++) {
      const a0 = stations[i];
      const a1 = stations[i + 1];
      if (a1 - a0 <= 1e-6) continue;
      parts.push({ kind: 'loft', rings: [ring(a0, a0, a1), ring(a1, a0, a1)], thickness: m.t.shell });
    }
  }
  if (m.end.depth > 0) {
    parts.push({
      kind: 'loft',
      rings: headStations(m, 'end').map((a) => ring(a, m.L, m.aMax)),
      thickness: m.t.end,
    });
  }
  if (m.end.closed) {
    const s = m.section(m.aMax, sec());
    parts.push({ kind: 'cap', rings: [{ a: m.aMax, s, ds: sec() }], thickness: m.t.end, dir: 1 });
  }
  return parts;
}

/** Surface point and outward normal for outline point j on a ring (tank frame). */
function pointNormal(
  m: TankModel,
  o: Outline,
  r: { a: number; s: Sec; ds: Sec },
  j: number,
  part: Part,
  pos: V3,
  nrm: V3,
): void {
  const { s, ds } = r;
  const U = o.u[j];
  const W = o.v[j];
  pos[0] = r.a;
  pos[1] = s.cu + s.ku * U;
  pos[2] = s.cv + s.kv * W;
  if (part.kind === 'cap') {
    nrm[0] = part.dir!;
    nrm[1] = 0;
    nrm[2] = 0;
    return;
  }
  // Outward normal = ∂P/∂s × ∂P/∂a with ∂P/∂s = (0, tu, tv) and ∂P/∂a = (1, du, dv).
  const tu = -o.nv[j] * s.ku;
  const tv = o.nu[j] * s.kv;
  const du = ds.cu + ds.ku * U;
  const dv = ds.cv + ds.kv * W;
  const nx = tu * dv - tv * du;
  const ny = tv;
  const nz = -tu;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9 || (s.ku < 1e-6 && s.kv < 1e-6)) {
    // Apex: the normal points along the axis, away from the shell.
    nrm[0] = r.a < m.L / 2 ? -1 : 1;
    nrm[1] = 0;
    nrm[2] = 0;
    return;
  }
  nrm[0] = nx / l;
  nrm[1] = ny / l;
  nrm[2] = nz / l;
}

function miter(n1: V3, t1: number, n2: V3, t2: number): V3 {
  const c = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
  const det = 1 - c * c;
  if (det < 1e-6) {
    const t = (t1 + t2) / 2;
    return [n1[0] * t, n1[1] * t, n1[2] * t];
  }
  const al = (t1 - c * t2) / det;
  const be = (t2 - c * t1) / det;
  return [al * n1[0] + be * n2[0], al * n1[1] + be * n2[1], al * n1[2] + be * n2[2]];
}

export function buildTankGeometry(m: TankModel, segments = 112): TankGeometry {
  const o = makeOutline(m.base, segments);
  const n = o.n;
  const parts = buildParts(m);

  // Per part: positions and normals for every ring × outline point (tank frame).
  const P: V3[][][] = [];
  const N: V3[][][] = [];
  for (const part of parts) {
    const pp: V3[][] = [];
    const nn: V3[][] = [];
    for (const r of part.rings) {
      const rowP: V3[] = [];
      const rowN: V3[] = [];
      for (let j = 0; j < n; j++) {
        const p: V3 = [0, 0, 0];
        const q: V3 = [0, 0, 0];
        pointNormal(m, o, r, j, part, p, q);
        rowP.push(p);
        rowN.push(q);
      }
      pp.push(rowP);
      nn.push(rowN);
    }
    P.push(pp);
    N.push(nn);
  }

  // Outer offsets: along the normal, mitred where two parts meet.
  const OFF: V3[][][] = P.map((pp, pi) =>
    pp.map((row, ri) => row.map((_, j) => {
      const nv = N[pi][ri][j];
      const t = parts[pi].thickness;
      return [nv[0] * t, nv[1] * t, nv[2] * t] as V3;
    })),
  );
  for (let pi = 0; pi < parts.length - 1; pi++) {
    const A = parts[pi];
    const B = parts[pi + 1];
    const ra = A.rings.length - 1;
    for (let j = 0; j < n; j++) {
      const off = miter(N[pi][ra][j], A.thickness, N[pi + 1][0][j], B.thickness);
      OFF[pi][ra][j] = off;
      OFF[pi + 1][0][j] = off;
    }
  }

  const inner = new GeoBuilder(m);
  const water = new GeoBuilder(m);
  const outer = new GeoBuilder(m);
  const eps = Math.max(0.4, m.size * 0.0012);

  parts.forEach((part, pi) => {
    const rings = P[pi];
    if (part.kind === 'cap') {
      const r = part.rings[0];
      const centre: V3 = [r.a, r.s.cu, r.s.cv];
      const dir: V3 = [part.dir!, 0, 0];
      const rim = rings[0];
      const ci = inner.vertex(centre, dir);
      const cw = water.vertex([centre[0] - dir[0] * eps, centre[1], centre[2]], dir);
      const co = outer.vertex([centre[0] + dir[0] * part.thickness, centre[1], centre[2]], dir);
      const ii: number[] = [];
      const iw: number[] = [];
      const io: number[] = [];
      for (let j = 0; j < n; j++) {
        ii.push(inner.vertex(rim[j], dir));
        iw.push(water.vertex([rim[j][0] - dir[0] * eps, rim[j][1], rim[j][2]], dir));
        const off = OFF[pi][0][j];
        io.push(outer.vertex([rim[j][0] + off[0], rim[j][1] + off[1], rim[j][2] + off[2]], dir));
      }
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        if (part.dir === -1) {
          inner.tri(ci, ii[k], ii[j]);
          water.tri(cw, iw[k], iw[j]);
          outer.tri(co, io[k], io[j]);
        } else {
          inner.tri(ci, ii[j], ii[k]);
          water.tri(cw, iw[j], iw[k]);
          outer.tri(co, io[j], io[k]);
        }
      }
      return;
    }
    const idxI: number[][] = [];
    const idxW: number[][] = [];
    const idxO: number[][] = [];
    rings.forEach((row, ri) => {
      const rI: number[] = [];
      const rW: number[] = [];
      const rO: number[] = [];
      for (let j = 0; j < n; j++) {
        const p = row[j];
        const nv = N[pi][ri][j];
        const off = OFF[pi][ri][j];
        rI.push(inner.vertex(p, nv));
        rW.push(water.vertex([p[0] - nv[0] * eps, p[1] - nv[1] * eps, p[2] - nv[2] * eps], nv));
        rO.push(outer.vertex([p[0] + off[0], p[1] + off[1], p[2] + off[2]], nv));
      }
      idxI.push(rI);
      idxW.push(rW);
      idxO.push(rO);
    });
    for (let ri = 0; ri < rings.length - 1; ri++) {
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        inner.quad(idxI[ri][j], idxI[ri][k], idxI[ri + 1][k], idxI[ri + 1][j]);
        water.quad(idxW[ri][j], idxW[ri][k], idxW[ri + 1][k], idxW[ri + 1][j]);
        outer.quad(idxO[ri][j], idxO[ri][k], idxO[ri + 1][k], idxO[ri + 1][j]);
      }
    }
  });

  // Cut-plane sections: the two outline points lying on the plane.
  const [c0, c1, c2, c3] = o.cardinal;
  const sideA = m.orientation === 'vertical' ? c0 : c1;
  const sideB = m.orientation === 'vertical' ? c2 : c3;
  const innerA: V3[] = [];
  const innerB: V3[] = [];
  const outerA: V3[] = [];
  const outerB: V3[] = [];
  parts.forEach((part, pi) => {
    if (part.kind === 'cap') return;
    P[pi].forEach((row, ri) => {
      const offA = OFF[pi][ri][sideA];
      const offB = OFF[pi][ri][sideB];
      innerA.push(row[sideA]);
      innerB.push(row[sideB]);
      outerA.push([row[sideA][0] + offA[0], row[sideA][1] + offA[1], row[sideA][2] + offA[2]]);
      outerB.push([row[sideB][0] + offB[0], row[sideB][1] + offB[1], row[sideB][2] + offB[2]]);
    });
  });
  const flat: V3 = m.orientation === 'vertical' ? [0, 0, -1] : [0, -1, 0]; // tank-frame direction of local +z

  const wallCut = new GeoBuilder(m);
  const cavityCut = new GeoBuilder(m);
  const strip = (b: GeoBuilder, xs: V3[], ys: V3[]) => {
    for (let i = 0; i < xs.length - 1; i++) {
      const p0 = b.vertex(xs[i], flat);
      const p1 = b.vertex(xs[i + 1], flat);
      const q1 = b.vertex(ys[i + 1], flat);
      const q0 = b.vertex(ys[i], flat);
      b.quad(p0, p1, q1, q0);
    }
  };
  if (innerA.length > 1) {
    strip(wallCut, innerA, outerA);
    strip(wallCut, innerB, outerB);
    strip(cavityCut, innerA, innerB);
    // Flat end plates in the section.
    const capQuad = (iA: V3, iB: V3, oA: V3, oB: V3) => {
      wallCut.quad(wallCut.vertex(iA, flat), wallCut.vertex(iB, flat), wallCut.vertex(oB, flat), wallCut.vertex(oA, flat));
    };
    const capPart = (pi: number) => {
      const row = P[pi][0];
      const offA = OFF[pi][0][sideA];
      const offB = OFF[pi][0][sideB];
      const add = (p: V3, d: V3): V3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      capQuad(row[sideA], row[sideB], add(row[sideA], offA), add(row[sideB], offB));
    };
    if (parts[0].kind === 'cap') capPart(0);
    if (parts[parts.length - 1].kind === 'cap') capPart(parts.length - 1);
  }

  const outerGeo = outer.build();
  outerGeo.computeBoundingBox();
  return {
    outline: o,
    inner: inner.build(),
    water: water.build(),
    outer: outerGeo,
    wallCut: wallCut.build(true, Math.max(m.size / 45, 6)),
    cavityCut: cavityCut.build(true),
    outerBox: outerGeo.boundingBox!.clone(),
    sectionEdges: edgeLines(m, [innerA, outerA, innerB, outerB], parts, P, OFF, sideA, sideB),
  };
}

/** Line segments along the inner and outer section edges, closed across flat end plates. */
function edgeLines(
  m: TankModel,
  polylines: V3[][],
  parts: Part[],
  P: V3[][][],
  OFF: V3[][][],
  sideA: number,
  sideB: number,
): THREE.BufferGeometry {
  const pts: number[] = [];
  const seg = (p: V3, q: V3) => {
    const a = tankToLocal(m, p[0], p[1], p[2]);
    const b = tankToLocal(m, q[0], q[1], q[2]);
    pts.push(a[0], a[1], a[2] + 0.5, b[0], b[1], b[2] + 0.5);
  };
  for (const line of polylines) for (let i = 0; i < line.length - 1; i++) seg(line[i], line[i + 1]);
  const add = (p: V3, d: V3): V3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  for (const pi of [0, parts.length - 1]) {
    if (parts[pi]?.kind !== 'cap') continue;
    const row = P[pi][0];
    seg(row[sideA], row[sideB]);
    seg(add(row[sideA], OFF[pi][0][sideA]), add(row[sideB], OFF[pi][0][sideB]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** Accumulates vertices in tank-frame coordinates and emits local-frame geometry. */
class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private idx: number[] = [];
  private count = 0;
  constructor(private m: TankModel) {}

  vertex(p: V3, n: V3): number {
    const lp = tankToLocal(this.m, p[0], p[1], p[2]);
    const ln = dirToLocal(this.m, n[0], n[1], n[2]);
    this.pos.push(lp[0], lp[1], lp[2]);
    this.nor.push(ln[0], ln[1], ln[2]);
    return this.count++;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** planar: faces lie in z = 0; uvPeriod sets texture coordinates from x, y (mm per repeat). */
  build(planar = false, uvPeriod = 0): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (uvPeriod > 0) {
      const uv = new Float32Array((this.pos.length / 3) * 2);
      for (let i = 0, k = 0; i < this.pos.length; i += 3, k += 2) {
        uv[k] = this.pos[i] / uvPeriod;
        uv[k + 1] = this.pos[i + 1] / uvPeriod;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (planar) {
      const nn = new Float32Array(this.pos.length);
      for (let i = 2; i < nn.length; i += 3) nn[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      // Wind every triangle counter-clockwise seen from +z, so it faces the viewer of the cut.
      const P = this.pos;
      const I = this.idx;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3;
        const b = I[t + 1] * 3;
        const c = I[t + 2] * 3;
        const cross = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
        if (cross < 0) {
          I[t + 1] = c / 3;
          I[t + 2] = b / 3;
        }
      }
      g.setIndex(I);
      return g;
    } else {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    }
    g.setIndex(this.idx);
    return g;
  }
}

/**
 * Liquid surface polygon for plane offset h (local coordinates). Untilted
 * vertical tanks get the section outline as a fan; otherwise the surface is
 * assembled from the chord it cuts in each cross-section.
 */
export function buildSurface(m: TankModel, e: VolumeEngine, outline: Outline, h: number): THREE.BufferGeometry | null {
  if (h <= e.hMin + 1e-9 || h >= e.hMax - 1e-9) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  const nrm = surfaceNormalLocal(m, e);
  const push = (p: V3) => {
    const l = tankToLocal(m, p[0], p[1], p[2]);
    pos.push(l[0], l[1], l[2]);
    return pos.length / 3 - 1;
  };

  if (e.axis === -1) {
    const a = h;
    const s = m.section(a, sec());
    if (s.ku <= 0 || s.kv <= 0) return null;
    const c = push([a, s.cu, s.cv]);
    const first = pos.length / 3;
    for (let j = 0; j < outline.n; j++) push([a, s.cu + s.ku * outline.u[j], s.cv + s.kv * outline.v[j]]);
    for (let j = 0; j < outline.n; j++) idx.push(c, first + j, first + ((j + 1) % outline.n));
  } else {
    // Range of a where the plane crosses the cavity.
    const r: [number, number] = [0, 0];
    const N = 600;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= N; i++) {
      const a = m.aMin + ((m.aMax - m.aMin) * i) / N;
      e.heightRange(a, r);
      if (r[0] <= h && r[1] >= h) {
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
    }
    if (!(hi >= lo)) return null;
    const step = (m.aMax - m.aMin) / N;
    lo = Math.max(m.aMin, lo - step);
    hi = Math.min(m.aMax, hi + step);
    const samples = new Set<number>();
    const K = 220;
    for (let i = 0; i <= K; i++) samples.add(lo + ((hi - lo) * (1 - Math.cos((Math.PI * i) / K))) / 2);
    for (const b of m.breaks) if (b > lo && b < hi) samples.add(b);
    const as = [...samples].sort((x, y) => x - y);
    let prev: [number, number] | null = null;
    for (const a of as) {
      const ch = e.surfaceChord(a, h);
      const w = ch ? ch.w : (h - e.na * a) / e.nw;
      const mid = ch ? (ch.c0 + ch.c1) / 2 : 0;
      const c0 = ch ? ch.c0 : mid;
      const c1 = ch ? ch.c1 : mid;
      const p0: V3 = e.axis === 1 ? [a, c0, w] : [a, w, c0];
      const p1: V3 = e.axis === 1 ? [a, c1, w] : [a, w, c1];
      const i0 = push(p0);
      const i1 = push(p1);
      if (prev) idx.push(prev[0], i0, i1, prev[0], i1, prev[1]);
      prev = [i0, i1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nn = new Float32Array(pos.length);
  for (let i = 0; i < nn.length; i += 3) {
    nn[i] = nrm[0];
    nn[i + 1] = nrm[1];
    nn[i + 2] = nrm[2];
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  g.setIndex(idx);
  return g;
}

/** World-up expressed in the tank group's local frame. */
export function surfaceNormalLocal(m: TankModel, e: VolumeEngine): V3 {
  if (e.axis === -1) return [0, 1, 0];
  const nu = e.axis === 0 ? e.nw : 0;
  const nv = e.axis === 1 ? e.nw : 0;
  return dirToLocal(m, e.na, nu, nv);
}
