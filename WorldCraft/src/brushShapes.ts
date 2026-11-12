// Brush shapes (alphas): how strongly a sculpt or paint brush acts across its footprint. The same function draws the
// preview in the panel and weights every cell a stroke touches, so what you see is what the brush does.
// Pictures can be imported as shapes too (white = full strength, black = none); they're kept on this computer.
import { hashInts, noise2 } from '@shared/src/world/random';
import { erodeGrid } from '@shared/src/world/erosion';

/**
 * Landform brushes: heightmaps of whole landforms (an eroded peak, a range, rocky hills, a mesa, dunes, canyon
 * country), made once from noise and then run through the erosion simulation, so they carry real gullies and
 * spurs. Raise with one builds that landform up stroke by stroke; Stamp presses it in at once.
 */
export const HEIGHT_SHAPES = ['peak', 'range', 'rockyhills', 'mesa', 'dunes', 'canyonland'] as const;
export const BRUSH_SHAPES = ['circle', 'square', 'soft', 'noise', 'crags', 'splatter', 'ridge', 'crater', 'arrow', 'dots', 'cloud', 'checker', 'cracks', ...HEIGHT_SHAPES] as const;
export type BrushShape = typeof BRUSH_SHAPES[number] | `img:${string}`;
export const BRUSH_SHAPE_NAMES: Record<typeof BRUSH_SHAPES[number], string> = { circle: 'Circle', square: 'Square', soft: 'Soft dot', noise: 'Noise', crags: 'Crags', splatter: 'Splatter', ridge: 'Ridge', crater: 'Crater', arrow: 'Arrow', dots: 'Dots', cloud: 'Cloud', checker: 'Checker', cracks: 'Cracks', peak: 'Eroded peak', range: 'Mountain range', rockyhills: 'Rocky hills', mesa: 'Mesa', dunes: 'Dunes', canyonland: 'Canyon land' };
export const isHeightShape = (s: BrushShape | undefined) => !!s && (HEIGHT_SHAPES as readonly string[]).includes(s);

// ---- landform heightmaps
const HM = 128;
const landforms = new Map<string, Float32Array>();
const ridged = (seed: number, x: number, y: number, oct = 5) => { let a = 0.5, f = 1, s = 0, n = 0; for (let o = 0; o < oct; o++) { const r = 1 - Math.abs(noise2(seed + o, x * f, y * f)); s += r * r * a; n += a; a *= 0.5; f *= 2.03; } return s / n; };
const fbmN = (seed: number, x: number, y: number, oct = 4) => { let a = 0.5, f = 1, s = 0, n = 0; for (let o = 0; o < oct; o++) { s += (noise2(seed + o * 7, x * f, y * f) * 0.5 + 0.5) * a; n += a; a *= 0.5; f *= 2.1; } return s / n; };
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** The landform before weathering, at (u, v) in −1..1 across. */
function landformBase(kind: string, u: number, v: number): number {
  const r = Math.hypot(u, v), wob = fbmN(301, u * 1.6, v * 1.6) - 0.5;
  switch (kind) {
    case 'peak': { const m = 1 - sstep(0.05, 0.95, r + wob * 0.3); return Math.pow(m, 1.3) * (0.4 + 0.6 * ridged(311, u * 2.2 + wob, v * 2.2 - wob)) + Math.pow(m, 3) * 0.35; }
    case 'range': { const m = 1 - sstep(0, 0.85, Math.abs(v + 0.18 * noise2(321, u * 1.5, 0.5)) * 1.9 + Math.max(0, Math.abs(u) - 0.5) * 2.4); return Math.pow(m, 1.2) * (0.35 + 0.65 * ridged(331, u * 2.6, v * 3.2)); }
    case 'rockyhills': { const edge = 1 - sstep(0.55, 0.98, r), f = fbmN(341, u * 2.4, v * 2.4) + edge * 0.18; return sstep(0.5, 0.8, f) * edge * (0.45 + 0.55 * ridged(351, u * 4.5, v * 4.5)); }
    case 'mesa': { const s = 1 - sstep(0.48, 0.6, r + wob * 0.35), top = 0.82 + 0.1 * fbmN(361, u * 3, v * 3), foot = (1 - sstep(0.55, 1, r)) * 0.18 * (0.6 + fbmN(371, u * 6, v * 6) * 0.8); return Math.max(s * top, foot); }
    case 'dunes': { const t = (((u * 3.2 + 0.35 * noise2(381, v * 1.4, u * 0.6)) % 1) + 1) % 1, p = t < 0.72 ? t / 0.72 : (1 - t) / 0.28; return Math.pow(p, 1.6) * 0.55 * (1 - sstep(0.55, 1, r)) * (0.75 + 0.5 * fbmN(391, u * 2, v * 2)); }
    case 'canyonland': { const base = 1 - sstep(0.7, 1, r + wob * 0.2), c = 1 - Math.abs(noise2(401, u * 2.4 + wob, v * 2.4)), cut = sstep(0.82, 0.96, c), h = 0.85 - 0.65 * cut, q = Math.floor(h * 4) / 4; return base * (q + sstep(0.75, 1, (h * 4) % 1) * 0.25); }
  }
  return 0;
}
/** Makes the landform heightmaps (once, in the background); `onReady` runs when each is done. */
let landformListeners: (() => void)[] = [];
export const onLandformsReady = (f: () => void) => { landformListeners.push(f); return () => { landformListeners = landformListeners.filter((g) => g !== f); }; };
let started = false;
export async function makeLandforms() {
  if (started) return; started = true;
  for (const kind of HEIGHT_SHAPES) {
    const h = new Float32Array(HM * HM);
    for (let j = 0; j < HM; j++) for (let i = 0; i < HM; i++) h[j * HM + i] = landformBase(kind, (i + 0.5) / HM * 2 - 1, (j + 0.5) / HM * 2 - 1) * HM * 0.2;
    // Weathered: gullies down the slopes, fans at their feet (dunes stay crisp: the wind shapes them). (No sliding pass:
    // at this size its row-by-row sweep left streaks.)
    if (kind !== 'dunes') await erodeGrid(h, HM, HM, 1, { rain: kind === 'mesa' ? 0.4 : 1, strength: kind === 'canyonland' ? 0.4 : 0.7, thermal: 0, talus: 1, seed: 7, materials: 0, debris: 0 }, () => true);
    let hi = 1e-6; for (const x of h) hi = Math.max(hi, x);
    // (Faded to nothing at the edge, so a stroke leaves no rim.)
    for (let j = 0; j < HM; j++) for (let i = 0; i < HM; i++) { const u = (i + 0.5) / HM * 2 - 1, v = (j + 0.5) / HM * 2 - 1; h[j * HM + i] = Math.max(0, h[j * HM + i] / hi) * (1 - sstep(0.88, 1, Math.max(Math.abs(u), Math.abs(v)))); }
    landforms.set(kind, h);
    for (const f of landformListeners) f();
  }
}
const sampleGrid = (a: Float32Array, n: number, u: number, v: number) => {
  const x = (u * 0.5 + 0.5) * (n - 1), y = (v * 0.5 + 0.5) * (n - 1), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const at = (p: number, q: number) => a[Math.min(n - 1, Math.max(0, q)) * n + Math.min(n - 1, Math.max(0, p))];
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
};

