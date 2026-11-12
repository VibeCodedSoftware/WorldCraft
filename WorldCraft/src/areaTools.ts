// Area tools (the "grid tools"): a rectangle dragged out on the land with the Area tool, then acted on as a whole:
// raised or lowered, duplicated elsewhere, turned, scaled, tilted, pushed or pulled along the brush's direction,
// aligned to one even slope or flattened. Each is one undoable change to the sculpt layer, with a soft edge so it
// blends into the land round it.
import { wc } from './store';

export type Rect = [number, number, number, number];
let area: Rect | null = null;
let listeners: (() => void)[] = [];
const view = () => (window as any).__wc?.view as { height(x: number, z: number): number; showArea(r: Rect | null): void; editedAt(x: number, z: number, r: number): void; refreshHeight(): void } | undefined;

export const getArea = () => area;
export function setArea(r: Rect | null) {
  area = r && Math.abs(r[2] - r[0]) > 0.5 && Math.abs(r[3] - r[1]) > 0.5 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : r ? null : null;
  // (While dragging, the outline follows even a tiny rectangle.)
  view()?.showArea(r ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : null);
  for (const f of listeners) f();
}
export const onArea = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };

export type AreaOp = 'raise' | 'lower' | 'flatten' | 'align' | 'tilt' | 'scale' | 'rotate' | 'push' | 'pull' | 'flipx' | 'flipz';
export interface AreaParams { amount: number; angle: number; factor: number; feather: number; direction: number }
/** The panel's current settings for the area tools (Duplicate's click in the view uses them too). */
export const areaParams: { current: AreaParams } = { current: { amount: 5, angle: 90, factor: 1.5, feather: 6, direction: 0 } };

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * New heights for the area, worked out from the land as it is now (all read before any is written, so moving land
 * over itself doesn't smear), then laid in as sculpt-layer changes faded over `feather` metres outside the rectangle.
 * `to`: Duplicate's destination (the centre the copy goes to); the source is the area.
 */
export function applyArea(op: AreaOp | 'duplicate', p: AreaParams, to?: [number, number]) {
  const v = view(), d0 = wc.get().doc; if (!v || !d0 || !area) return;
  const cell = d0.edits.cell, [x0, z0, x1, z1] = area, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, F = Math.max(0, p.feather);
  // Where the change lands: the area itself, or (Duplicate) the same-sized rectangle round `to`.
  const ox = op === 'duplicate' && to ? to[0] - cx : 0, oz = op === 'duplicate' && to ? to[1] - cz : 0;
  const tx0 = x0 + ox, tz0 = z0 + oz, tx1 = x1 + ox, tz1 = z1 + oz;
  const h = (x: number, z: number) => v.height(x, z);
  // Statistics of the area: mean, and the best-fitting even slope (least squares) for Align.
  let n = 0, sh = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
  for (let x = x0; x <= x1; x += cell) for (let z = z0; z <= z1; z += cell) { const y = h(x, z), dx = x - cx, dz = z - cz; n++; sh += y; sx += dx; sz += dz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sxh += dx * y; szh += dz * y; }
  if (!n) return;
  const mean = sh / n, det = sxx * szz - sxz * sxz;
  const gx = det > 1e-6 ? (sxh * szz - szh * sxz) / det : 0, gz = det > 1e-6 ? (szh * sxx - sxh * sxz) / det : 0; void sx; void sz;
  const a = (p.direction * Math.PI) / 180, ux = Math.cos(a), uz = Math.sin(a), hw = (x1 - x0) / 2, hd = (z1 - z0) / 2;
  const target = (x: number, z: number): number => {
    const y = h(x, z), dx = x - cx, dz = z - cz;
    switch (op) {
      case 'raise': return y + p.amount;
      case 'lower': return y - p.amount;
      case 'flatten': return mean;
      case 'align': return mean + gx * dx + gz * dz;
      case 'tilt': return y + (p.amount / Math.max(1, Math.max(hw, hd))) * (dx * ux + dz * uz);
      case 'scale': return mean + (y - mean) * p.factor;
      case 'rotate': { const r = (-p.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), sxp = cx + dx * c - dz * s, szp = cz + dx * s + dz * c; return Math.abs(sxp - cx) <= hw && Math.abs(szp - cz) <= hd ? h(sxp, szp) : y; }
      case 'push': case 'pull': { const k = op === 'push' ? p.amount : -p.amount, sxp = x - ux * k, szp = z - uz * k; return Math.abs(sxp - cx) <= hw && Math.abs(szp - cz) <= hd ? h(sxp, szp) : y; }
      case 'flipx': return h(cx - dx, z);
      case 'flipz': return h(x, cz - dz);
      case 'duplicate': return h(x - ox, z - oz);
    }
  };
  const changes: [string, number][] = [];
  for (let i = Math.floor((tx0 - F) / cell); i <= Math.ceil((tx1 + F) / cell); i++) for (let j = Math.floor((tz0 - F) / cell); j <= Math.ceil((tz1 + F) / cell); j++) {
    const x = i * cell, z = j * cell;
    const out = Math.hypot(Math.max(0, tx0 - x, x - tx1), Math.max(0, tz0 - z, z - tz1));
    const w = F > 0 ? 1 - smooth(0, F, out) : out > 0 ? 0 : 1; if (w <= 0) continue;
    // (Outside the rectangle, the edge's own new height eases back to the land: no cliff at the border.)
    const ex = Math.max(tx0, Math.min(tx1, x)), ez = Math.max(tz0, Math.min(tz1, z));
    const t = out > 0 ? target(ex, ez) - h(ex, ez) : target(x, z) - h(x, z);
    if (Math.abs(t) > 1e-4) changes.push([`${i},${j}`, t * w]);
  }
  const label = op === 'duplicate' ? 'Area duplicated' : `Area: ${op}`;
  wc.mutate(label, (d) => { for (const [k, dv] of changes) d.edits.height[k] = (d.edits.height[k] ?? 0) + dv; });
  // (Once the view has the new edits, which reach it on the next render: the land there is rebuilt.)
  const done = area;
  setTimeout(() => {
    v.refreshHeight();
    v.editedAt((tx0 + tx1) / 2, (tz0 + tz1) / 2, Math.hypot(tx1 - tx0, tz1 - tz0) / 2 + F + cell * 2);
    if (op === 'duplicate' && to) setArea([tx0, tz0, tx1, tz1]); else setArea(done);
  }, 60);
}
