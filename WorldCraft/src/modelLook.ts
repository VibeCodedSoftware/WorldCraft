// Pictures, and how supplied models get theirs. The new grass models are bare cards and the Tree models bare wood, with no
// textures in the files: here they get their grass picture or wood material, and the trees get leaves from our leaf system.
// The files themselves aren't changed.
import * as THREE from 'three';
import { leafDefaults, leafMesh, type TreeMesh } from '@shared/src/world/generators';
import { hairOnMesh, modelHairDefaults } from '@shared/src/world/leafHair';
import type { ModelWood, WorldConfig } from '@shared/src/world/document';
import { assetUrl } from './store';

/** Average brightness of a picture's visible pixels, in linear light. */
function meanLum(g: CanvasRenderingContext2D, w: number, h: number) {
  const d = g.getImageData(0, 0, w, h).data, step = Math.max(1, Math.floor((w * h) / 20000)) * 4, lin = (v: number) => Math.pow(v / 255, 2.2);
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += step) if (d[i + 3] > 80) { sum += 0.3 * lin(d[i]) + 0.55 * lin(d[i + 1]) + 0.15 * lin(d[i + 2]); n++; }
  return n ? sum / n : 0.15;
}

/** Pictures with opaque black where they should be see-through get real transparency here too. */
function keyedTexture(url: string, pixel: boolean, srgb = true): THREE.Texture {
  const t = new THREE.Texture();
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const closest = () => { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; };
  if (pixel) closest();
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    // Pictures this small are pixel art whatever they're called: Closest, never blurred.
    if (Math.max(img.width, img.height) <= 128) closest();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0);
    if (srgb && /\.(png|webp)/i.test(url)) {
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data, w = c.width, h = c.height;
      const black = (i: number) => p[i + 3] > 100 && p[i] + p[i + 1] + p[i + 2] < 30;
      if ([0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4].every(black)) { for (let i = 0; i < p.length; i += 4) if (p[i] + p[i + 1] + p[i + 2] < 30) p[i + 3] = 0; g.putImageData(d, 0, 0); }
    }
    t.userData.meanLum = meanLum(g, c.width, c.height);
    t.image = c; t.needsUpdate = true;
  };
  // A picture that can't load must not draw black: a texture with no image samples as black. A plain stand-in, and say so.
  img.onerror = () => {
    console.warn('WorldCraft: could not load picture', url);
    const c = document.createElement('canvas'); c.width = c.height = 2;
    const g = c.getContext('2d')!;
    g.fillStyle = /normal/i.test(url) ? '#8080ff' : !srgb ? '#808080' : /leaf|leaves|pine|grass/i.test(url) ? '#5c7f3a' : '#7a6248';
    g.fillRect(0, 0, 2, 2);
    t.userData.meanLum = 0.15;
    t.image = c; t.needsUpdate = true;
  };
  img.src = url;
  return t;
}
const texCache = new Map<string, THREE.Texture>();
export function tex(id: string, o: { pixel?: boolean; repeat?: boolean; srgb?: boolean; uv?: [number, number, number] } = {}) {
  const url = assetUrl(id); if (!url) return null;
  const key = id + JSON.stringify(o);
  let t = texCache.get(key);
  if (!t) {
    t = keyedTexture(url, !!o.pixel || /pixel/i.test(id), o.srgb !== false);
    if (o.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (o.uv) { t.repeat.set(o.uv[0], o.uv[1]); t.rotation = (o.uv[2] * Math.PI) / 180; }
    texCache.set(key, t);
  }
  return t;
}

const G = 'lib:world/grass/pictures/';
const GRASS_PICS: Record<string, string> = {
  PixelArtGrass: G + 'PixelArt-GrassCard.png', PixelArtGrass2: G + 'PixelArt-GrassCard2.png',
  RealisticGrass: G + 'RealisticGrass.png', 'Realistic Grass': G + 'RealisticGrass.png', Realistic_Grass_2: G + 'RealisticGrass.png', Stylized_Grass_1: G + 'grass-stylized.png',
};

/** Two-sided cards: the back of one mustn't go black because its normal flips. */
function softBacks(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);'); };
  m.customProgramCacheKey = () => 'softBacks';
  return m;
}