// ---- imported shapes
const SIZE = 64;
const custom = new Map<string, Float32Array>();
const KEY = 'wc.brushShapes';
function loadCustom() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
    for (const [name, b64] of Object.entries(raw)) { const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); custom.set(name, Float32Array.from(bytes, (v) => v / 255)); }
  } catch { /* storage blocked: imported shapes last this session */ }
}
loadCustom();
function saveCustom() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...custom].map(([n, a]) => [n, btoa(String.fromCharCode(...Array.from(a, (v) => Math.round(v * 255))))])))); } catch { /* full or blocked */ }
}
/** The imported shapes' ids ("img:<name>"). */
export const customShapes = () => [...custom.keys()].map((n) => `img:${n}` as BrushShape);
export const shapeName = (s: BrushShape) => (s.startsWith('img:') ? s.slice(4) : BRUSH_SHAPE_NAMES[s as typeof BRUSH_SHAPES[number]]);
/** A picture as a brush shape: brightness becomes strength; a picture with transparency uses its alpha. */
export async function importBrushShape(file: File): Promise<BrushShape> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = SIZE;
    const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0, SIZE, SIZE);
    const d = g.getImageData(0, 0, SIZE, SIZE).data, a = new Float32Array(SIZE * SIZE);
    let anyClear = false; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { anyClear = true; break; }
    for (let i = 0; i < a.length; i++) a[i] = anyClear ? d[i * 4 + 3] / 255 : (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.55 + d[i * 4 + 2] * 0.15) / 255;
    let name = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Brush', n = 2; const base = name;
    while (custom.has(name)) name = `${base} ${n++}`;
    custom.set(name, a); saveCustom();
    return `img:${name}`;
  } finally { URL.revokeObjectURL(url); }
}
export function removeBrushShape(s: BrushShape) { custom.delete(s.slice(4)); saveCustom(); }
function sampleCustom(a: Float32Array, u: number, v: number) {
  const x = (u * 0.5 + 0.5) * (SIZE - 1), y = (v * 0.5 + 0.5) * (SIZE - 1), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const at = (p: number, q: number) => a[Math.min(SIZE - 1, Math.max(0, q)) * SIZE + Math.min(SIZE - 1, Math.max(0, p))];
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}

