// Footprints and trails in the snow: a picture of how far the snow has been pressed down (0 untouched .. 1 packed to
// the ground), over an area round whoever is walking. The terrain reads it twice: its surface sinks there (you push
// through deep snow), and each print is shaded by its own slopes and packed-snow colour. Prints fill in again over
// time (Track life, Recovery speed: falling snow and wind).
import * as THREE from 'three';

const N = 512;

export class SnowTrail {
  /** Metres the picture covers, centred on `cx, cz`. */
  readonly size = 96;
  private data = new Uint8Array(N * N);
  private tex = new THREE.DataTexture(this.data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  private cx = 0; private cz = 0; private fade = 0;
  readonly uniforms = { uTrail: { value: this.tex as THREE.Texture }, uTrailBox: { value: new THREE.Vector3(0, 0, this.size) } };

  constructor() { this.tex.magFilter = THREE.LinearFilter; this.tex.minFilter = THREE.LinearFilter; this.tex.needsUpdate = true; }

  /** Keeps the area round `x, z`: moved in whole pixels when the walker nears its edge, so prints stay where they are. */
  follow(x: number, z: number) {
    if (Math.abs(x - this.cx) < this.size * 0.3 && Math.abs(z - this.cz) < this.size * 0.3) return;
    const px = this.size / N, dx = Math.round((x - this.cx) / px), dz = Math.round((z - this.cz) / px);
    const next = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) { const sj = j + dz; if (sj < 0 || sj >= N) continue; for (let i = 0; i < N; i++) { const si = i + dx; if (si >= 0 && si < N) next[j * N + i] = this.data[sj * N + si]; } }
    this.data.set(next); this.cx += dx * px; this.cz += dz * px;
    this.uniforms.uTrailBox.value.set(this.cx, this.cz, this.size); this.tex.needsUpdate = true;
  }

  /** Presses an oval (a footprint, `len` long and `wid` wide, turned `angle` radians) to `depth` (0..1), soft-edged. */
  stamp(x: number, z: number, angle: number, len: number, wid: number, depth: number) {
    const px = this.size / N, r = Math.max(len, wid) / 2 + px * 2;
    const ci = (x - this.cx) / px + N / 2, cj = (z - this.cz) / px + N / 2, c = Math.cos(angle), s = Math.sin(angle);
    for (let j = Math.floor(cj - r / px); j <= cj + r / px; j++) for (let i = Math.floor(ci - r / px); i <= ci + r / px; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const wx = (i - ci) * px, wz = (j - cj) * px, u = (wx * c + wz * s) / (len / 2), v = (-wx * s + wz * c) / (wid / 2);
      const d = Math.hypot(u, v); if (d > 1.15) continue;
      // A print: flat-bottomed, with a soft rim; a little deeper at the heel than the toe.
      const k = Math.min(1, (1.15 - d) / 0.3) * depth * (0.88 + 0.12 * Math.max(0, -u));
      const at = j * N + i; this.data[at] = Math.max(this.data[at], Math.round(k * 255));
    }
    this.tex.needsUpdate = true;
  }

  /** A trench ploughed from one point to the next (pushing through deep snow), `wid` wide, to `depth`. */
  furrow(x0: number, z0: number, x1: number, z1: number, wid: number, depth: number) {
    const l = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(l / 0.1)), a = Math.atan2(z1 - z0, x1 - x0);
    for (let k = 0; k <= steps; k++) this.stamp(x0 + ((x1 - x0) * k) / steps, z0 + ((z1 - z0) * k) / steps, a, wid, wid, depth);
  }

  /** Prints fill in: over `life` seconds (0: they stay), faster with `recovery`. */
  update(dt: number, life: number, recovery: number) {
    const rate = (life > 0 ? 1 / life : 0) + Math.max(0, recovery) * 0.004;
    if (rate <= 0) return;
    this.fade += dt * rate * 255;
    if (this.fade < 1) return;
    const step = Math.floor(this.fade); this.fade -= step;
    let any = false;
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) { this.data[i] = Math.max(0, this.data[i] - step); any = true; }
    if (any) this.tex.needsUpdate = true;
  }

  clear() { this.data.fill(0); this.tex.needsUpdate = true; }
}
