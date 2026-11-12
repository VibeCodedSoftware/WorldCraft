// Rain and snow in the 3D view, as SpriteCraft draws its pixel weather (SpriteCraft/src/core/weather.ts): the same
// presets, three depth layers (far drops slower, shorter and in the far colour), streaks slanted by the wind, flakes
// that sway and come in SpriteCraft's 1 to 4 pixel shapes, and little crowns of splash where rain hits the ground.
// Everything is worked out in the shader from each drop's own random numbers and the time, in boxes that follow the
// camera, so it costs nothing to keep going.
import * as THREE from 'three';

export type FallKind = 'rain' | 'snow' | 'dust';
export interface FallPreset { name: string; kind: FallKind; amount: number; speed: number; speedVar: number; wind: number; sway: number; length: number; size: number; near: string; far: string; splash: string; splashes: boolean; depths: [boolean, boolean, boolean] }

/** SpriteCraft's weather presets (its defaults filled in), in its own units: pixels, pixels a second, degrees. */
const RAIN = { kind: 'rain' as const, amount: 6, speed: 220, speedVar: 0.25, wind: 12, sway: 0, length: 6, size: 1, near: '#c0d8ff', far: '#5a6c96', splash: '#e0ecff', splashes: true, depths: [true, true, true] as [boolean, boolean, boolean] };
const SNOW = { kind: 'snow' as const, amount: 4, speed: 22, speedVar: 0.3, wind: 8, sway: 3, length: 0, size: 3, near: '#ffffff', far: '#8fa3c4', splash: '#ffffff', splashes: false, depths: [true, true, true] as [boolean, boolean, boolean] };
export const FALL_PRESETS: FallPreset[] = [
  { ...RAIN, name: 'Drizzle', amount: 3, speed: 150, length: 3, wind: 6, splashes: false, depths: [true, true, false] },
  { ...RAIN, name: 'Light rain', amount: 4, speed: 200, length: 5, wind: 10 },
  { ...RAIN, name: 'Heavy rain', amount: 10, speed: 260, length: 8, wind: 14 },
  { ...RAIN, name: 'Storm', amount: 14, speed: 320, length: 10, wind: 35, speedVar: 0.35, sway: 1, near: '#d0e0ff', far: '#46506e' },
  { ...SNOW, name: 'Light snow', amount: 2, speed: 16, sway: 3, size: 2 },
  { ...SNOW, name: 'Snowfall', amount: 4, speed: 22, sway: 3, size: 3 },
  { ...SNOW, name: 'Blizzard', amount: 9, speed: 45, wind: 50, sway: 5, size: 3, speedVar: 0.5 },
  { ...SNOW, name: 'Big flakes', amount: 1.5, speed: 14, sway: 5, size: 4 },
  { ...SNOW, kind: 'dust', name: 'Dust', amount: 5, speed: 6, wind: 70, sway: 6, size: 2, near: '#c9ae7c', far: '#9a8462', speedVar: 0.6 },
];
/** The preset a weather type falls back to. */
export const presetFor = (type: string, chosen?: string): FallPreset | null => {
  const kind: FallKind | null = type === 'rain' || type === 'storm' ? 'rain' : type === 'snow' ? 'snow' : type === 'dust' ? 'dust' : null;
  if (!kind) return null; // (clear, fog, mist: nothing falls, whatever preset was picked)
  const named = chosen ? FALL_PRESETS.find((p) => p.name === chosen) : undefined;
  if (named && named.kind === kind) return named;
  return FALL_PRESETS.find((p) => p.name === (type === 'storm' ? 'Storm' : type === 'rain' ? 'Light rain' : type === 'snow' ? 'Snowfall' : 'Dust'))!;
};

/** Pixels to metres: SpriteCraft's 16 pixels a metre for sizes; falling speeds are a game's, so a little brisker. */
const PX = 1 / 16, FALL = 1 / 9;
const DEPTH = [{ speed: 0.45, len: 0.4, box: 110, size: 0.34 }, { speed: 0.7, len: 0.7, box: 55, size: 0.67 }, { speed: 1, len: 1, box: 26, size: 1 }];
const MAX = 9000;