/** The grass picture a model wears, if it wears one. */
export const grassPictureOf = (id: string) => GRASS_PICS[stemOf(id)] as string | undefined;

export const woodOf = (cfg: WorldConfig | null, id: string, n: number): ModelWood => ({ set: ((n - 1) % 4) + 1, u: 1, v: 0.15, rot: 0, ...cfg?.modelWood?.[id] });

export function woodMaterial(n: number, uv: [number, number, number] = [1, 1, 0]) {
  const a = (name: string, srgb: boolean) => tex(`lib:world/woods/Wood${n}/Wood${n}_${name}.jpg`, { repeat: true, srgb, uv });
  // (These barks are dark pictures, and a trunk stands in its own shade: brightened, and no extra darkening from AO.)
  return new THREE.MeshStandardMaterial({ name: 'Wood', map: a('Diffuse', true), normalMap: a('Normal', false), roughnessMap: a('Roughness', false), roughness: 1, metalness: 0, color: new THREE.Color(2.6, 2.6, 2.6) });
}

/** Painted by the thousand, as a layer of instances, rather than one object per dab: grass models and 2D cards. */
export const paintsInBulk = (id: string) => id.startsWith('card:') || /\/grass\//i.test(id);
export const bulkLayerId = (id: string) => 'painted_' + id.replace(/[^A-Za-z0-9]+/g, '_');
export const bulkLayerName = (id: string) => 'Painted ' + stemOf(id.replace(/^card:/, ''));

