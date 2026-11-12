// WorldCraft's documents: the shared local file API (dev server in the browser, craft:// in the desktop app), undo, and
// the view of the world's settings after its logic has run.
import { useSyncExternalStore } from 'react';
import { WORLD_FORMAT, type WorldConfig, type WorldDoc } from '@shared/src/world/document';
import { runWorldLogic, type LogicRun } from '@shared/src/world/bricks';
import { smoothPath, emptyEdits } from '@shared/src/world/features';
import { applyWorldStyle } from '@shared/src/world/generators';
import { generatedPicture } from './procTex';

const BASE = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'http://craft.localhost' : '';

async function req(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, init);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error ?? m; } catch { /* not json */ } throw new Error(m); }
  return r;
}

export const api = {
  list: async (): Promise<{ id: string; name: string; modified: number }[]> => (await req('/api/projects')).json(),
  load: async (id: string): Promise<WorldDoc> => { const a = await (await req(`/api/projects/${encodeURIComponent(id)}`)).json(); if (a?.format !== WORLD_FORMAT) throw new Error('Not a WorldCraft world'); return migrate(a); },
  save: async (d: WorldDoc) => { await req(`/api/projects/${encodeURIComponent(d.id)}`, { method: 'PUT', body: JSON.stringify(d) }); },
  remove: async (id: string) => { await req(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  putFile: async (id: string, rel: string, data: Blob | ArrayBuffer) => { await req(`/api/projects/${encodeURIComponent(id)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: data as BodyInit }); },
  library: async (): Promise<{ id: string; label: string; files: { path: string; size: number }[] }[]> => (await req('/api/library')).json(),
  exchangeList: async (): Promise<{ path: string }[]> => (await req('/api/exchange')).json(),
  exchangeGet: async (name: string) => (await req(`/api/exchange/${encodeURIComponent(name)}`)).text(),
  exchangePut: async (name: string, body: string) => (await req(`/api/exchange/${encodeURIComponent(name)}`, { method: 'PUT', body })).json(),
};

/** "lib:world/path" and "proj:path" to a URL; a "#Object" fragment stays. */
export function assetUrl(id: string): string | null {
  const hash = id.indexOf('#');
  if (hash >= 0) { const u = assetUrl(id.slice(0, hash)); return u && u + '#' + encodeURIComponent(id.slice(hash + 1)); }
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  if (id.startsWith('lib:')) { const rest = id.slice(4), i = rest.indexOf('/'); return `${BASE}/api/library/${rest.slice(0, i)}/${enc(rest.slice(i + 1))}`; }
  if (id.startsWith('proj:') && state.doc) return `${BASE}/api/projects/${encodeURIComponent(state.doc.id)}/files/${enc(id.slice(5))}`;
  if (id.startsWith('gen:')) return generatedPicture(id);
  return null;
}

/** Worlds made before the asset library changed point at these. */
const RENAMED: Record<string, string> = {
  'lib:world/bark/bark-brown.jpg': 'lib:world/woods/Wood1/Wood1_Diffuse.jpg', 'lib:world/bark/bark-deep.jpg': 'lib:world/woods/Wood3/Wood3_Diffuse.jpg', 'lib:world/bark/bark-pale.jpg': 'lib:world/woods/Wood4/Wood4_Diffuse.jpg', 'lib:world/bark/bark-grey.jpg': 'lib:world/woods/Wood2/Wood2_Diffuse.jpg',
  'lib:world/leaves/stylized/leaves-stylized.png': 'lib:world/leaves/Leaves-Stylized.png', 'lib:world/leaves/realistic/leaf-pine-sprig.png': 'lib:world/leaves/Pine1.png', 'lib:world/leaves/realistic/leaf-maple-orange.png': 'lib:world/leaves/Leaf5.png', 'lib:world/leaves/realistic/leaf-red.png': 'lib:world/leaves/Leaf1.png', 'lib:world/leaves/realistic/leaf-dry-oak.png': 'lib:world/leaves/Leaf2.png', 'lib:world/leaves/realistic/leaf-maple-dark.png': 'lib:world/leaves/Leaf3.png', 'lib:world/leaves/realistic/leaf-golden.png': 'lib:world/leaves/Leaf4.png',
  'lib:world/leaves/pixel/PixelArt-TreeLeafs.png': 'lib:world/leaves/PixelArt-TreeLeafs.png', 'lib:world/leaves/pixel/PixelArt-Falling-Leaf.png': 'lib:world/leaves/PixelArt-Falling-Leaf.png',
  'card:lib:world/grass/grass-stylized.png': 'lib:world/grass/Stylized_Grass_1.fbx', 'card:lib:world/grass/pixel/PixelArt-GrassCard.png': 'lib:world/grass/PixelArtGrass.fbx', 'card:lib:world/grass/pixel/PixelArt-GrassCard2.png': 'lib:world/grass/PixelArtGrass2.fbx',
  'lib:world/grass/models/Stylized_Grass_1.fbx': 'lib:world/grass/StylizedGrass.blend',
  // (The FBX copies of these lost their look; the .blend files are the originals.)
  'lib:world/grass/Stylized_Grass_1.fbx': 'lib:world/grass/StylizedGrass.blend', 'lib:world/trees/StylizedTree2.fbx': 'lib:world/trees/StylizedTree2.blend', 'lib:world/grass/models/Realsitc-ish Grass.fbx': 'lib:world/grass/Realsitc-ish Grass.fbx',
};

function migrate(d0: WorldDoc): WorldDoc {
  let text = JSON.stringify(d0);
  for (const [a, b] of Object.entries(RENAMED)) text = text.split(a).join(b);
  const d: WorldDoc = JSON.parse(text);
  d.edits ={ ...emptyEdits(), ...d.edits };
  // The old Hole tool cut the land away (a see-through gap to the backdrop): those spots become pits with rock walls.
  const oldHoles = Object.keys(d.edits.holes ?? {});
  if (oldHoles.length) {
    const rock = (d.edits.paint.rock ??= {});
    for (const k of oldHoles) { d.edits.height[k] = (d.edits.height[k] ?? 0) - 6; rock[k] = Math.max(rock[k] ?? 0, 0.8); }
    d.edits.holes = {};
  }
  for (const l of d.config.layers as (typeof d.config.layers[number] & { sway?: number })[]) { l.moves ??= (l.sway ?? 1) > 0; delete l.sway; }
  // Stylized tree 2 was taken out of the library: layers and placed objects using it let it go.
  const gone = (s: string) => /\/StylizedTree2\.(blend|fbx)$/.test(s);
  for (const l of d.config.layers) l.sources = l.sources.filter((s) => !gone(s));
  d.placed = d.placed.filter((p) => !gone(p.asset));
  // The fantasy tree is a sakura (Japanese cherry): its name, and its colours if they were never changed.
  const sak = d.config.trees.find((t) => t.id === 'fantasy');
  if (sak && sak.name === 'Fantasy tree') { sak.name = 'Sakura'; if (sak.cfg.leaf === '#c25bd6') { sak.cfg.leaf = '#f4a9c8'; sak.cfg.bark = '#4a3532'; } }
  // Worlds still on the first default scatter rules get the better ones (a layer you changed is left alone).
  for (const l of d.config.layers) {
    if (l.id === 'l_trees' && l.maxSlope === 0.2 && l.density === 0.5) { l.maxSlope = 0.5; l.sources = l.sources.filter((s) => !/\/Tree[15]\.fbx$/.test(s)); }
    // (The first default mixed different grasses; they're different types, so one is the default now.)
    if (l.id === 'l_grass' && l.sources.length > 1 && l.sources[0] === 'lib:world/grass/RealisticGrass.fbx' && (l.density === 40 || l.density === 80)) { l.maxSlope = 0.55; l.density = 240; l.copyGround = true; l.sources = [l.sources[0]]; }
  }
  if (d.config.optimize.grassDistance === 80) d.config.optimize.grassDistance = 170;
  // The first default trees mixed stylized models in with realistic ones: worlds still on that list take the realistic
  // look (one kind of tree, leaf, grass and rock), and the default meadow is thicker.
  const trees = d.config.layers.find((l) => l.id === 'l_trees'), grass = d.config.layers.find((l) => l.id === 'l_grass');
  // The default grass grew on slopes too steep for it.
  if (grass && (grass.maxSlope === 0.55 || grass.maxSlope === 0.6)) grass.maxSlope = 0.42;
  // The default grass grew in patches with bare ground between: still on that default, it's a thick, even meadow now.
  if (grass && grass.density === 400 && grass.clustering === 0.45) { grass.density = 800; grass.clustering = 0; grass.minScale = Math.max(grass.minScale, 0.8); }
  if (!d.config.style) {
    if (trees && trees.sources.join() === 'tree:oak,tree:pine,tree:birch,tree:maple,lib:world/trees/StylizedTree1.fbx') applyWorldStyle(d.config, 'realistic');
  } else {
    // Looks set up before each look had one grass (stylized had two), or with the supplied stylized tree models among
    // the generated ones: set up again. A world whose layers were changed by hand is left alone.
    const oldTrees = trees?.sources.some((s) => /StylizedTree[12]\./.test(s) && trees.sources.some((x) => x.startsWith('tree:')));
    const oldGrass = grass && ((grass.sources.length === 2 && grass.sources.every((s) => /StylizedGrass(_2)?\.blend$/.test(s))) || grass.density === 400);
    if (oldTrees || oldGrass) applyWorldStyle(d.config, d.config.style);
  }
  // Flatlands used to sit so low that the whole plain counted as shore and turned to beach: lift it, and what stands on it.
  if (d.config.terrain.preset === 'Flatlands' && d.config.terrain.baseHeight === 2) {
    d.config.terrain.baseHeight = 8;
    for (const o of d.placed ?? []) o.y += 6;
  }
  d.config.surface.greens ??= true;
  d.placed ??= []; d.roads ??= []; d.particles ??= []; d.sounds ??= []; d.assets ??= []; d.favorites ??= []; d.presets ??= {};
  return d;
}

export type Panel = 'world' | 'terrain' | 'paint' | 'trees' | 'rocks' | 'scatter' | 'biomes' | 'water' | 'roads' | 'snow' | 'seasons' | 'weather' | 'structures' | 'caves' | 'interact' | 'particles' | 'optimize' | 'presets' | 'export';

export interface WCState { doc: WorldDoc | null; dirty: boolean; rev: number; status: string; panel: Panel; selected: string | null; run: LogicRun | null; logicOpen: boolean; /** The layer, species or set picked in the Objects tree. */ focus: string | null; messages: { t: string; text: string }[]; /** Drawing quality on this computer. */ quality: 'auto' | 'low' | 'medium' | 'high' | 'ultra' }
const savedQuality = (): WCState['quality'] => { try { const q = localStorage.getItem('wc.quality'); return q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : 'auto'; } catch { return 'auto'; } };
let state: WCState = { doc: null, dirty: false, rev: 0, status: '', panel: 'terrain', selected: null, run: null, logicOpen: true, focus: null, messages: [], quality: savedQuality() };
const note = (text: string) => { const t = new Date().toLocaleTimeString(); return [...state.messages.slice(-199), { t, text }]; };
const subs = new Set<() => void>();
const undo: string[] = []; const redo: string[] = [];

/** The settings generators use: the world's own, then whatever the logic's On generate sets. Road bricks add roads. */
function compute(d: WorldDoc): LogicRun { return runWorldLogic(d.logic, d.config); }

export const wc = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); },
  set(p: Partial<WCState>) { state = { ...state, ...p }; subs.forEach((f) => f()); },
  open(doc: WorldDoc) { undo.length = 0; redo.length = 0; wc.set({ doc, dirty: false, rev: state.rev + 1, run: compute(doc), selected: null }); },
  close() { wc.set({ doc: null, run: null, selected: null }); },
  /** `quiet`: part of a slider drag or brush stroke, undone with the steps around it. */
  mutate(label: string, fn: (d: WorldDoc) => void, quiet = false) {
    if (!state.doc) return;
    if (!quiet) { undo.push(JSON.stringify(state.doc)); if (undo.length > 80) undo.shift(); redo.length = 0; }
    const d: WorldDoc = JSON.parse(JSON.stringify(state.doc)); fn(d); d.modified = new Date().toISOString();
    wc.set({ doc: d, dirty: true, rev: state.rev + 1, run: compute(d), status: label, messages: quiet ? state.messages : note(label) });
  },
  /** Edits in place (brush strokes: copying the whole world many times a second would stall). */
  touch(fn: (d: WorldDoc) => void) { if (!state.doc) return; fn(state.doc); state = { ...state, dirty: true, rev: state.rev + 1 }; subs.forEach((f) => f()); },
  checkpoint() { if (state.doc) { undo.push(JSON.stringify(state.doc)); if (undo.length > 80) undo.shift(); redo.length = 0; } },
  undo() { const u = undo.pop(); if (!u || !state.doc) return; redo.push(JSON.stringify(state.doc)); const d = JSON.parse(u); wc.set({ doc: d, dirty: true, rev: state.rev + 1, run: compute(d), status: 'Undo' }); },
  redo() { const r = redo.pop(); if (!r || !state.doc) return; undo.push(JSON.stringify(state.doc)); const d = JSON.parse(r); wc.set({ doc: d, dirty: true, rev: state.rev + 1, run: compute(d), status: 'Redo' }); },
  async save() { if (!state.doc) return; await api.save(state.doc); wc.set({ dirty: false, status: `Saved "${state.doc.name}"`, messages: note(`Saved "${state.doc.name}"`) }); },
  log(text: string) { wc.set({ messages: note(text), status: text }); },
};

export function useWC<T>(sel: (s: WCState) => T): T { return useSyncExternalStore(wc.subscribe, () => sel(state)); }

/** Settings after the logic: what the world is actually built from. */
export const effective = (): WorldConfig | null => state.run?.config ?? state.doc?.config ?? null;
export const roadsOf = (d: WorldDoc) => [...d.roads, ...(state.run?.roads ?? []).map((r, i) => ({ id: 'brick' + i, kind: r.kind, width: r.width, points: [[r.x1, r.z1], [r.x2, r.z2]] as [number, number][], conform: r.conform, bridge: false, material: '', decorate: 0 }))];
export { smoothPath };