/** SpriteCraft's flake shapes, 1 to 4 pixels: dot, square, plus, star. */
function flakeTexture(size: number) {
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const g = c.getContext('2d')!; g.fillStyle = '#fff';
  const put = (x: number, y: number) => g.fillRect(3 + x, 3 + y, 1, 1);
  put(0, 0);
  if (size >= 2) { put(1, 0); put(0, 1); put(1, 1); }
  if (size >= 3) { put(-1, 0); put(0, -1); put(2, 1); put(1, 2); }
  if (size >= 4) { put(-1, -1); put(2, -1); put(-1, 2); put(2, 2); }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}
/** A splash crown, then droplets thrown out: SpriteCraft's splash in a few frames across one picture. */
function splashTexture() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 8;
  const g = c.getContext('2d')!; g.fillStyle = '#fff';
  // frame 0: crown; 1: two drops up; 2: drops out and down; 3: nearly gone
  [[[2, 5], [5, 5], [1, 4], [6, 4]], [[1, 3], [6, 3], [3, 6], [4, 6]], [[0, 4], [7, 4]], [[0, 6], [7, 6]]].forEach((f, i) => f.forEach(([x, y]) => g.fillRect(i * 8 + x, y, 1, 1)));
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}

export class WeatherFx {
  readonly group = new THREE.Group();
  private rain: THREE.LineSegments; private snow: THREE.Points; private splash: THREE.Points;
  private u = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uSpeed: { value: 20 }, uSpeedVar: { value: 0.25 }, uLen: { value: 0.6 }, uSway: { value: 0 }, uNear: { value: new THREE.Color() }, uFar: { value: new THREE.Color() }, uSize: { value: 3 }, uPx: { value: 600 }, uOn: { value: new THREE.Vector3(1, 1, 1) }, uFloor: { value: -1e9 } };
  private flakes = new Map<number, THREE.Texture>();
  private splashU = { uTime: { value: 0 }, uMap: { value: splashTexture() }, uColor: { value: new THREE.Color('#e0ecff') }, uPx: { value: 600 } };
  private splashT = 0; private splashI = 0;

  constructor() {
    this.group.name = 'Weather';
    // Each drop: two vertices (head and tail), its depth layer and three random numbers.
    const seeds = new Float32Array(MAX * 2 * 3), ends = new Float32Array(MAX * 2), depth = new Float32Array(MAX * 2);
    let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < MAX; i++) {
      const a = rnd(), b = rnd(), c = rnd(), d = i % 3;
      for (let e = 0; e < 2; e++) { const k = i * 2 + e; seeds.set([a, b, c], k * 3); ends[k] = e; depth[k] = d; }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(seeds, 3)); rg.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1)); rg.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    const common = `uniform float uTime, uSpeed, uSpeedVar, uLen, uSway, uSize, uPx, uFloor; uniform vec3 uCam, uOn; uniform vec2 uWind; varying float vDepth;
      float boxOf(float d) { return d < 0.5 ? ${DEPTH[0].box.toFixed(1)} : d < 1.5 ? ${DEPTH[1].box.toFixed(1)} : ${DEPTH[2].box.toFixed(1)}; }
      vec3 dropRaw(vec3 seed, float d, float t) {
        float sp = uSpeed * (d < 0.5 ? ${DEPTH[0].speed} : d < 1.5 ? ${DEPTH[1].speed} : 1.0) * (1.0 + (fract(seed.x * 13.7) * 2.0 - 1.0) * uSpeedVar);
        vec3 q = seed * boxOf(d);
        q.y -= t * sp;
        q.xz += uWind * t * (sp / max(0.01, uSpeed));
        q.x += uSway * sin(t * 1.7 + seed.z * 31.0);
        q.z += uSway * cos(t * 1.3 + seed.y * 17.0);
        return q;
      }
      // Where the drop is now, in its box round the camera; a lag gives where it was, on the same side of the box.
      vec3 dropAt(vec3 seed, float d, float lag) {
        float box = boxOf(d);
        vec3 now = dropRaw(seed, d, uTime);
        vec3 head = mod(now - uCam + box * 0.5, box) - box * 0.5 + uCam;
        return lag > 0.0 ? head + (dropRaw(seed, d, uTime - lag) - now) : head;
      }`;
    this.rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.u,
      vertexShader: `${common} attribute float aEnd, aDepth;
        void main() {
          vDepth = aDepth;
          float lenK = aDepth < 0.5 ? ${DEPTH[0].len} : aDepth < 1.5 ? ${DEPTH[1].len} : 1.0;
          // The tail is where the head was a moment ago: a streak along the drop's slanted path.
          vec3 p = dropAt(position, aDepth, aEnd * uLen * lenK / max(0.5, uSpeed));
          if (uOn[int(aDepth)] < 0.5 || p.y < uFloor) p = vec3(0.0, -1e5, 0.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform vec3 uNear, uFar; varying float vDepth;
        void main() { gl_FragColor = vec4(mix(uFar, uNear, vDepth < 0.5 ? 0.0 : vDepth < 1.5 ? 0.6 : 1.0), vDepth < 0.5 ? 0.5 : 0.8); }`,
    }));
    this.rain.frustumCulled = false;
    // Snow and dust: a point a flake, in SpriteCraft's pixel shapes, kept whole pixels in size.
    const sg = new THREE.BufferGeometry();
    const sSeeds = new Float32Array(MAX * 3), sDepth = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) { sSeeds.set([rnd(), rnd(), rnd()], i * 3); sDepth[i] = i % 3; }
    sg.setAttribute('position', new THREE.BufferAttribute(sSeeds, 3)); sg.setAttribute('aDepth', new THREE.BufferAttribute(sDepth, 1));
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { ...this.u, uMap: { value: this.flake(3) } },
      vertexShader: `${common} attribute float aDepth;
        void main() {
          vDepth = aDepth;
          vec3 p = dropAt(position, aDepth, 0.0);
          if (uOn[int(aDepth)] < 0.5 || p.y < uFloor) p = vec3(0.0, -1e5, 0.0);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float k = aDepth < 0.5 ? ${DEPTH[0].size} : aDepth < 1.5 ? ${DEPTH[1].size} : 1.0;
          gl_PointSize = max(1.0, floor(clamp(uSize * k * ${PX.toFixed(4)} * 2.2 * uPx / max(1.0, -mv.z), 1.0, 24.0)));
        }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uNear, uFar; varying float vDepth;
        void main() { float a = texture2D(uMap, gl_PointCoord).r; if (a < 0.5) discard; gl_FragColor = vec4(mix(uFar, uNear, vDepth < 0.5 ? 0.0 : vDepth < 1.5 ? 0.6 : 1.0), 0.95); }`,
    }));
    this.snow.frustumCulled = false;
    // Splashes: points on the ground near the camera, each playing the crown once and moving on.
    const n = 260, pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1e5), 3)); pg.setAttribute('aBorn', new THREE.BufferAttribute(new Float32Array(n).fill(-10), 1));
    this.splash = new THREE.Points(pg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.splashU,
      vertexShader: `uniform float uTime, uPx; attribute float aBorn; varying float vF;
        void main() { vec4 mv = viewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vF = (uTime - aBorn) / 0.22; gl_PointSize = vF < 0.0 || vF > 1.0 ? 0.0 : max(4.0, floor(0.5 * uPx / max(1.0, -mv.z))); }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uColor; varying float vF;
        void main() { float f = floor(clamp(vF, 0.0, 0.999) * 4.0); vec2 uv = vec2((f + gl_PointCoord.x) / 4.0, 1.0 - gl_PointCoord.y); if (texture2D(uMap, uv).r < 0.5) discard; gl_FragColor = vec4(uColor, 0.85); }`,
    }));
    this.splash.frustumCulled = false;
    this.group.add(this.rain, this.snow, this.splash);
  }
  private flake(size: number) { let t = this.flakes.get(size); if (!t) { t = flakeTexture(size); this.flakes.set(size, t); } return t; }

  /**
   * `preset` null: nothing falls. `amount` 0..1 scales the preset's density. `windDir`: radians; `windSpeed` m/s.
   * `ground(x, z)` places splashes; `floor` is the lowest anything falls (the sea).
   */
  update(preset: FallPreset | null, amount: number, o: { time: number; dt: number; camera: THREE.PerspectiveCamera; pixelHeight: number; windDir: number; windSpeed: number; splashes: boolean; ground: (x: number, z: number) => number; floor: number }) {
    this.group.visible = !!preset && amount > 0;
    if (!preset || amount <= 0) return;
    const u = this.u;
    u.uTime.value = o.time; u.uCam.value.copy(o.camera.position); u.uFloor.value = o.floor;
    u.uSpeed.value = preset.speed * FALL; u.uSpeedVar.value = preset.speedVar;
    // SpriteCraft's slant: tan(wind) across per unit fallen, plus the world's own wind.
    const slant = Math.tan((Math.max(-75, Math.min(75, preset.wind)) * Math.PI) / 180) * preset.speed * FALL;
    const w = slant + o.windSpeed * (preset.kind === 'rain' ? 0.6 : 1);
    u.uWind.value.set(Math.cos(o.windDir) * w, Math.sin(o.windDir) * w);
    // Streaks: SpriteCraft's length in pixels, as metres of fall (8 px, heavy rain, is about a metre).
    u.uSway.value = preset.sway * PX * 4; u.uLen.value = preset.length * PX * 2;
    u.uNear.value.set(preset.near); u.uFar.value.set(preset.far); u.uSize.value = preset.size;
    u.uPx.value = o.pixelHeight / (2 * Math.tan((o.camera.fov * Math.PI) / 360));
    u.uOn.value.set(preset.depths[0] ? 1 : 0, preset.depths[1] ? 1 : 0, preset.depths[2] ? 1 : 0);
    const count = Math.round(Math.min(MAX, preset.amount * 520 * Math.max(0.05, Math.min(1.5, amount * 2))));
    const isRain = preset.kind === 'rain';
    this.rain.visible = isRain; this.snow.visible = !isRain;
    if (isRain) this.rain.geometry.setDrawRange(0, count * 2);
    else { this.snow.geometry.setDrawRange(0, count); (this.snow.material as THREE.ShaderMaterial).uniforms.uMap.value = this.flake(Math.max(1, Math.min(4, Math.round(preset.size)))); }
    // Splashes: a few new ones each frame, round the camera, on the ground.
    const on = isRain && preset.splashes && o.splashes;
    this.splash.visible = on;
    if (!on) return;
    this.splashU.uTime.value = o.time; this.splashU.uColor.value.set(preset.splash); this.splashU.uPx.value = u.uPx.value;
    const pos = this.splash.geometry.getAttribute('position') as THREE.BufferAttribute, born = this.splash.geometry.getAttribute('aBorn') as THREE.BufferAttribute;
    this.splashT += o.dt * preset.amount * 60 * Math.min(1.5, amount * 2);
    const cam = o.camera.position;
    while (this.splashT >= 1) {
      this.splashT -= 1;
      const k = this.splashI++ % pos.count, a = Math.random() * Math.PI * 2, r = 1.5 + Math.sqrt(Math.random()) * 24;
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r, y = Math.max(o.ground(x, z), o.floor);
      pos.setXYZ(k, x, y + 0.05, z); born.setX(k, o.time - Math.random() * 0.03);
    }
    pos.needsUpdate = true; born.needsUpdate = true;
  }
}