const stemOf = (id: string) => decodeURIComponent(id.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
export const isHeavyName = (id: string) => /^Tree\d+$/.test(stemOf(id));

/** Gives a loaded supplied model its look. Safe on anything else: unknown models are left as they are. */
export function dressModel(id: string, root: THREE.Object3D, cfg: WorldConfig | null = null) {
  const stem = stemOf(id);
  const pic = GRASS_PICS[stem];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.dressed) meshes.push(o as THREE.Mesh); });
  const treeNo = /^Tree(\d+)$/.exec(stem);
  // (Loaded models are shared, and their clones keep the look. Only their leaves can change, with the settings.)
  const wood = () => {
    if (!treeNo) return;
    const w = woodOf(cfg, id, Number(treeNo[1])), sig = JSON.stringify(w);
    if (root.userData.woodSig === sig) return;
    root.userData.woodSig = sig;
    for (const m of meshes) m.material = woodMaterial(w.set, [w.u, w.v, w.rot]);
  };
  if (root.userData.dressedModel) { if (treeNo) { wood(); addLeaves(root, meshes, Number(treeNo[1]), cfg, id); } return; }
  root.userData.dressedModel = true;
  if (stem === 'Realsitc-ish Grass') {
    // Real 3D blades, one colour: lit like the ground, and its own vertex colours left out so a colour over it comes out true.
    const mat = softBacks(new THREE.MeshStandardMaterial({ name: 'Grass', color: '#4f9a35', side: THREE.DoubleSide, roughness: 0.95 }));
    for (const m of meshes) { m.geometry = m.geometry.clone(); m.geometry.deleteAttribute('color'); const nor = m.geometry.getAttribute('normal'); if (nor) for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0); m.material = mat; }
    return;
  }
  if (stem === 'StylizedGrass') {
    // A clump of 3D blades in one plain colour: lit like the ground (normals up), so it sits in it from every side.
    const mat = softBacks(new THREE.MeshStandardMaterial({ name: 'Grass', color: '#5fae3e', side: THREE.DoubleSide, roughness: 0.9 }));
    for (const m of meshes) { m.geometry = m.geometry.clone(); m.geometry.deleteAttribute('color'); const nor = m.geometry.getAttribute('normal'); if (nor) for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0); m.material = mat; }
    return;
  }
  if (stem === 'StylizedGrass_2') { bladeClump(root, meshes); return; }
  if (pic) {
    const t = tex(pic);
    const mat = softBacks(new THREE.MeshStandardMaterial({ name: 'Grass', map: t, alphaTest: 0.25, side: THREE.DoubleSide, roughness: 0.95, color: /RealisticGrass\.png$/.test(pic) ? new THREE.Color(3.4, 3.8, 3.2) : '#ffffff' })); // (that photo is dark; a plain multiply brings it to grass level)
    for (const m of meshes) {
      // Lit like the ground it grows from, from every side, here and wherever it's exported to.
      if (m.geometry.getAttribute('normal')) { m.geometry = m.geometry.clone(); const nor = m.geometry.getAttribute('normal'); for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0); }
      // Blades whose UVs are all one point can't show a picture: plain leaf green.
      const uv = m.geometry.getAttribute('uv'); let span = 0;
      if (uv) for (let i = 1; i < uv.count; i++) span = Math.max(span, Math.abs(uv.getX(i) - uv.getX(0)), Math.abs(uv.getY(i) - uv.getY(0)));
      m.material = span > 0.01 ? mat : new THREE.MeshStandardMaterial({ name: 'Grass', color: '#4f9a35', side: THREE.DoubleSide, roughness: 0.95 });
      // One of the cards was exported lying flat (by its node's rotation, not its geometry): stand it up, stems down.
      root.updateMatrixWorld(true);
      const s = new THREE.Box3().setFromObject(m, true).getSize(new THREE.Vector3());
      if (s.y < Math.max(s.x, s.z) * 0.02) {
        const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(m.matrixWorld));
        const pos = g.getAttribute('position'), tex0 = g.getAttribute('uv');
        let lean = 0; for (let i = 0; i < pos.count; i++) lean += (tex0 ? tex0.getY(i) - 0.5 : 0) * pos.getZ(i);
        g.rotateX(lean >= 0 ? -Math.PI / 2 : Math.PI / 2);
        g.computeBoundingBox(); g.translate(0, -g.boundingBox!.min.y, 0);
        m.geometry = g; root.add(m); m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1); m.updateMatrixWorld(true);
      }
    }
    return;
  }
  if (treeNo) { wood(); addLeaves(root, meshes, Number(treeNo[1]), cfg, id); return; }
  if (/^StylizedTree\d/.test(stem)) for (const m of meshes) softCrown(m);
  for (const m of meshes) {
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const next = list.map((x) => {
      // Leaf cut-outs: their picture's edges average out when drawn small (far away, in a thumbnail), and a high
      // cut-off then dropped every leaf, leaving bare branches. A lower one keeps the crown at every size.
      const xs = x as THREE.MeshStandardMaterial;
      if (xs.map && xs.alphaTest >= 0.4) { xs.alphaTest = 0.2; xs.transparent = false; xs.needsUpdate = true; }
      if (xs.map && xs.alphaTest > 0) whenLoaded(xs.map, bleedCutout);
      // (A trunk with its own picture, as in the .blend models, keeps it.)
      if (/trunk/i.test(x.name) && !(x as THREE.MeshStandardMaterial).map) return woodMaterial(1);
      // The stylized trees' leaf colours are nearly black in the file: lifted to read as the green they're meant to be.
      const c = (x as THREE.MeshStandardMaterial).color;
      if (/^StylizedTree/.test(stem) && c && c.r + c.g + c.b < 0.3) { c.r += 0.03; c.multiplyScalar(0.34 / Math.max(0.02, c.r + c.g + c.b)); }
      return x;
    });
    m.material = Array.isArray(m.material) ? next : next[0];
  }
}

/**
 * Stylized trees are lit as one soft, rounded crown, not leaf by leaf: each leaf's normal points out from the crown's
 * middle, so the crown is bright on the sunny side and shades smoothly round to the other, and the flat stylized
 * leaf picture reads as it does in Blender. Leaves are the material groups with a cut-out picture; the trunk is left.
 */
