// Waterfalls: wherever a river's surface drops steeply, a curtain of falling water pours from the lip to the foot (white
// streaks running down it), foam churns at the foot, and ParticleCraft's Waterfall (spray off the lip) and Waterfall
// mist (at the foot) play there. Found from the rivers themselves, so they come and go as the land and rivers change.
import * as THREE from 'three';
import { ParticleView } from '@gamecraft/engine/particlesView';
import { Emitter, linkEmitters } from '@shared/src/runtime/particles';
import type { RiverPath } from '@shared/src/world/features';
import { builtinEffect } from './builtinFx';

export interface Fall {
  x: number; y: number; z: number; /** Foot. */ bx: number; by: number; bz: number; /** Downstream, degrees round Y. */ yaw: number; width: number; drop: number;
  /** The river's points from the lip to the foot (x, water level, z). */ path: [number, number, number][];
  /** Drop over the ground it covers: 0.45 or more is a waterfall (a falling sheet, foam at the foot, mist); less is rapids (spray only, the river's own streaks show it running fast). */ steep: number;
}

/** Steep enough for a falling sheet of water (about 24° and up); gentler drops are rapids. */
export const FALL_STEEPNESS = 0.45;

/**
 * The real drops along rivers: neighbouring steps that each fall steeply (a metre or more over the 8 m between points)
 * joined into one fall, kept when the whole drop is at least `minDrop` metres. (Every small step used to be a "fall",
 * so mist lay all along gently sloping rivers.)
 */
export function findFalls(rivers: RiverPath[], minDrop = 3.5): Fall[] {
  const out: Fall[] = [];
  for (const r of rivers) {
    let i = 0;
    while (i + 1 < r.points.length) {
      if (r.levels[i] - r.levels[i + 1] < 1) { i++; continue; }
      let j = i + 1;
      while (j + 1 < r.points.length && r.levels[j] - r.levels[j + 1] >= 1) j++;
      const drop = r.levels[i] - r.levels[j];
      if (drop >= minDrop) {
        const [x, z] = r.points[i], [bx, bz] = r.points[j];
        let run = 0; for (let k = i + 1; k <= j; k++) run += Math.hypot(r.points[k][0] - r.points[k - 1][0], r.points[k][1] - r.points[k - 1][1]);
        out.push({ x, y: r.levels[i], z, bx, by: r.levels[j], bz, yaw: (Math.atan2(bx - x, bz - z) * 180) / Math.PI, width: Math.max(1.5, r.widths[i] * 0.5), drop,
          path: r.points.slice(i, j + 1).map(([px, pz], k) => [px, r.levels[i + k], pz] as [number, number, number]), steep: drop / Math.max(0.5, run) });
      }
      i = j;
    }
  }
  return out;
}

