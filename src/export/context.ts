import { polygonSides } from '../core/shape';
import type { TankModel } from '../core/tank';
import type { Project } from '../core/types';
import { plain } from '../core/units';
import type { Conversion } from './shared';

export function endNames(p: Project): { start: string; end: string; startLong: string; endLong: string } {
  return p.tank.orientation === 'vertical'
    ? { start: 'Bottom', end: 'Top', startLong: 'Bottom (footer)', endLong: 'Top (head)' }
    : { start: 'Left end', end: 'Right end', startLong: 'Left end head', endLong: 'Right end head' };
}

const POLY_NAMES: Record<number, string> = { 6: 'hexagonal', 8: 'octagonal', 10: 'decagonal', 12: 'dodecagonal' };

export function bodyName(p: Project, m: TankModel): string {
  if (p.tank.kind === 'pit' && p.tank.pit) {
    const f = p.tank.pit.floor;
    const floor = f.type === 'plane' ? 'floor sloping one way' : f.type === 'vertices' ? 'floor given at the corners' : 'flat floor';
    return `Concrete storage, open at the top, ${p.tank.pit.outline.length}-corner plan, ${floor}${p.tank.pit.sumps.length ? `, ${p.tank.pit.sumps.length} sump${p.tank.pit.sumps.length === 1 ? '' : 's'}` : ''}`;
  }
  const o = p.tank.orientation === 'vertical' ? 'Vertical' : 'Horizontal';
  const shape = m.profile ? ' (stepped / profiled shell)' : m.endScale !== 1 ? ' (tapered)' : '';
  switch (m.bodyType) {
    case 'sphere':
      return 'Sphere';
    case 'cylinder':
      return `${o} cylinder${shape}`;
    case 'oval':
      return `${o} elliptical shell${shape}`;
    case 'rect':
      return `${o} rectangular tank${shape}`;
    case 'stadium':
      return `${o} obround (stadium) shell${shape}`;
    case 'polygon': {
      const n = polygonSides(m.base);
      return `${o} ${POLY_NAMES[n] ?? `${n}-sided`} tank (${n} sides)${shape}`;
    }
    case 'chamfer':
      return `${o} box with cut (chamfered) corners${shape}`;
    case 'trapezoid':
      return `${o} trapezoidal tank${shape}`;
    case 'boxoval':
      return `${o} box-oval (superellipse, n = ${plain(p.tank.body.squareness, 2)}) shell${shape}`;
    case 'dshape':
      return `${o} D-shaped tank (round ${p.tank.orientation === 'vertical' ? 'back' : 'top'})${shape}`;
    case 'trough':
      return `${o} U-shaped tank (round ${p.tank.orientation === 'vertical' ? 'front' : 'bottom'})${shape}`;
  }
}

/** Raw value a sensor sends at a level, or null outside the levels it can measure. */
export function expectedRaw(c: Conversion, level: number): number | null {
  const g = c.geom;
  if (level < g.validMin - 1e-9 || level > g.validMax + 1e-9) return null;
  return (level - c.A) / c.B;
}