function softCrown(m: THREE.Mesh) {
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const isLeaf = (i: number) => { const x = mats[i] as THREE.MeshStandardMaterial | undefined; return !!x && (/leaf|foli/i.test(x.name) || (!!x.map && x.alphaTest > 0 && !/trunk|bark|wood/i.test(x.name))); };
  const g = m.geometry.clone(), pos = g.getAttribute('position'), nor = g.getAttribute('normal');
  if (!pos || !nor) return;
  const ranges = g.groups.length ? g.groups.filter((gr) => isLeaf(gr.materialIndex ?? 0)).map((gr) => [gr.start, gr.start + gr.count]) : isLeaf(0) ? [[0, pos.count]] : [];
  if (!ranges.length) return;
  const idx = g.index, vert = (i: number) => (idx ? idx.getX(i) : i);
  const c = new THREE.Vector3(), v = new THREE.Vector3(); let n = 0;
  for (const [a, b] of ranges) for (let i = a; i < b; i++) { c.add(v.fromBufferAttribute(pos, vert(i))); n++; }
  c.divideScalar(Math.max(1, n));
  for (const [a, b] of ranges) for (let i = a; i < b; i++) { const k = vert(i); v.fromBufferAttribute(pos, k).sub(c).normalize(); nor.setXYZ(k, v.x, v.y, v.z); }
  nor.needsUpdate = true;
  m.geometry = g;
  // (Both sides of a leaf card keep the crown's normal: flipped on the back, half the leaves faced inward and went dark.)
  mats.forEach((x, i) => { if (isLeaf(i)) { const s = x as THREE.MeshStandardMaterial; s.roughness = 0.95; s.side = THREE.DoubleSide; softBacks(s); s.needsUpdate = true; } });
}

/** Runs `fn` once the texture has its picture (loaders attach it only when it has loaded). */
export function whenLoaded(t: THREE.Texture, fn: (t: THREE.Texture) => void) {
  const ok = () => { const img = t.source?.data as HTMLImageElement | undefined; return !!img && (!('complete' in img) || (img.complete && img.naturalWidth > 0)); };
  if (ok()) { fn(t); return; }
  let n = 0; const id = setInterval(() => { if (ok()) { clearInterval(id); fn(t); } else if (++n > 200) clearInterval(id); }, 50);
}
/**
 * A cut-out picture (leaves) whose see-through pixels are white: drawn small, that white blends into the edges and the
 * crown goes pale. The see-through pixels take the picture's own average colour instead (still see-through).
 */
export function bleedCutout(t: THREE.Texture) {
  if (t.userData.bled) return;
  const img = t.source.data as HTMLImageElement | HTMLCanvasElement;
  const w = (img as HTMLImageElement).naturalWidth || img.width, h = (img as HTMLImageElement).naturalHeight || img.height;
  if (!w || !h) return;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h), p = d.data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < p.length; i += 4) if (p[i + 3] > 200) { r += p[i]; gg += p[i + 1]; b += p[i + 2]; n++; }
  if (!n) return;
  r /= n; gg /= n; b /= n;
  for (let i = 0; i < p.length; i += 4) if (p[i + 3] < 128) { p[i] = r; p[i + 1] = gg; p[i + 2] = b; }
  g.putImageData(d, 0, 0);
  t.image = c; t.userData.bled = true; t.needsUpdate = true;
}

/**
 * StylizedGrass_2.blend is one blade scattered over a plane by a Blender hair particle system, and its colour is a
 * shader-node gradient a file reader can't run. What comes through is a single dark blade (and the bare plane): it is
 * made into a clump of the blades instead, leaning and turned every way, with the gradient as vertex colours, dark at
 * the root to light at the tip.
 */