const CURTAIN_VS = `attribute float aV; varying vec2 vUv2; varying float vV; void main(){ vUv2 = uv; vV = aV; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CURTAIN_FS = `uniform float uTime; uniform vec3 uColor; varying vec2 vUv2; varying float vV;
  float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n1(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
  void main(){
    // Long thin streaks running down the fall (not blobs), clear water between them tinted the river's colour.
    float x = vUv2.x;
    vec2 p = vec2(x * 26.0, vUv2.y * 0.55 - uTime * 2.4);
    float s = n1(p) * 0.55 + n1(p * vec2(2.1, 1.7) + 4.0) * 0.3 + n1(p * vec2(4.3, 3.1) + 9.0) * 0.15;
    float streak = smoothstep(0.42, 0.78, s);
    // Soft sides that waver as it falls; fading in at the lip and out into the foam at the foot (no hard edges).
    float w = 0.14 + 0.1 * n1(vec2(vUv2.y * 0.8 - uTime * 0.9, x * 3.0));
    float edge = smoothstep(0.0, w, x) * smoothstep(1.0, 1.0 - w, x);
    float ends = smoothstep(0.0, 0.1, vV) * (1.0 - smoothstep(0.82, 1.0, vV));
    float a = (0.16 + 0.66 * streak) * edge * ends;
    vec3 c = mix(uColor * 0.85 + 0.06, vec3(0.95, 0.97, 1.0), 0.3 + 0.6 * streak + 0.15 * vV);
    gl_FragColor = vec4(c, a);
  }`;
const FOAM_FS = `uniform float uTime; varying vec2 vUv2; varying float vV;
  float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n1(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
  void main(){
    // Churning foam round the foot: drifting patches in an uneven round pool, thinning outward. (Plain 2D noise: the
    // old pattern ran round the centre and pinched into a star there.)
    vec2 q = (vUv2 - 0.5) * 2.0; float r = length(q);
    vec2 w = vUv2 * 6.0;
    float f = n1(w + vec2(uTime * 0.6, -uTime * 0.4)) * 0.6 + n1(w * 2.3 - vec2(uTime * 0.9, uTime * 0.7) + 3.0) * 0.4;
    float pool = 1.0 - smoothstep(0.3 + 0.3 * n1(w * 0.7 + uTime * 0.2), 1.0, r);
    float a = smoothstep(0.4, 0.72, f) * pool * 0.85;
    gl_FragColor = vec4(vec3(0.96, 0.98, 1.0), a);
  }`;

export class WaterfallFx {
  group = new THREE.Group();
  private items: { fall: Fall; ems: Emitter[]; views: ParticleView[]; meshes: THREE.Mesh[] }[] = [];
  private time = { value: 0 };
  enabled = true;
  constructor() { this.group.name = 'waterfalls'; }

  set(falls: Fall[], waterColor = '#5f9fb8') {
    this.clear();
    const sheet = builtinEffect('pc:waterfall') ?? [], mist = builtinEffect('pc:waterfall-mist') ?? [];
    const curtainMat = new THREE.ShaderMaterial({ uniforms: { uTime: this.time, uColor: { value: new THREE.Color(waterColor) } }, vertexShader: CURTAIN_VS, fragmentShader: CURTAIN_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const foamMat = new THREE.ShaderMaterial({ uniforms: { uTime: this.time }, vertexShader: CURTAIN_VS, fragmentShader: FOAM_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    // (At most 24, the tallest first.)
    for (const f of [...falls].sort((a, b) => b.drop - a.drop).slice(0, 24)) {
      const meshes: THREE.Mesh[] = [];
      const isFall = f.steep >= FALL_STEEPNESS;
      // The curtain: a strip down the river's path from the lip to the foot, a little above the water, pushed out from
      // the face so it stands as a sheet of falling water. (Rapids have none: a sheet lying along a gentle slope looked
      // like a pale panel on the river.)
      if (isFall) {
        const P = f.path, pos: number[] = [], uv: number[] = [], vv: number[] = [], idx: number[] = [];
        let total = 0; const along = [0]; for (let k = 1; k < P.length; k++) { total += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1], P[k][2] - P[k - 1][2]); along.push(total); }
        for (let k = 0; k < P.length; k++) {
          const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)], dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l;
          for (const s of [-1, 1]) { pos.push(P[k][0] + nx * f.width * s, P[k][1] + 0.25, P[k][2] + nz * f.width * s); uv.push(s < 0 ? 0 : 1, along[k] / 3); vv.push(along[k] / Math.max(1e-3, total)); }
          if (k + 1 < P.length) { const q = k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aV', new THREE.Float32BufferAttribute(vv, 1)); g.setIndex(idx);
        const m = new THREE.Mesh(g, curtainMat); m.renderOrder = 3; meshes.push(m);
      }
      // Foam at the foot.
      if (isFall) {
        const r = f.width * 1.6 + f.drop * 0.15, g = new THREE.PlaneGeometry(r * 2, r * 2); g.rotateX(-Math.PI / 2);
        g.setAttribute('aV', new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count).fill(1), 1));
        const m = new THREE.Mesh(g, foamMat); m.position.set(f.bx, f.by + 0.08, f.bz); m.renderOrder = 3; meshes.push(m);
      }
      for (const m of meshes) this.group.add(m);
      // Spray off the lip and mist at the foot (ParticleCraft's presets), lighter than the presets' own.
      const ems: Emitter[] = [];
      const fallTime = Math.sqrt((2 * Math.max(1, f.drop)) / 9.8) + 0.25;
      sheet.forEach((l, i) => {
        const rate = l.params.rate * Math.min(2, f.width / 3) * (isFall ? 0.45 : 0.18);
        const e = new Emitter(`wf:${f.x}:${f.z}:s${i}`, { ...l.params, lifetime: fallTime, lifetimeVar: 0.15, emitterRotation: [0, f.yaw, 0], emitterScale: f.width * 1.6, rate, alphaStart: (l.params.alphaStart ?? 1) * 0.55, maxParticles: Math.ceil(rate * (fallTime + 0.4)) + 40 }, l.name);
        e.position = [f.x, f.y + 0.1, f.z]; e.plane = 'xz'; ems.push(e);
      });
      if (isFall) mist.forEach((l, i) => {
        const e = new Emitter(`wf:${f.x}:${f.z}:m${i}`, { ...l.params, rate: l.params.rate * 0.5, sizeStart: l.params.sizeStart * Math.min(1, 0.4 + f.drop / 20), alphaStart: (l.params.alphaStart ?? 1) * 0.7, emitterScale: Math.max(1, f.width * 0.5) }, l.name);
        e.position = [f.bx, f.by + 0.3, f.bz]; e.plane = 'xz'; ems.push(e);
      });
      linkEmitters(ems);
      const views = ems.map((e) => new ParticleView(e));
      for (const v of views) this.group.add(v.points);
      this.items.push({ fall: f, ems, views, meshes });
    }
  }
  get count() { return this.items.length; }
  /** Advances and draws those within `reach` of the camera. */
  update(dt: number, pixelScale: number, cam: THREE.Vector3, reach = 600) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.time.value += dt;
    for (const it of this.items) {
      const near = Math.hypot(it.fall.x - cam.x, it.fall.z - cam.z) < reach;
      for (const v of it.views) v.points.visible = near;
      for (const m of it.meshes) m.visible = near;
      if (!near) continue;
      for (const e of it.ems) { e.update(dt); if (!e.params.looping && e.done) e.restart(); }
      for (const v of it.views) v.update(pixelScale, false);
    }
  }
  clear() {
    for (const it of this.items) { for (const v of it.views) { this.group.remove(v.points); v.dispose(); } for (const m of it.meshes) { this.group.remove(m); m.geometry.dispose(); } }
    this.items = [];
  }
}
