// WorldCraft: launcher and the editor. A ribbon of grouped tools on top; asset library and preview on the left; the 3D
// view in the middle; the world's objects and their settings on the right; logic, messages and output docked below.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodingStylePicker, LogicView, useCodingStyle } from '@shared/ui/LogicEditor';
import { newWorld, infiniteNoiseEvents, ecosystemEvents } from '@shared/src/world/features';
import { TERRAIN_PRESETS } from '@shared/src/world/terrain';
import { applyTerrainPreset } from '@shared/src/world/features';
import { applyProfile, listProfiles, onProfiles, removeProfile, renameProfile, saveProfile } from './terrainProfiles';
import { importAsset } from './importTexture';
import { makeSpawn } from '@shared/src/world/scatter';
import { noise2, randomSeed, smoothstep } from '@shared/src/world/random';
import { brushFrame, brushWeight, isHeightShape, makeLandforms } from './brushShapes';
import { applyArea, areaParams, setArea } from './areaTools';

/** The sculpting shortcuts, on the view while a sculpt brush is out (closable; a small button brings it back). */
const SCULPT_TOOLS = new Set(['raise', 'lower', 'smooth', 'flatten', 'noise', 'stamp', 'terrace', 'push', 'erode', 'twist', 'relief', 'tilt', 'align', 'clone', 'hole']);
const SHORTCUTS: [string, string][] = [['Sculpt', 'Left mouse'], ['Subtract (raise / lower)', 'Shift + left mouse'], ['Brush radius', 'Ctrl + wheel'], ['Brush smoothness', 'Ctrl + Shift + wheel'], ['Brush strength', 'Ctrl + Alt + wheel'], ['Brush rotation', 'Alt + Shift + wheel'], ['Height change (level step)', 'Ctrl + X + wheel'], ['Flatten height', 'Ctrl + C + wheel'], ['Radius / smoothness / strength', 'I / O / P + move mouse']];
function ShortcutCard({ tool }: { tool: string }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('wc.keysCard') !== 'off'; } catch { return true; } });
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem('wc.keysCard', v ? 'on' : 'off'); } catch { /* not remembered */ } };
  if (!SCULPT_TOOLS.has(tool)) return null;
  if (!open) return <button className="wc-keycard-open" title="Show the sculpting shortcuts" onClick={() => set(true)}>Shortcuts</button>;
  return <div className="wc-keycard"><button className="wc-keycard-x" title="Hide" onClick={() => set(false)}>×</button><table><tbody>{SHORTCUTS.map(([a, k]) => <tr key={a}><td>{a}</td><td>{k}</td></tr>)}</tbody></table></div>;
}
import { validateDocument } from '@shared/src/validate';
import { OPTIMIZE_PROFILES } from '@shared/src/world/bricks';
import { SURFACE_LAYERS } from '@shared/src/world/biomes';
import { LEAF_STYLES, type LeafStyle, type Placed, type WorldDoc, type WorldStyle } from '@shared/src/world/document';
import { applyWorldStyle, LOOK_GRASSES, lookGrass, deleteSkeletonBranch, generateTree, genId, moveSkeletonNode, parseGenId, resolveTree, strokeBranch } from '@shared/src/world/generators';
import { ROAD_KINDS } from '@shared/src/world/features';
import { Hint, Row } from './ui';
import { WorldView, type BrushCfg, type BrushTool } from './view';
import { BIOME_INFO, biomeAt } from '@shared/src/world/biomes';
import { QualityPicker, RightPanel, setDrawTool } from './panels';
import { PlanetBuilder } from './planetView';
import { NodeGraphWindow } from './nodeGraph';
import { api, assetUrl, effective, roadsOf, useWC, wc, type Panel } from './store';
import { bulkLayerId, bulkLayerName, paintsInBulk } from './modelLook';
import { makeLayer } from '@shared/src/world/scatter';
import { buildSubject, drawSubject, infoOf, materialSets, thumbnail, type MaterialSet, type ModelInfo } from './thumbs';
import { groupPbrSets } from '@shared/src/materialMaps';

// ------------------------------------------------------------------------------------------------- small pieces

const G: Record<string, string> = {
  new: 'M6 3h9l4 4v14H6zM15 3v4h4', open: 'M3 7h6l2 2h10v10H3z', save: 'M5 3h12l3 3v15H5zM8 3v6h8V3M8 21v-7h9v7', import: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  undo: 'M8 7L4 11l4 4M4 11h10a5 5 0 010 10h-3', redo: 'M16 7l4 4-4 4M20 11H10a5 5 0 000 10h3', copy: 'M8 8h12v12H8zM4 4h12v3M4 4v12h3', trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  orbit: 'M12 3a9 9 0 110 18 9 9 0 010-18zM3 12c4 3 14 3 18 0', select: 'M5 3l13 8-6 2 4 7-3 1-3-7-5 4z', move: 'M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3', rotate: 'M20 12a8 8 0 11-3-6M20 3v5h-5', scale: 'M4 20L20 4M14 4h6v6M10 20H4v-6',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', top: 'M4 4h16v16H4zM12 8v8M8 12h8', wire: 'M3 8l9-5 9 5v8l-9 5-9-5zM12 3v18M3 8l18 8M21 8L3 16', cloud: 'M7 18a4 4 0 010-8 6 6 0 0111-1 4.5 4.5 0 01-1 9z', tree: 'M12 22v-7M12 2l6 8h-3l4 6H5l4-6H6z', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z',
  seed: 'M12 21c-5 0-8-4-8-9 5 0 8 4 8 9zM12 21c5 0 8-4 8-9-5 0-8 4-8 9zM12 12c0-4 1-7 0-10-2 3-1 6 0 10', globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', play: 'M7 4l13 8-13 8z', mountain: 'M2 20L9 7l4 6 3-4 6 11z', hill: 'M2 20c4-9 8-9 11-5 2-3 6-3 9 5z', cliff: 'M3 20h8V9h4V5h6v15', plateau: 'M2 20l4-8h12l4 8z', canyon: 'M2 8h6l3 12h2l3-12h6', island: 'M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0M6 14c2-6 10-6 12 0', islands: 'M2 19c2-1.5 4-1.5 5 0s4 1.5 5 0 4-1.5 5 0 3 1 5 0M3 15c1-5 6-5 8 0M13 15c1-7 7-7 8 0', blank: 'M3 15l6-4h12l-6 4z', valley: 'M2 6l8 12h4l8-12', desert: 'M2 20c6-8 10-6 14-3 2-2 4-2 6-1v4z',
  nodes: 'M2 5h7v5H2zM15 3h7v5h-7zM15 15h7v5h-7zM9 7.5h2c2 0 2-2 4-2M11 7.5c2 0 2 10 4 10',
  folder: 'M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z',
  raise: 'M12 20V6M7 11l5-5 5 5M4 21h16', lower: 'M12 4v14M7 13l5 5 5-5M4 3h16', smooth: 'M2 14c4-6 7-6 10-2s6 4 10-2', flatten: 'M3 16h18M6 12h12M9 8h6', noise: 'M2 14l3-5 3 7 3-10 3 9 3-6 2 4 3-3', hole: 'M12 7c6 0 9 2 9 5s-3 5-9 5-9-2-9-5 3-5 9-5z', stamp: 'M8 3h8v7l3 4v3H5v-3l3-4zM4 21h16', brush: 'M18 3l3 3-9 9-3-3zM9 12c-3 0-4 2-4 4s-2 3-3 3c3 2 9 2 10-3', paint: 'M4 13L13 4l7 7-9 9zM20 15s2 3 2 4a2 2 0 01-4 0c0-1 2-4 2-4',
  drop: 'M12 3v11M7 10l5 5 5-5M5 21h14', click: 'M9 9l11 4-5 2-2 5zM5 3v3M3 5h3M3 3l2 2', water: 'M12 3s7 8 7 12a7 7 0 01-14 0c0-4 7-12 7-12z', river: 'M8 2c-3 5 8 7 5 12s-5 3-5 8M14 2c-3 5 8 7 5 12s-5 3-5 8', wave: 'M2 10c3-3 5-3 7 0s4 3 7 0 4-3 6 0M2 16c3-3 5-3 7 0s4 3 7 0 4-3 6 0', road: 'M8 2L4 22M16 2l4 20M12 3v3M12 10v4M12 18v3', snow: 'M12 2v20M4 7l16 10M20 7L4 17', rain: 'M7 16a4 4 0 010-8 6 6 0 0111-1 4 4 0 01-1 9zM8 19l-1 3M12 19l-1 3M16 19l-1 3', fog: 'M3 8h14M6 12h15M3 16h15', sun: 'M12 8a4 4 0 110 8 4 4 0 010-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', leaf: 'M4 20C4 9 12 4 21 3c0 9-5 17-16 17zM4 20c4-5 8-8 12-11', rock: 'M3 18l3-9 6-5 7 4 2 10z', layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5', build: 'M4 21V10l8-6 8 6v11h-5v-7H9v7z', cave: 'M3 21c0-10 4-17 9-17s9 7 9 17h-5c0-6-2-9-4-9s-4 3-4 9z', voxel: 'M12 2l8 4.5v9L12 20l-8-4.5v-9zM4 6.5l8 4.5 8-4.5M12 11v9', gauge: 'M4 18a9 9 0 1116 0M12 15l4-6', logic: 'M4 4h6v5H4zM14 15h6v5h-6zM10 6h4a2 2 0 012 2v7', export: 'M12 16V4M7 9l5-5 5 5M4 15v5h16v-5', star: 'M12 3l3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L3 10l6-1z', plus: 'M12 5v14M5 12h14',
};
const Glyph = ({ n, size = 22 }: { n: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={G[n] ?? G.plus} /></svg>;
const Big = ({ i, l, on, off, tip, click }: { i: string; l: string; on?: boolean; off?: boolean; tip?: string; click?: () => void }) => <button className={'rb-big' + (on ? ' on' : '')} disabled={off} title={tip ?? l} onClick={click}><Glyph n={i} /><span>{l}</span></button>;
const Group = ({ l, children }: { l: string; children: React.ReactNode }) => <div className="rb-group"><div className="rb-items">{children}</div><label>{l}</label></div>;
const RSlider = ({ l, v, min, max, step, set, off }: { l: string; v: number; min: number; max: number; step: number; set: (n: number) => void; off?: boolean }) => (
  <div className={'rb-slider' + (off ? ' off' : '')}><div><input type="range" disabled={off} min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} /><input type="number" disabled={off} min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} /></div><span>{l}</span></div>
);

const TABS: { id: string; panel: Panel }[] = [
  { id: 'File', panel: 'export' }, { id: 'Edit', panel: 'terrain' }, { id: 'View', panel: 'optimize' }, { id: 'World', panel: 'presets' }, { id: 'Terrain', panel: 'terrain' }, { id: 'Generators', panel: 'trees' }, { id: 'Scatter', panel: 'scatter' }, { id: 'Water', panel: 'water' }, { id: 'Roads', panel: 'roads' }, { id: 'Snow', panel: 'snow' }, { id: 'Weather', panel: 'weather' }, { id: 'Seasons', panel: 'seasons' }, { id: 'Structures', panel: 'structures' }, { id: 'Optimize', panel: 'optimize' }, { id: 'Export', panel: 'export' },
];
const SCULPT: [BrushTool, string, string][] = [['raise', 'Raise', 'raise'], ['lower', 'Lower', 'lower'], ['smooth', 'Smooth', 'smooth'], ['flatten', 'Flatten', 'flatten'], ['noise', 'Noise', 'noise'], ['terrace', 'Terrace', 'flatten'], ['push', 'Push', 'smooth'], ['erode', 'Erode', 'noise'], ['stamp', 'Stamp', 'stamp'], ['hole', 'Hole', 'hole'], ['twist', 'Rotate', 'rotate'], ['relief', 'Scale', 'scale'], ['tilt', 'Tilt', 'flatten'], ['align', 'Align', 'flatten'], ['clone', 'Duplicate', 'copy']];
const PAINT: [BrushTool, string, string][] = [['paint', 'Ground', 'paint'], ['biome', 'Biome', 'layers'], ['scatter', 'Plants', 'leaf'], ['erase', 'Erase', 'trash'], ['snow', 'Snow', 'snow']];
const SHAPES: [string, string][] = [['Blank', 'blank'], ['Mountains', 'mountain'], ['Hills', 'hill'], ['Valleys', 'valley'], ['Cliffs', 'cliff'], ['Plateaus', 'plateau'], ['Canyons', 'canyon'], ['Island', 'island'], ['Islands', 'islands'], ['Desert', 'desert']];

// ------------------------------------------------------------------------------------------------- launcher

