// Export: a finished world as a scene for GameCraft (in the same exchange folder and format as LogicCraft's scenes), or
// baked as glTF plus a heightmap for Blender, Godot and Unity. Geometry is baked here; procedural settings travel along
// in the document so GameCraft keeps them, but only GameCraft reads them.
import React, { useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { SCENE_PACKAGE_FORMAT, SCENE_PACKAGE_VERSION, scenePackageFileName } from '@shared/src/scenePackage';
import { emptyScene, makeInstance, type InstanceData } from '@shared/src/runtime/scene';
import { behaviorDefaults } from '@shared/src/runtime/behaviors';
import { block, createLogicDocument, event, type EventNode } from '@shared/src/schema';
import { bakeHeightmap, chunksAround } from '@shared/src/world/terrain';
import { buildFeatures, ribbonMesh, ROAD_KINDS, smoothPath, terrainChunk, worldHeight } from '@shared/src/world/features';
import { baseSource, generateRock, generateTree, leafMesh, resolveRock, resolveTree, treeFromSkeleton, type MeshData } from '@shared/src/world/generators';
import { sourceVariants } from '@shared/src/world/scatter';
import { lakeWaterMesh, riverWaterMesh } from '@shared/src/world/features';
import type { TreeSkeleton } from '@shared/src/world/document';
import { builtinEffect } from './builtinFx';
import { FALL_COLORS, fallIndex, scatterSquare, structuresInSquare } from '@shared/src/world/scatter';
import { groundColor, hexRgb } from '@shared/src/world/biomes';
import { slopeAt } from '@shared/src/world/terrain';
import { seasonPalette } from '@shared/src/world/season';
import { GRAY_MEAN, streamKey, type EndlessSettings, type WorldConfig, type WorldDoc } from '@shared/src/world/document';
import { loadModel } from '@gamecraft/engine/assets';
import { dressModel, grassPictureOf } from './modelLook';
import { makeImpostor } from './thumbs';
import { riverOptions, waterOptions } from '@shared/src/world/waterLook';
import { DEFAULT_SKY } from '@shared/src/runtime/sky';
import { worldClouds } from './view';
import { api, assetUrl, roadsOf, useWC, wc } from './store';
import { Hint, Row, Section } from './ui';

const bh = (type: string, props: Record<string, any> = {}) => ({ type, props: { ...behaviorDefaults(type), ...props } });
const noCol = { shape: 'none' as const, size: [1, 1, 1] as [number, number, number], offset: [0, 0, 0] as [number, number, number] };

const geoOf = (m: MeshData) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2)); g.setIndex(m.indices); return g; };
const stdMat = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, ...o });

async function toGlb(root: THREE.Object3D): Promise<ArrayBuffer> { return (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer; }
function dataUrl(buf: ArrayBuffer, mime: string) { let s = ''; const b = new Uint8Array(buf), step = 0x8000; for (let i = 0; i < b.length; i += step) s += String.fromCharCode(...b.subarray(i, i + step)); return `data:${mime};base64,${btoa(s)}`; }
function download(name: string, data: BlobPart, type = 'application/octet-stream') { const u = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); }

