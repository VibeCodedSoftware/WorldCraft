// Falling leaves (Weather › Falling leaves): ParticleCraft's Falling leaves preset in the world's look drifting down
// under the trees nearest the camera (Leaves in the wind when it blows hard), more in autumn. The trees are found from
// the scattered tree layers the view has placed, and the emitters move on with the camera.
import * as THREE from 'three';
import { ParticleView } from '@gamecraft/engine/particlesView';
import { Emitter, linkEmitters } from '@shared/src/runtime/particles';
import { builtinEffect } from './builtinFx';

/** A tree to drop leaves from: where, how big, and its own leaf colours and picture (so its falling leaves match it). */
interface Tree { x: number; y: number; z: number; scale: number; colors?: string[]; image?: string | null }
interface Item { key: string; ems: Emitter[]; views: ParticleView[] }

export class LeafFallFx {
  group = new THREE.Group();
  private items = new Map<string, Item>();
  private preset = '';
  private nextLook = 0;
  constructor() { this.group.name = 'falling leaves'; }

  /** The preset for a world look and wind. */
  static presetFor(style: string | undefined, windy: boolean) {
    const look = style === 'pixel' ? 'pixel' : style === 'stylized' || style === 'toon' ? 'stylized' : 'realistic';
    return `pc:${windy ? 'wind' : 'falling'}-leaves-${look}`;
  }

  /**
   * `trees`: candidate trees (called at most twice a second); `amount`: 0 turns it off. Keeps an emitter in the canopy
   * of each of the nearest (up to 10, within 70 m), dropping those left behind.
   */
  update(dt: number, pixelScale: number, cam: THREE.Vector3, on: boolean, amount: number, preset: string, trees: () => Tree[]) {
    this.group.visible = on && amount > 0;
    if (!this.group.visible) { if (this.items.size) this.clear(); return; }
    if (preset !== this.preset) { this.clear(); this.preset = preset; }
    if (performance.now() > this.nextLook) {
      this.nextLook = performance.now() + 500;
      const near = trees().map((t) => ({ t, d: Math.hypot(t.x - cam.x, t.z - cam.z) })).filter((o) => o.d < 70).sort((a, b) => a.d - b.d).slice(0, 10);
      const want = new Set(near.map((o) => `${Math.round(o.t.x * 10)},${Math.round(o.t.z * 10)}`));
      for (const [k, it] of this.items) if (!want.has(k)) { for (const v of it.views) { this.group.remove(v.points); v.dispose(); } this.items.delete(k); }
      const layers = builtinEffect(preset) ?? [];
      for (const { t } of near) {
        const k = `${Math.round(t.x * 10)},${Math.round(t.z * 10)}`;
        if (this.items.has(k) || !layers.length) continue;
        const s = Math.max(0.5, t.scale);
        const ems = layers.map((l, i) => {
          // The tree's own leaves: its leaf picture, in its leaf colours (healthy, and any yellow / orange / brown share).
          const col = t.colors?.length ? t.colors[i % t.colors.length] : null;
          const own = col ? { colorStart: col, colorEnd: col, colorMid: '', ...(t.image ? { textureImage: t.image } : {}) } : {};
          const e = new Emitter(`leaf:${k}:${i}`, { ...l.params, ...own, rate: l.params.rate * amount, emitterScale: s * 0.7, seed: (l.params.seed ?? 1) + i + (Math.abs(Math.round(t.x * 7 + t.z * 13)) % 1000) }, l.name);
          // (In the crown: a tree is about 9 m tall at scale 1.)
          e.position = [t.x, t.y + 6.5 * s, t.z]; e.plane = 'xz';
          // (Leaves land on the ground under the tree, not on the floor of the effect's own preview.)
          (e.params as any).floorY = t.y + 0.05;
          return e;
        });
        linkEmitters(ems);
        const views = ems.map((e) => new ParticleView(e));
        for (const v of views) this.group.add(v.points);
        this.items.set(k, { key: k, ems, views });
      }
    }
    for (const it of this.items.values()) {
      for (const e of it.ems) { e.update(dt); if (!e.params.looping && e.done) e.restart(); }
      for (const v of it.views) v.update(pixelScale, false);
    }
  }
  get count() { return this.items.size; }
  clear() { for (const it of this.items.values()) for (const v of it.views) { this.group.remove(v.points); v.dispose(); } this.items.clear(); }
}
