// Live preview of placed ParticleCraft effects in the WorldCraft view: each placement runs its effect's layers on the
// shared particle engine (sub-emitters linked) and draws them with GameCraft's particle renderer, at the placement's
// position, rotation and scale, pushed by the world's wind when "Follows the wind" is on.
import * as THREE from 'three';
import { ParticleView } from '@gamecraft/engine/particlesView';
import { Emitter, linkEmitters, type EmitterParams } from '@shared/src/runtime/particles';
import type { ParticleRef } from '@shared/src/world/document';
import { builtinEffect } from './builtinFx';

interface Item { key: string; ems: Emitter[]; views: ParticleView[] }

export class FxPreview {
  group = new THREE.Group();
  private items = new Map<string, Item>();
  private effects = new Map<string, { name: string; params: EmitterParams }[] | 'loading' | 'missing'>();
  enabled = true;
  constructor(private load: (file: string) => Promise<string>) { this.group.name = 'ParticleCraft effects'; }

  private layersOf(file: string) {
    const hit = this.effects.get(file);
    if (hit) return hit;
    // ParticleCraft's and SpriteCraft's own presets: no file needed.
    const own = builtinEffect(file);
    if (own) { const v = own.length ? own : 'missing' as const; this.effects.set(file, v); return v; }
    this.effects.set(file, 'loading');
    this.load(file).then((t) => { const a = JSON.parse(t); this.effects.set(file, Array.isArray(a.layers) && a.layers.length ? a.layers : 'missing'); this.sig = ''; }).catch(() => this.effects.set(file, 'missing'));
    return 'loading' as const;
  }
  private sig = '';

  /** Rebuilds the emitters of placements whose effect, scale or wind setting changed. */
  sync(refs: ParticleRef[]) {
    const sig = JSON.stringify(refs.map((r) => [r.id, r.effect, r.scale, r.wind]));
    for (const r of refs) { const it = this.items.get(r.id); if (it) for (const e of it.ems) { e.position = [r.x, r.y, r.z]; e.heading = r.rotation ?? 0; } }
    if (sig === this.sig) return;
    this.sig = sig;
    const keep = new Set(refs.map((r) => r.id));
    for (const [id, it] of this.items) if (!keep.has(id)) { this.drop(it); this.items.delete(id); }
    for (const r of refs) {
      const layers = this.layersOf(r.effect);
      const key = JSON.stringify([r.effect, r.scale, r.wind, typeof layers]);
      const old = this.items.get(r.id);
      if (old?.key === key) continue;
      if (old) this.drop(old);
      if (typeof layers === 'string') { this.items.set(r.id, { key, ems: [], views: [] }); continue; }
      const s = Math.max(0.05, r.scale || 1);
      const ems = layers.map((l, i) => {
        const p = l.params;
        const e = new Emitter(`wc:${r.id}:${i}`, { ...p, sizeStart: p.sizeStart * s, sizeEnd: p.sizeEnd * s, sizeVar: p.sizeVar * s, speed: p.speed * s, speedVar: p.speedVar * s, gravity: p.gravity * s, emitterScale: (p.emitterScale ?? 1) * s, offset: p.offset ? [p.offset[0] * s, p.offset[1] * s, p.offset[2] * s] : undefined }, l.name);
        e.position = [r.x, r.y, r.z]; e.heading = r.rotation ?? 0; e.plane = 'xz';
        return e;
      });
      linkEmitters(ems);
      const views = ems.map((e) => new ParticleView(e));
      for (const v of views) this.group.add(v.points);
      this.items.set(r.id, { key, ems, views });
    }
  }
  private drop(it: Item) { for (const v of it.views) { this.group.remove(v.points); v.dispose(); } }

  /** Advances and draws. `wind`: direction (x, z) and strength of the world's wind. */
  update(dt: number, pixelScale: number, wind: { x: number; z: number; strength: number }, refs: ParticleRef[]) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    for (const r of refs) {
      const it = this.items.get(r.id); if (!it) continue;
      for (const e of it.ems) {
        // The world's wind as an extra force (kept separate so the effect's own forces stay as authored).
        if (r.wind !== false && wind.strength > 0) {
          const base = (e.params.forces ?? []).filter((f) => !(f as any).world);
          e.params.forces = [...base, { type: 'wind', direction: [wind.x, 0, wind.z], speed: wind.strength * 4, coupling: 0.35, gust: 0.6, gustFreq: 0.4, world: true } as any];
        }
        e.update(dt);
        if (!e.params.looping && e.done) e.restart();
      }
      for (const v of it.views) v.update(pixelScale, false);
    }
  }
  dispose() { for (const it of this.items.values()) this.drop(it); this.items.clear(); }
}