/** A picture for a generated tree's model: kept small, and grey when its colours come from the leaf rules. */
async function exportTexture(id: string, gray: boolean, repeat: boolean, pixel: boolean): Promise<THREE.Texture | null> {
  const url = assetUrl(id); if (!url || !id) return null;
  const img = new Image(); img.crossOrigin = 'anonymous';
  // (onload, not decode(): decode can wait for the page to be drawn, so an export started and left in the background
  // would hang on its first picture.)
  const ok = await new Promise<boolean>((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
  if (!ok || !img.width) return null;
  const k = Math.min(1, 256 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const g = c.getContext('2d', { willReadFrequently: true })!; g.imageSmoothingEnabled = !pixel; g.drawImage(img, 0, 0, c.width, c.height);
  // Grey: only the picture's light and dark, its average at GRAY_MEAN whatever the picture, so a colour laid over it comes out true.
  if (gray) {
    const d = g.getImageData(0, 0, c.width, c.height), p = d.data, lin = (v: number) => Math.pow(v / 255, 2.2);
    const lum = (i: number) => 0.3 * lin(p[i]) + 0.55 * lin(p[i + 1]) + 0.15 * lin(p[i + 2]);
    let sum = 0, n = 0; for (let i = 0; i < p.length; i += 4) if (p[i + 3] > 80) { sum += lum(i); n++; }
    const mean = n ? Math.max(0.005, sum / n) : 0.15;
    for (let i = 0; i < p.length; i += 4) { const v = Math.round(255 * Math.pow(Math.min(1, Math.max(0.45, Math.min(1.7, lum(i) / mean)) * GRAY_MEAN), 1 / 2.2)); p[i] = p[i + 1] = p[i + 2] = v; }
    g.putImageData(d, 0, 0);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (pixel || /pixel/i.test(id) || Math.max(img.width, img.height) <= 128) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; }
  return t;
}

/** A mesh without vertex colours (water ribbons). */
const toPlain = (m: MeshData) => { const g = geoOf(m); g.deleteAttribute('color'); return g; };

/** A generated source as a model centred on its base, the seasons' colours baked in. */
async function sourceGroup(c: WorldConfig, src: string, fall?: string, skeleton?: TreeSkeleton): Promise<THREE.Group | null> {
  const g = new THREE.Group();
  if (src.startsWith('tree:')) {
    const res = resolveTree(c, src); if (!res) return null;
    const p = res.cfg;
    const tree = skeleton ? treeFromSkeleton(p, skeleton, res.seed) : generateTree(p, res.seed);
    const bark = await exportTexture(p.barkAsset, false, true, false);
    if (bark) { bark.repeat.set(p.barkU ?? 1, p.barkV ?? 1); bark.rotation = ((p.barkRot ?? 0) * Math.PI) / 180; }
    // (Vertex colours on the wood carry the bark colour; with a picture they'd darken it.)
    const wood = geoOf(tree.wood); if (bark) wood.deleteAttribute('color');
    g.add(new THREE.Mesh(wood, stdMat(bark ? { map: bark, vertexColors: false, color: new THREE.Color(2.2, 2.2, 2.2) } : { color: p.bark })));
    if (tree.leaves.length) {
      const leafPic = await exportTexture(p.leafAsset, !p.leafOriginal || !!fall, false, p.pixelLeaves);
      const lm = leafMesh(tree, c.leaves, fall ?? p.leaf);
      if (!fall && c.season.enabled && c.season.treeLeaves) { const pal = seasonPalette(c.season.season); for (let i = 0; i < lm.colors.length; i += 3) { const q = pal[Math.floor(i / 12) % 4]; lm.colors[i] = q[0]; lm.colors[i + 1] = q[1]; lm.colors[i + 2] = q[2]; } }
      g.add(new THREE.Mesh(geoOf(lm), stdMat({ side: THREE.DoubleSide, roughness: 0.8, ...(leafPic ? { map: leafPic, alphaTest: 0.2 } : {}) })));
    }
    return g;
  }
  if (src.startsWith('rock:')) { const res = resolveRock(c, src); if (!res) return null; g.add(new THREE.Mesh(geoOf(generateRock(res.cfg, res.seed)), stdMat({ flatShading: res.cfg.lowPoly }))); return g; }
  return null;
}

export interface ExportOpts { radius: number; grass: boolean; maxPerLayer: number; player: 'first' | 'third' | 'none'; /** Endless worlds: generate as the player moves (else baked to an area). */ stream?: boolean }
type Progress = (text: string, frac: number) => boolean;

/** The world's meshes and placements, shared by both kinds of export. */
function bakeWorld(d: WorldDoc, cfg: WorldConfig, o: ExportOpts) {
  const roads = roadsOf(d).map((r) => ({ ...r, points: smoothPath(r.points) }));
  const f = buildFeatures(cfg, roads, d.edits);
  const height = worldHeight(cfg, d.edits, f);
  const list = cfg.terrain.endless ? chunksAround({ ...cfg.terrain, viewChunks: o.radius }, 0, 0, o.radius) : chunksAround(cfg.terrain, 0, 0);
  return { roads, f, height, list };
}

async function exportGameCraft(d: WorldDoc, cfg: WorldConfig, o: ExportOpts, progress: Progress) {
  const baked0 = bakeWorld(d, cfg, o), { roads, f, height } = baked0;
  // Endless: nothing baked to an area. GameCraft generates the land as the player moves (see `settings.endless` below).
  const stream = cfg.terrain.endless && o.stream !== false, list = stream ? [] : baked0.list;
  // Grass in any world goes the same way, as instances round the player: as scene objects, dense grass would be hundreds of thousands of them.
  const wantsGrass = (l: WorldConfig['layers'][number]) => l.enabled && l.kind === 'grass' && (o.grass || !!l.paintOnly);
  const grassStream = !stream && cfg.layers.some(wantsGrass);
  const scene = emptyScene(d.name, '3d');
  scene.settings.background = '#8ec5ee';
  scene.settings.world = { color: '#c4dcf2', strength: cfg.sky.ambient, viewTransform: 'filmic', exposure: -0.23, fogEnabled: cfg.weather.fog > 0.02, fogColor: '#cfe0ef', fogDensity: 0.0002 + cfg.weather.fog * cfg.weather.fog * 0.018 };
  const files: Record<string, string> = {};
  const inst: InstanceData[] = [];
  let uid = 1;
  const add = (type: string, kind: InstanceData['kind'], over: Partial<InstanceData>) => { const i = makeInstance(uid++, type, kind, over); inst.push(i); return i; };
  const put = async (rel: string, root: THREE.Object3D) => { const buf = await toGlb(root); files[rel] = dataUrl(buf, 'model/gltf-binary'); return 'proj:' + rel; };
  const counts: Record<string, number> = {};
  const size = cfg.terrain.chunkSize;
  const tick = () => new Promise((r) => setTimeout(r));
  // Terrain: one object a chunk, with a grid of collision boxes on it.
  let groundMap: THREE.Texture | null = null;
  for (let k = 0; k < list.length; k++) {
    if (!progress(`Terrain ${k + 1} of ${list.length}`, (k / list.length) * 0.6)) return null;
    await tick();
    const [cx, cz] = list[k], m = terrainChunk(cfg, d.edits, f, height, cx, cz, cfg.terrain.resolution);
    const x0 = cx * size, z0 = cz * size, xc = x0 + size / 2, zc = z0 + size / 2;
    let low = Infinity; for (let i = 1; i < m.positions.length; i += 3) low = Math.min(low, m.positions[i]);
    for (let i = 0; i < m.positions.length; i += 3) { m.positions[i] -= xc; m.positions[i + 1] -= low; m.positions[i + 2] -= zc; }
    // The ground material's grain over the terrain's colours, the same size as in WorldCraft (terrain UVs repeat every 8 m).
    groundMap ??= await exportTexture('lib:world/ground/Grass004/Grass004_Color.jpg', true, true, false);
    if (groundMap) groundMap.repeat.set(8 * 0.29, 8 * 0.29);
    const asset = await put(`world/terrain_${cx}_${cz}.glb`, new THREE.Mesh(geoOf(m), stdMat(groundMap ? { map: groundMap, color: new THREE.Color(1 / GRAY_MEAN, 1 / GRAY_MEAN, 1 / GRAY_MEAN) } : {})));
    // Fine enough to walk on: about 3 m a box, whatever the chunk size, at most 32 a side.
    const n = Math.min(32, Math.max(8, Math.round(size / 3))), cell = size / n, boxes: number[][] = [];
    let peak = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const lx = -size / 2 + (a + 0.5) * cell, lz = -size / 2 + (b + 0.5) * cell, top = height(xc + lx, zc + lz) - low;
      peak = Math.max(peak, top);
      boxes.push([lx, top / 2 - 2, lz, cell, top + 4, cell]);
    }
    // The overall bounds must cover the boxes: physics looks at these first.
    add('Terrain', 'mesh', { name: `Terrain ${cx},${cz}`, x: xc, y: low, z: zc, color: '#ffffff', mesh: { asset, rotY: 0 }, collider: { shape: 'box', size: [size, peak + 4, size], offset: [0, peak / 2 - 2, 0], boxes } as any, behaviors: [bh('solid')] });
  }
  // Generated sources, once each.
  const assetOf = new Map<string, { id: string; scale: number }>();
  const inGameCraft = async (id: string) => {
    // The shared library is under "library" in GameCraft; files imported here travel inside the scene.
    if (id.startsWith('lib:world/')) return 'lib:library/world/' + id.slice('lib:world/'.length);
    if (id.startsWith('proj:')) { const rel = id.slice(5), url = assetUrl(id); if (url && !files[rel]) { const r = await fetch(url); files[rel] = dataUrl(await r.arrayBuffer(), r.headers.get('Content-Type') ?? 'application/octet-stream'); } }
    return id;
  };
  /**
   * A supplied model with its look, as its own file: the wood and grass pictures aren't in the source files, so copying
   * those would lose them. Trees too detailed to run many of in a game go as their picture on crossed cards.
   */
  const baked = new Map<string, { id: string; scale: number; height: number }>();
  const bakeModel = async (src: string, target: number | null, rel: string, look: { fall?: string; gray?: boolean } = {}) => {
    if (baked.has(rel)) return baked.get(rel)!;
    const url = assetUrl(src); if (!url) return null;
    let lm; try { lm = await loadModel(url); } catch { return null; }
    dressModel(src, lm.scene, cfg); lm.scene.updateMatrixWorld(true);
    // A model can name picture files that didn't come with it: those parts go out in their plain colour, not black.
    await new Promise((r) => setTimeout(r, 400));
    lm.scene.traverse((x) => { const m = x as THREE.Mesh; if (!m.isMesh) return; for (const mt of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) if (mt.map && !mt.map.image && !mt.map.source?.data) { mt.map = null; if (mt.color.getHex() === 0xcccccc) mt.color.set('#6b5238'); mt.needsUpdate = true; } });
    // Fall colours, or ready to take the ground's colour: the same picture in grey, so the colour shows true. Wood stays.
    const saved: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    if (look.fall || look.gray) {
      const pic = grassPictureOf(src) ?? cfg.modelLeaves?.[src]?.picture ?? 'lib:world/leaves/Leaves-Stylized.png';
      const gray = await exportTexture(pic, true, false, false);
      lm.scene.traverse((o) => {
        const m = o as THREE.Mesh; if (!m.isMesh) return;
        const first = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
        if (first.name === 'Wood') return;
        saved.push([m, m.material]);
        // (Grey carries the light and dark; the plain white here leaves the ground's colour to come from the instance.)
        const c = first.clone(); if (c.map && gray) c.map = gray; c.color = look.fall ? new THREE.Color(look.fall) : new THREE.Color('#ffffff');
        m.material = c;
      });
    }
    const restore = () => { for (const [m, mt] of saved) m.material = mt; };
    const box = new THREE.Box3().setFromObject(lm.scene), hgt = box.getSize(new THREE.Vector3()).y;
    const scale = target != null ? (hgt > 0 ? target / hgt : 1) : hgt > 60 ? 0.01 : 1;
    let tris = 0; const parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
    lm.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { tris += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; const g = m.geometry.clone().applyMatrix4(m.matrixWorld); const ms = Array.isArray(m.material) ? m.material[0] : m.material; parts.push({ geo: g, mat: ms }); } });
    if (tris > 20000) {
      await new Promise((r) => setTimeout(r, 2500)); // (the wood and leaf pictures arrive first)
      const card = makeImpostor(parts, (t) => new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 }));
      restore();
      const out = { id: await put(rel, new THREE.Mesh(card.geo, card.mat)), scale, height: hgt };
      baked.set(rel, out); return out;
    }
    const out = { id: await put(rel, lm.scene), scale, height: hgt };
    restore();
    baked.set(rel, out); return out;
  };
  const TARGET: Record<string, number> = { tree: 9, rock: 1.5, grass: 0.7, flower: 0.5, bush: 1.4, prop: 1, debris: 0.8 };
  const srcAsset = async (src: string, kind: string, fall = -1, gray = false) => {
    const tag = (fall >= 0 ? `_fall${fall}` : '') + (gray ? '_gray' : ''), key = src + tag, fallHex = fall >= 0 ? FALL_COLORS[fall] : undefined;
    if (assetOf.has(key)) return assetOf.get(key)!;
    let out: { id: string; scale: number } | null = null;
    if (src.startsWith('tree:') || src.startsWith('rock:')) { const g = await sourceGroup(cfg, src, src.startsWith('tree:') ? fallHex : undefined); if (g) out = { id: await put(`world/${src.replace(':', '_')}${tag}.glb`, g), scale: 1 }; }
    else if (src.startsWith('card:')) out = { id: await inGameCraft(src.slice(5)), scale: 1 };
    else {
      // The same size as in WorldCraft's view: scaled to fit its kind. (A look after the path, "@toon", is the view's.)
      const base = baseSource(src);
      const made = await bakeModel(base, TARGET[kind] ?? 1, `world/${base.replace(/[^A-Za-z0-9]+/g, '_')}${tag}.glb`, { fall: fallHex, gray });
      out = made ?? { id: await inGameCraft(base), scale: 1 };
    }
    if (out) assetOf.set(key, out);
    return out;
  };
  const ctx = { cfg, edits: d.edits, height, water: f.water, onRoad: f.onRoad };
  const logicEvents: EventNode[] = [];
  const globals: { name: string; type: 'number'; value: number }[] = [];
  for (let l = 0; l < cfg.layers.length; l++) {
    const layer = cfg.layers[l];
    // (Grass goes separately, below: instances round the player. What you painted by hand always goes.)
    if (!layer.enabled || layer.kind === 'grass') continue;
    if (!progress(`Placing ${layer.name}`, 0.6 + (l / cfg.layers.length) * 0.3)) return null;
    await tick();
    const type = layer.name.replace(/[^A-Za-z0-9_]+/g, '_') || 'Object';
    let placed = 0;
    outer: for (const [cx, cz] of list) for (const it of scatterSquare(ctx, layer, cx * size, cz * size, size)) {
      if (d.edits.removed.includes(it.uid)) continue;
      if (placed >= o.maxPerLayer) break outer;
      // Takes the ground's colour: as an object colour over a grey picture. Trees keep their wood, so only smaller plants.
      const copies = !!layer.copyGround && layer.kind !== 'tree';
      const a = await srcAsset(it.source, layer.kind, fallIndex(layer, it.tint), copies); if (!a) continue;
      const below = copies ? groundColor(cfg, d.edits, it.x, it.z, it.y, 0, { plants: true }) : null;
      const shade = below ? '#' + new THREE.Color().setRGB(below[0] / GRAY_MEAN, below[1] / GRAY_MEAN, below[2] / GRAY_MEAN).getHexString() : '#ffffff';
      if (it.source.startsWith('card:')) {
        // A grass card: a picture standing on the ground, facing the camera or crossed-free as the layer says.
        const s = it.scale * 1;
        add(type, 'sprite', { x: it.x, y: it.y + s / 2, z: it.z, ry: it.ry, sx: s, sy: s, sz: s, color: shade, collider: noCol, sprite: { image: a.id, frames: 1, fps: 0, billboard: layer.faceCamera, billboardMode: 'vertical', pixelArt: /pixel/i.test(a.id), lit: true } as any });
        placed++;
        continue;
      }
      const trunk = layer.kind === 'tree' ? { shape: 'box' as const, size: [1, 8, 1] as [number, number, number], offset: [0, 4, 0] as [number, number, number] } : layer.kind === 'rock' ? { shape: 'box' as const, size: [1, 1, 1] as [number, number, number], offset: [0, 0.5, 0] as [number, number, number] } : noCol;
      const s = it.scale * a.scale;
      const i = add(type, 'mesh', { x: it.x, y: it.y, z: it.z, ry: it.ry, sx: s, sy: s, sz: s, color: shade, mesh: { asset: a.id, rotY: 0, ...(below ? { tint: true } : {}) }, collider: { ...trunk, size: trunk.size.map((v) => v / a.scale) as any, offset: trunk.offset.map((v) => v / a.scale) as any }, behaviors: trunk.shape !== 'none' ? [bh('solid')] : [] });
      if (layer.interact?.enabled) i.behaviors.push(bh('interactable', { prompt: `Press E to ${layer.interact.action}`, distance: layer.interact.distance, key: 'E' }));
      placed++;
    }
    counts[layer.name] = placed;
    if (layer.interact?.enabled && placed) {
      // Runs in GameCraft: using it removes it and adds the resource. Felled-tree physics isn't part of this yet.
      const res = (layer.interact.resource || layer.name).replace(/[^A-Za-z0-9_]+/g, '_');
      if (!globals.some((g) => g.name === res)) globals.push({ name: res, type: 'number', value: 0 });
      logicEvents.push(event([block('interact.on_interact', {}, type)], [block('var.add', { variable: res, value: String(layer.interact.quantity) }), block('object.destroy', {}, type), block('audio.play', { sound: 'pickup', volume: '70' })]));
    }
  }
  // Roads.
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i]; if (r.points.length < 2) continue;
    const cx = r.points[0][0], cy = height(r.points[0][0], r.points[0][1]), cz = r.points[0][1];
    const m = ribbonMesh(r.points, () => r.width, (x, z) => height(x, z) + 0.12, hexRgb(ROAD_KINDS[r.kind]?.color ?? '#6b6b6b'));
    let low = Infinity, bx = 0, bz = 0, c2 = 0;
    for (let k = 0; k < m.positions.length; k += 3) { low = Math.min(low, m.positions[k + 1]); bx += m.positions[k]; bz += m.positions[k + 2]; c2++; }
    bx /= c2; bz /= c2;
    let ax = Infinity, az = Infinity, ex = -Infinity, ez = -Infinity;
    for (let k = 0; k < m.positions.length; k += 3) { ax = Math.min(ax, m.positions[k]); ex = Math.max(ex, m.positions[k]); az = Math.min(az, m.positions[k + 2]); ez = Math.max(ez, m.positions[k + 2]); }
    const mx = (ax + ex) / 2, mz = (az + ez) / 2;
    for (let k = 0; k < m.positions.length; k += 3) { m.positions[k] -= mx; m.positions[k + 1] -= low; m.positions[k + 2] -= mz; }
    const asset = await put(`world/road_${i}.glb`, new THREE.Mesh(geoOf(m), stdMat()));
    add('Road', 'mesh', { x: mx, y: low, z: mz, color: '#ffffff', mesh: { asset, rotY: 0 }, collider: noCol });
    void cx; void cy; void cz; void bx; void bz;
  }
  // Water: GameCraft's own, swimmable.
  if (cfg.water.enabled) {
    const w = stream ? 4000 : cfg.terrain.endless ? (o.radius * 2 + 1) * size : Math.max(cfg.terrain.width, cfg.terrain.depth), depth = 60;
    add('Water', 'box', { x: 0, y: cfg.water.level - depth / 2, z: 0, sx: w, sy: depth, sz: w, color: cfg.water.color, opacity: cfg.water.opacity, collider: { shape: 'box', size: [1, 1, 1], offset: [0, 0, 0] }, material: { roughness: 0.08, metalness: 0.1, emissive: '#000000', emissiveStrength: 0, surface: 'water', ripples: true, water: waterOptions(cfg.water, w) } as any, behaviors: [bh('water')] });
  }
  // Rivers (to look at, as their course isn't a box to swim in) and lakes (swimmable), in the same water.
  const riverLook = { roughness: 0.08, metalness: 0.1, emissive: '#000000', emissiveStrength: 0, surface: 'water', water: riverOptions(cfg.water) } as any;
  // (Lakes too: their uneven shores are meshes in the same water, as rivers are.)
  const waterMeshes = [...f.rivers.map((r) => ({ name: 'River', m: riverWaterMesh(r) })), ...f.lakes.map((l) => ({ name: 'Lake', m: lakeWaterMesh(l) }))];
  for (let k = 0; k < waterMeshes.length; k++) {
    const rm = waterMeshes[k].m;
    let ly = Infinity, ax = Infinity, bx = -Infinity, az = Infinity, bz = -Infinity;
    for (let i = 0; i < rm.positions.length; i += 3) { ax = Math.min(ax, rm.positions[i]); bx = Math.max(bx, rm.positions[i]); ly = Math.min(ly, rm.positions[i + 1]); az = Math.min(az, rm.positions[i + 2]); bz = Math.max(bz, rm.positions[i + 2]); }
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    // (A little above 0 in its own space: the water shader only moves what is above the object's middle.)
    for (let i = 0; i < rm.positions.length; i += 3) { rm.positions[i] -= mx; rm.positions[i + 1] -= ly - 0.02; rm.positions[i + 2] -= mz; }
    const nm = waterMeshes[k].name;
    const asset = await put(`world/${nm.toLowerCase()}_${k}.glb`, new THREE.Mesh(geoOf(rm), stdMat()));
    add(nm, 'mesh', { name: `${nm} ${k + 1}`, x: mx, y: ly, z: mz, color: cfg.water.color, opacity: cfg.water.opacity, mesh: { asset, rotY: 0 }, collider: noCol, material: riverLook });
  }
  // The sky: GameCraft's own atmosphere and sun, the same clouds.
  scene.settings.sky = { ...DEFAULT_SKY, enabled: true, time: cfg.sky.time, sunStrength: cfg.sky.sunStrength / 3, haze: 2.5 + cfg.weather.fog * 6, stars: cfg.sky.stars };
  { const cl = worldClouds(cfg); scene.settings.clouds = { enabled: cfg.weather.clouds > 0, ...cl, span: 1600, thickness: cl.thickness, base: cl.base }; }
  // Placed objects and structures.
  // (Models taller than 60 units are taken as centimetres, as in the view.)
  const placedScale = async (asset: string) => { const url = assetUrl(asset); if (!url) return { size: new THREE.Vector3(1, 1, 1), k: 1 }; try { const lm = await loadModel(url); return { size: lm.size, k: lm.size.y > 60 ? 0.01 : 1 }; } catch { return { size: new THREE.Vector3(1, 1, 1), k: 1 }; } };
  for (const p of d.placed) {
    if (!p.asset) continue;
    if (p.asset.startsWith('tree:') || p.asset.startsWith('rock:')) {
      // A tree with its own edited or drawn wood: baked by itself.
      const own = p.tree?.skeleton ? await sourceGroup(cfg, p.asset, undefined, p.tree.skeleton) : null;
      const a = own ? { id: await put(`world/placed_${p.id.replace(/[^A-Za-z0-9]+/g, '_')}.glb`, own), scale: 1 } : await srcAsset(p.asset, p.asset.startsWith('tree:') ? 'tree' : 'rock'); if (!a) continue;
      add(p.name.replace(/[^A-Za-z0-9_]+/g, '_') || 'Object', 'mesh', { x: p.x, y: p.snap ? height(p.x, p.z) : p.y, z: p.z, ry: p.ry, sx: p.scale, sy: p.scale, sz: p.scale, color: '#ffffff', mesh: { asset: a.id, rotY: 0 }, collider: noCol });
      continue;
    }
    const { size: sz, k } = await placedScale(p.asset);
    // Library models carry their look in a baked copy; your own imported files go as they are.
    const lookOf = p.asset.startsWith('lib:') ? await bakeModel(p.asset, null, `world/${p.asset.replace(/[^A-Za-z0-9]+/g, '_')}_placed.glb`) : null;
    add(p.name.replace(/[^A-Za-z0-9_]+/g, '_') || 'Object', 'mesh', { x: p.x, y: p.snap ? height(p.x, p.z) : p.y, z: p.z, ry: p.ry, sx: p.scale * k, sy: p.scale * k, sz: p.scale * k, color: '#ffffff', mesh: { asset: lookOf?.id ?? await inGameCraft(p.asset), rotY: 0 }, collider: { shape: 'box', size: [sz.x, sz.y, sz.z], offset: [0, sz.y / 2, 0] }, behaviors: [bh('solid')] });
  }
  for (const sp of cfg.spawns) for (const [cx, cz] of list) for (const st of structuresInSquare(ctx, sp, cx * size, cz * size, size)) {
    if (d.edits.removed.includes(st.uid)) continue;
    const { size: sz, k } = await placedScale(st.asset);
    add(sp.name.replace(/[^A-Za-z0-9_]+/g, '_') || 'Structure', 'mesh', { name: sp.name, x: st.x, y: st.y, z: st.z, ry: st.ry, sx: st.scale * k, sy: st.scale * k, sz: st.scale * k, color: '#ffffff', mesh: { asset: await inGameCraft(st.asset), rotY: 0 }, collider: { shape: 'box', size: [sz.x, sz.y, sz.z], offset: [0, sz.y / 2, 0] }, behaviors: [bh('solid')] });
  }
  if (stream || grassStream) {
    // Each object in each look, baked once; GameCraft works out where they stand, for ever.
    progress('Preparing the endless world', 0.7);
    const sources: EndlessSettings['sources'] = {}, structures: EndlessSettings['structures'] = {};
    const cardOf = async (src: string, fallHex: string | undefined, rel: string) => {
      const g = await sourceGroup(cfg, src, fallHex); if (!g) return undefined;
      const card = makeImpostor(g.children.map((c) => ({ geo: (c as THREE.Mesh).geometry, mat: (c as THREE.Mesh).material as THREE.Material })), (t) => new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 }));
      return put(rel, new THREE.Mesh(card.geo, card.mat));
    };
    for (const layer of cfg.layers) {
      if (!layer.enabled || (layer.kind === 'grass' ? !wantsGrass(layer) : !stream)) continue;
      const gray = !!layer.copyGround && layer.kind !== 'tree', falls = layer.randomColor ? [-1, 0, 1, 2, 3] : [-1];
      // (Every random shape of a generated tree or rock: GameCraft picks the same one WorldCraft shows.)
      for (const src of layer.sources.flatMap((s) => sourceVariants(s, cfg))) for (const fall of falls) {
        const key = streamKey(src, fall, gray);
        if (sources[key]) continue;
        if (!progress(`Preparing ${layer.name}`, 0.72)) return null;
        await tick();
        if (src.startsWith('card:')) {
          const pic = await exportTexture(src.slice(5), gray, false, false);
          if (pic) sources[key] = { asset: await put(`world/card_${src.replace(/[^A-Za-z0-9]+/g, '_')}${gray ? '_gray' : ''}.glb`, new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: pic, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 0.95 }))), scale: 1 };
          continue;
        }
        const a = await srcAsset(src, layer.kind, fall, gray); if (!a) continue;
        sources[key] = { asset: a.id, scale: a.scale };
        if (src.startsWith('tree:')) sources[key].far = await cardOf(src, fall >= 0 ? FALL_COLORS[fall] : undefined, `world/${src.replace(':', '_')}_${fall}_far.glb`);
      }
    }
    if (stream) for (const sp of cfg.spawns) for (const id of sp.assets) {
      if (structures[id]) continue;
      const { size: sz, k } = await placedScale(id);
      structures[id] = { asset: await inGameCraft(id), scale: k, size: [sz.x, sz.y, sz.z] };
    }
    let ground: string | undefined;
    const pic = await exportTexture('lib:world/ground/Grass004/Grass004_Color.jpg', true, true, false);
    if (pic) { files['world/ground.jpg'] = (pic.image as HTMLCanvasElement).toDataURL('image/jpeg', 0.85); ground = 'proj:world/ground.jpg'; }
    scene.settings.endless = { id: Date.now().toString(36), config: cfg, edits: d.edits, roads: roadsOf(d), sources, structures, ground, viewChunks: Math.max(3, Math.min(8, cfg.terrain.viewChunks)), grassOnly: !stream };
  }
  // Sun, and something to walk the world with.
  const t = cfg.sky.time, az = ((t - 6) / 12) * 180;
  add('Sun', 'light', { name: 'Sun', y: 60, rx: -Math.max(8, Math.sin(((t - 6) / 12) * Math.PI) * 70), ry: az, light: { ...(makeInstance(0, 'x', 'light').light as any), type: 'directional', intensity: cfg.sky.sunStrength, castShadow: true, color: '#fff4e3' } });
  if (o.player === 'third') {
    const y = height(0, 0);
    add('Player', 'capsule', { name: 'Player', x: 0, y: y + 2, z: 0, sx: 0.7, sy: 1.8, sz: 0.7, color: '#3f6fd4', behaviors: [bh('platform', { maxSpeed: 7, stepHeight: 1.2 })] });
    add('Camera', 'camera', { name: 'Camera', x: 0, y: y + 6, z: 8, camera: { ...(makeInstance(0, 'x', 'camera').camera as any), clipEnd: 6000 }, behaviors: [bh('follow', { target: 'Player', offsetY: 4, offsetZ: 8, smoothing: 0.85 })] });
  } else if (o.player === 'first') {
    const y = height(0, 0);
    // First person, set up as GameCraft's own first-person game is: an unseen body with its feet on the ground, eyes in its head.
    add('Player', 'box', { name: 'Player', x: 0, y: y + 0.1, z: 0, ry: 90, visible: false, color: '#ffffff', collider: { shape: 'box', size: [0.6, 1.75, 0.6], offset: [0, 0.875, 0] }, behaviors: [bh('platform', { maxSpeed: 5.5, runMultiplier: 1.7, jumpStrength: 6.5, turnSpeed: 0, stepHeight: 1.2 })] });
    const camDefaults = makeInstance(0, 'x', 'camera').camera as any;
    add('Camera', 'camera', { name: 'Camera', x: 0, y: y + 1.7, z: 0, camera: { ...camDefaults, focalLength: 24, clipStart: 0.05, clipEnd: 6000 }, behaviors: [bh('follow', { target: 'Player', firstPerson: true, eyeHeight: 1.65, sensitivity: 0.22, lookAt: false, smoothing: 0 })] });
  }
  // Placed ParticleCraft effects become real emitter objects: their layers travel as the package's effect presets
  // (name, name#2…), scaled per placement, with the world's wind baked in as a force when the placement follows it.
  const particlePresets: Record<string, any> = {};
  if (d.particles.length) progress('Placing effects', 0.9);
  for (const r of d.particles) {
    let a: any;
    const own = builtinEffect(r.effect);
    if (own) a = { layers: own };
    else try { a = JSON.parse(await api.exchangeGet(r.effect)); } catch { counts['missing effects'] = (counts['missing effects'] ?? 0) + 1; continue; }
    const layers: { name: string; params: any }[] = Array.isArray(a?.layers) ? a.layers : [];
    if (!layers.length) continue;
    const s = Math.max(0.05, r.scale || 1), w = cfg.weather, wa = (w.windDirection * Math.PI) / 180, ws = w.windStrength * Math.max(0.2, w.windSpeed / 2);
    const name = `${(r.name || 'Effect').replace(/[^A-Za-z0-9_]+/g, '_')}_${r.id.replace(/[^A-Za-z0-9]/g, '')}`;
    layers.forEach((l, k) => {
      const p = { ...l.params, sizeStart: l.params.sizeStart * s, sizeEnd: l.params.sizeEnd * s, sizeVar: l.params.sizeVar * s, speed: l.params.speed * s, speedVar: l.params.speedVar * s, gravity: l.params.gravity * s, emitterScale: (l.params.emitterScale ?? 1) * s };
      if (r.wind !== false && ws > 0) p.forces = [...(p.forces ?? []), { type: 'wind', direction: [Math.cos(wa), 0, Math.sin(wa)], speed: ws * 4, coupling: 0.35, gust: 0.6, gustFreq: 0.4 }];
      particlePresets[k ? `${name}#${k + 1}` : name] = p;
    });
    add(name, 'emitter', { name: r.name || 'Effect', x: r.x, y: r.y, z: r.z, ry: r.rotation ?? 0, emitter: { preset: name, params: {}, playing: true }, collider: { shape: 'none', size: [1, 1, 1], offset: [0, 0, 0] } } as any);
    counts.effects = (counts.effects ?? 0) + 1;
  }
  scene.instances = inst;
  const logic = createLogicDocument(d.name, 'worldcraft', 'xz');
  logic.globals = globals as any;
  logic.sheets[0].name = d.name;
  logic.sheets[0].events = logicEvents;
  scene.sheetId = logic.sheets[0].id;
  // Everything a later version of GameCraft (or a re-import) needs: settings GameCraft doesn't act on yet travel along.
  logic.extensions.world = { config: cfg, particles: d.particles, sounds: d.sounds, version: 1 };
  progress('Writing the scene', 0.95);
  await tick();
  const pkg = { format: SCENE_PACKAGE_FORMAT, schemaVersion: SCENE_PACKAGE_VERSION, sourceApp: 'worldcraft', exported: new Date().toISOString(), name: d.name, scenes: [scene], logic, images: {}, files, particlePresets };
  const file = scenePackageFileName(d.name);
  await api.exchangePut(file, JSON.stringify(pkg));
  return { file, objects: inst.length, counts };
}

