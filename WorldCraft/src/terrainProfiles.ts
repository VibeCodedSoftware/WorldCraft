// Custom terrain profiles: a world's land and look saved under a name (right-click the terrain › Save terrain as a
// profile), offered on the start screen under the built-in terrains, and removable from its folder button. Kept on
// this computer (with the app), not in any one world.
import type { WorldConfig } from '@shared/src/world/document';
import { deepCopy } from '@shared/src/world/document';

/** What a profile carries: the land's shape and its layers, ground colours and look, biomes, water, snow, plants. */
export interface TerrainProfile {
  name: string; created: number;
  terrain: WorldConfig['terrain']; surface: WorldConfig['surface']; biomes: WorldConfig['biomes'];
  water: WorldConfig['water']; snow: WorldConfig['snow']; layers: WorldConfig['layers']; cave: WorldConfig['cave'];
}

const KEY = 'wc.terrainProfiles';
let listeners: (() => void)[] = [];

export function listProfiles(): TerrainProfile[] {
  try { const a = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function store(list: TerrainProfile[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked: nothing saved */ }
  for (const f of listeners) f();
}
export const onProfiles = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };

/** Saves (or replaces, by name) a profile of this world's land and look. */
export function saveProfile(name: string, c: WorldConfig): TerrainProfile {
  const p: TerrainProfile = { name: name.trim() || 'My terrain', created: Date.now(), terrain: deepCopy(c.terrain), surface: deepCopy(c.surface), biomes: deepCopy(c.biomes), water: deepCopy(c.water), snow: deepCopy(c.snow), layers: deepCopy(c.layers), cave: deepCopy(c.cave) };
  // (A profile is a starting shape: not tied to a planet region.)
  if (p.terrain.planet) p.terrain.planet = { ...p.terrain.planet, enabled: false };
  store([...listProfiles().filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), p]);
  return p;
}
export function removeProfile(name: string) { store(listProfiles().filter((x) => x.name !== name)); }
export function renameProfile(from: string, to: string) {
  const t = to.trim(); if (!t || listProfiles().some((x) => x.name.toLowerCase() === t.toLowerCase())) return false;
  store(listProfiles().map((x) => (x.name === from ? { ...x, name: t } : x))); return true;
}
/** Lays a profile over a world's settings: its land (size included), look, water, snow and plants. */
export function applyProfile(c: WorldConfig, p: TerrainProfile) {
  c.terrain = { ...deepCopy(p.terrain), preset: p.name };
  c.surface = deepCopy(p.surface); c.biomes = deepCopy(p.biomes); c.water = deepCopy(p.water); c.snow = deepCopy(p.snow); c.cave = deepCopy(p.cave);
  if (p.layers?.length) c.layers = deepCopy(p.layers);
}