/**
 * The brush's weight (0..1) at (u, v): the point in the brush's own frame (already turned by its rotation), −1..1
 * across. `falloff` is the share of the radius at full strength (the rest fades: the smoothness).
 */
export function brushWeight(shape: BrushShape | undefined, u: number, v: number, falloff: number): number {
  if (shape?.startsWith('img:')) {
    const a = custom.get(shape.slice(4));
    if (!a || Math.abs(u) > 1 || Math.abs(v) > 1) return 0;
    // (The picture itself, faded a little at its edge by the smoothness so strokes blend.)
    const edge = Math.max(Math.abs(u), Math.abs(v)), soft = edge < falloff ? 1 : 1 - (edge - falloff) / Math.max(1e-3, 1 - falloff);
    return sampleCustom(a, u, v) * Math.max(0, Math.min(1, 0.5 + soft * 0.5));
  }
  if (isHeightShape(shape)) {
    // (The landform as it is: its own edges already fade. Until it's made, a soft dot.)
    if (Math.abs(u) > 1 || Math.abs(v) > 1) return 0;
    const a = landforms.get(shape!); if (a) return sampleGrid(a, HM, u, v);
    const r = Math.hypot(u, v); return r > 1 ? 0 : (1 - r) * (1 - r) * (1 + 2 * r);
  }
  if (shape === 'checker' || shape === 'arrow') {
    if (Math.abs(u) > 1 || Math.abs(v) > 1) return 0;
    const edge = Math.max(Math.abs(u), Math.abs(v)), soft = edge < falloff ? 1 : 1 - (edge - falloff) / Math.max(1e-3, 1 - falloff);
    if (shape === 'checker') return ((Math.floor(u * 3 + 3) + Math.floor(v * 3 + 3)) & 1 ? 1 : 0) * Math.max(0.3, soft);
    // (Pointing up the brush, the way its rotation turns: −v.)
    const head = v < -0.05 && Math.abs(u) < (v + 0.95) * 0.7, shaft = v >= -0.05 && v < 0.9 && Math.abs(u) < 0.2;
    return head || shaft ? Math.max(0.3, soft) : 0;
  }
  const r = shape === 'square' ? Math.max(Math.abs(u), Math.abs(v)) : Math.hypot(u, v);
  if (r > 1) return 0;
  const inner = shape === 'soft' ? 0 : falloff;
  let w = r < inner ? 1 : 1 - (r - inner) / Math.max(1e-3, 1 - inner);
  if (shape === 'soft') w = w * w * (3 - 2 * w);
  switch (shape) {
    case 'noise': w *= Math.max(0, Math.min(1, 0.5 + noise2(17, u * 2.6, v * 2.6) * 0.9 + noise2(29, u * 6, v * 6) * 0.35)); break;
    case 'crags': { const n = 1 - Math.abs(noise2(41, u * 2.2, v * 2.2)), m = 1 - Math.abs(noise2(43, u * 5, v * 5)); w *= Math.pow(n, 3) * 0.75 + Math.pow(m, 4) * 0.35; break; }
    case 'splatter': { const cx = Math.floor(u * 4 + 4), cz = Math.floor(v * 4 + 4), h = hashInts(7, cx, cz), du = (u * 4 + 4 - cx) - ((h & 255) / 255 * 0.6 + 0.2), dv = (v * 4 + 4 - cz) - (((h >>> 8) & 255) / 255 * 0.6 + 0.2), rr = 0.15 + ((h >>> 16) & 255) / 255 * 0.25; w *= Math.max(0, 1 - Math.hypot(du, dv) / rr); break; }
    case 'ridge': w *= Math.max(0, 1 - Math.abs(v) * 3.2) * (1 - Math.abs(u) * 0.3); break;
    case 'crater': w = r < 0.6 ? -(1 - r / 0.6) * 0.8 : Math.max(0, 1 - Math.abs(r - 0.75) / 0.2) * 0.6; break;
    case 'dots': { const cu = Math.round(u * 1.5) / 1.5, cv = Math.round(v * 1.5) / 1.5; w *= Math.max(0, 1 - Math.hypot(u - cu, v - cv) / 0.24); break; }
    case 'cloud': w *= sstep(0.35, 0.75, fbmN(411, u * 2.2, v * 2.2) + (1 - r) * 0.25); break;
    case 'cracks': { const c = 1 - Math.abs(noise2(421, u * 3, v * 3)), d = 1 - Math.abs(noise2(431, u * 7, v * 7)); w *= Math.max(sstep(0.9, 0.98, c), sstep(0.93, 0.99, d) * 0.6); break; }
  }
  return w;
}

/** Turns a world offset (dx, dz) into the brush's frame for a radius and rotation (degrees). */
export function brushFrame(dx: number, dz: number, radius: number, rotation: number): [number, number] {
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [(dx * c + dz * s) / radius, (-dx * s + dz * c) / radius];
}