function bladeClump(root: THREE.Object3D, meshes: THREE.Mesh[]) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  // The blade: the one long thin mesh (not the flat plane the particles grew on).
  const longness = (m: THREE.Mesh) => { m.geometry.computeBoundingBox(); const s = m.geometry.boundingBox!.getSize(new THREE.Vector3()), dims = [s.x, s.y, s.z].sort((a, b) => b - a); return dims[0] / Math.max(1e-4, dims[1]); };
  const blade = [...meshes].sort((a, b) => longness(b) - longness(a))[0];
  if (!blade) return;
  const g0 = blade.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, blade.matrixWorld));
  const g = g0.index ? g0.toNonIndexed() : g0;
  g.computeBoundingBox();
  const bb = g.boundingBox!, size = bb.getSize(new THREE.Vector3());
  // Standing up: the blade's long axis is its height.
  if (size.z > size.y * 1.5) g.rotateX(-Math.PI / 2); else if (size.x > size.y * 1.5) g.rotateZ(Math.PI / 2);
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -g.boundingBox!.min.y, -c.z);
  const h = g.boundingBox!.max.y - g.boundingBox!.min.y || 1;
  g.scale(1 / h, 1 / h, 1 / h);
  const src = g.getAttribute('position');
  const pos: number[] = [], col: number[] = [], nor: number[] = [];
  // The file's own look: an even, slightly blue mid-green, darker toward the roots, some blades darker than others.
  const root0 = new THREE.Color('#2c6a42'), tip = new THREE.Color('#72c07f'), mid = new THREE.Color();
  // (Slimmer than the file's blade: there each is a hair particle a third its size, so they read as thin.)
  g.scale(0.55, 1, 0.55);
  let s = 12345; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  for (let b = 0; b < 13; b++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.3, k = 0.65 + rnd() * 0.5;
    const e = new THREE.Euler((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5, 'YXZ');
    m4.compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(k, k * (0.85 + rnd() * 0.3), k));
    const shade = rnd() < 0.3 ? 0.62 + rnd() * 0.15 : 0.9 + rnd() * 0.2;
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i);
      const t = Math.max(0, Math.min(1, v.y));
      v.applyMatrix4(m4);
      pos.push(v.x, v.y, v.z); nor.push(0, 1, 0);
      mid.copy(root0).lerp(tip, Math.min(1, t * 1.6)).multiplyScalar(shade);
      col.push(mid.r, mid.g, mid.b);
    }
  }
  const clump = new THREE.BufferGeometry();
  clump.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); clump.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); clump.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  clump.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0.5), 2));
  for (const m of meshes) m.removeFromParent();
  const mesh = new THREE.Mesh(clump, softBacks(new THREE.MeshStandardMaterial({ name: 'Grass', vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 })));
  root.add(mesh);
}

/** Bare supplied wood gets leaf particles: grown from its own triangles, the same system as generated trees. */
function addLeaves(root: THREE.Object3D, meshes: THREE.Mesh[], seed: number, cfg: WorldConfig | null, id: string) {
  const h = { ...modelHairDefaults(), ...cfg?.modelLeaves?.[id] };
  const sig = JSON.stringify([h, cfg?.leaves]);
  if (root.userData.leafSig === sig) return;
  root.userData.leafSig = sig;
  for (const old of root.children.filter((c) => c.userData.dressed)) root.remove(old);
  if (h.amount <= 0) return;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const gs = meshes.map((m) => ({ pos: m.geometry.getAttribute('position'), idx: m.geometry.index, mat: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) }));
  const counts = gs.map((g) => (g.idx ? g.idx.count : g.pos.count) / 3);
  const v = new THREE.Vector3();
  const corner = (g: typeof gs[number], i: number, out: number[]) => { const k = g.idx ? g.idx.getX(i) : i; v.fromBufferAttribute(g.pos, k).applyMatrix4(g.mat); out[0] = v.x; out[1] = v.y; out[2] = v.z; };
  const total = counts.reduce((a, b) => a + b, 0);
  const leaves = hairOnMesh(total, (i, a, b, c) => {
    let n = 0; while (i >= counts[n]) i -= counts[n++];
    corner(gs[n], i * 3, a); corner(gs[n], i * 3 + 1, b); corner(gs[n], i * 3 + 2, c);
  }, h, seed * 7919);
  if (!leaves.length) return;
  const m = leafMesh({ leaves } as TreeMesh, cfg?.leaves ?? leafDefaults(), '#ffffff');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2)); g.setIndex(m.indices);
  const leaf = new THREE.Mesh(g, softBacks(new THREE.MeshStandardMaterial({ name: 'Leaf', map: tex(h.picture ?? 'lib:world/leaves/Leaves-Stylized.png'), vertexColors: true, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 0.85, color: '#ffffff' })));
  leaf.userData.dressed = true; leaf.castShadow = true;
  root.add(leaf);
}
