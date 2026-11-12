// Library thumbnails and the Preview pane: a small separate renderer that draws any source (a generated tree or rock, a
// library model or a picture) on a dark backdrop, and reports its triangles and vertices.
import * as THREE from 'three';
import { loadModel } from '@gamecraft/engine/assets';
import { generateRock, generateTree, leafMesh, type MeshData } from '@shared/src/world/generators';
import type { WorldConfig } from '@shared/src/world/document';
import { assetUrl } from './store';
import { bleedCutout, dressModel } from './modelLook';

export interface ModelInfo { triangles: number; vertices: number }

let renderer: THREE.WebGLRenderer | null = null;
const R = () => (renderer ??= (() => { const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setPixelRatio(1); r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.9; return r; })());

const geo = (m: MeshData) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2)); g.setIndex(m.indices); return g; };

/** Material sets the library found: id "mat:<name>" to its maps. */
export interface MaterialSet { name: string; maps: Partial<Record<'color' | 'normal' | 'roughness' | 'metalness' | 'height' | 'ao' | 'emission' | 'opacity', string>> }
export const materialSets = new Map<string, MaterialSet>();

/** A material as a UV sphere, every map on it. */
async function materialSphere(set: MaterialSet): Promise<THREE.Object3D> {
  const load = async (id: string | undefined, srgb: boolean) => {
    const url = id && assetUrl(id); if (!url) return null;
    try { const t = await new THREE.TextureLoader().loadAsync(url); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 1); return t; } catch { return null; }
  };
  const [map, normalMap, roughnessMap, aoMap] = await Promise.all([load(set.maps.color, true), load(set.maps.normal, false), load(set.maps.roughness, false), load(set.maps.ao, false)]);
  if (aoMap) aoMap.channel = 0;
  return new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, aoMap, roughness: 1, metalness: 0 }));
}

/** A picture of a tree from the side, on two crossed cards: what stands in for it far away. */
export function makeImpostor(parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[], material: (t: THREE.Texture) => THREE.Material): { geo: THREE.BufferGeometry; mat: THREE.Material; tris: number } {
  const r = R(), size = 512; r.setSize(size, size, false); r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#dfe9ff', '#4a4a40', 1.6));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2); sun.position.set(2, 5, 6); scene.add(sun);
  const box = new THREE.Box3();
  for (const p of parts) { const m = new THREE.InstancedMesh(p.geo, p.mat, 1); m.setMatrixAt(0, new THREE.Matrix4()); m.frustumCulled = false; scene.add(m); p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!); }
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x, s.y, s.z) / 2 || 1;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, half * 8);
  cam.position.set(c.x, c.y, c.z + half * 3); cam.lookAt(c);
  r.render(scene, cam);
  const out = document.createElement('canvas'); out.width = out.height = size; out.getContext('2d')!.drawImage(r.domElement, 0, 0);
  const tex = new THREE.CanvasTexture(out); tex.colorSpace = THREE.SRGBColorSpace;
  // Two square cards, centred where the picture was framed; lit from above like the crown they replace.
  const a = new THREE.PlaneGeometry(half * 2, half * 2).translate(c.x, c.y, c.z), b = new THREE.PlaneGeometry(half * 2, half * 2).rotateY(Math.PI / 2).translate(c.x, c.y, c.z);
  const g = new THREE.BufferGeometry();
  const join = (name: string, n: number) => { const x = a.getAttribute(name).array as Float32Array, y = b.getAttribute(name).array as Float32Array, o = new Float32Array(x.length + y.length); o.set(x); o.set(y, x.length); g.setAttribute(name, new THREE.BufferAttribute(o, n)); };
  join('position', 3); join('uv', 2); join('normal', 3);
  const nor = g.getAttribute('normal'); for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
  // Both faces of each card, as their own triangles: drawn "double sided", the back's light would flip and it would go
  // black, here and in anything the card is exported to.
  const one = [...Array.from(a.index!.array), ...Array.from(b.index!.array).map((i) => i + 4)], back: number[] = [];
  for (let i = 0; i < one.length; i += 3) back.push(one[i], one[i + 2], one[i + 1]);
  g.setIndex([...one, ...back]);
  const mat = material(tex); mat.side = THREE.FrontSide;
  return { geo: g, mat, tris: 8 };
}