/**
 * The whole world as one .glb, for Blender (File > Import > glTF 2.0), Godot or Unity: terrain with its ground picture,
 * everything scattered or placed, structures, roads, water, rivers and the sun, each kind under its own named parent.
 * Copies of a plant share one mesh (linked duplicates in Blender), so a big forest stays a small file.
 */
async function exportBaked(d: WorldDoc, cfg: WorldConfig, o: ExportOpts, progress: Progress) {
  const { roads, f, height, list } = bakeWorld(d, cfg, o);
  const root = new THREE.Group(); root.name = d.name;
  const tick = () => new Promise((r) => setTimeout(r));
  const group = (name: string) => { const g = new THREE.Group(); g.name = name; root.add(g); return g; };
  const terrain = group('Terrain');
  const ground = await exportTexture('lib:world/ground/Grass004/Grass004_Color.jpg', true, true, false);
  if (ground) ground.repeat.set(8 * 0.29, 8 * 0.29);
  const groundMat = stdMat(ground ? { map: ground, color: new THREE.Color(1 / GRAY_MEAN, 1 / GRAY_MEAN, 1 / GRAY_MEAN) } : {});
  for (let k = 0; k < list.length; k++) {
    if (!progress(`Terrain ${k + 1} of ${list.length}`, (k / list.length) * 0.4)) return null;
    await tick();
    const mesh = new THREE.Mesh(geoOf(terrainChunk(cfg, d.edits, f, height, list[k][0], list[k][1], cfg.terrain.resolution)), groundMat);
    mesh.name = `terrain_${list[k][0]}_${list[k][1]}`; terrain.add(mesh);
  }
  // One source object per plant, tree, rock or model, with its look. Its copies only differ in where they stand.
  const made = new Map<string, { obj: THREE.Object3D; k: number } | null>();
  const TARGET: Record<string, number> = { tree: 9, rock: 1.5, grass: 0.7, flower: 0.5, bush: 1.4, prop: 1, debris: 0.8 };
  const heavyLimit = 5;
  const source = async (src: string, kind: string | null, fall: number, many: number) => {
    const key = `${src}|${kind}|${fall}`;
    if (made.has(key)) return made.get(key)!;
    let out: { obj: THREE.Object3D; k: number } | null = null;
    const fallHex = fall >= 0 ? FALL_COLORS[fall] : undefined;
    if (src.startsWith('tree:') || src.startsWith('rock:')) { const g = await sourceGroup(cfg, src, fallHex); if (g) out = { obj: g, k: 1 }; }
    else if (src.startsWith('card:')) {
      const t = await exportTexture(src.slice(5), false, false, false);
      if (t) { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 0.95 })); out = { obj: m, k: 1 }; }
    } else {
      const url = assetUrl(baseSource(src));
      if (url) try {
        const lm = await loadModel(url);
        dressModel(baseSource(src), lm.scene, cfg); lm.scene.updateMatrixWorld(true);
        const hgt = new THREE.Box3().setFromObject(lm.scene).getSize(new THREE.Vector3()).y;
        const k = kind && TARGET[kind] && kind !== 'prop' ? (hgt > 0 ? TARGET[kind] / hgt : 1) : hgt > 60 ? 0.01 : 1;
        const copy = lm.scene.clone(true);
        let tris = 0; const parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
        copy.updateMatrixWorld(true);
        copy.traverse((x) => {
          const m = x as THREE.Mesh; if (!m.isMesh) return;
          tris += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
          let mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
          if (fallHex && mat.name !== 'Wood') { mat = mat.clone(); mat.color = new THREE.Color(fallHex); m.material = mat; }
          parts.push({ geo: m.geometry.clone().applyMatrix4(m.matrixWorld), mat });
        });
        // A few very detailed trees come whole; forests of them come as picture cards, or the file would reach gigabytes.
        if (tris > 20000 && many > heavyLimit) {
          await new Promise((r) => setTimeout(r, 2500));
          const card = makeImpostor(parts, (t) => new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 }));
          out = { obj: new THREE.Mesh(card.geo, card.mat), k };
        } else out = { obj: copy, k };
      } catch { out = null; }
    }
    made.set(key, out);
    return out;
  };
  const place = (parent: THREE.Object3D, s: { obj: THREE.Object3D; k: number }, name: string, x: number, y: number, z: number, ry: number, scale: number) => {
    const c = s.obj.clone(true); c.name = name; c.position.set(x, y, z); c.rotation.y = (ry * Math.PI) / 180; c.scale.setScalar(scale * s.k); parent.add(c);
  };
  const size = cfg.terrain.chunkSize, ctx = { cfg, edits: d.edits, height, water: f.water, onRoad: f.onRoad };
  for (let l = 0; l < cfg.layers.length; l++) {
    const layer = cfg.layers[l];
    if (!layer.enabled || (layer.kind === 'grass' && !o.grass && !layer.paintOnly)) continue;
    if (!progress(`Placing ${layer.name}`, 0.4 + (l / cfg.layers.length) * 0.3)) return null;
    await tick();
    const items: ReturnType<typeof scatterSquare> = [];
    for (const [cx, cz] of list) { for (const it of scatterSquare(ctx, layer, cx * size, cz * size, size)) { if (items.length < o.maxPerLayer && !d.edits.removed.includes(it.uid)) items.push(it); } }
    const g = group(layer.name);
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.source, (counts.get(it.source) ?? 0) + 1);
    for (const it of items) { const s = await source(it.source, layer.kind, fallIndex(layer, it.tint), counts.get(it.source)!); if (s) place(g, s, it.source.split('/').pop()!.replace(/\.[^.]+$/, ''), it.x, it.y, it.z, it.ry, it.scale); }
  }
  // Placed by hand, then structures.
  const placed = group('Placed');
  for (const p of d.placed) {
    if (!p.asset) continue;
    const own = p.tree?.skeleton ? await sourceGroup(cfg, p.asset, undefined, p.tree.skeleton) : null;
    const s = own ? { obj: own, k: 1 } : await source(p.asset, null, -1, 1);
    if (s) place(placed, s, p.name || 'Object', p.x, p.snap ? height(p.x, p.z) : p.y, p.z, p.ry, p.scale);
  }
  const structures = group('Structures');
  for (const sp of cfg.spawns) for (const [cx, cz] of list) for (const st of structuresInSquare(ctx, sp, cx * size, cz * size, size)) { const s = await source(st.asset, null, -1, 1); if (s) place(structures, s, sp.name, st.x, st.y, st.z, st.ry, st.scale); }
  const roadG = group('Roads');
  for (const r of roads) if (r.points.length > 1) { const m = new THREE.Mesh(geoOf(ribbonMesh(r.points, () => r.width, (x, z) => height(x, z) + 0.12, hexRgb(ROAD_KINDS[r.kind]?.color ?? '#6b6b6b'))), stdMat()); m.name = 'road'; roadG.add(m); }
  // Water, as ordinary glossy see-through surfaces: other programs have their own water shaders to put on them.
  const waterG = group('Water');
  const waterMat = new THREE.MeshStandardMaterial({ name: 'Water', color: cfg.water.color, transparent: true, opacity: Math.max(0.05, cfg.water.opacity / 100), roughness: 0.06, metalness: 0.1, side: THREE.DoubleSide });
  if (cfg.water.enabled) { const w = cfg.terrain.endless ? (o.radius * 2 + 1) * size : Math.max(cfg.terrain.width, cfg.terrain.depth); const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w).rotateX(-Math.PI / 2), waterMat); m.position.y = cfg.water.level; m.name = 'Sea'; waterG.add(m); }
  for (const r of f.rivers) { const m = new THREE.Mesh(toPlain(riverWaterMesh(r)), waterMat); m.name = 'River'; waterG.add(m); }
  for (const l of f.lakes) { const m = new THREE.Mesh(toPlain(lakeWaterMesh(l)), waterMat); m.name = 'Lake'; waterG.add(m); }
  // The sun, where it is in the world.
  const t = cfg.sky.time, az = ((t - 6) / 12) * Math.PI, sun = new THREE.DirectionalLight('#fff4e3', cfg.sky.sunStrength);
  sun.name = 'Sun'; sun.position.set(Math.cos(az) * 100, Math.max(0.05, Math.sin(az)) * 100, 40); root.add(sun, sun.target);
  progress('Writing the glTF', 0.8);
  await tick();
  const safe = d.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'world';
  download(`${safe}.glb`, await toGlb(root), 'model/gltf-binary');
  // Heightmap: 16-bit little-endian raw (RAW16), square, plus its scale.
  const res = 1025, hm = bakeHeightmap(height, cfg.terrain.endless ? { ...cfg.terrain, width: (o.radius * 2 + 1) * size, depth: (o.radius * 2 + 1) * size } : cfg.terrain, res);
  const raw = new Uint16Array(res * res), span = Math.max(1e-3, hm.max - hm.min);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.round(((hm.data[i] - hm.min) / span) * 65535);
  download(`${safe}_heightmap_${res}x${res}.r16`, raw.buffer);
  download(`${safe}_world.json`, JSON.stringify({ name: d.name, heightmap: { size: res, min: hm.min, max: hm.max, widthMeters: cfg.terrain.endless ? (o.radius * 2 + 1) * size : cfg.terrain.width, depthMeters: cfg.terrain.endless ? (o.radius * 2 + 1) * size : cfg.terrain.depth }, config: cfg, roads: d.roads, placed: d.placed }, null, 1), 'application/json');
  return { file: `${safe}.glb`, objects: root.children.length, counts: {} };
}