function Launcher() {
  const [list, setList] = useState<{ id: string; name: string; modified: number }[]>([]);
  const [name, setName] = useState('My world');
  const [preset, setPreset] = useState('Mountains');
  const [err, setErr] = useState('');
  const refresh = () => api.list().then((l) => setList(l.sort((a, b) => b.modified - a.modified))).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { refresh(); }, []);
  // Custom terrain profiles (saved by right-clicking a terrain): under the built-in terrains, with a folder to manage them.
  const [profiles, setProfiles] = useState(listProfiles());
  useEffect(() => onProfiles(() => setProfiles(listProfiles())), []);
  const [manage, setManage] = useState(false);
  const create = async () => {
    const d = newWorld(name || 'World');
    Object.assign(d.config.terrain, { width: 1024, depth: 1024, chunkSize: 128, resolution: 96 });
    d.config.sky.time = 8.5; d.config.weather.clouds = 0.5;
    const prof = preset.startsWith('custom:') ? profiles.find((p) => p.name === preset.slice(7)) : null;
    if (prof) applyProfile(d.config, prof);
    else { d.config.water.rivers = preset === 'Mountains' || preset === 'Valleys' ? 3 : 0; applyTerrainPreset(d.config, preset); }
    await api.save(d); wc.open(d);
  };
  return <div className="wc-launch">
    <header><img src="icon.png" alt="" /><div><h1>WorldCraft</h1><p>Procedural worlds for GameCraft</p></div></header>
    <div className="wc-launch-body">
      <section><h2>New world</h2>
        <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Terrain<span className="wc-launch-terrain">
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <optgroup label="Terrains">{Object.keys(TERRAIN_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>
            <optgroup label="Custom">{profiles.length ? profiles.map((p) => <option key={p.name} value={'custom:' + p.name}>{p.name}</option>) : <option disabled value="">Right-click your terrain to save one</option>}</optgroup>
          </select>
          <button className="wc-btn" title="Your custom terrains: rename or delete them" onClick={(e) => { e.preventDefault(); setManage(true); }}><Glyph n="folder" size={15} /></button>
        </span></label>
        {manage && <div className="wc-modal-back" onClick={() => setManage(false)}><div className="wc-modal" onClick={(e) => e.stopPropagation()}>
          <h3>Custom terrains</h3>
          {!profiles.length && <p className="wc-hint">None yet. In a world, right-click the terrain and choose "Save terrain as a custom profile".</p>}
          {profiles.map((p) => <div key={p.name} className="wc-world"><button title="Rename" onClick={() => { const n = prompt('New name', p.name); if (n && !renameProfile(p.name, n)) alert('That name is taken or empty.'); }}><b>{p.name}</b><em>{new Date(p.created).toLocaleString()}</em></button><button title="Delete" onClick={() => { if (confirm(`Delete the custom terrain "${p.name}"? Worlds made from it stay as they are.`)) { removeProfile(p.name); if (preset === 'custom:' + p.name) setPreset('Mountains'); } }}>✕</button></div>)}
          <div style={{ textAlign: 'right', marginTop: 8 }}><button className="wc-btn" onClick={() => setManage(false)}>Done</button></div>
        </div></div>}
        <button className="wc-btn primary" onClick={create}>Create world</button>
      </section>
      <section><h2>Your worlds</h2>
        {!list.length && <p className="wc-hint">Nothing here yet. Worlds save automatically.</p>}
        {list.map((p) => <div className="wc-world" key={p.id}><button onClick={() => api.load(p.id).then(wc.open).catch((e) => setErr(String(e.message ?? e)))}><b>{p.name}</b><em>{new Date(p.modified).toLocaleString()}</em></button><button title="Delete" onClick={async () => { if (confirm(`Delete "${p.name}"?`)) { await api.remove(p.id); refresh(); } }}>✕</button></div>)}
      </section>
    </div>
    {err && <p className="wc-hint">{err}</p>}
  </div>;
}

// ------------------------------------------------------------------------------------------------- right-click menu

/**
 * Right-click on the terrain: what's there (height, slope, biome), saving the world's land as a custom terrain for the
 * start screen, and quick edits at that spot (sized by the brush): place the picked asset, flatten, smooth, raise,
 * lower, snow, clear objects; and looking, walking, copying the spot, undo and going home.
 */
function TerrainMenu({ at, close, view, brushSize, picked, placeAt }: { at: { x: number; y: number; p: { x: number; y: number; z: number } | null }; close: () => void; view: WorldView | null; brushSize: number; picked: { id: string; kind: Item['kind'] } | null; placeAt: (asset: string, x: number, y: number, z: number, select?: boolean) => void }) {
  const p = at.p, doc = wc.get().doc!, c = effective() ?? doc.config;
  const info = useMemo(() => {
    if (!p || !view) return null;
    const h = (x: number, z: number) => view.height(x, z), e = 1.5;
    const slope = Math.hypot(h(p.x + e, p.z) - h(p.x - e, p.z), h(p.x, p.z + e) - h(p.x, p.z - e)) / (2 * e);
    return { slope: Math.round((Math.atan(slope) * 180) / Math.PI), biome: c.biomes.enabled ? BIOME_INFO[biomeAt(c, doc.edits, p.x, p.z, p.y).id]?.name ?? 'custom' : 'none' };
  }, [p?.x, p?.z]);
  const R = Math.max(2, brushSize);
  const redraw = () => setTimeout(() => { view?.refreshHeight(); if (p) view?.editedAt(p.x, p.z, R + doc.edits.cell * 2); }, 60);
  /** A change to the land round the spot: `to(height here, weight 0..1)` gives the new height. */
  const reshape = (label: string, to: (y: number, w: number, x: number, z: number) => number) => {
    if (!p || !view) return;
    const cell = doc.edits.cell, ch: [string, number][] = [];
    for (let i = Math.floor((p.x - R) / cell); i <= Math.ceil((p.x + R) / cell); i++) for (let j = Math.floor((p.z - R) / cell); j <= Math.ceil((p.z + R) / cell); j++) {
      const x = i * cell, z = j * cell, d = Math.hypot(x - p.x, z - p.z) / R; if (d > 1) continue;
      const w = 1 - d * d * (3 - 2 * d), y = view.height(x, z), t = to(y, w, x, z);
      if (Math.abs(t - y) > 1e-3) ch.push([`${i},${j}`, t - y]);
    }
    wc.mutate(label, (d) => { for (const [k, dv] of ch) d.edits.height[k] = (d.edits.height[k] ?? 0) + dv; });
    redraw();
  };
  const run = (f: () => void) => () => { close(); f(); };
  const canPlace = !!p && !!picked && (picked.kind === 'model' || picked.kind === 'generated');
  return <div className="wc-ctx" style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}>
    {p ? <div className="wc-ctx-head">{`${Math.round(p.x)}, ${Math.round(p.z)} · ${p.y.toFixed(1)} m up · slope ${info?.slope ?? 0}°${info && info.biome !== 'none' ? ` · ${info.biome}` : ''}`}</div> : <div className="wc-ctx-head">Not on the ground</div>}
    <button onClick={run(() => { const n = prompt('Name for this terrain (it appears under Custom on the start screen)', doc.name); if (n) { saveProfile(n, doc.config); wc.log(`Saved the custom terrain "${n}"`); } })}>Save terrain as a custom profile…</button>
    <hr />
    <button disabled={!canPlace} onClick={run(() => { if (p && picked) placeAt(picked.id, p.x, p.y, p.z); })}>{canPlace ? `Place "${picked!.id.replace(/^.*[/:]/, '').replace(/\.[^.]+$/, '').replace(/[@~].*$/, '')}" here` : 'Place the picked asset here'}</button>
    <button disabled={!p} onClick={run(() => reshape('Flattened here', (y, w) => y + (p!.y - y) * w))}>Flatten here ({Math.round(R)} m)</button>
    <button disabled={!p} onClick={run(() => { const avg = (x: number, z: number) => (view!.height(x + 2, z) + view!.height(x - 2, z) + view!.height(x, z + 2) + view!.height(x, z - 2)) / 4; reshape('Smoothed here', (y, w, x, z) => y + (avg(x, z) - y) * w * 0.8); })}>Smooth here</button>
    <button disabled={!p} onClick={run(() => reshape('Raised a hill here', (y, w) => y + w * R * 0.25))}>Raise a hill here</button>
    <button disabled={!p} onClick={run(() => reshape('Lowered here', (y, w) => y - w * R * 0.2))}>Lower here</button>
    <button disabled={!p} onClick={run(() => { if (!p) return; const cell = doc.edits.cell; wc.mutate('Snow here', (d) => { for (let i = Math.floor((p.x - R) / cell); i <= Math.ceil((p.x + R) / cell); i++) for (let j = Math.floor((p.z - R) / cell); j <= Math.ceil((p.z + R) / cell); j++) { const dd = Math.hypot(i * cell - p.x, j * cell - p.z) / R; if (dd <= 1) d.edits.snow[`${i},${j}`] = Math.min(1, (d.edits.snow[`${i},${j}`] ?? 0) + (1 - dd)); } }); redraw(); })}>Snow here</button>
    <button disabled={!p} onClick={run(() => { if (!p) return; const n = doc.placed.filter((o) => Math.hypot(o.x - p.x, o.z - p.z) <= R).length; wc.mutate(`Removed ${n} object${n === 1 ? '' : 's'} here`, (d) => { d.placed = d.placed.filter((o) => Math.hypot(o.x - p.x, o.z - p.z) > R); }); })}>Remove placed objects here</button>
    <hr />
    <button disabled={!p} onClick={run(() => { if (!p || !view) return; const cam = view.camera.position, t = view.controls.target; cam.set(cam.x + p.x - t.x, cam.y + p.y - t.y, cam.z + p.z - t.z); t.set(p.x, p.y, p.z); view.controls.update(); })}>Look at this spot</button>
    <button disabled={!p} onClick={run(() => { if (p) void navigator.clipboard?.writeText(`${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`).then(() => wc.log('Copied the spot (x, y, z)')); })}>Copy this spot (x, y, z)</button>
    <hr />
    <button onClick={run(() => wc.undo())}>Undo</button>
    <button onClick={run(() => wc.redo())}>Redo</button>
    <button onClick={run(async () => { await wc.save(); wc.close(); })}>Back to the start screen</button>
  </div>;
}

// ------------------------------------------------------------------------------------------------- library

interface Item { id: string; name: string; group: string; kind: 'model' | 'picture' | 'generated' | 'material'; /** A material's own images. */ children?: Item[] }

/** A picture with opaque black where it should be see-through (all corners black) gets real transparency on import. */
async function transparentBlack(f: File): Promise<Blob> {
  if (!/\.(png|webp)$/i.test(f.name)) return f;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(bmp, 0, 0); bmp.close();
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, w = c.width, h = c.height;
    const black = (i: number) => px[i + 3] > 100 && px[i] + px[i + 1] + px[i + 2] < 30;
    if (![0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4].every(black)) return f;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 30) px[i + 3] = 0;
    g.putImageData(d, 0, 0);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? f), 'image/png'));
  } catch { return f; }
}

function Thumb({ item }: { item: Item }) {
  const [src, setSrc] = useState(item.kind === 'picture' ? assetUrl(item.id) ?? '' : '');
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (item.kind === 'picture') return;
    let live = true;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { io.disconnect(); thumbnail(item.id, effective()).then((u) => { if (live) setSrc(u); }); } });
    if (ref.current) io.observe(ref.current);
    return () => { live = false; io.disconnect(); };
  }, [item.id, item.kind]);
  return <img ref={ref} src={src || 'data:image/gif;base64,R0lGODlhAQABAAAAACw='} alt="" draggable={false} style={/pixel/i.test(item.id) ? { imageRendering: 'pixelated' } : undefined} />;
}