/** The object to show for a source id. */
export async function buildSubject(id: string, cfg: WorldConfig | null): Promise<THREE.Object3D | null> {
  if (id.startsWith('mat:')) { const s = materialSets.get(id); return s ? materialSphere(s) : null; }
  if (id.startsWith('tree:') && cfg) {
    const p = cfg.trees.find((t) => t.id === id.slice(5))?.cfg; if (!p) return null;
    const t = generateTree(p, 1), g = new THREE.Group();
    const barkT = await loadPicture(p.barkAsset);
    if (barkT) { barkT.wrapS = barkT.wrapT = THREE.RepeatWrapping; }
    g.add(new THREE.Mesh(geo(t.wood), new THREE.MeshStandardMaterial({ vertexColors: !barkT, map: barkT, roughness: 0.9 })));
    if (t.leaves.length) {
      const leafT = await loadPicture(p.leafAsset);
      const lm = new THREE.MeshStandardMaterial({ vertexColors: true, map: leafT, alphaTest: leafT ? 0.15 : 0, side: THREE.DoubleSide, roughness: 0.8 });
      // Two-sided cards: their backs must not go black. The picture gives light and dark, the leaf colour the colour.
      lm.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);').replace('#include <map_fragment>', `#include <map_fragment>\n${p.leafOriginal ? '' : 'diffuseColor.rgb = vec3(0.45 + 0.9 * dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)));'}`); };
      g.add(new THREE.Mesh(geo(leafMesh(t, cfg.leaves, p.leafOriginal ? '#ffffff' : p.leaf)), lm));
    }
    return g;
  }
  if (id.startsWith('rock:') && cfg) { const p = cfg.rocks.find((t) => t.id === id.slice(5))?.cfg; if (!p) return null; return new THREE.Mesh(geo(generateRock(p, 7)), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: p.lowPoly })); }
  const url = assetUrl(id); if (!url) return null;
  try { const lm = await loadModel(url); dressModel(id, lm.scene, cfg); await texturesReady(lm.scene); return lm.scene; } catch { return null; }
}

/** Waits for a model's pictures (a .blend's packed ones decode after it loads): drawn sooner, it shows as bare white bits. */
async function texturesReady(root: THREE.Object3D, ms = 5000) {
  const texs: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) for (const t of [mat.map, mat.normalMap, mat.alphaMap]) if (t) texs.push(t);
  });
  // (A loader gives the texture its picture only once the picture has loaded: until then there's nothing to wait on.)
  const ready = (t: THREE.Texture) => { const img = t.source?.data as HTMLImageElement | undefined; return !!img && (!('complete' in img) || (img.complete && img.naturalWidth > 0)); };
  const end = performance.now() + ms;
  while (texs.some((t) => !ready(t)) && performance.now() < end) await new Promise((r) => setTimeout(r, 50));
  for (const t of texs) if (ready(t)) t.needsUpdate = true;
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) if (mat.map && mat.alphaTest > 0 && ready(mat.map)) bleedCutout(mat.map); });
}

async function loadPicture(id: string) {
  const url = id ? assetUrl(id) : null; if (!url) return null;
  try {
    const t = await new THREE.TextureLoader().loadAsync(url); t.colorSpace = THREE.SRGBColorSpace;
    if (/pixel/i.test(id) || Math.max(t.image.width, t.image.height) <= 128) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    return t;
  } catch { return null; }
}

export function infoOf(o: THREE.Object3D): ModelInfo {
  let triangles = 0, vertices = 0;
  o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh && m.geometry) { const pos = m.geometry.attributes.position; vertices += pos?.count ?? 0; triangles += (m.geometry.index?.count ?? pos?.count ?? 0) / 3; } });
  return { triangles: Math.round(triangles), vertices };
}

/** Draws `o` framed in a square, turned by `angle`. */
export function drawSubject(o: THREE.Object3D, size: number, angle: number, target?: HTMLCanvasElement): HTMLCanvasElement {
  const r = R(); r.setSize(size, size, false); r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#dfe9ff', '#3a3a34', 1.3));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6); sun.position.set(3, 5, 4); scene.add(sun);
  const holder = new THREE.Group(); holder.add(o); holder.rotation.y = angle; scene.add(holder);
  const box = new THREE.Box3().setFromObject(holder), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const d = Math.max(s.x, s.y, s.z, 0.01) * 1.55;
  const cam = new THREE.PerspectiveCamera(35, 1, d * 0.01, d * 20);
  cam.position.set(c.x + d * 0.75, c.y + d * 0.45, c.z + d * 1.1); cam.lookAt(c);
  r.render(scene, cam);
  holder.remove(o);
  const out = target ?? document.createElement('canvas');
  if (out.width !== size) { out.width = size; out.height = size; }
  const g = out.getContext('2d')!; g.clearRect(0, 0, size, size); g.drawImage(r.domElement, 0, 0);
  return out;
}

const cache = new Map<string, Promise<string>>();
/** One at a time: model files can be slow, and the library may hold many. */
let queue: Promise<unknown> = Promise.resolve();
export function thumbnail(id: string, cfg: WorldConfig | null): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = (queue = queue.then(async () => { const o = await buildSubject(id, cfg); return o ? drawSubject(o, 112, 0.5).toDataURL('image/png') : ''; }).catch(() => '')) as Promise<string>;
    cache.set(id, p);
  }
  return p;
}
