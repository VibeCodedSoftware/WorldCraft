// Effects that come with WorldCraft, so they can be placed without exporting anything first:
//  - ParticleCraft's presets ("pc:<id>"), compiled from the same shared library ParticleCraft uses, so new presets
//    there show up here too;
//  - SpriteCraft's particle presets ("sc:<name>"): its fire, smoke, sparks, magic and the rest, turned into 3D layers
//    the way SpriteCraft itself sends them to ParticleCraft (SpriteCraft/src/core/particles.ts, toCraft: 16 px a metre).
import { finalizeAsset, newAsset, VFX_PRESETS } from '@shared/src/vfx/vfx';
import type { EmitterParams } from '@shared/src/runtime/particles';

type Layer = { name: string; params: EmitterParams };

/** SpriteCraft's presets, in its units (pixels, pixels a second, degrees with -90 up). */
interface SpriteEmitter { shape?: 'point' | 'line' | 'circle' | 'ring' | 'box'; shapeW?: number; shapeH?: number; rate?: number; burst?: number; lifetime?: number; lifetimeVar?: number; speed?: number; speedVar?: number; angle?: number; spread?: number; gravity?: number; drag?: number; turbulence?: number; turbulenceScale?: number; swirl?: number; attract?: number; sizeStart?: number; sizeEnd?: number; colours?: string[]; alphaStart?: number; alphaEnd?: number; look?: 'pixel' | 'disc' | 'spark' | 'star'; trail?: number; blend?: 'normal' | 'additive'; radial?: number }
const SPRITE_PRESETS: [string, SpriteEmitter][] = [
  ['Fire', { shape: 'line', shapeW: 8, rate: 40, lifetime: 0.7, lifetimeVar: 0.3, speed: 22, speedVar: 0.4, angle: -90, spread: 12, turbulence: 30, turbulenceScale: 6, sizeStart: 3, sizeEnd: 1, colours: ['#fff1c1', '#ffcd75', '#ef7d57', '#b13e53'], look: 'pixel', blend: 'additive' }],
  ['Smoke', { shape: 'line', shapeW: 6, rate: 10, lifetime: 1.8, lifetimeVar: 0.3, speed: 12, angle: -90, spread: 15, drag: 0.6, turbulence: 14, sizeStart: 2, sizeEnd: 5, colours: ['#94b0c2', '#566c86', '#333c57'], alphaStart: 0.9, alphaEnd: 0, look: 'disc' }],
  ['Sparks', { rate: 25, lifetime: 0.6, speed: 60, speedVar: 0.4, angle: -90, spread: 60, gravity: 160, sizeStart: 2, sizeEnd: 1, colours: ['#ffffff', '#ffcd75', '#ef7d57'], look: 'spark', trail: 0.05, blend: 'additive' }],
  ['Magic sparkle', { shape: 'circle', shapeW: 14, shapeH: 14, rate: 18, lifetime: 0.9, speed: 8, spread: 180, gravity: -10, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#a7f0ff', '#73eff7', '#3b5dc9'], look: 'star', swirl: 40, blend: 'additive' }],
  ['Explosion', { burst: 40, rate: 0, lifetime: 0.7, lifetimeVar: 0.4, speed: 70, speedVar: 0.6, spread: 180, drag: 3, sizeStart: 4, sizeEnd: 1, colours: ['#ffffff', '#fff1c1', '#ffcd75', '#ef7d57', '#5d275d'], look: 'disc', blend: 'additive' }],
  ['Coin pickup', { burst: 14, rate: 0, lifetime: 0.6, speed: 45, spread: 180, gravity: 120, sizeStart: 2, sizeEnd: 1, colours: ['#fff1c1', '#ffcd75', '#b86f50'], look: 'star' }],
  ['Dust puff', { shape: 'line', shapeW: 8, burst: 8, rate: 0, lifetime: 0.7, speed: 18, angle: -90, spread: 70, drag: 2.5, sizeStart: 2, sizeEnd: 4, colours: ['#c2a385', '#94785f'], alphaStart: 0.9, alphaEnd: 0, look: 'disc' }],
  ['Hit flash', { burst: 12, rate: 0, lifetime: 0.25, speed: 90, spread: 180, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#f4f4f4', '#ffcd75'], look: 'spark', trail: 0.04, blend: 'additive' }],
  ['Bubbles', { shape: 'line', shapeW: 10, rate: 6, lifetime: 1.6, speed: 18, angle: -90, spread: 8, turbulence: 20, sizeStart: 2, sizeEnd: 3, colours: ['#a7f0ff', '#73eff7'], look: 'disc' }],
  ['Heal', { shape: 'circle', shapeW: 16, shapeH: 6, rate: 12, lifetime: 1, speed: 16, angle: -90, spread: 5, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#a7f070', '#38b764'], look: 'star', blend: 'additive' }],
  ['Poison', { shape: 'line', shapeW: 10, rate: 8, lifetime: 1.2, speed: 10, angle: -90, spread: 20, turbulence: 18, sizeStart: 2, sizeEnd: 3, colours: ['#a7f070', '#38b764', '#257179'], alphaStart: 1, alphaEnd: 0, look: 'disc' }],
  ['Portal swirl', { shape: 'ring', shapeW: 20, shapeH: 20, rate: 30, lifetime: 1, speed: 0, swirl: 180, attract: 40, sizeStart: 2, sizeEnd: 1, colours: ['#ffffff', '#b2a2ff', '#5d275d'], look: 'pixel', trail: 0.08, blend: 'additive' }],
];

/** SpriteCraft's toCraft, for a placed 3D effect: pixels to metres, its up (-90°) to +Y, the shape round the vertical. */
const PX = 16;
function fromSprite(e: SpriteEmitter): EmitterParams {
  const a = (((e.angle ?? -90) * Math.PI) / 180), cols = e.colours ?? ['#ffffff'];
  const shape = e.shape === 'box' ? 'box' : e.shape === 'circle' ? 'circle' : e.shape === 'ring' ? 'ring' : e.shape === 'line' ? 'line' : 'point';
  const sw = e.shapeW ?? 6, sh = e.shapeH ?? 2;
  return {
    rate: e.rate ?? 20, burst: e.burst ?? 0, lifetime: e.lifetime ?? 0.8, lifetimeVar: (e.lifetime ?? 0.8) * (e.lifetimeVar ?? 0.3), speed: (e.speed ?? 20) / PX, speedVar: ((e.speed ?? 20) * (e.speedVar ?? 0.3)) / PX,
    direction: [Math.cos(a), -Math.sin(a), 0], spread: e.spread ?? 20, gravity: -(e.gravity ?? 0) / PX, acceleration: [0, 0, 0], drag: e.drag ?? 0,
    sizeStart: Math.max(0.03, (e.sizeStart ?? 1) / PX * 1.6), sizeEnd: Math.max(0, (e.sizeEnd ?? 1) / PX * 1.6), sizeVar: 0,
    colorStart: cols[0], colorEnd: cols[cols.length - 1], colorMid: cols.length > 2 ? cols[Math.floor(cols.length / 2)] : '',
    alphaStart: e.alphaStart ?? 1, alphaEnd: e.alphaEnd ?? (e.look === 'disc' ? 0 : 1), rotation: 0, rotationSpeed: 0,
    shape, shapeSize: [shape === 'circle' || shape === 'ring' ? sw / 2 / PX : sw / PX, sh / PX, shape === 'box' ? 0 : sw / 2 / PX],
    maxParticles: Math.max(50, Math.ceil((e.rate ?? 20) * (e.lifetime ?? 0.8) * 2 + (e.burst ?? 0))),
    texture: e.look === 'pixel' ? 'pixel' : e.look === 'spark' ? 'spark' : e.look === 'star' ? 'star' : 'circle',
    blending: e.blend ?? 'normal', space: 'world', looping: true, duration: 2, seed: 1,
    collideFloor: false, floorY: 0, bounce: 0.3, turbulence: (e.turbulence ?? 0) / PX, turbulenceFreq: PX / Math.max(2, e.turbulenceScale ?? 8), vortex: (e.swirl ?? 0) / 57.3, vortexPull: (e.attract ?? 0) / PX,
    trail: e.trail ?? 0, radialSpeed: (e.radial ?? 0) / PX,
  } as unknown as EmitterParams;
}

/** What can be placed: ParticleCraft's presets by category, and SpriteCraft's. */
export const BUILTIN_EFFECTS: { group: string; id: string; name: string; look?: string }[] = [
  ...VFX_PRESETS.map((p) => ({ group: 'ParticleCraft: ' + p.category, id: 'pc:' + p.id, name: p.name, look: p.look ?? 'stylized' })),
  ...SPRITE_PRESETS.map(([n]) => ({ group: 'SpriteCraft', id: 'sc:' + n, name: n, look: 'pixel' })),
];

const cache = new Map<string, Layer[] | null>();
/** The layers of a built-in effect, or null when `effect` is a file from the exchange folder. */
export function builtinEffect(effect: string): Layer[] | null {
  if (!effect.startsWith('pc:') && !effect.startsWith('sc:')) return null;
  if (cache.has(effect)) return cache.get(effect)!;
  let out: Layer[] | null = null;
  if (effect.startsWith('pc:')) {
    const p = VFX_PRESETS.find((x) => x.id === effect.slice(3));
    if (p) { const a = finalizeAsset(newAsset(p.name, p.build(), p.category)); out = (a.layers ?? []) as Layer[]; }
  } else {
    const p = SPRITE_PRESETS.find(([n]) => n === effect.slice(3));
    if (p) out = [{ name: p[0], params: fromSprite(p[1]) }];
  }
  cache.set(effect, out ?? []);
  return out ?? [];
}