/** Stores-style library: search, folders of thumbnails. Drag onto the view, or pick and use Click / Brush. */
function Library({ picked, pick }: { picked: string; pick: (i: Item) => void }) {
  const [lib, setLib] = useState<{ id: string; files: { path: string }[] }[]>([]);
  const [q, setQ] = useState('');
  const [onlyFav, setOnlyFav] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const doc = useWC((st) => st.doc!);
  useEffect(() => { api.library().then(setLib).catch(() => setLib([])); }, []);
  const items = useMemo(() => {
    const out: Item[] = [
      ...doc.config.trees.map((t) => ({ id: 'tree:' + t.id, name: t.name, group: 'Generated trees', kind: 'generated' as const })),
      ...doc.config.rocks.map((t) => ({ id: 'rock:' + t.id, name: t.name, group: 'Generated rocks', kind: 'generated' as const })),
    ];
    // Pictures that belong together (Wood1_Diffuse, Wood1_Normal…) are one material: a sphere with its images under it.
    const pictures = [...lib.flatMap((l) => l.files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.path)).map((f) => ({ id: `lib:${l.id}/${f.path}`, path: f.path }))), ...doc.assets.filter((a) => a.kind === 'texture').map((a) => ({ id: a.id, path: a.id.slice(5) }))];
    const grouped = new Set<string>();
    for (const set of groupPbrSets(pictures)) {
      const id = 'mat:' + set.folder + '/' + set.name;
      materialSets.set(id, { name: set.name, maps: set.maps as MaterialSet['maps'] });
      const children: Item[] = Object.entries(set.maps).map(([slot, a]) => { grouped.add(a as string); return { id: a as string, name: `${set.name} ${slot === 'color' ? 'Diffuse' : slot === 'ao' ? 'AO' : slot[0].toUpperCase() + slot.slice(1)}`, group: 'Materials', kind: 'picture' as const }; });
      out.push({ id, name: set.name, group: 'Materials', kind: 'material', children });
    }
    // A texture on its own (not a cut-out leaf, grass card or cloud) is a material too: a sphere wearing it, its picture
    // under the arrow, so textures never sit loose in the library.
    const cutout = (p: string) => /(^|\/)(leaves|grass|clouds)\//i.test(p) || /leaf|grass[-_]?card|particle/i.test(p);
    const single = (id: string, path: string, group: string) => {
      const name = path.split('/').pop()!.replace(/\.[^.]+$/, ''), mid = 'mat:' + path;
      materialSets.set(mid, { name, maps: { color: id } as MaterialSet['maps'] });
      out.push({ id: mid, name, group, kind: 'material', children: [{ id, name: `${name} Diffuse`, group, kind: 'picture' }] });
    };
    for (const l of lib) for (const f of l.files) {
      if (!/\.(fbx|glb|gltf|obj|png|jpe?g|webp)$/i.test(f.path) || grouped.has(`lib:${l.id}/${f.path}`)) continue;
      const parts = f.path.split('/'), isModel = /\.(fbx|glb|gltf|obj)$/i.test(f.path);
      if (!isModel && !cutout(f.path)) { single(`lib:${l.id}/${f.path}`, f.path, 'Materials'); continue; }
      out.push({ id: `lib:${l.id}/${f.path}`, name: parts[parts.length - 1].replace(/\.[^.]+$/, ''), group: parts.slice(0, -1).join(' › ') || 'Library', kind: isModel ? 'model' : 'picture' });
    }
    for (const a of doc.assets) if (!grouped.has(a.id)) { if (a.kind === 'texture' && !cutout(a.id)) single(a.id, a.id.slice(5), 'Imported'); else out.push({ id: a.id, name: a.name, group: 'Imported', kind: a.kind === 'model' ? 'model' : 'picture' }); }
    return out;
  }, [lib, doc.assets, doc.config.trees, doc.config.rocks]);
  const shown = items.filter((i) => (!q || (i.name + i.group).toLowerCase().includes(q.toLowerCase())) && (!onlyFav || doc.favorites.includes(i.id)));
  const groups = [...new Set(shown.map((i) => i.group))];
  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const rel = `imported/${f.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
      await api.putFile(doc.id, rel, await (await transparentBlack(f)).arrayBuffer());
      const model = /\.(fbx|glb|gltf|obj|blend)$/i.test(f.name);
      wc.mutate('Imported ' + f.name, (d) => { if (!d.assets.some((a) => a.id === 'proj:' + rel)) d.assets.push({ id: 'proj:' + rel, name: f.name.replace(/\.[^.]+$/, ''), kind: model ? 'model' : 'texture', group: 'imported', tags: [] }); });
    }
  };
  return <div className="wc-lib">
    <div className="wc-lib-bar"><button title="Favorites only" className={onlyFav ? 'on' : ''} onClick={() => setOnlyFav(!onlyFav)}><Glyph n="star" size={14} /></button><input type="text" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /><label className="wc-btn small" title="Your buildings, props, trees or textures (.fbx .glb .obj .blend .png .jpg)">Import<input type="file" multiple hidden accept=".fbx,.glb,.gltf,.obj,.blend,.png,.jpg,.jpeg,.webp" onChange={(e) => { importFiles(e.target.files); e.target.value = ''; }} /></label></div>
    <div className="wc-lib-list">{groups.map((g) => <div key={g}><h4>{g} <em>({shown.filter((i) => i.group === g).length})</em></h4>
      <div className="wc-grid">{shown.filter((i) => i.group === g).map((i) => <React.Fragment key={i.id}>
        <div className={'wc-tile' + (picked === i.id ? ' on' : '')} title={i.kind === 'material' ? `${i.name}: drag onto the terrain to make it the ground's texture` : i.kind === 'picture' && /leaf|leaves/i.test(i.id) ? `${i.name}: drag onto a tree to make it that tree's leaves` : i.name} draggable onDragStart={(e) => { e.dataTransfer.setData('x-wc-asset', i.id); pick(i); }} onClick={() => pick(i)}>
          <Thumb item={i} /><em>{i.name}</em>
          {i.children && <button className={'wc-mat-arrow' + (open[i.id] ? ' on' : '')} title={`Images in ${i.name}`} onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [i.id]: !open[i.id] }); }}>{open[i.id] ? '▴' : '▾'}</button>}
          <button title="Favorite" className={doc.favorites.includes(i.id) ? 'fav on' : 'fav'} onClick={(e) => { e.stopPropagation(); wc.mutate('Favorite', (d) => { d.favorites = d.favorites.includes(i.id) ? d.favorites.filter((x) => x !== i.id) : [...d.favorites, i.id]; }, true); }}>★</button>
        </div>
        {i.children && open[i.id] && <div className="wc-mat-maps">{i.children.map((c) => <div key={c.id} className={'wc-tile' + (picked === c.id ? ' on' : '')} title={c.name} draggable onDragStart={(e) => { e.dataTransfer.setData('x-wc-asset', c.id); pick(c); }} onClick={() => pick(c)}><Thumb item={c} /><em>{c.name.replace(i.name + ' ', '')}</em></div>)}</div>}
      </React.Fragment>)}</div>
    </div>)}</div>
  </div>;
}

/** The picked asset, turning, with its size. */
function Preview({ id, picture }: { id: string; picture: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const spawnable = useWC((st) => !!st.doc?.config.spawns.some((s) => s.assets.includes(id)));
  const [info, setInfo] = useState<ModelInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!id || picture) return;
    let live = true, raf = 0, angle = 0.4, last = 0;
    buildSubject(id, effective()).then((o) => {
      if (!o || !live) return;
      setInfo(infoOf(o));
      const tick = (t: number) => { if (!live) return; if (t - last > 66) { last = t; angle += 0.05; if (canvas.current) drawSubject(o, 200, angle, canvas.current); } raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    });
    return () => { live = false; cancelAnimationFrame(raf); };
  }, [id, picture]);
  return <div className="wc-preview">
    {info && <span>Triangles {info.triangles.toLocaleString()}, Vertices {info.vertices.toLocaleString()}</span>}
    {picture ? <img src={assetUrl(id) ?? ''} alt="" style={/pixel/i.test(id) ? { imageRendering: 'pixelated' } : undefined} /> : <canvas ref={canvas} width={200} height={200} />}
    {!id && <i>Pick an asset</i>}
    {id && !picture && !id.startsWith('mat:') && !id.startsWith('tree:') && !id.startsWith('rock:') && <label className="wc-spawnable" title="This model may spawn around the world, in the first structure set. Open Structures for the rest of the rules."><input type="checkbox" checked={spawnable} onChange={(e) => { const on = e.target.checked; wc.mutate(on ? 'Spawnable structure' : 'Not spawnable', (d) => { let sp = d.config.spawns[0]; if (!sp && on) { sp = makeSpawn('s_' + Date.now().toString(36), 'Structures'); d.config.spawns.push(sp); } if (sp) sp.assets = on ? [...sp.assets.filter((a) => a !== id), id] : sp.assets.filter((a) => a !== id); }); }} />Spawnable structure</label>}
  </div>;
}

// ------------------------------------------------------------------------------------------------- objects tree

interface TreeRow { key: string; label: string; depth: number; icon: string; panel?: Panel; focus?: string; eye?: boolean; setEye?: (v: boolean) => void; swatch?: string; parent?: boolean }

function ObjectsTree() {
  const doc = useWC((st) => st.doc!);
  const panel = useWC((st) => st.panel), focus = useWC((st) => st.focus);
  const selected = useWC((st) => st.selected);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({ trees: true, rocks: true, ground: false });
  const c = doc.config;
  const tog = (label: string, fn: (d: WorldDoc, v: boolean) => void) => (v: boolean) => wc.mutate(label, (d) => fn(d, v));
  const rows: TreeRow[] = [
    { key: 'terrain', label: 'Terrain', depth: 0, icon: 'mountain', panel: 'terrain', parent: true },
    { key: 'biomes', label: 'Biomes', depth: 1, icon: 'layers', panel: 'biomes', eye: c.biomes.enabled, setEye: tog('Biomes', (d, v) => { d.config.biomes.enabled = v; }) },
    { key: 'ground', label: 'Materials', depth: 1, icon: 'paint', panel: 'terrain', parent: true },
    ...SURFACE_LAYERS.map((k): TreeRow => ({ key: 'm_' + k, label: k[0].toUpperCase() + k.slice(1), depth: 2, icon: 'paint', panel: 'paint', swatch: (c.surface as any)[k], focus: k })),
    { key: 'sculpt', label: 'Sculpt & mask layers', depth: 1, icon: 'brush', panel: 'paint' },
    { key: 'caves', label: 'Caves', depth: 1, icon: 'cave', panel: 'caves', eye: c.cave.enabled, setEye: tog('Caves', (d, v) => { d.config.cave.enabled = v; }) },
    { key: 'voxel', label: 'Voxel mode', depth: 1, icon: 'voxel', panel: 'caves', eye: c.voxel.enabled, setEye: tog('Voxel mode', (d, v) => { d.config.voxel.enabled = v; }) },
    { key: 'water', label: 'Water & rivers', depth: 0, icon: 'water', panel: 'water', eye: c.water.enabled, setEye: tog('Water', (d, v) => { d.config.water.enabled = v; }) },
    { key: 'roads', label: `Roads (${doc.roads.length})`, depth: 0, icon: 'road', panel: 'roads' },
    { key: 'layers', label: 'Scatter layers', depth: 0, icon: 'leaf', panel: 'scatter', parent: true },
    ...c.layers.map((l): TreeRow => ({ key: l.id, label: l.name, depth: 1, icon: l.kind === 'tree' ? 'tree' : l.kind === 'rock' ? 'rock' : 'leaf', panel: 'scatter', focus: l.id, eye: l.enabled, setEye: (v) => wc.mutate('Layer', (d) => { d.config.layers.find((x) => x.id === l.id)!.enabled = v; }) })),
    { key: 'trees', label: 'Tree species', depth: 0, icon: 'tree', panel: 'trees', parent: true },
    ...c.trees.map((t): TreeRow => ({ key: 't_' + t.id, label: t.name, depth: 1, icon: 'tree', panel: 'trees', focus: t.id })),
    { key: 'rocks', label: 'Rock kinds', depth: 0, icon: 'rock', panel: 'rocks', parent: true },
    ...c.rocks.map((t): TreeRow => ({ key: 'k_' + t.id, label: t.name, depth: 1, icon: 'rock', panel: 'rocks', focus: t.id })),
    { key: 'struct', label: 'Structures', depth: 0, icon: 'build', panel: 'structures', parent: true },
    ...c.spawns.map((s): TreeRow => ({ key: s.id, label: s.name, depth: 1, icon: 'build', panel: 'structures', focus: s.id, eye: s.enabled, setEye: (v) => wc.mutate('Structures', (d) => { d.config.spawns.find((x) => x.id === s.id)!.enabled = v; }) })),
    { key: 'placed', label: `Placed objects (${doc.placed.length})`, depth: 0, icon: 'select', parent: true },
    ...doc.placed.map((p): TreeRow => ({ key: 'p_' + p.id, label: p.name, depth: 1, icon: 'select', focus: 'placed:' + p.id })),
    { key: 'seasons', label: 'Seasons', depth: 0, icon: 'leaf', panel: 'seasons', eye: c.season.enabled, setEye: tog('Seasons', (d, v) => { d.config.season.enabled = v; }) },
    { key: 'snow', label: 'Snow', depth: 0, icon: 'snow', panel: 'snow', eye: c.snow.enabled, setEye: tog('Snow', (d, v) => { d.config.snow.enabled = v; }) },
    { key: 'weather', label: 'Weather & sky', depth: 0, icon: 'cloud', panel: 'weather' },
    { key: 'effects', label: `Effects (${doc.particles.length})`, depth: 0, icon: 'star', panel: 'particles' },
    { key: 'optimize', label: 'Optimize', depth: 0, icon: 'gauge', panel: 'optimize' },
    { key: 'presets', label: 'Presets', depth: 0, icon: 'star', panel: 'presets' },
    { key: 'export', label: 'Export', depth: 0, icon: 'export', panel: 'export' },
  ];
  // Children of a closed parent are hidden.
  let hideDepth = -1;
  const visible = rows.filter((r) => {
    if (q) return r.label.toLowerCase().includes(q.toLowerCase());
    if (hideDepth >= 0) { if (r.depth > hideDepth) return false; hideDepth = -1; }
    if (r.parent && closed[r.key]) hideDepth = r.depth;
    return true;
  });
  return <div className="wc-tree">
    <div className="wc-lib-bar"><input type="text" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    <div className="wc-tree-list">{visible.map((r) => {
      const on = r.focus?.startsWith('placed:') ? selected === r.focus.slice(7) : r.focus ? focus === r.focus && panel === r.panel : !focus && panel === r.panel;
      return <div key={r.key} className={'wc-node' + (on ? ' on' : '')} style={{ paddingLeft: 4 + r.depth * 14 }} onClick={() => {
        if (r.focus?.startsWith('placed:')) { wc.set({ selected: r.focus.slice(7) }); return; }
        if (r.panel) wc.set({ panel: r.panel, focus: r.focus ?? null });
      }}>
        {r.eye !== undefined ? <button className={'wc-eye' + (r.eye ? ' on' : '')} title={r.eye ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); r.setEye?.(!r.eye); }}><Glyph n="eye" size={13} /></button> : <span className="wc-eye" />}
        {r.parent ? <button className="wc-tw" onClick={(e) => { e.stopPropagation(); setClosed({ ...closed, [r.key]: !closed[r.key] }); }}>{closed[r.key] ? '▸' : '▾'}</button> : <span className="wc-tw" />}
        <Glyph n={r.icon} size={13} /><span className="wc-node-l">{r.label}</span>
        {r.swatch && <i style={{ background: r.swatch }} />}
      </div>;
    })}</div>
  </div>;
}

/** A placed generated tree: its leaf type, a new random shape, and its own wood node by node. */
function PlacedTree({ p, view }: { p: Placed; view: WorldView | null }) {
  const g = parseGenId(p.asset)!;
  const cfg = useWC((st) => st.doc!.config);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<{ b: number; n: number } | null>(null);
  const [twigs, setTwigs] = useState(false);
  useEffect(() => { (window as any).__wcNodePicked = setPicked; return () => { delete (window as any).__wcNodePicked; }; }, []);
  useEffect(() => () => { view?.editNodes(null); }, [view, p.id]);
  const edit = (label: string, fn: (q: Placed) => void) => wc.mutate(label, (d) => { const q = d.placed.find((x) => x.id === p.id); if (q) fn(q); });
  const setStyle = (style: string) => edit('Leaf type', (q) => { q.asset = genId({ ...g, style: (style || undefined) as LeafStyle | undefined }); });
  const skeletonNow = () => p.tree?.skeleton ?? (() => { const r = resolveTree(cfg, p.asset); return r ? generateTree(r.cfg, r.seed).skeleton! : { branches: [] }; })();
  const startEdit = (on: boolean, fine = twigs) => {
    setEditing(on); setPicked(null);
    if (!on) { view?.editNodes(null); return; }
    const sk = skeletonNow();
    // Its wood becomes its own from now on, so moving nodes changes only this tree.
    if (!p.tree?.skeleton) edit('Edit tree nodes', (q) => { q.tree = { skeleton: sk }; });
    view?.editNodes({ id: p.id, skeleton: sk, maxLevel: fine ? 9 : 1 });
  };
  const sk = p.tree?.skeleton;
  return <>
    <Row label="Leaf type"><select value={g.style ?? ''} onChange={(e) => setStyle(e.target.value)}><option value="">The species' own</option>{LEAF_STYLES.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></Row>
    <Row label="Species"><select value={g.preset} onChange={(e) => edit('Species', (q) => { q.asset = genId({ ...g, preset: e.target.value }); q.name = cfg.trees.find((t) => t.id === e.target.value)?.name ?? q.name; })}>{cfg.trees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Row>
    <Row label="Shape seed" tip="This tree's random shape. The same seed always grows the same tree: note it, or type one in"><input type="number" disabled={!!p.locked || !!sk} value={g.variant} onChange={(e) => edit('Tree seed', (q) => { q.asset = genId({ ...g, variant: Math.max(0, Math.round(Number(e.target.value) || 0)) }); })} /></Row>
    <label className="wc-check" title="Keeps this tree exactly as it is: no new shape, seed or node changes until unlocked"><input type="checkbox" checked={!!p.locked} onChange={(e) => edit(e.target.checked ? 'Locked tree shape' : 'Unlocked tree shape', (q) => { q.locked = e.target.checked || undefined; })} />Lock this tree's shape</label>
    <div className="wc-tools">
      <button title="Another random shape of this species" disabled={!!sk || !!p.locked} onClick={() => edit('New tree shape', (q) => { q.asset = genId({ ...g, variant: 1 + Math.floor(Math.random() * 99999) }); })}>New shape</button>
      <button className={editing ? 'on' : ''} disabled={!!p.locked} onClick={() => startEdit(!editing)}>{editing ? 'Done editing nodes' : 'Edit nodes'}</button>
      {sk && <button title="Back to the species' own shape" disabled={!!p.locked} onClick={() => { view?.editNodes(null); setEditing(false); edit('Reset tree shape', (q) => { delete q.tree; }); }}>Reset shape</button>}
      {sk && <button title="Leaves on this tree's branches, in its species' look" onClick={() => edit(p.tree!.leaves === false ? 'Added leaves' : 'Removed leaves', (q) => { q.tree!.leaves = q.tree!.leaves === false ? true : false; })}>{p.tree!.leaves === false ? 'Add leaves' : 'Remove leaves'}</button>}
    </div>
    {editing && <>
      <label className="wc-check"><input type="checkbox" checked={twigs} onChange={(e) => { setTwigs(e.target.checked); startEdit(true, e.target.checked); }} />Show smaller branches too</label>
      <Hint>Click a node (yellow trunk, blue branches, green smaller), then drag its arrows: the branch bends there and everything growing beyond it follows.</Hint>
      {picked && sk && <div className="wc-tools">
        <button title="This branch thicker" onClick={() => edit('Thicker branch', (q) => { const b = q.tree!.skeleton.branches[picked.b]; b.r = b.r.map((r) => Math.round(r * 1.2 * 1000) / 1000); })}>Thicker</button>
        <button title="This branch thinner" onClick={() => edit('Thinner branch', (q) => { const b = q.tree!.skeleton.branches[picked.b]; b.r = b.r.map((r) => Math.max(0.006, Math.round(r / 1.2 * 1000) / 1000)); })}>Thinner</button>
        <button onClick={() => { const next = deleteSkeletonBranch(sk, picked.b); setPicked(null); edit('Removed a branch', (q) => { q.tree = { ...q.tree!, skeleton: next }; }); }}>{picked.b === 0 ? 'Remove trunk (all)' : 'Remove this branch'}</button>
      </div>}
    </>}
  </>;
}

function PlacedSettings({ view }: { view: WorldView | null }) {
  const placed = useWC((st) => st.doc!.placed);
  const sel = useWC((st) => st.selected);
  const p = placed.find((x) => x.id === sel);
  if (!p) return null;
  const set = (k: keyof Placed, v: any) => wc.mutate('Move object', (d) => { (d.placed.find((x) => x.id === p.id) as any)[k] = v; }, true);
  return <section className="wc-sec"><header><b>{p.name}</b></header>
    {p.asset.startsWith('tree:') && <PlacedTree key={p.id} p={p} view={view} />}
    <div className="wc-tools"><button onClick={() => view?.setGizmoMode('translate')}>Move</button><button onClick={() => view?.setGizmoMode('rotate')}>Rotate</button><button onClick={() => view?.setGizmoMode('scale')}>Scale</button></div>
    {(['x', 'y', 'z', 'ry', 'scale'] as const).map((k) => <label key={k} className="wc-row"><span>{k === 'ry' ? 'Rotation' : k.toUpperCase()}</span><div><input type="number" step={k === 'scale' ? 0.1 : 1} value={Number(p[k].toFixed(2))} onChange={(e) => set(k, Number(e.target.value))} /></div></label>)}
    <label className="wc-check"><input type="checkbox" checked={p.snap} onChange={(e) => set('snap', e.target.checked)} />Snap to ground</label>
    <label className="wc-row"><span>Group</span><div><input type="text" value={p.group ?? ''} onChange={(e) => set('group', e.target.value)} /></div></label>
    <div className="wc-tools">
      <button onClick={() => wc.mutate('Duplicate', (d) => { const id = 'o_' + Date.now().toString(36); d.placed.push({ ...p, id, x: p.x + 6 }); wc.set({ selected: id }); })}>Duplicate</button>
      <button onClick={() => { wc.mutate('Delete', (d) => { d.placed = d.placed.filter((x) => x.id !== p.id); }); wc.set({ selected: null }); }}>Delete</button>
    </div>
  </section>;
}

// ------------------------------------------------------------------------------------------------- editor

function Editor() {
  const doc = useWC((st) => st.doc!);
  const panel = useWC((st) => st.panel);
  const status = useWC((st) => st.status);
  const dirty = useWC((st) => st.dirty);
  const run = useWC((st) => st.run);
  const selected = useWC((st) => st.selected);
  const messages = useWC((st) => st.messages);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<WorldView | null>(null);
  const [view, setView] = useState<WorldView | null>(null);
  const [leftTab, setLeftTab] = useState<'library'>('library');
  const [tab, setTab] = useState('Terrain');
  const [dock, setDock] = useState<'logic' | 'log' | 'output' | ''>('logic');
  const [stats, setStats] = useState<any>(null);
  const [picked, setPicked] = useState<{ id: string; kind: Item['kind'] } | null>(null);
  const [walking, setWalking] = useState(false);
  const [planetOpen, setPlanetOpen] = useState(false);
  /** The right-click menu on the terrain: where it opened, and the ground point under it. */
  const [ctx, setCtx] = useState<{ x: number; y: number; p: { x: number; y: number; z: number } | null } | null>(null);
  const rightDown = useRef<[number, number] | null>(null);
  useEffect(() => { if (!ctx) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [ctx]);
  const [graphOpen, setGraphOpen] = useState(false);
  const startWalk = () => { const v = viewRef.current; if (!v || v.walking) return; setWalking(true); v.startWalk(() => setWalking(false)); };
  const [placeMode, setPlaceMode] = useState<'drop' | 'click' | 'brush'>('drop');
  const [movesChecked, setMovesChecked] = useState(true);
  const paintMoves = useRef(true);
  const [densityPick, setDensityPick] = useState(500);
  const paintDensity = useRef(500);
  const [dest, setDest] = useState('');
  const [show, setShow] = useState({ objects: true, clouds: true, wire: false, slab: true });
  const [gridSnap, setGridSnap] = useState(0);
  const [brush, setBrushState] = useState<BrushCfg>({ tool: 'orbit', size: 24, strength: 0.5, falloff: 0.5, value: 'grass', asset: '', roadKind: 'dirt', spacing: 1, randomRotation: true, randomScale: true });
  const brushRef = useRef(brush);
  const setBrush = useCallback((p: Partial<BrushCfg>) => { setBrushState((b) => { const nb = { ...b, ...p }; brushRef.current = nb; if (viewRef.current) viewRef.current.brush = nb; return nb; }); }, []);
  const [draft, setDraft] = useState<[number, number][]>([]);
  /** What a drawn tree grows: its species' bark and leaves, in a leaf type. */
  const [drawSp, setDrawSp] = useState<{ preset: string; style?: LeafStyle }>({ preset: 'oak', style: 'stylized' });
  const drawSpecies = useRef(drawSp); drawSpecies.current = drawSp;
  const stopDrawing = () => { if (viewRef.current) viewRef.current.drawTree = null; };
  // The Trees panel's "Draw a tree": that species, its own leaves, the Draw tree tool on, the Generators tab showing it.
  useEffect(() => { setDrawTool((species) => { setDrawSp((s) => ({ ...s, preset: species, style: wc.get().doc?.config.trees.find((t) => t.id === species)?.cfg.leafStyle ?? s.style })); stopDrawing(); setBrush({ tool: 'treedraw' }); setTab('Generators'); }); });
  const draftRef = useRef(draft); draftRef.current = draft;
  const destRef = useRef(dest); destRef.current = dest;
  const [style, setStyle] = useCodingStyle('worldcraft');
  const flattenTo = useRef(0);
  /** Hole: the ground height where each cell was when the stroke first reached it (it digs down from there). */
  const holeBase = useRef(new Map<string, number>());
  /** Align: where the stroke began (x, ground height, z). Duplicate: the spot copied from, and the offset to it. */
  const alignFrom = useRef<[number, number, number]>([0, 0, 0]);
  const cloneSrc = useRef<[number, number] | null>(null), cloneOff = useRef<[number, number] | null>(null);
  const lastXZ = useRef<[number, number]>([0, 0]);
  const areaFrom = useRef<[number, number]>([0, 0]);
  useEffect(() => { void makeLandforms(); }, []);

  /**
   * Something dropped on the terrain (from the library, or files from outside, imported first): a tree, rock or model is
   * placed there; a material or texture becomes the ground's texture; a leaf picture becomes the leaves of the tree it
   * lands on (or nearest, within a few metres).
   */
  const dropOnTerrain = async (id0: string, files: File[], cx: number, cy: number) => {
    const v = viewRef.current; if (!v) return;
    const p = v.groundAtClient(cx, cy); if (!p) return;
    const ids = id0 ? [id0] : [];
    for (const f of files) if (/\.(fbx|glb|gltf|obj|blend|png|jpe?g|webp)$/i.test(f.name)) { try { ids.push(await importAsset(f)); } catch { wc.log(`Couldn't import ${f.name}`); } }
    for (const id of ids) {
      const isPic = /\.(png|jpe?g|webp)$/i.test(id);
      if (id.startsWith('mat:')) {
        const set = materialSets.get(id); if (!set) continue;
        wc.mutate(`Ground texture: ${set.name}`, (d) => { d.config.surface.groundTex = { ...d.config.surface.groundTex, color: set.maps.color, normal: (set.maps as any).normal, height: (set.maps as any).height }; });
        wc.log(`The ground now wears ${set.name} (Terrain › Ground texture to change it)`);
      } else if (isPic && /leaf|leaves/i.test(id)) {
        const t = v.nearestTree(p.x, p.z, 6), g = t ? parseGenId(t) : null;
        if (!g || g.kind !== 'tree') { wc.log('Drop a leaf picture onto a generated tree to give it those leaves'); continue; }
        wc.mutate('Leaf picture', (d) => { const tr = d.config.trees.find((x) => x.id === g.preset); if (tr) tr.cfg.leafAsset = id; });
        wc.log(`${g.preset}: new leaves`);
      } else if (isPic) {
        wc.mutate('Ground texture', (d) => { d.config.surface.groundTex = { ...d.config.surface.groundTex, color: id }; });
        wc.log('The ground now wears that texture (Terrain › Ground texture to change it)');
      } else placeAt(id, p.x, p.y, p.z);
    }
  };

  const finishRoad = useCallback(() => {
    const pts = draftRef.current;
    if (pts.length > 1) wc.mutate('Drew a road', (d) => { d.roads.push({ id: 'r_' + Date.now().toString(36), kind: brushRef.current.roadKind, width: ROAD_KINDS[brushRef.current.roadKind]?.width ?? 4, points: pts, conform: 0.6, bridge: false, material: '', decorate: 0 }); });
    setDraft([]); setBrush({ tool: 'orbit' });
  }, [setBrush]);

  const placeAt = useCallback((asset: string, x: number, y: number, z: number, select = true) => {
    const id = 'o_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const b = brushRef.current;
    // A generated tree or rock dropped in gets a random shape of its own (its seed is in its name, so it stays that shape).
    const g = parseGenId(asset);
    if (g && !g.variant) asset = genId({ ...g, variant: 1 + Math.floor(Math.random() * 99998) });
    wc.mutate('Placed an object', (d) => {
      const name = g?.kind === 'tree' ? d.config.trees.find((t) => t.id === g.preset)?.name ?? 'Tree' : g?.kind === 'rock' ? d.config.rocks.find((t) => t.id === g.preset)?.name ?? 'Rock' : asset.split('/').pop()!.replace(/\.[^.]+$/, '');
      d.placed.push({ id, asset, name, x, y, z, ry: b.randomRotation ? Math.random() * 360 : 0, scale: b.randomScale ? 0.85 + Math.random() * 0.3 : 1, snap: true, group: destRef.current || undefined });
    }, !select);
    if (select) wc.set({ selected: id });
  }, []);

  useEffect(() => {
    const v = new WorldView(host.current!, {
      onBrush: (tool, x, z, dt, first) => {
        const b = brushRef.current;
        const bulk = tool === 'brushplace' && !!b.asset && paintsInBulk(b.asset);
        if (bulk && first && !wc.get().doc!.config.layers.some((l) => l.id === bulkLayerId(b.asset!))) {
          // Its own layer: painted by the thousand, instanced, undoable, erasable, and exported like any other.
          wc.mutate('Paint grass', (d) => { d.config.layers.push(makeLayer({ id: bulkLayerId(b.asset!), name: bulkLayerName(b.asset!), kind: 'grass', sources: [b.asset!], paintOnly: true, density: paintDensity.current, clustering: 0, maxSlope: 0.8, copyGround: true, moves: paintMoves.current })); }, true);
        }
        if (tool === 'brushplace' && !bulk) {
          if (!b.asset) return;
          if (first) wc.checkpoint();
          // Radius: how wide; strength: how fast; hardness: how close together they may stand.
          const gap = 1.5 + (1 - b.falloff) * b.size * 0.5;
          const n = Math.max(1, Math.round(b.strength * 2));
          for (let k = 0; k < n; k++) {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * b.size, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
            if (wc.get().doc!.placed.some((p) => (p.x - px) ** 2 + (p.z - pz) ** 2 < gap * gap)) continue;
            placeAt(b.asset, px, v.height(px, pz), pz, false);
          }
          return;
        }
        // Area: drag out the rectangle the area tools act on. Paste area: the copy goes where you click.
        if (tool === 'area') { if (first) areaFrom.current = [x, z]; setArea([areaFrom.current[0], areaFrom.current[1], x, z]); return; }
        if (tool === 'areapaste') { if (first) { applyArea('duplicate', areaParams.current, [x, z]); setBrush({ tool: 'area' }); } return; }
        if (first) { wc.checkpoint(); flattenTo.current = b.flattenHeight ?? v.height(x, z); lastXZ.current = [x, z]; }
        const cell = wc.get().doc!.edits.cell;
        const R = b.size, k = b.strength * Math.min(0.2, dt) * 5;
        // Shift: the other way round (raise lowers, lower raises, noise digs).
        const sign = v.brushShift ? -1 : 1;
        // Push: the way the brush moved since the last tick.
        const mv = [x - lastXZ.current[0], z - lastXZ.current[1]]; lastXZ.current = [x, z];
        wc.touch((d) => {
          const e = d.edits;
          // The brush's weight at each cell: its shape (alpha), turned by its rotation, with its smoothness.
          const each = (fn: (key: string, wx: number, wz: number, w: number) => void) => {
            for (let i = Math.floor((x - R) / cell); i <= Math.ceil((x + R) / cell); i++) for (let j = Math.floor((z - R) / cell); j <= Math.ceil((z + R) / cell); j++) {
              const wx = i * cell, wz = j * cell; const [u, w2] = brushFrame(wx - x, wz - z, R, b.rotation ?? 0);
              const w = brushWeight(b.shape, u, w2, b.falloff); if (w === 0) continue;
              fn(`${i},${j}`, wx, wz, w);
            }
          };
          const grid = (o: Record<string, Record<string, number>>, name: string) => (o[name] ??= {});
          switch (tool) {
            case 'raise': each((key, _x, _z, w) => { e.height[key] = (e.height[key] ?? 0) + sign * w * k * 1.2; }); break;
            case 'lower': each((key, _x, _z, w) => { e.height[key] = (e.height[key] ?? 0) - sign * w * k * 1.2; }); break;
            case 'noise': each((key, wx, wz, w) => { e.height[key] = (e.height[key] ?? 0) + sign * w * k * 3 * noise2(99, wx * 0.2, wz * 0.2); }); break;
            case 'flatten': each((key, wx, wz, w) => { e.height[key] = (e.height[key] ?? 0) + (flattenTo.current - v.height(wx, wz)) * Math.min(1, Math.abs(w) * k * 2); }); break;
            // Terrace: steps of the level height, with a short slope between (like a hillside cut into fields).
            case 'terrace': { const step = Math.max(0.25, b.levelStep ?? 5); each((key, wx, wz, w) => { const h = v.height(wx, wz), q = h / step, base = Math.floor(q), fr = q - base, target = (base + smoothstep(0.7, 0.95, fr)) * step; e.height[key] = (e.height[key] ?? 0) + (target - h) * Math.min(1, Math.abs(w) * k * 2); }); break; }
            // Push: ground dragged along with the brush (a smudge), piling up ahead and thinning behind.
            case 'push': { const len = Math.hypot(mv[0], mv[1]); if (len < 0.01) break; const back = Math.min(len, R * 0.5) * sign; const ux = (mv[0] / len) * back, uz = (mv[1] / len) * back;
              const moved: [string, number][] = []; each((key, wx, wz, w) => { moved.push([key, (v.height(wx - ux, wz - uz) - v.height(wx, wz)) * Math.min(1, Math.abs(w) * b.strength * 1.5)]); });
              for (const [key, dv] of moved) e.height[key] = (e.height[key] ?? 0) + dv; break; }
            // Erode: weathering by hand: steep spots slump into their lowest neighbour and crests soften, leaving the flats.
            case 'erode': { const ch: [string, number][] = []; each((key, wx, wz, w) => { const h = v.height(wx, wz), lo = Math.min(v.height(wx + cell, wz), v.height(wx - cell, wz), v.height(wx, wz + cell), v.height(wx, wz - cell)), hi = Math.max(v.height(wx + cell, wz), v.height(wx - cell, wz), v.height(wx, wz + cell), v.height(wx, wz - cell)); const drop = h - lo - cell * 0.5; let dv = drop > 0 ? -drop * 0.25 : 0; if (h < lo) dv += (lo - h) * 0.3; if (h > hi) dv -= (h - hi) * 0.2; ch.push([key, dv * Math.min(1, Math.abs(w) * k * 2) * 2]); }); for (const [key, dv] of ch) e.height[key] = (e.height[key] ?? 0) + dv; break; }
            case 'smooth': each((key, wx, wz, w) => { const avg = (v.height(wx + cell * 2, wz) + v.height(wx - cell * 2, wz) + v.height(wx, wz + cell * 2) + v.height(wx, wz - cell * 2)) / 4; e.height[key] = (e.height[key] ?? 0) + (avg - v.height(wx, wz)) * Math.min(1, w * k * 2); }); break;
            // Rotate: the land under the brush turns round its middle (Shift: the other way).
            case 'twist': {
              const ang = sign * k * 0.5, moved: [string, number][] = [];
              each((key, wx, wz, w) => { const a = -ang * Math.min(1, w), c = Math.cos(a), s = Math.sin(a), dx = wx - x, dz = wz - z; moved.push([key, v.height(x + dx * c - dz * s, z + dx * s + dz * c) - v.height(wx, wz)]); });
              for (const [key, dv] of moved) e.height[key] = (e.height[key] ?? 0) + dv;
              break;
            }
            // Scale: hills and hollows grow taller round their own average (Shift: flatter).
            case 'relief': {
              let sum = 0, n = 0; each((_k, wx, wz) => { sum += v.height(wx, wz); n++; }); const mean = sum / Math.max(1, n);
              each((key, wx, wz, w) => { e.height[key] = (e.height[key] ?? 0) + (v.height(wx, wz) - mean) * sign * k * 0.6 * Math.min(1, w); });
              break;
            }
            // Tilt: the ground tips the way the brush rotation points (Shift: the other way), 0 at the brush's middle.
            case 'tilt': {
              const a = ((b.rotation ?? 0) * Math.PI) / 180, dx = Math.cos(a), dz = Math.sin(a);
              each((key, wx, wz, w) => { e.height[key] = (e.height[key] ?? 0) + sign * k * 0.12 * Math.min(1, w) * ((wx - x) * dx + (wz - z) * dz); });
              break;
            }
            // Align: a straight slope from where the stroke started to where it is now (ramps, roads, embankments).
            case 'align': {
              if (first) alignFrom.current = [x, v.height(x, z), z];
              const [sx, sy, sz] = alignFrom.current, ex = x - sx, ez = z - sz, len2 = ex * ex + ez * ez, ey = v.height(x, z);
              each((key, wx, wz, w) => { const t = len2 > 1 ? Math.max(0, Math.min(1, ((wx - sx) * ex + (wz - sz) * ez) / len2)) : 0, target = sy + (ey - sy) * t; e.height[key] = (e.height[key] ?? 0) + (target - v.height(wx, wz)) * Math.min(1, Math.abs(w) * k * 2); });
              break;
            }
            // Duplicate: Shift-click picks the land to copy; painting then lays its shape down here.
            case 'clone': {
              if (v.brushShift) { cloneSrc.current = [x, z]; cloneOff.current = null; wc.log(`Duplicate: copying from ${Math.round(x)}, ${Math.round(z)}`); break; }
              if (!cloneSrc.current) { if (first) wc.log('Duplicate: Shift-click the land to copy first'); break; }
              if (first || !cloneOff.current) cloneOff.current = [x - cloneSrc.current[0], z - cloneSrc.current[1]];
              const [ox, oz] = cloneOff.current, ch: [string, number][] = [];
              each((key, wx, wz, w) => { ch.push([key, (v.height(wx - ox, wz - oz) - v.height(wx, wz)) * Math.min(1, Math.abs(w) * k * 2)]); });
              for (const [key, dv] of ch) e.height[key] = (e.height[key] ?? 0) + dv;
              break;
            }
            // Hole: digs a pit into the ground with steep rock walls, down to Strength × radius below where the stroke
            // began (it used to cut the land away, leaving a see-through gap to the backdrop).
            case 'hole': {
              if (first) holeBase.current.clear();
              const depth = Math.max(1, R * b.strength * 1.2), rate = depth * Math.min(0.2, dt) * 2.5;
              const rock = grid(e.paint, 'rock');
              each((key, wx, wz, w) => {
                if (!holeBase.current.has(key)) holeBase.current.set(key, v.height(wx, wz));
                const p = smoothstep(0.02, 0.35, w); // (steep sides: most of the depth is reached close to the rim)
                // (Dry: not below the sea, which would fill it; unless the ground there was already lower.)
                const base = holeBase.current.get(key)!, sea = d.config.water.enabled ? d.config.water.level + 0.6 : -Infinity;
                const target = Math.max(base - depth * p, Math.min(base, sea)), now = v.height(wx, wz);
                if (now > target) e.height[key] = (e.height[key] ?? 0) - Math.min(now - target, rate);
                const wall = 1 - Math.pow(Math.abs(2 * p - 1), 2);
                if (wall > 0.1) rock[key] = Math.max(rock[key] ?? 0, wall);
              });
              break;
            }
            case 'stamp': if (first) {
              // Landforms with a natural outline (broken by noise, different every click) that follow the brush's rotation;
              // brush shapes other than the plain ones also mask them.
              const shape = b.value, H = R * b.strength, seed = Math.floor(Math.random() * 100000);
              const masked = !['circle', 'square', 'soft', undefined].includes(b.shape);
              const fbm = (px: number, pz: number) => noise2(seed, px * 0.045, pz * 0.045) * 0.6 + noise2(seed + 1, px * 0.11, pz * 0.11) * 0.3 + noise2(seed + 2, px * 0.27, pz * 0.27) * 0.1;
              each((key, wx, wz, w) => {
                const [u, vv] = brushFrame(wx - x, wz - z, R, b.rotation ?? 0), n = fbm(wx, wz);
                const r = Math.min(1, Math.hypot(u, vv) * (1 + n * 0.18)), fall = smoothstep(1, 0.7, r);
                let add = 0;
                if (shape === 'brush') {
                  // The brush's own shape as a heightmap: a landform brush stamps its whole eroded landform, others their outline.
                  e.height[key] = (e.height[key] ?? 0) + H * (isHeightShape(b.shape) ? 0.8 : 0.4) * Math.max(0, w);
                  return;
                }
                if (shape === 'mountain') {
                  // Ridges running from the summit, on a broad foot: not a cone.
                  const base = Math.pow(smoothstep(1, 0, r), 1.25), ridge = 1 - Math.abs(noise2(seed + 3, u * 2.4 + n, vv * 2.4 - n));
                  add = H * (base * (0.5 + 0.5 * ridge * ridge) + Math.pow(base, 3) * 0.35) * (0.85 + 0.3 * n);
                } else if (shape === 'hill') add = H * 0.42 * Math.max(0, (Math.exp(-3 * r * r) - Math.exp(-3)) / (1 - Math.exp(-3))) * (0.9 + 0.25 * n);
                else if (shape === 'crater') add = H * (-(1 - Math.min(1, (r / 0.7) ** 2)) * 0.45 * (r < 0.7 ? 1 : 0) + Math.exp(-(((r - 0.72) / 0.13) ** 2)) * 0.3) * fall;
                else if (shape === 'valley') add = -H * 0.5 * Math.exp(-((vv / 0.35) ** 2)) * smoothstep(1, 0.6, Math.abs(u)) * (0.85 + 0.3 * n);
                else if (shape === 'cliff') add = H * 0.7 * smoothstep(-0.06, 0.06, vv + n * 0.12) * fall * (0.9 + 0.2 * n);
                else if (shape === 'canyon') {
                  // A narrow floor and stepped walls, along the brush's direction.
                  const f = 1 - smoothstep(0.08, 0.28, Math.abs(vv) + n * 0.06), steps = Math.round(f * 3) / 3;
                  add = -H * 0.7 * (f * 0.4 + steps * 0.6) * smoothstep(1, 0.75, Math.abs(u));
                }
                if (masked) add *= Math.min(1, Math.max(0, w) * 3);
                e.height[key] = (e.height[key] ?? 0) + add;
              });
            } break;
            case 'paint': if (b.value === 'erase') { each((key, _x, _z, w) => { for (const m of Object.values(e.paint)) if (m[key] !== undefined) { m[key] = Math.max(0, m[key] - w * k * 2); if (!m[key]) delete m[key]; } }); } else { const m = grid(e.paint, b.value); each((key, _x, _z, w) => { m[key] = Math.min(1, (m[key] ?? 0) + w * k * 2); for (const [name, o] of Object.entries(e.paint)) if (name !== b.value && o[key]) o[key] = Math.max(0, o[key] - w * k * 2); }); } break;
            case 'biome': each((key, _x, _z, w) => { if (w > 0.25) { if (b.value === 'erase') delete e.biome[key]; else e.biome[key] = b.value; } }); break;
            case 'snow': each((key, _x, _z, w) => { e.snow[key] = Math.min(1, (e.snow[key] ?? 0) + w * k * 2); }); break;
            case 'brushplace': { const m = grid(e.density, bulkLayerId(b.asset!)); each((key, _x, _z, w) => { m[key] = Math.min(1, (m[key] ?? 0) + w * k * 3); }); break; }
            case 'scatter': { const base = d.config.layers.find((l) => l.id === b.value)?.paintOnly ? 0 : 1, m = grid(e.density, b.value); each((key, _x, _z, w) => { m[key] = Math.min(4, (m[key] ?? base) + w * k * 3); }); break; }
            case 'erase': if (b.value === 'snow') each((key, _x, _z, w) => { const o = (e.snow[key] ?? 0) - w * k * 3; if (o <= 0) delete e.snow[key]; else e.snow[key] = o; }); else { const base = d.config.layers.find((l) => l.id === b.value)?.paintOnly ? 0 : 1, m = grid(e.density, b.value); each((key, _x, _z, w) => { m[key] = Math.max(0, (m[key] ?? base) - w * k * 4); }); } break;
          }
        });
        v.editedAt(x, z, R + cell);
      },
      onBrushEnd: () => { wc.log('Edited the terrain'); },
      onBrushChange: (p) => setBrush(p),
      onPlace: (x, y, z) => { const b = brushRef.current; if (b.asset) placeAt(b.asset, x, y, z); },
      onRoadPoint: (x, z, done) => { setDraft((p) => [...p, [x, z]]); if (done) setTimeout(finishRoad); },
      onSelect: (id) => wc.set({ selected: id }),
      onMoved: (id, x, y, z, ry, scale) => wc.mutate('Moved an object', (d) => { const p = d.placed.find((q) => q.id === id); if (p) { p.x = x; p.z = z; p.y = y; p.ry = ry; p.scale = scale; } }),
      // Draw tree: the foot, then each stroke a branch.
      onTreeStart: (x, y, z) => {
        const id = 'o_' + Date.now().toString(36), sp = drawSpecies.current;
        // (Bare wood to start with: leaves are added once the tree is built, from its settings.)
        wc.mutate('Started drawing a tree', (d) => { d.placed.push({ id, asset: genId({ kind: 'tree', preset: sp.preset, style: sp.style, variant: 0 }), name: 'Drawn tree', x, y, z, ry: 0, scale: 1, snap: true, tree: { skeleton: { branches: [] }, leaves: false } }); });
        v.drawTree = { id }; wc.set({ selected: id });
      },
      onTreeStroke: (id, pts, parent, at) => wc.mutate(parent < 0 ? 'Drew the trunk' : 'Drew a branch', (d) => {
        const q = d.placed.find((x) => x.id === id); if (!q) return;
        const sk = (q.tree ??= { skeleton: { branches: [] } }).skeleton;
        const res = resolveTree(d.config, q.asset), trunkR = res ? res.cfg.trunk * res.cfg.age : 0.3;
        // The trunk grows from the tree's own foot.
        if (parent < 0) pts[0] = [0, 0, 0];
        const b = strokeBranch(pts, parent >= 0 ? sk.branches[parent] : null, parent, at, trunkR);
        if (b) sk.branches.push(b);
      }),
      onTreeNode: (id, b, n, to) => wc.mutate('Moved a tree node', (d) => { const q = d.placed.find((x) => x.id === id); if (q?.tree && !q.locked) q.tree.skeleton = moveSkeletonNode(q.tree.skeleton, b, n, to); }),
      onNodePicked: (n) => (window as any).__wcNodePicked?.(n),
      onMessage: (text) => wc.log(text),
      onStats: (s) => setStats(s),
    });
    viewRef.current = v; setView(v);
    v.brush = brushRef.current;
    { const c = effective(); if (c && !c.terrain.endless) { const s = Math.max(c.terrain.width, c.terrain.depth); v.controls.target.set(0, c.terrain.baseHeight + c.terrain.height * 0.15, 0); v.camera.position.set(s * 0.1, s * 0.72, s * 0.86); } }
    (window as any).__wc = { view: v, store: wc, api };
    return () => { v.dispose(); viewRef.current = null; };
  }, [finishRoad, placeAt]);

  useEffect(() => {
    const v = viewRef.current; if (!v) return;
    const c = effective(); if (!c) return;
    v.setWorld(c, doc.edits, doc.placed, roadsOf(doc), OPTIMIZE_PROFILES[c.optimize.profile]?.densityScale ?? 1);
    // Placed ParticleCraft effects play live in the view.
    v.setEffects(doc.particles, (f) => api.exchangeGet(f));
  }, [doc, view, run]);
  const quality = useWC((st) => st.quality);
  useEffect(() => { viewRef.current?.setQuality(quality); try { localStorage.setItem('wc.quality', quality); } catch { /* it just won't be remembered */ } }, [quality, view]);
  useEffect(() => { viewRef.current?.refreshHeight(); }, [doc.edits]);
  useEffect(() => { viewRef.current?.select(selected); }, [selected, view]);
  useEffect(() => { const v = viewRef.current; if (v) { v.show = show; v.refreshLook(); } }, [show, view]);
  useEffect(() => { const v = viewRef.current; if (v) v.gizmo.setTranslationSnap(gridSnap || null); }, [gridSnap, view]);

  useEffect(() => { const t = setInterval(() => { if (wc.get().dirty) wc.save().catch(() => undefined); }, 20000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (e.shiftKey) wc.redo(); else wc.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); wc.save(); }
      if (e.key === 'Escape') { if (viewRef.current) { viewRef.current.drawTree = null; viewRef.current.editNodes(null); } setBrush({ tool: 'orbit' }); setDraft([]); wc.set({ selected: null }); }
      if (e.key === 'Delete' && wc.get().selected) { const id = wc.get().selected; wc.mutate('Deleted an object', (d) => { d.placed = d.placed.filter((x) => x.id !== id); }); wc.set({ selected: null }); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [setBrush]);

  const issues = useMemo(() => validateDocument(doc.logic, { app: 'worldcraft', types: [] } as any), [doc.logic]);
  const openTab = (id: string) => { setTab(id); const t = TABS.find((x) => x.id === id); if (t) wc.set({ panel: t.panel, focus: null }); };
  const useTool = (t: BrushTool) => { setBrush({ tool: brush.tool === t ? 'orbit' : t }); wc.set({ panel: 'paint', focus: null }); };
  const setMode = (m: 'drop' | 'click' | 'brush') => { setPlaceMode(m); setBrush({ tool: m === 'click' ? 'place' : m === 'brush' ? 'brushplace' : 'orbit', ...(m !== 'brush' && brush.asset?.startsWith('card:') ? { asset: undefined } : {}) }); };
  const pickItem = (i: Item) => {
    setPicked({ id: i.id, kind: i.kind });
    // In Brush mode a picture paints as standing 2D cards.
    if (i.kind === 'picture' && placeMode === 'brush') { setBrush({ asset: 'card:' + i.id, tool: 'brushplace' }); return; }
    if (i.kind === 'picture' || i.kind === 'material') return;
    setBrush({ asset: i.id, ...(placeMode === 'click' ? { tool: 'place' as const } : placeMode === 'brush' ? { tool: 'brushplace' as const } : {}) });
  };
  const groups = [...new Set(doc.placed.map((p) => p.group).filter(Boolean))] as string[];
  const cam = (x: number, y: number, z: number) => { const v = viewRef.current; if (v) { const c = effective()!, s = c.terrain.endless ? 300 : Math.max(c.terrain.width, c.terrain.depth); v.controls.target.set(0, c.terrain.baseHeight, 0); v.camera.position.set(x * s, y * s, z * s); } };
  const PlaceTools = <>
    <Group l="Create objects">
      <Big i="drop" l="Drop" on={placeMode === 'drop'} tip="Drag from the library onto the view" click={() => setMode('drop')} />
      <Big i="click" l="Click" on={placeMode === 'click'} tip="Click the terrain to place the picked asset" click={() => setMode('click')} />
      <Big i="brush" l="Brush" on={placeMode === 'brush'} tip="Paint the picked asset over the terrain" click={() => setMode('brush')} />
      <div className="rb-dest"><select size={3} value={dest} onChange={(e) => setDest(e.target.value)}><option value="">to World</option>{groups.map((g) => <option key={g} value={g}>to {g}</option>)}<option value="Forest">to Forest</option><option value="Village">to Village</option></select><span>Destination</span></div>
      <RSlider l="Radius" v={brush.size} min={1} max={120} step={1} off={placeMode !== 'brush'} set={(n) => setBrush({ size: n })} />
      <RSlider l="Strength" v={brush.strength} min={0.02} max={1} step={0.01} off={placeMode !== 'brush'} set={(n) => setBrush({ strength: n })} />
      <RSlider l="Hardness" v={brush.falloff} min={0} max={1} step={0.01} off={placeMode !== 'brush'} set={(n) => setBrush({ falloff: n })} />
      {placeMode === 'brush' && brush.asset && paintsInBulk(brush.asset) && (() => {
        const id = bulkLayerId(brush.asset), layer = doc.config.layers.find((l) => l.id === id);
        return <><RSlider l="Density" v={layer?.density ?? densityPick} min={20} max={1500} step={10} set={(n) => { paintDensity.current = n; setDensityPick(n); if (layer) wc.mutate('Grass density', (d) => { d.config.layers.find((l) => l.id === id)!.density = n; }, true); }} /><label className="rb-check" title="Animated in WorldCraft with the wind settings under Weather. GameCraft shows it standing still for now."><input type="checkbox" checked={layer ? layer.moves !== false : movesChecked} onChange={(e) => { const on = e.target.checked; paintMoves.current = on; setMovesChecked(on); if (layer) wc.mutate('Moves in the wind', (d) => { d.config.layers.find((l) => l.id === id)!.moves = on; }); }} />Moves in the wind</label></>;
      })()}
    </Group>
  </>;
  const SeedBtn = (fn: (s: number) => void, l: string) => <Big i="seed" l={l} tip="A new seed: only this part changes" click={() => { const s = randomSeed(); fn(s); }} />;
  const BrushSliders = <Group l="Brush">
    <RSlider l="Radius" v={brush.size} min={1} max={120} step={1} set={(n) => setBrush({ size: n })} />
    <RSlider l="Strength" v={brush.strength} min={0.02} max={1} step={0.01} set={(n) => setBrush({ strength: n })} />
    <RSlider l="Hardness" v={brush.falloff} min={0} max={1} step={0.01} set={(n) => setBrush({ falloff: n })} />
  </Group>;
  const ribbon: Record<string, React.ReactNode> = {
    File: <>
      <Group l="World"><Big i="new" l="Worlds" tip="Back to your worlds" click={() => wc.save().then(() => wc.close())} /><Big i="save" l="Save" click={() => wc.save()} /></Group>
      <Group l="Export"><Big i="export" l="Export" click={() => wc.set({ panel: 'export', focus: null })} /></Group>
    </>,
    Edit: <>
      <Group l="History"><Big i="undo" l="Undo" click={() => wc.undo()} /><Big i="redo" l="Redo" click={() => wc.redo()} /></Group>
      <Group l="Transform"><Big i="orbit" l="Navigate" on={brush.tool === 'orbit'} click={() => setBrush({ tool: 'orbit' })} /><Big i="select" l="Select" on={brush.tool === 'select'} click={() => setBrush({ tool: 'select' })} /><Big i="move" l="Move" off={!selected} click={() => view?.setGizmoMode('translate')} /><Big i="rotate" l="Rotate" off={!selected} click={() => view?.setGizmoMode('rotate')} /><Big i="scale" l="Scale" off={!selected} click={() => view?.setGizmoMode('scale')} /></Group>
      <Group l="Object"><Big i="copy" l="Duplicate" off={!selected} click={() => wc.mutate('Duplicated', (d) => { const p = d.placed.find((x) => x.id === selected); if (p) { const id = 'o_' + Date.now().toString(36); d.placed.push({ ...p, id, x: p.x + 6 }); wc.set({ selected: id }); } })} /><Big i="trash" l="Delete" off={!selected} click={() => { wc.mutate('Deleted', (d) => { d.placed = d.placed.filter((x) => x.id !== selected); }); wc.set({ selected: null }); }} /></Group>
      <Group l="Snap"><Big i="top" l="Grid 1 m" on={gridSnap === 1} click={() => setGridSnap(gridSnap === 1 ? 0 : 1)} /><Big i="top" l="Grid 5 m" on={gridSnap === 5} click={() => setGridSnap(gridSnap === 5 ? 0 : 5)} /></Group>
    </>,
    View: <>
      <Group l="Camera"><Big i="frame" l="Whole world" click={() => cam(0.62, 0.55, 0.72)} /><Big i="top" l="From above" click={() => cam(0.001, 1.25, 0.001)} /></Group>
      <Group l="Show"><Big i="tree" l="Objects" on={show.objects} click={() => setShow({ ...show, objects: !show.objects })} /><Big i="cloud" l="Clouds" on={show.clouds} click={() => setShow({ ...show, clouds: !show.clouds })} /><Big i="wire" l="Wireframe" on={show.wire} click={() => setShow({ ...show, wire: !show.wire })} /><Big i="layers" l="Table" on={show.slab} tip="The block and table under a finite world" click={() => setShow({ ...show, slab: !show.slab })} /></Group>
    </>,
    World: <>
      <Group l="Test"><Big i="play" l="Walk" on={walking} tip="Walk the world in first person, as a player would in GameCraft. WASD to move, mouse to look, Shift to run, Space to jump, Esc to stop" click={startWalk} /></Group>
      <Group l="Look">{([['realistic', 'Realistic', 'tree'], ['stylized', 'Stylized', 'leaf'], ['toon', 'Toon', 'star'], ['pixel', 'Pixel art', 'voxel'], ['mixed', 'Mixed', 'layers']] as [WorldStyle, string, string][]).map(([k, l, i]) => <Big key={k} i={i} l={l} on={doc.config.style === k} tip={k === 'mixed' ? 'Every look, each in its own regions of the world' : `Only ${l.toLowerCase()} trees, leaves, grass and rocks`} click={() => wc.mutate('World look: ' + l, (d) => { applyWorldStyle(d.config, k); })} />)}
        {doc.config.style && doc.config.style !== 'mixed' && (() => { const look = doc.config.style; const cur = lookGrass(doc.config, look); return <div className="rb-dest"><select size={1} value={cur.id} onChange={(e) => wc.mutate('Grass type', (d) => { (d.config.grassChoice ??= {})[look] = e.target.value; applyWorldStyle(d.config, look); })}>{LOOK_GRASSES[look].map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select><span>Grass</span></div>; })()}
      </Group>
      <Group l="Seed">{SeedBtn((s) => wc.mutate('New world seed', (d) => { d.config.terrain.seed = s; d.config.biomes.seed = s + 1; d.config.water.riverSeed = s + 2; }), 'New seed')}</Group>
      <Group l="Time of day"><RSlider l="Hour" v={doc.config.sky.time} min={0} max={24} step={0.25} set={(n) => wc.mutate('Time of day', (d) => { d.config.sky.time = n; }, true)} /></Group>
      <Group l="Systems"><Big i="logic" l="Ecosystem" tip="Season drives leaves, snow and snowfall, as editable bricks" click={() => { wc.mutate('World Ecosystem bricks', (d) => { d.logic.sheets[0].events = ecosystemEvents(); }); setDock('logic'); }} /><Big i="star" l="Presets" click={() => wc.set({ panel: 'presets', focus: null })} /><Big i="cave" l="Caves" click={() => wc.set({ panel: 'caves', focus: null })} /><Big i="star" l="Effects" click={() => wc.set({ panel: 'particles', focus: null })} /></Group>
    </>,
    Terrain: <>
      <Group l="Shape">{SHAPES.map(([p, i]) => <Big key={p} i={i} l={p} on={doc.config.terrain.preset === p} click={() => wc.mutate('Terrain: ' + p, (d) => { applyTerrainPreset(d.config, p); })} />)}</Group>
      <Group l="Planet"><Big i="globe" l="Planet" on={!!doc.config.terrain.planet?.enabled} tip="Make a whole planet, turn and zoom it, and build any spot of it as this world" click={() => setPlanetOpen(true)} /></Group>
      <Group l="Nodes"><Big i="nodes" l="Node graph" on={(doc.edits.grids ?? []).some((x) => x.label === 'Node graph')} tip="Build the land from connected nodes (Mountain, Warp, Erosion, Terrace, Mask, Combine, Colorize) with a live 3D preview, then apply it" click={() => setGraphOpen(true)} /></Group>
      <Group l="Voxel mode"><Big i="voxel" l="Voxels" on={doc.config.voxel.enabled} tip="The land as blocks. Your terrain settings aren't changed: turn it off to go back" click={() => wc.mutate('Voxel mode', (d) => { d.config.voxel.enabled = !d.config.voxel.enabled; })} /><RSlider l="Block size" v={doc.config.voxel.size} min={0.25} max={8} step={0.25} off={!doc.config.voxel.enabled} set={(n) => wc.mutate('Block size', (d) => { d.config.voxel.size = n; }, true)} /></Group>
      <Group l="Sculpt">{SCULPT.map(([t, l, i]) => <Big key={t} i={i} l={l} on={brush.tool === t} click={() => useTool(t)} />)}</Group>
      <Group l="Paint">{PAINT.map(([t, l, i]) => <Big key={t} i={i} l={l} on={brush.tool === t} click={() => useTool(t)} />)}</Group>
      {BrushSliders}
      <Group l="World"><Big i="wave" l="Endless" on={doc.config.terrain.endless} click={() => wc.mutate('Endless terrain', (d) => { d.config.terrain.endless = !d.config.terrain.endless; })} /><Big i="logic" l="Infinite Noise" tip="Loads an editable Infinite Noise setup as bricks" click={() => { wc.mutate('Infinite Noise bricks', (d) => { d.logic.sheets[0].events = infiniteNoiseEvents(); }); setDock('logic'); }} />{SeedBtn((s) => wc.mutate('Terrain seed', (d) => { d.config.terrain.seed = s; }), 'Seed')}</Group>
    </>,
    Generators: <>
      <Group l="Generators"><Big i="tree" l="Trees" on={panel === 'trees'} click={() => wc.set({ panel: 'trees', focus: null })} /><Big i="rock" l="Rocks" on={panel === 'rocks'} click={() => wc.set({ panel: 'rocks', focus: null })} /><Big i="layers" l="Biomes" on={panel === 'biomes'} click={() => wc.set({ panel: 'biomes', focus: null })} /></Group>
      <Group l="Draw a tree">
        <Big i="brush" l={brush.tool === 'treedraw' ? 'Drawing' : 'Draw tree'} on={brush.tool === 'treedraw'} tip="Click the ground for the tree's foot, drag up to draw the trunk, then drag from any node to draw a branch. Alt+drag turns the view" click={() => { stopDrawing(); setBrush({ tool: brush.tool === 'treedraw' ? 'orbit' : 'treedraw' }); }} />
        <Big i="plus" l="New tree" off={brush.tool !== 'treedraw'} tip="Finish this one and start another" click={() => stopDrawing()} />
        <Big i="undo" l="Undo stroke" off={brush.tool !== 'treedraw'} click={() => wc.undo()} />
        <div className="rb-dest"><select size={1} value={drawSp.preset} onChange={(e) => setDrawSp({ ...drawSp, preset: e.target.value })}>{doc.config.trees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select><select size={1} value={drawSp.style ?? ''} onChange={(e) => setDrawSp({ ...drawSp, style: (e.target.value || undefined) as LeafStyle | undefined })}><option value="">Own leaves</option>{LEAF_STYLES.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select><span>Bark and leaves</span></div>
      </Group>
      {PlaceTools}
    </>,
    Scatter: <>
      {PlaceTools}
      <Group l="Layers"><Big i="leaf" l="Paint more" on={brush.tool === 'scatter'} click={() => useTool('scatter')} /><Big i="trash" l="Erase" on={brush.tool === 'erase'} click={() => useTool('erase')} />{SeedBtn((s) => wc.mutate('Scatter seed', (d) => { d.config.layers.forEach((l, i) => { l.seed = s + i; }); }), 'New seeds')}</Group>
    </>,
    Water: <>
      <Group l="Water"><Big i="water" l="Sea & lakes" on={doc.config.water.enabled} click={() => wc.mutate('Water', (d) => { d.config.water.enabled = !d.config.water.enabled; })} /><RSlider l="Level (m)" v={doc.config.water.level} min={-50} max={200} step={0.5} set={(n) => wc.mutate('Water level', (d) => { d.config.water.level = n; }, true)} /><RSlider l="Waves" v={doc.config.water.waves} min={0} max={2} step={0.01} set={(n) => wc.mutate('Waves', (d) => { d.config.water.waves = n; }, true)} /></Group>
      <Group l="Rivers"><RSlider l="Rivers" v={doc.config.water.rivers} min={0} max={12} step={1} set={(n) => wc.mutate('Rivers', (d) => { d.config.water.rivers = n; })} /><RSlider l="Lakes" v={doc.config.water.lakes} min={0} max={12} step={1} set={(n) => wc.mutate('Lakes', (d) => { d.config.water.lakes = n; })} />{SeedBtn((s) => wc.mutate('River seed', (d) => { d.config.water.riverSeed = s; }), 'Seed')}</Group>
    </>,
    Roads: <><Group l="Draw"><Big i="road" l={brush.tool === 'road' ? 'Drawing' : 'Draw road'} on={brush.tool === 'road'} click={() => setBrush({ tool: brush.tool === 'road' ? 'orbit' : 'road' })} /><Big i="plus" l="Finish" off={draft.length < 2} click={finishRoad} /><Big i="undo" l="Cancel" off={!draft.length} click={() => setDraft([])} /></Group></>,
    Snow: <><Group l="Snow"><Big i="snow" l="Snow" on={doc.config.snow.enabled} click={() => wc.mutate('Snow', (d) => { d.config.snow.enabled = !d.config.snow.enabled; })} /><RSlider l="Coverage" v={doc.config.snow.coverage} min={0} max={1} step={0.01} set={(n) => wc.mutate('Snow coverage', (d) => { d.config.snow.coverage = n; }, true)} /><RSlider l="From height" v={doc.config.snow.startHeight} min={-100} max={400} step={1} set={(n) => wc.mutate('Snow height', (d) => { d.config.snow.startHeight = n; }, true)} /><RSlider l="Snowfall" v={doc.config.snow.fall} min={0} max={1} step={0.01} set={(n) => wc.mutate('Snowfall', (d) => { d.config.snow.fall = n; }, true)} /></Group><Group l="Paint"><Big i="brush" l="Paint snow" on={brush.tool === 'snow'} click={() => useTool('snow')} /></Group>{BrushSliders}</>,
    Weather: <><Group l="Weather">{([['clear', 'sun', 'Clear'], ['rain', 'rain', 'Rain'], ['snow', 'snow', 'Snow'], ['fog', 'fog', 'Fog'], ['storm', 'rain', 'Storm'], ['dust', 'fog', 'Dust'], ['mist', 'fog', 'Mist']] as const).map(([k, i, l]) => <Big key={k} i={i} l={l} on={doc.config.weather.type === k} click={() => wc.mutate('Weather: ' + l, (d) => { d.config.weather.type = k; })} />)}<RSlider l="Intensity" v={doc.config.weather.intensity} min={0} max={1} step={0.01} set={(n) => wc.mutate('Intensity', (d) => { d.config.weather.intensity = n; }, true)} /></Group><Group l="Sky"><RSlider l="Clouds" v={doc.config.weather.clouds} min={0} max={1} step={0.01} set={(n) => wc.mutate('Clouds', (d) => { d.config.weather.clouds = n; }, true)} /><RSlider l="Hour" v={doc.config.sky.time} min={0} max={24} step={0.25} set={(n) => wc.mutate('Time of day', (d) => { d.config.sky.time = n; }, true)} /></Group><Group l="Wind"><RSlider l="Speed" v={doc.config.weather.windSpeed} min={0} max={20} step={0.5} set={(n) => wc.mutate('Wind', (d) => { d.config.weather.windSpeed = n; }, true)} /><RSlider l="Direction" v={doc.config.weather.windDirection} min={0} max={360} step={5} set={(n) => wc.mutate('Wind', (d) => { d.config.weather.windDirection = n; }, true)} /></Group></>,
    Seasons: <><Group l="Season">{(['spring', 'summer', 'autumn', 'winter'] as const).map((k) => <Big key={k} i={k === 'winter' ? 'snow' : k === 'autumn' ? 'leaf' : k === 'summer' ? 'sun' : 'tree'} l={k[0].toUpperCase() + k.slice(1)} on={doc.config.season.enabled && doc.config.season.season === k} click={() => wc.mutate('Season: ' + k, (d) => { d.config.season.enabled = true; d.config.season.season = k; })} />)}<Big i="eye" l="Original" on={!doc.config.season.enabled} tip="The assets' own colours" click={() => wc.mutate('Original colours', (d) => { d.config.season.enabled = false; })} /></Group><Group l="Transition"><RSlider l="Blend" v={doc.config.season.blend} min={0} max={1} step={0.01} set={(n) => wc.mutate('Season blend', (d) => { d.config.season.blend = n; }, true)} /><RSlider l="Per minute" v={doc.config.season.speed} min={0} max={6} step={0.1} set={(n) => wc.mutate('Season speed', (d) => { d.config.season.speed = n; }, true)} /></Group></>,
    Structures: <>{PlaceTools}<Group l="Spawning"><Big i="build" l="Sets" on={panel === 'structures'} click={() => wc.set({ panel: 'structures', focus: null })} /></Group></>,
    Optimize: <><Group l="Profile">{(['high', 'balanced', 'performance', 'mobile', 'openworld'] as const).map((p) => <Big key={p} i="gauge" l={{ high: 'High', balanced: 'Balanced', performance: 'Perform.', mobile: 'Mobile', openworld: 'Open world' }[p]} on={doc.config.optimize.profile === p} click={() => wc.mutate('Profile: ' + p, (d) => { const o = OPTIMIZE_PROFILES[p]; d.config.optimize.profile = p; Object.assign(d.config.optimize, { lodDistance: o.lodDistance, cull: o.cull, grassDistance: o.grassDistance, impostors: o.impostors }); })} />)}</Group><Group l="Numbers"><Big i="logic" l="Output" click={() => setDock('output')} /></Group></>,
    Export: <><Group l="Send to"><Big i="export" l="GameCraft" click={() => wc.set({ panel: 'export', focus: null })} /><Big i="export" l="Blender, Godot, Unity" click={() => wc.set({ panel: 'export', focus: null })} /></Group></>,
  };
  const heights = view?.heights;
  const ruler = heights && Number.isFinite(heights.max) ? Array.from({ length: 6 }, (_, i) => Math.round(heights.max + ((heights.min - heights.max) * i) / 5)) : [];
  return <div className={'wc-app' + (dock ? '' : ' nodock')}>
    {planetOpen && <PlanetBuilder onClose={() => setPlanetOpen(false)} />}
    {graphOpen && <NodeGraphWindow onClose={() => setGraphOpen(false)} />}
    <div className="wc-title">
      <img src="icon.png" alt="" title="Back to the start screen (saves first)" style={{ cursor: 'pointer' }} onClick={async () => { await wc.save(); wc.close(); }} /><button title="Save" onClick={() => wc.save()}><Glyph n="save" size={15} /></button><button title="Undo" onClick={() => wc.undo()}><Glyph n="undo" size={15} /></button><button title="Redo" onClick={() => wc.redo()}><Glyph n="redo" size={15} /></button>
      <span className="wc-grow" /><em>{doc.name}{dirty ? ' *' : ''} - WorldCraft</em><span className="wc-grow" />
    </div>
    <div className="rb-tabs">{TABS.map((t) => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => openTab(t.id)}>{t.id}</button>)}</div>
    <div className="rb-body">{ribbon[tab]}</div>
    <aside className="wc-left">
      <div className="wc-dock-h"><b>Library</b></div>
      {leftTab === 'library' && <Library picked={picked?.id ?? ''} pick={pickItem} />}
      <div className="wc-dock-h"><b>Preview</b></div>
      <Preview id={picked?.id ?? ''} picture={picked?.kind === 'picture'} />
    </aside>
    <main className="wc-center">
      <div className="wc-doc-tabs"><button className="on">{doc.name}</button><span className="wc-grow" />{status && <em>{status}</em>}</div>
      <div className="wc-vp">
        <div className="wc-viewport" ref={host} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void dropOnTerrain(e.dataTransfer.getData('x-wc-asset'), [...e.dataTransfer.files], e.clientX, e.clientY); }}
          onPointerDownCapture={(e) => { if (e.button === 2) rightDown.current = [e.clientX, e.clientY]; else setCtx(null); }}
          onContextMenu={(e) => {
            e.preventDefault();
            const d0 = rightDown.current; if (d0 && Math.hypot(e.clientX - d0[0], e.clientY - d0[1]) > 5) return; // (a right-drag turned the view)
            const v = viewRef.current, p = v?.groundAtClient(e.clientX, e.clientY);
            setCtx({ x: Math.min(e.clientX, window.innerWidth - 250), y: Math.min(e.clientY, window.innerHeight - 420), p: p ? { x: p.x, y: p.y, z: p.z } : null });
          }} />
        {ctx && <TerrainMenu at={ctx} close={() => setCtx(null)} view={viewRef.current} brushSize={brush.size} picked={picked} placeAt={placeAt} />}
        {ruler.length > 0 && <div className="wc-ruler">{ruler.map((r, i) => <span key={i}>{r}</span>)}</div>}
        {heights && Number.isFinite(heights.max) && <div className="wc-minmax">Max {Math.round(heights.max)}<br />Min {Math.round(heights.min)}</div>}
        <ShortcutCard tool={brush.tool} />
        <div className="wc-strip">
          <button title="Navigate" className={brush.tool === 'orbit' ? 'on' : ''} onClick={() => setBrush({ tool: 'orbit' })}><Glyph n="orbit" size={15} /></button>
          <button title="Select" className={brush.tool === 'select' ? 'on' : ''} onClick={() => setBrush({ tool: 'select' })}><Glyph n="select" size={15} /></button>
          <button title="Move" disabled={!selected} onClick={() => view?.setGizmoMode('translate')}><Glyph n="move" size={15} /></button>
          <button title="Rotate" disabled={!selected} onClick={() => view?.setGizmoMode('rotate')}><Glyph n="rotate" size={15} /></button>
          <button title="Scale" disabled={!selected} onClick={() => view?.setGizmoMode('scale')}><Glyph n="scale" size={15} /></button>
          <i />
          <button title="Whole world" onClick={() => cam(0.62, 0.55, 0.72)}><Glyph n="frame" size={15} /></button>
          <button title="From above" onClick={() => cam(0.001, 1.25, 0.001)}><Glyph n="top" size={15} /></button>
          <i />
          <button title="Objects" className={show.objects ? 'on' : ''} onClick={() => setShow({ ...show, objects: !show.objects })}><Glyph n="tree" size={15} /></button>
          <button title="Clouds" className={show.clouds ? 'on' : ''} onClick={() => setShow({ ...show, clouds: !show.clouds })}><Glyph n="cloud" size={15} /></button>
          <button title="Water" className={doc.config.water.enabled ? 'on' : ''} onClick={() => wc.mutate('Water', (d) => { d.config.water.enabled = !d.config.water.enabled; })}><Glyph n="water" size={15} /></button>
          <button title="Wireframe" className={show.wire ? 'on' : ''} onClick={() => setShow({ ...show, wire: !show.wire })}><Glyph n="wire" size={15} /></button>
        </div>
        {brush.tool === 'place' && <span className="wc-tip">Click the terrain to place{brush.asset ? '' : ': pick an asset in the library first'}. Esc to stop.</span>}
        {walking && <span className="wc-tip">WASD move, mouse look, Shift run, Space jump, Esc to stop<button className="wc-btn small" style={{ marginLeft: 8 }} onClick={() => viewRef.current?.stopWalk()}>Stop</button></span>}
        {walking && <div className="wc-crosshair" />}
        {brush.tool === 'brushplace' && <span className="wc-tip">Paint over the terrain{brush.asset ? '' : ': pick an asset in the library first'}. Esc to stop.</span>}
        {brush.tool === 'road' && <span className="wc-tip">Click to add points, double-click to finish.</span>}
        {brush.tool === 'treedraw' && <span className="wc-tip">Click the ground for a new tree, drag up for its trunk, then drag out from any node for a branch. Alt+drag turns the view. Esc to stop.</span>}
      </div>
    </main>
    <aside className="wc-right">
      <div className="wc-dock-h"><b>Objects</b></div>
      <ObjectsTree />
      <div className="wc-dock-h"><b>Settings</b></div>
      <div className="wc-settings"><PlacedSettings view={view} /><RightPanel panel={panel} brush={brush} setBrush={setBrush} draft={draft.length} finishRoad={finishRoad} cancelRoad={() => setDraft([])} stats={stats} /></div>
    </aside>
    <section className="wc-bottom">
      <div className="wc-bottom-tabs">
        {([['logic', 'Logic Bricks'], ['log', 'Message Log'], ['output', 'Output']] as const).map(([k, l]) => <button key={k} className={dock === k ? 'on' : ''} onClick={() => setDock(dock === k ? '' : k)}>{l}</button>)}
        {dock === 'logic' && <CodingStylePicker value={style} onChange={setStyle} app="worldcraft" doc={doc.logic} sheetId={doc.logic.sheets[0].id} />}
        {run && run.errors.length > 0 && <span className="wc-err">{run.errors[0].message}</span>}
        <span className="wc-grow" />
        {run && <em>{run.ran} bricks ran · {Object.keys(run.sources).length} settings set by bricks</em>}
        <QualityPicker />
        {stats && <em>{stats.fps} fps · {stats.chunks} chunks{stats.building ? ` (+${stats.building})` : ''} · {stats.objects.toLocaleString()} objects{stats.drawnTriangles ? ` · ${(stats.drawnTriangles / 1e6).toFixed(2)}M triangles drawn` : ''}</em>}
      </div>
      {dock === 'logic' && <div className="wc-logic-body"><LogicView codingStyle={style} doc={doc.logic} sheetId={doc.logic.sheets[0].id} app="worldcraft" types={[]} issues={issues} onChange={(l, label) => wc.mutate(label, (d) => { d.logic = l; })} sceneNames={[]} /></div>}
      {dock === 'log' && <div className="wc-log">{messages.length ? [...messages].reverse().map((m, i) => <div key={i}><em>{m.t}</em> {m.text}</div>) : <i>Nothing yet.</i>}</div>}
      {dock === 'output' && <div className="wc-log">{stats ? <table className="wc-stats"><tbody><tr><td>Frame rate</td><td>{stats.fps} fps</td></tr><tr><td>Chunks</td><td>{stats.chunks}</td></tr><tr><td>Terrain triangles</td><td>{stats.terrainTriangles.toLocaleString()}</td></tr><tr><td>Objects</td><td>{stats.objects.toLocaleString()}</td></tr><tr><td>Object triangles</td><td>{stats.objectTriangles.toLocaleString()}</td></tr><tr><td>Draw calls</td><td>{stats.drawCalls.toLocaleString()}</td></tr><tr><td>Geometry memory (estimate)</td><td>{stats.memoryMb} MB</td></tr></tbody></table> : <i>Building…</i>}</div>}
    </section>
  </div>;
}

/** If something fails while drawing the interface, say so and keep the world reachable: never an empty window. */
class Guard extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: any) { return { error: String(e?.message ?? e) }; }
  componentDidCatch() { wc.save().catch(() => undefined); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="wc-launch"><h1>Something went wrong</h1><p>Your world was saved. {this.state.error}</p><br /><button className="wc-btn primary" onClick={() => location.reload()}>Reload WorldCraft</button></div>;
  }
}

export function App() {
  const open = useWC((st) => !!st.doc);
  return <Guard>{open ? <Editor /> : <Launcher />}</Guard>;
}
export type { WorldDoc };