export function ExportPanel() {
  const doc = useWC((st) => st.doc!);
  const cfg = useWC((st) => st.run?.config ?? st.doc!.config);
  const [o, setO] = useState<ExportOpts>({ radius: 2, grass: true, maxPerLayer: 2000, player: 'first' });
  const [busy, setBusy] = useState<{ text: string; frac: number } | null>(null);
  const [msg, setMsg] = useState('');
  const cancel = useRef(false);
  const run = async (fn: typeof exportGameCraft, done: (r: { file: string; objects: number }) => string) => {
    cancel.current = false; setMsg('');
    try {
      await wc.save();
      const r = await fn(doc, cfg, o, (text, frac) => { setBusy({ text, frac }); return !cancel.current; });
      setMsg(r ? done(r) : 'Cancelled.');
    } catch (e: any) { setMsg('Export failed: ' + (e?.message ?? e)); }
    setBusy(null);
  };
  return <>
    <Section title="Export">
      {cfg.terrain.endless && <Row label="Endless in GameCraft" tip="The land keeps generating round the player as they walk, from this world's seed and rules. Off: baked to one finite area"><input type="checkbox" checked={o.stream !== false} onChange={(e) => setO({ ...o, stream: e.target.checked })} /></Row>}
      {cfg.terrain.endless && <Row label="Area to bake for Blender (chunks round the centre)" tip={o.stream !== false ? 'Blender and other programs can only take a finite area' : 'Also the area baked for GameCraft'}><input type="number" min={0} max={12} value={o.radius} onChange={(e) => setO({ ...o, radius: Number(e.target.value) })} /></Row>}
      <Row label="Most objects per layer"><input type="number" min={0} step={100} value={o.maxPerLayer} onChange={(e) => setO({ ...o, maxPerLayer: Number(e.target.value) })} /></Row>
      <Row label="Include grass" tip="At full density in GameCraft: drawn as instances round the player. In the Blender file, up to 'Most objects per layer'. Grass you painted always goes"><input type="checkbox" checked={o.grass} onChange={(e) => setO({ ...o, grass: e.target.checked })} /></Row>
      <Row label="Player" tip="The player and camera the scene starts with. You can change them in GameCraft"><select value={o.player} onChange={(e) => setO({ ...o, player: e.target.value as ExportOpts['player'] })}><option value="first">First person</option><option value="third">Third person</option><option value="none">None</option></select></Row>
    </Section>
    <Section title="GameCraft">
      <Hint>Terrain with collision, objects, water, roads, your buildings and the sun as a new scene. Trees over 20,000 triangles go as picture cards, so they can run by the hundred. In GameCraft: Import scene, into this project or a new one.</Hint>
      <button className="wc-btn primary" disabled={!!busy} onClick={() => run(exportGameCraft, (r) => `Sent "${r.file}" with ${r.objects} objects to GameCraft's import list.`)}>Export to GameCraft</button>
    </Section>
    <Section title="Blender (also Godot, Unity)">
      <Hint>The whole world as one .glb: terrain, everything scattered and placed, structures, roads, water and the sun, grouped by kind. In Blender: File, Import, glTF 2.0. Plants share their meshes, so a forest stays small. Also saves a 16-bit heightmap and the settings. Clouds and the water shader stay behind: they only run in WorldCraft and GameCraft.</Hint>
      <button className="wc-btn primary" disabled={!!busy} onClick={() => run(exportBaked, (r) => `Saved ${r.file}, the heightmap and the settings to your downloads.`)}>Export to Blender</button>
    </Section>
    {busy && <div className="wc-progress"><div style={{ width: `${Math.round(busy.frac * 100)}%` }} /><span>{busy.text}</span><button className="wc-btn small" onClick={() => { cancel.current = true; }}>Cancel</button></div>}
    {msg && <Hint>{msg}</Hint>}
  </>;
}
