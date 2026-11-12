// The right-hand panels: one per system. Every control here changes the world's settings; the view follows.
import React, { useEffect, useMemo, useState } from 'react';
import { newTerrainLayer, packGrid, TERRAIN_LAYER_TYPES, TERRAIN_PRESETS } from '@shared/src/world/terrain';
import { smoothstep } from '@shared/src/world/random';
import { erodeGrid, erosionDefaults } from '@shared/src/world/erosion';
import { STAGE_NAMES, stageOf } from '@shared/src/world/growth';
import { BIOME_INFO, LOOK_PALETTES, surfaceDefaults, SURFACE_LAYERS } from '@shared/src/world/biomes';
import { hairDefaults, modelHairDefaults } from '@shared/src/world/leafHair';
import { woodOf } from './modelLook';
import { applySceneTemplate, applyTerrainPreset, ROAD_KINDS, SCENE_TEMPLATES, ecosystemEvents, infiniteNoiseEvents, treeLogicEvent } from '@shared/src/world/features';
/** Starts the Draw tree tool for a species (set by the editor). */
export let drawTool: ((species: string) => void) | null = null;
export const setDrawTool = (f: (species: string) => void) => { drawTool = f; };
import { makeLayer } from '@shared/src/world/scatter';
import { OPTIMIZE_PROFILES } from '@shared/src/world/bricks';
import { randomSeed } from '@shared/src/world/random';
import { applyWorldStyle, LOOK_GRASSES, lookGrass, TREE_PRESETS } from '@shared/src/world/generators';
import { deepCopy, LEAF_STYLES, type EditGrid, type LayerKind, type LeafStyle, type ScatterLayer, type StructureSpawn, type WorldConfig, type WorldStyle } from '@shared/src/world/document';
import { BUILTIN_EFFECTS } from './builtinFx';
import { FALL_PRESETS } from './weatherFx';
import { SEASON_PALETTES } from '@shared/src/world/season';
import type { BrushCfg, WorldView } from './view';
import { api, effective, useWC, wc, type Panel } from './store';
import { b, c, Fields, Hint, n, NO_SOURCES, num, Row, s, Section, type Field } from './ui';
import { ExportPanel } from './exporter';
import { PlanetSection } from './planetView';
import { applyArea, areaParams, getArea, onArea, setArea, type AreaOp } from './areaTools';
import type { SculptLayerCfg } from '@shared/src/world/document';
import { importAsset, PICTURE_FILES } from './importTexture';
import { groupPbrSets } from '@shared/src/materialMaps';
import { BRUSH_SHAPES, brushFrame, brushWeight, customShapes, importBrushShape, makeLandforms, onLandformsReady, removeBrushShape, shapeName, type BrushShape } from './brushShapes';

/** Which item a panel shows: its own choice, or whatever was just picked in the Objects tree. */
function useFocus(first: string): [string, (s: string) => void] {
  const focus = useWC((st) => st.focus);
  const [id, setId] = useState(focus ?? first);
  useEffect(() => { if (focus) setId(focus); }, [focus]);
  return [id, setId];
}

/** Set one setting in a part of the config. */
const setter = (section: keyof WorldConfig) => (k: string, v: any, quiet?: boolean) => wc.mutate(`${String(section)}: ${k}`, (d) => { (d.config[section] as any)[k] = v; }, quiet);

const Seed = ({ value, set, disabled }: { value: number; set: (v: number) => void; disabled?: boolean }) => (
  <Row label="Seed" tip="The same seed and settings always give the same result"><span className="wc-seed"><input type="number" disabled={disabled} value={value} onChange={(e) => set(Math.round(Number(e.target.value)))} /><button disabled={disabled} title="Pick a new seed" onClick={(e) => { e.preventDefault(); set(randomSeed()); }}>Random</button></span></Row>
);

const TERRAIN_FIELDS: Field[] = [
  n('height', 'Height (m)', 1, 400, 1), n('baseHeight', 'Base height (m)', -50, 100, 0.5), n('noiseScale', 'Noise scale (m)', 20, 1200, 5), n('noiseIntensity', 'Noise intensity', 0, 2),
  n('octaves', 'Noise layers', 1, 10, 1), n('lacunarity', 'Layer detail', 1.5, 3, 0.01), n('gain', 'Layer strength', 0.2, 0.8), n('warp', 'Warp', 0, 1),
  n('sharpness', 'Mountain sharpness', 0, 1), n('valleyDepth', 'Valley depth', 0, 1), n('plateau', 'Plateaus', 0, 1), n('terraces', 'Cliffs (terraces)', 0, 6, 1),
  n('canyon', 'Canyons', 0, 1), n('island', 'Island', 0, 1), n('islands', 'Many islands', 0, 1), n('islandSize', 'Island size (m)', 20, 1000, 5), n('islandLand', 'How much is land', 0, 1), n('flatten', 'Flatten', 0, 1), n('erosion', 'Erosion', 0, 1, 0.01, 'Gullies on high ground, worked out per point so chunks of an endless world match. Not a water simulation.'), n('smooth', 'Smoothing', 0, 1),
];

function TerrainPanel() {
  const t = useWC((st) => st.doc!.config.terrain);
  const sources = useWC((st) => st.run?.sources ?? NO_SOURCES);
  const set = setter('terrain');
  const lock = (k: string) => !!sources['terrain.' + k];
  return <>
    <Section title="Shape">
      <Row label="Preset" locked={lock('preset')}><select disabled={lock('preset')} value={t.preset} onChange={(e) => wc.mutate('Terrain preset', (d) => { applyTerrainPreset(d.config, e.target.value); })}>{Object.keys(TERRAIN_PRESETS).map((o) => <option key={o}>{o}</option>)}</select></Row>
      <Seed value={t.seed} disabled={lock('seed')} set={(v) => set('seed', v)} />
      <Fields fields={TERRAIN_FIELDS} value={t} set={set} path="terrain" />
    </Section>
    <Section title="Scene templates">
      <Hint>A whole scene in one go: land, terrain layers, water, ground colours and plants. Everything it sets stays editable.</Hint>
      <div className="wc-tools">{SCENE_TEMPLATES.map((n2) => <button key={n2} onClick={() => wc.mutate(`Scene: ${n2}`, (d) => { applySceneTemplate(d.config, n2); })}>{n2}</button>)}</div>
    </Section>
    <PlanetSection />
    <TerrainLayers />
    <ErosionSim />
    <Section title="Voxel mode">
      <Fields fields={[b('enabled', 'Voxel terrain', 'The land as blocks. Your terrain settings aren\'t changed: turn it off to go back.'), n('size', 'Block size (m)', 0.25, 8, 0.25), b('smooth', 'Smooth shading')]} value={useWC((st) => st.doc!.config.voxel)} set={setter('voxel')} path="voxel" />
    </Section>
    <Section title="World size and chunks">
      <Fields fields={[b('endless', 'Endless terrain', 'Chunks generate round the camera, with no edge. Off: a finite world.'), ...(t.endless ? [n('viewChunks', 'Load radius (chunks)', 1, 12, 1), n('unloadMargin', 'Unload margin (chunks)', 0, 6, 1)] : [num('width', 'Width (m)', 16), num('depth', 'Depth (m)', 16)]), n('chunkSize', 'Chunk size (m)', 16, 256, 8), n('resolution', 'Chunk resolution', 4, 256, 4), n('budget', 'Chunks built per frame', 1, 16, 1)]} value={t} set={set} path="terrain" />
      <Hint>Every chunk is worked out from the seed and its position, so it comes back the same on every visit and meets its neighbours exactly.</Hint>
    </Section>
    <Section title="Ground colours">
      <Fields fields={[...SURFACE_LAYERS.map((k) => c(k, k[0].toUpperCase() + k.slice(1))), n('slopeRock', 'Rock on slopes from', 0, 0.8), n('beachWidth', 'Beach width (m)', 0, 20, 0.5), n('blend', 'Blend', 0, 0.3), b('greens', 'Random green ground', 'Patches of different greens across the ground. Grass layers can copy them: Copy the ground colour, in Scatter.'), n('greenAmount', 'How much green', 0, 1), n('greenScale', 'Patch size (m)', 2, 200, 1), c('greenA', 'Dark green'), c('greenB', 'Mid green'), c('greenC', 'Light green')]} value={{ ...surfaceDefaults(), ...useWC((st) => st.doc!.config.surface) }} set={setter('surface')} path="surface" />
    </Section>
    <GroundTexture />
    <Section title="Infinite Noise Terrain">
      <Hint>Puts an editable Infinite Noise setup in the logic below: noise layers, height, erosion, biomes, endless chunks and the seed, each one a brick.</Hint>
      <button className="wc-btn" onClick={() => wc.mutate('Infinite Noise Terrain preset', (d) => { d.logic.sheets[0].events = infiniteNoiseEvents(); })}>Load preset into the logic</button>
    </Section>
  </>;
}

const LAYER_FIELDS_T: Field[] = [b('enabled', 'On'), s('type', 'Shape', [...TERRAIN_LAYER_TYPES]), s('blend', 'Blend', ['add', 'subtract', 'max', 'min', 'smooth', 'replace'], { add: 'Add', subtract: 'Subtract', max: 'Highest of the two', min: 'Lowest of the two', smooth: 'Smooth blend', replace: 'Replace' }), n('scale', 'Scale (m)', 4, 2000, 1), n('height', 'Height (m)', 0, 400, 0.5), num('minHeight', 'Only above (m)'), num('maxHeight', 'Only below (m)'), n('fade', 'Mask fade (m)', 0, 100, 0.5), n('patchiness', 'Patchiness', 0, 1, 0.01, '0: everywhere. Higher: only in patches.'), n('patchScale', 'Patch size (m)', 20, 3000, 10), n('direction', 'Direction (dunes, ramp, °)', 0, 360, 5), n('amount', 'Rock cover (outcrops)', 0, 1, 0.01, 'How much of the ground the outcrops cover: low, separate rocks; high, one continuous rocky mass.'), n('offset', 'Ramp middle (m)', -2000, 2000, 1, 'Where along its direction the ramp rises.'), s('paint', 'Paints ground', ['', 'rock', 'gravel', 'dirt', 'sand', 'mud', 'snow'], { '': 'Nothing' }), num('seed', 'Seed')];
const NO_LAYERS: NonNullable<WorldConfig['terrain']['layers']> = [];
/** The terrain layer stack: shapes blended in order onto the base land, each with its own masks. */
function TerrainLayers() {
  const layers = useWC((st) => st.doc!.config.terrain.layers ?? NO_LAYERS);
  const [pick, setPick] = useState<typeof TERRAIN_LAYER_TYPES[number]>('ridges');
  const [open, setOpen] = useState<string | null>(null);
  const edit = (label: string, fn: (l: NonNullable<WorldConfig['terrain']['layers']>) => void, quiet?: boolean) => wc.mutate(label, (d) => { fn((d.config.terrain.layers ??= [])); }, quiet);
  return <Section title="Terrain layers">
    <Hint>Shapes stacked on the land above, in order, each blended into what's below it and only where its masks allow (a band of height, patches). Like the layer stack of a terrain studio; each layer can also be a Terrain Layer brick.</Hint>
    <div className="wc-list">{layers.map((l, i) => <button key={l.id} className={open === l.id ? 'on' : ''} onClick={() => setOpen(open === l.id ? null : l.id)}><span>{i + 1}. {l.name}</span><em>{l.enabled ? `${l.blend} ${l.height} m` : 'off'}</em></button>)}</div>
    <span className="wc-seed"><select value={pick} onChange={(e) => setPick(e.target.value as typeof pick)}>{TERRAIN_LAYER_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select><button onClick={() => edit('Terrain layer added', (L) => { const nl = newTerrainLayer(pick, L.length); L.push(nl); setOpen(nl.id); })}>Add layer</button></span>
    {layers.map((l, i) => open === l.id && <div className="wc-sub" key={l.id}>
      <Row label="Name"><input type="text" value={l.name} onChange={(e) => edit('Layer name', (L) => { L[i].name = e.target.value; }, true)} /></Row>
      <Fields fields={LAYER_FIELDS_T} value={l} set={(k, v, q) => edit('Terrain layer', (L) => { (L[i] as any)[k] = v; }, q)} path={`tlayer:${l.id}`} />
      <div className="wc-tools">
        <button disabled={i === 0} onClick={() => edit('Layer up', (L) => { [L[i - 1], L[i]] = [L[i], L[i - 1]]; })}>Up</button>
        <button disabled={i === layers.length - 1} onClick={() => edit('Layer down', (L) => { [L[i + 1], L[i]] = [L[i], L[i + 1]]; })}>Down</button>
        <button onClick={() => edit('Layer removed', (L) => { L.splice(i, 1); })}>Delete</button>
      </div>
    </div>)}
  </Section>;
}

/** The ground's look: coloured from height, slope and the erosion run's flow, wear and sediment through a palette. */
function GroundLook() {
  const look = useWC((st) => st.doc!.config.surface.look);
  const set = (p: Partial<{ palette: string; strength: number }>) => wc.mutate('Ground look', (d) => { d.config.surface.look = { palette: '', strength: 0.75, ...d.config.surface.look, ...p }; });
  return <>
    <Row label="Ground look" tip="Colours the land from its own data: low to high ground, rock on slopes, and (after an erosion run) dark channels where water ran, worn rock, and pale sediment fans."><select value={look?.palette ?? ''} onChange={(e) => set({ palette: e.target.value })}><option value="">Biomes (off)</option>{Object.entries(LOOK_PALETTES).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}</select></Row>
    {!!look?.palette && <Row label="Look strength"><span className="wc-slider"><input type="range" min={0} max={1} step={0.01} value={look.strength} onChange={(e) => set({ strength: Number(e.target.value) })} /><input type="number" step={0.01} value={look.strength} onChange={(e) => set({ strength: Number(e.target.value) })} /></span></Row>}
  </>;
}

/** Hydraulic and thermal erosion run as a simulation over a finite world, written into its edits (undoable). */
function ErosionSim() {
  const t = useWC((st) => st.doc!.config.terrain);
  const [o, setO] = useState(erosionDefaults());
  const [busy, setBusy] = useState<number | null>(null);
  const stop = React.useRef(false);
  const runs = useWC((st) => st.doc!.edits.grids?.filter((g) => g.label === 'Erosion').length ?? 0);
  const run = async () => {
    const v = (window as any).__wc?.view, doc = wc.get().doc; if (!v || !doc) return;
    const cell = doc.edits.cell, ax = Math.round(-t.width / 2 / cell), az = Math.round(-t.depth / 2 / cell);
    const nx = Math.round(t.width / cell) + 1, nz = Math.round(t.depth / cell) + 1, h = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = v.height((ax + i) * cell, (az + j) * cell);
    stop.current = false; setBusy(0);
    const res = await erodeGrid(h, nx, nz, cell, o, (f) => { setBusy(f); return !stop.current; });
    setBusy(null);
    if (!res) { wc.log('Erosion stopped: nothing changed'); return; }
    // One dense grid per run (a few hundred KB packed), not an edit per point: saves, undo and exports stay light.
    const N = nx * nz, hgt = new Int16Array(N), wet = new Uint8Array(N), sed = new Uint8Array(N), scr = new Uint8Array(N), deb = new Uint8Array(N);
    const mFlow = new Uint8Array(N), mWear = new Uint8Array(N), mDep = new Uint8Array(N);
    const byte = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
    for (let q = 0; q < N; q++) {
      mFlow[q] = byte(res.flow[q]); mWear[q] = byte(res.wear[q]); mDep[q] = byte(Math.max(res.deposit[q], res.scree[q] * 0.7));
      hgt[q] = Math.round(Math.max(-327, Math.min(327, res.delta[q])) * 100);
      // Materials from the simulation: wet dark channels where water ran, sediment on the fans and valley floors it
      // dropped, scree where loose rock slid (only clear signals: the land between keeps its own colours).
      wet[q] = byte(smoothstep(0.6, 0.95, res.flow[q]) * 0.4 * o.materials);
      sed[q] = byte(smoothstep(0.15, 0.6, res.deposit[q]) * 0.75 * o.materials);
      scr[q] = byte(smoothstep(0.1, 0.5, res.scree[q]) * 0.85 * o.materials);
      deb[q] = byte(smoothstep(0.2, 0.7, Math.max(res.scree[q], res.deposit[q] * 0.6)) * o.debris);
    }
    wc.mutate('Erosion simulation', (d) => {
      const g: EditGrid = { id: 'eg_' + Date.now().toString(36), label: 'Erosion', x0: ax * cell, z0: az * cell, nx, nz, cell, height: packGrid(hgt), maps: { flow: packGrid(mFlow), wear: packGrid(mWear), deposit: packGrid(mDep) } };
      // (A run with a look chosen colours the land from what it did; with none yet, Temperate starts it off.)
      if (!d.config.surface.look?.palette) d.config.surface.look = { palette: 'temperate', strength: 0.75 };
      if (o.materials > 0) g.paint = { mud: packGrid(wet), dirt: packGrid(sed), gravel: packGrid(scr) };
      if (o.debris > 0) {
        let l = d.config.layers.find((x) => x.id === 'l_erosion_debris');
        if (!l) { l = makeLayer({ id: 'l_erosion_debris', name: 'Debris (erosion)', kind: 'rock', sources: ['rock:stone', 'rock:jagged'], density: 5, maxSlope: 0.9, clustering: 0.3, minScale: 0.15, maxScale: 0.6, align: 0.9 }); l.paintOnly = true; d.config.layers.push(l); }
        g.density = { [l.id]: packGrid(deb) };
      }
      (d.edits.grids ??= []).push(g);
    });
  };
  return <Section title="Erosion simulation">
    <GroundLook />
    {t.endless ? <Hint>For finite worlds: a simulation needs the whole land at once. Endless worlds use the Erosion slider above, worked out point by point.</Hint> : <>
      <Fields fields={[n('rain', 'Hydraulic: rain', 0, 1, 0.01, 'How much rain runs over the land, cutting gullies and leaving fans of sediment.'), n('strength', 'Hydraulic: strength', 0, 1, 0.01), n('thermal', 'Thermal: sliding', 0, 1, 0.01, 'Loose material sliding off slopes steeper than it rests at: scree, softened crests.'), n('talus', 'Thermal: resting slope', 0.05, 1.5, 0.01), n('materials', 'Ground from flow', 0, 1, 0.01, 'Colours the ground by what the simulation did: dark wet channels where water ran (Mud), sediment fans (Dirt), scree under steep slopes (Gravel).'), n('debris', 'Debris', 0, 1, 0.01, 'Stones settled where scree and sediment collect (a Debris scatter layer).'), num('seed', 'Seed')]} value={o} set={(k, v) => setO({ ...o, [k]: v })} />
      <div className="wc-tools">{busy === null ? <><button onClick={run}>Run erosion</button>{runs > 0 && <button onClick={() => wc.mutate('Erosion removed', (d) => { d.edits.grids = (d.edits.grids ?? []).filter((g) => g.label !== 'Erosion'); })}>Remove {runs} run{runs > 1 ? 's' : ''}</button>}</> : <><span>Eroding… {Math.round(busy * 100)}%</span><button onClick={() => { stop.current = true; }}>Stop</button></>}</div>
      <Hint>Written into the land as hand edits: undo takes it back, and the sculpt brushes work on top of it. Run it again for more.</Hint>
    </>}
  </Section>;
}

const BRUSH_TOOLS: { id: BrushCfg['tool']; label: string; tip: string }[] = [
  { id: 'raise', label: 'Raise', tip: 'Raise the ground' }, { id: 'lower', label: 'Lower', tip: 'Lower the ground' }, { id: 'smooth', label: 'Smooth', tip: 'Even out bumps' }, { id: 'flatten', label: 'Flatten', tip: 'Level to where you start' }, { id: 'noise', label: 'Noise', tip: 'Add roughness' }, { id: 'terrace', label: 'Terrace', tip: 'Cut the ground into steps of the level height' }, { id: 'push', label: 'Push / Pull', tip: 'Drag the ground along with the brush (Shift: pull)' }, { id: 'erode', label: 'Erode', tip: 'Weather by hand: steep spots slump, crests soften' }, { id: 'hole', label: 'Hole', tip: 'Dig a pit with steep rock walls (down to Strength × size)' }, { id: 'stamp', label: 'Stamp', tip: 'Press a landform into the ground: it follows the rotation' },
  { id: 'twist', label: 'Rotate', tip: 'Turn the land under the brush round its middle (Shift: the other way)' }, { id: 'relief', label: 'Scale', tip: 'Make hills and hollows taller (Shift: flatter), round their own average' },
  { id: 'tilt', label: 'Tilt', tip: 'Tip the ground the way the brush rotation points (Shift: the other way)' }, { id: 'align', label: 'Align', tip: 'Make a straight slope from where the stroke starts to where it is now: ramps and roads' },
  { id: 'clone', label: 'Duplicate', tip: 'Alt-click to pick the land to copy, then paint it elsewhere (copies its shape)' },
  { id: 'paint', label: 'Ground', tip: 'Paint a ground material' }, { id: 'biome', label: 'Biome', tip: 'Paint a biome' }, { id: 'snow', label: 'Snow', tip: 'Paint snow; Erase takes it off' }, { id: 'scatter', label: 'Plants & objects', tip: 'Paint more of a scatter layer' }, { id: 'erase', label: 'Erase', tip: 'Remove scatter or snow here' },
];
/** How the sculpt layer is laid over the generated land: scaled, one way only, snapped to level steps. */
function SculptLayerSettings() {
  const L = useWC((st) => st.doc!.edits.layer) ?? {};
  const set = (p: Partial<SculptLayerCfg>) => wc.mutate('Sculpt layer settings', (d) => { d.edits.layer = { ...d.edits.layer, ...p }; });
  const redraw = () => setTimeout(() => { const v = (window as any).__wc?.view; if (v) { v.refreshHeight(); v.editedAll(); } }, 60);
  return <>
    <Row label="Height scale" tip="All the hand sculpting, taller or flatter (0 hides it, 1 as sculpted)."><span className="wc-slider"><input type="range" min={0} max={3} step={0.05} value={L.scale ?? 1} onChange={(e) => { set({ scale: Number(e.target.value) }); redraw(); }} /><input type="number" step={0.05} value={L.scale ?? 1} onChange={(e) => { set({ scale: Number(e.target.value) }); redraw(); }} /></span></Row>
    <Row label="Operation" tip="Add: raises and digs as sculpted. Raise only / Lower only: keeps just that half."><select value={L.op ?? 'add'} onChange={(e) => { set({ op: e.target.value as SculptLayerCfg['op'] }); redraw(); }}><option value="add">Add</option><option value="raise">Raise only</option><option value="lower">Lower only</option></select></Row>
    <Row label="Height offset (m)" tip="Metres added wherever you sculpted: lifts or sinks the whole sculpted part."><span className="wc-slider"><input type="range" min={-40} max={40} step={0.5} value={L.offset ?? 0} onChange={(e) => { set({ offset: Number(e.target.value) }); redraw(); }} /><input type="number" step={0.5} value={L.offset ?? 0} onChange={(e) => { set({ offset: Number(e.target.value) }); redraw(); }} /></span></Row>
    <Row label="Height blending" tip="How much of the sculpted result shows: 1 all of it, 0 the land as generated."><span className="wc-slider"><input type="range" min={0} max={1} step={0.01} value={L.blend ?? 1} onChange={(e) => { set({ blend: Number(e.target.value) }); redraw(); }} /><input type="number" step={0.01} value={L.blend ?? 1} onChange={(e) => { set({ blend: Number(e.target.value) }); redraw(); }} /></span></Row>
    <Row label="Snap to level step" tip="Where you sculpted, the ground settles into flat steps this many metres apart (0: off)."><span className="wc-slider"><input type="range" min={0} max={20} step={0.5} value={L.step ?? 0} onChange={(e) => { set({ step: Number(e.target.value) }); redraw(); }} /><input type="number" step={0.5} value={L.step ?? 0} onChange={(e) => { set({ step: Number(e.target.value) }); redraw(); }} /></span></Row>
  </>;
}

const AREA_OPS: { op: AreaOp | 'duplicate'; label: string; tip: string }[] = [
  { op: 'raise', label: 'Add', tip: 'Raise the area by Amount' }, { op: 'lower', label: 'Lower', tip: 'Lower the area by Amount' },
  { op: 'duplicate', label: 'Duplicate', tip: 'Then click where the copy goes' }, { op: 'rotate', label: 'Rotate', tip: 'Turn the land inside by Angle' },
  { op: 'scale', label: 'Scale', tip: 'Hills and hollows inside taller (Factor over 1) or flatter (under 1)' }, { op: 'tilt', label: 'Tilt', tip: 'Tip the area by Amount metres, toward Direction' },
  { op: 'push', label: 'Push', tip: 'Move the land inside Amount metres toward Direction' }, { op: 'pull', label: 'Pull', tip: 'Move the land inside Amount metres back from Direction' },
  { op: 'align', label: 'Align', tip: 'Turn the area into one even slope, the one that fits it best' }, { op: 'flatten', label: 'Flatten', tip: 'Level the area to its average height' },
  { op: 'flipx', label: 'Flip X', tip: 'Mirror the land inside left to right' }, { op: 'flipz', label: 'Flip Z', tip: 'Mirror the land inside front to back' },
];
/** The area ("grid") tools: drag out a rectangle with the Area tool, then act on it as a whole. */
function AreaToolsPanel({ setBrush, tool }: { setBrush: (p: Partial<BrushCfg>) => void; tool: BrushCfg['tool'] }) {
  const [, bump] = useState(0);
  useEffect(() => onArea(() => bump((n) => n + 1)), []);
  const [p, setP] = useState(areaParams.current);
  const upd = (k: keyof typeof p, v: number) => { const np = { ...p, [k]: v }; areaParams.current = np; setP(np); };
  const area = getArea();
  const num2 = (k: keyof typeof p, label: string, min: number, max: number, step: number, tip?: string) => <Row label={label} tip={tip}><span className="wc-slider"><input type="range" min={min} max={max} step={step} value={p[k]} onChange={(e) => upd(k, Number(e.target.value))} /><input type="number" step={step} value={p[k]} onChange={(e) => upd(k, Number(e.target.value))} /></span></Row>;
  return <Section title="Area tools">
    <div className="wc-tools">
      <button className={tool === 'area' ? 'on' : ''} title="Drag on the land to mark the area" onClick={() => setBrush({ tool: 'area' })}>Mark area</button>
      {area && <button onClick={() => setArea(null)}>Clear area</button>}
    </div>
    {area ? <>
      <Hint>{`Area: ${Math.round(area[2] - area[0])} × ${Math.round(area[3] - area[1])} m.`}{tool === 'areapaste' ? ' Click where the copy goes.' : ''}</Hint>
      <div className="wc-tools">{AREA_OPS.map((o) => <button key={o.op} title={o.tip} className={o.op === 'duplicate' && tool === 'areapaste' ? 'on' : ''} onClick={() => { if (o.op === 'duplicate') setBrush({ tool: 'areapaste' }); else applyArea(o.op, p); }}>{o.label}</button>)}</div>
      {num2('amount', 'Amount (m)', 0.5, 60, 0.5, 'Add, Lower, Tilt, Push and Pull.')}
      {num2('angle', 'Angle (°)', -180, 180, 5, 'Rotate.')}
      {num2('factor', 'Factor', 0, 3, 0.05, 'Scale.')}
      {num2('direction', 'Direction (°)', 0, 360, 5, 'Tilt, Push and Pull: 0 is +X, 90 is +Z.')}
      {num2('feather', 'Soft edge (m)', 0, 40, 1, 'How far outside the area the change fades out.')}
    </> : <Hint>Mark an area first: choose Mark area and drag a rectangle on the land.</Hint>}
  </Section>;
}

const STAMPS = ['mountain', 'crater', 'hill', 'valley', 'cliff', 'canyon', 'brush'];
const STAMP_NAMES: Record<string, string> = { brush: 'The brush shape (landform brushes)' };

/** A brush shape drawn as the brush will act: white full strength, dark none (red where it digs). */
function BrushPreview({ shape, falloff, rotation, size }: { shape: BrushShape; falloff: number; rotation: number; size: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return; const g = cv.getContext('2d')!; const img = g.createImageData(size, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const [u, v] = brushFrame((i + 0.5) / size * 2 - 1, (j + 0.5) / size * 2 - 1, 1, rotation);
      const w = brushWeight(shape, u, v, falloff), o = (j * size + i) * 4, c = Math.round(Math.abs(w) * 235 + 20);
      img.data[o] = w < 0 ? c : c; img.data[o + 1] = w < 0 ? 40 : c; img.data[o + 2] = w < 0 ? 40 : c; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [shape, falloff, rotation, size]);
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, borderRadius: 4, display: 'block' }} />;
}

function PaintPanel({ brush, setBrush }: { brush: BrushCfg; setBrush: (p: Partial<BrushCfg>) => void }) {
  const layers = useWC((st) => st.doc!.config.layers);
  const custom = useWC((st) => st.doc!.config.biomes.custom);
  const opts: { label: string; o: string[]; names?: Record<string, string> } | null =
    brush.tool === 'paint' ? { label: 'Material', o: [...SURFACE_LAYERS, 'erase'] }
      : brush.tool === 'biome' ? { label: 'Biome', o: [...Object.keys(BIOME_INFO), ...custom.map((k) => k.id), 'erase'], names: { ...Object.fromEntries(Object.entries(BIOME_INFO).map(([k, v]) => [k, v.name])), ...Object.fromEntries(custom.map((k) => [k.id, k.name])) } }
        : brush.tool === 'scatter' || brush.tool === 'erase' ? { label: 'Layer', o: brush.tool === 'erase' ? ['snow', ...layers.map((l) => l.id)] : layers.map((l) => l.id), names: { snow: 'Snow', ...Object.fromEntries(layers.map((l) => [l.id, l.name])) } }
          : brush.tool === 'stamp' ? { label: 'Shape', o: STAMPS, names: STAMP_NAMES } : null;
  useEffect(() => { if (opts && !opts.o.includes(brush.value)) setBrush({ value: opts.o[0] }); });
  // The landform brushes are made once in the background: their previews redraw as each is ready.
  const [landformRev, setLandformRev] = useState(0);
  useEffect(() => { const off = onLandformsReady(() => setLandformRev((n) => n + 1)); void makeLandforms(); return off; }, []);
  return <>
    <Section title="Sculpt and paint">
      <div className="wc-tools">{BRUSH_TOOLS.map((t) => <button key={t.id} className={brush.tool === t.id ? 'on' : ''} title={t.tip} onClick={() => setBrush({ tool: t.id })}>{t.label}</button>)}</div>
      {opts && <Row label={opts.label}><select value={brush.value} onChange={(e) => setBrush({ value: e.target.value })}>{opts.o.map((o) => <option key={o} value={o}>{opts.names?.[o] ?? o}</option>)}</select></Row>}
      <Row label="Brush size (m)"><span className="wc-slider"><input type="range" min={1} max={120} value={brush.size} onChange={(e) => setBrush({ size: Number(e.target.value) })} /><input type="number" value={brush.size} onChange={(e) => setBrush({ size: Number(e.target.value) })} /></span></Row>
      <Row label="Strength"><span className="wc-slider"><input type="range" min={0.02} max={1} step={0.01} value={brush.strength} onChange={(e) => setBrush({ strength: Number(e.target.value) })} /><input type="number" step={0.01} value={brush.strength} onChange={(e) => setBrush({ strength: Number(e.target.value) })} /></span></Row>
      <Row label="Smoothness (falloff)"><span className="wc-slider"><input type="range" min={0} max={1} step={0.01} value={brush.falloff} onChange={(e) => setBrush({ falloff: Number(e.target.value) })} /><input type="number" step={0.01} value={brush.falloff} onChange={(e) => setBrush({ falloff: Number(e.target.value) })} /></span></Row>
      <Row label="Rotation (°)"><span className="wc-slider"><input type="range" min={0} max={360} step={1} value={brush.rotation ?? 0} onChange={(e) => setBrush({ rotation: Number(e.target.value) })} /><input type="number" value={brush.rotation ?? 0} onChange={(e) => setBrush({ rotation: Number(e.target.value) })} /></span></Row>
      {brush.tool === 'flatten' && <Row label="Flatten to (m)" tip="Empty: the height where the stroke starts."><span className="wc-seed"><input type="number" value={brush.flattenHeight ?? ''} placeholder="where you start" onChange={(e) => setBrush({ flattenHeight: e.target.value === '' ? null : Number(e.target.value) })} /><button onClick={() => setBrush({ flattenHeight: null })}>Clear</button></span></Row>}
      {brush.tool === 'terrace' && <Row label="Level step (m)"><span className="wc-slider"><input type="range" min={0.5} max={40} step={0.5} value={brush.levelStep ?? 5} onChange={(e) => setBrush({ levelStep: Number(e.target.value) })} /><input type="number" value={brush.levelStep ?? 5} onChange={(e) => setBrush({ levelStep: Number(e.target.value) })} /></span></Row>}
      <Hint>Drag on the terrain. Painted plants come from the same scatter layer rules, so each brush stroke stays editable.</Hint>
    </Section>
    <Section title="Brush shape">
      <div className="wc-brushes">{[...BRUSH_SHAPES, ...customShapes()].map((sh) => <button key={sh} title={shapeName(sh)} className={(brush.shape ?? 'circle') === sh ? 'on' : ''} onClick={() => setBrush({ shape: sh })}><BrushPreview key={landformRev} shape={sh} falloff={brush.falloff} rotation={brush.rotation ?? 0} size={44} /><span>{shapeName(sh)}</span></button>)}</div>
      <div className="wc-tools">
        <label className="wc-btnlike">Import brush…<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const sh = await importBrushShape(f); setBrush({ shape: sh }); wc.log(`Imported brush "${shapeName(sh)}"`); } catch { wc.log(`Couldn't read ${f.name} as a picture`); } }} /></label>
        {brush.shape?.startsWith('img:') && <button onClick={() => { removeBrushShape(brush.shape!); setBrush({ shape: 'circle' }); }}>Remove this brush</button>}
      </div>
      <Hint>Any picture can be a brush: white is full strength, black none (or its transparency, if it has one). Imported brushes stay on this computer.</Hint>
    </Section>
    <Section title="Whole sculpt layer">
      <div className="wc-tools">
        {([['Flip X', (i: number, j: number) => [-i, j]], ['Flip Z', (i: number, j: number) => [i, -j]], ['Turn left', (i: number, j: number) => [j, -i]], ['Turn right', (i: number, j: number) => [-j, i]]] as [string, (i: number, j: number) => [number, number]][]).map(([l, f]) =>
          <button key={l} onClick={() => wc.mutate(`Sculpt layer: ${l}`, (d) => {
            const moveGrid = (g: Record<string, number>) => { const o: Record<string, number> = {}; for (const [k, val] of Object.entries(g)) { const [i, j] = k.split(',').map(Number), [a, c] = f(i, j); o[`${a},${c}`] = val; } return o; };
            d.edits.height = moveGrid(d.edits.height);
            for (const m of Object.keys(d.edits.paint)) d.edits.paint[m] = moveGrid(d.edits.paint[m]);
          })}>{l}</button>)}
        <button title="Level everything sculpted to its own average height" onClick={() => wc.mutate('Sculpt layer: Flatten', (d) => {
          const v = (window as any).__wc?.view; if (!v) return; const c = d.edits.cell, keys = Object.keys(d.edits.height); if (!keys.length) return;
          const hs = keys.map((k) => { const [i, j] = k.split(',').map(Number); return v.height(i * c, j * c) as number; }), mean = hs.reduce((a, b) => a + b, 0) / hs.length;
          keys.forEach((k, q) => { d.edits.height[k] += mean - hs[q]; });
          setTimeout(() => { v.refreshHeight(); v.editedAll(); }, 60);
        })}>Flatten</button>
        <button onClick={() => { if (window.confirm('Remove all hand sculpting and painted ground? Undo brings it back.')) wc.mutate('Sculpt layer cleared', (d) => { d.edits.height = {}; for (const m of Object.keys(d.edits.paint)) d.edits.paint[m] = {}; }); }}>Clear</button>
      </div>
      <SculptLayerSettings />
      <Hint>Acts on everything sculpted and painted by hand, about the world's middle. The generated terrain underneath stays as it is.</Hint>
    </Section>
    <AreaToolsPanel setBrush={setBrush} tool={brush.tool} />
    <Section title="Shortcuts">
      <table className="wc-keys"><tbody>
        {[['Sculpt / paint', 'Left mouse'], ['Subtract (raise ↔ lower, pull)', 'Shift + left mouse'], ['Brush radius', 'Ctrl + wheel'], ['Brush smoothness', 'Ctrl + Shift + wheel'], ['Brush strength', 'Ctrl + Alt + wheel'], ['Brush rotation', 'Alt + Shift + wheel'], ['Height change (level step)', 'Ctrl + X + wheel'], ['Flatten height', 'Ctrl + C + wheel'], ['Radius / smoothness / strength', 'I / O / P + move mouse'], ['Turn the view', 'Right mouse'], ['Zoom', 'Wheel']].map(([a, k]) => <tr key={a}><td>{a}</td><td>{k}</td></tr>)}
      </tbody></table>
    </Section>
  </>;
}

const TREE_FIELDS: Field[] = [n('height', 'Tree height (m)', 1, 40, 0.5), n('trunk', 'Trunk thickness (m)', 0.05, 2), n('taper', 'Taper', 0.1, 1), n('branches', 'Branch count', 1, 24, 1), n('levels', 'Branch levels', 1, 4, 1), n('angle', 'Branch angle (°)', 5, 100, 1), n('length', 'Branch length', 0.1, 1.2), n('randomness', 'Randomness', 0, 1), n('roots', 'Roots', 0, 12, 1), n('age', 'Age', 0.1, 1.5), n('leafSize', 'Leaf size (m)', 0.05, 2), n('leafDensity', 'Leaf density', 0, 3), n('leafSpread', 'Leaf spread', 0, 2), s('canopy', 'Canopy', ['round', 'cone', 'wide', 'droop', 'palm', 'none']), c('bark', 'Bark colour'), c('leaf', 'Leaf colour'), b('leafOriginal', "Leaf picture's own colours", 'Off: the picture gives light and dark, the Leaf Control gives colours.'), b('pixelLeaves', 'Pixel art (no smoothing)')];
const SHAPE_FIELDS: Field[] = [n('asymmetry', 'Asymmetry', 0, 1, 0.01, 'How one-sided the crown is: each tree leans and reaches toward a side of its own.'), n('curvature', 'Branch curvature', 0, 1, 0.01, 'How much branches bend and wander as they grow.'), n('variants', 'Random shapes', 1, 24, 1, 'How many different individuals a scattered species comes in. Each also gets its own height, width and lean.')];
const GROWTH_FIELDS: Field[] = [n('light', 'Light competition', 0, 1, 0.01, 'Branches pick the least crowded direction; shaded twigs die back.'), n('upAttraction', 'Reach for the sky', -1, 2), n('gravity', 'Weight (sag)', 0, 4, 0.05), n('stiffness', 'Stiffness', 0.05, 2), n('splitChance', 'Fork chance', 0, 1), n('splitAngle', 'Fork angle (°)', 5, 80, 1), n('breakChance', 'Snapped branches', 0, 1), n('flatness', 'Flatten into layers', 0, 1), n('phyllotaxis', 'Turn between branches (°)', 0, 360, 0.5, '137.5 is the spacing plants use.'), n('flare', 'Trunk flare', 0, 3), n('lumps', 'Trunk unevenness', 0, 0.5)];
const STAGE_FIELDS: Field[] = [n('count', 'Count ×', 0, 3), n('length', 'Length ×', 0.1, 3), n('angle', 'Angle + (°)', -60, 60, 1), n('radius', 'Thickness ×', 0.2, 2), n('start', 'Grows from (along parent)', 0, 1), n('end', 'Grows to', 0, 1), n('up', 'Reach for the sky', -1, 2), n('gravity', 'Weight', 0, 4, 0.05), n('split', 'Fork chance', 0, 1), n('splitAngle', 'Fork angle (°)', 5, 80, 1), n('flat', 'Flatten', 0, 1), n('brk', 'Snap chance', 0, 1)];
const LEAF_FIELDS: Field[] =[n('healthy', 'Healthy %', 0, 100, 1), n('yellow', 'Yellow %', 0, 100, 1), n('orange', 'Orange %', 0, 100, 1), n('brown', 'Brown %', 0, 100, 1), n('sizeMin', 'Min size ×', 0.1, 2), n('sizeMax', 'Max size ×', 0.1, 3), n('variation', 'Colour variation', 0, 1), n('brightness', 'Brightness', 0, 2), n('saturation', 'Saturation', 0, 2), n('opacity', 'Opacity', 0.1, 1), num('seed', 'Seed')];

const BARK_UV: Field[] = [n('barkU', 'Wood UV: repeat round', 0.05, 20, 0.05), n('barkV', 'Wood UV: repeat along', 0.05, 20, 0.05), n('barkRot', 'Wood UV: rotate (°)', 0, 360, 1)];
const MODEL_WOOD: Field[] = [n('set', 'Wood material (1-4)', 1, 4, 1), n('u', 'Wood UV: repeat round', 0.01, 20, 0.01), n('v', 'Wood UV: repeat along', 0.01, 20, 0.01), n('rot', 'Wood UV: rotate (°)', 0, 360, 1)];
const HAIR_COMMON: Field[] =[n('amount', 'Amount ×', 0, 6, 0.05, 'How many leaves.'), n('start', 'Grow from (0 base)', 0, 1), n('end', 'Grow to (1 tip)', 0, 1), n('tipBias', 'Crowd toward the tips', 0, 1), n('length', 'Stalk (m)', 0, 3, 0.02, 'How far out from the wood a leaf sits.'), n('angle', 'Away from branch (°)', 0, 180, 1, '0 along the branch, 90 straight out.'), n('random', 'Random direction', 0, 2), n('droop', 'Droop', 0, 3), n('sizeRandom', 'Random size', 0, 1), n('clumps', 'Leaves per spot', 1, 8, 1, 'Like child hairs: more leaves round each spot.'), n('clumpSize', 'Clump spread', 0, 2)];
const HAIR_FIELDS: Field[] = [...HAIR_COMMON, s('where', 'Grow on', ['tips', 'all']), n('fromStage', 'From stage (0 trunk)', 0, 4, 1, 'Leaves only on this stage of the Growth Stack and finer.'), n('limit', 'Most per tree', 100, 40000, 100)];
const MODEL_HAIR_FIELDS: Field[] = [...HAIR_COMMON, n('size', 'Leaf size (% of tree)', 0.5, 20, 0.1), n('thinOnly', 'Thinnest wood only', 0.02, 1, 0.01, 'Smaller: leaves only on the finest branches. 1: all over the wood.'), n('limit', 'Most per tree', 100, 40000, 100)];

function useLibrary() {
  const [lib, setLib] = useState<{ id: string; files: { path: string }[] }[]>([]);
  useEffect(() => { api.library().then(setLib).catch(() => setLib([])); }, []);
  return lib;
}
const fileName = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '');

/**
 * The ground's texture: the built-in grass, a material set from the library, or your own pictures, map by map (colour /
 * albedo, normal, height), tiled every so many metres. Its light and dark go over the ground's colours, or (Own colours)
 * the picture's own colours are shown.
 */
function GroundTexture() {
  const g = useWC((st) => st.doc!.config.surface.groundTex) ?? {};
  const lib = useLibrary();
  const imported = useWC((st) => st.doc!.assets).filter((a) => a.kind === 'texture').map((a) => ({ id: a.id, path: a.id.slice(5) }));
  const pics = useMemo(() => [...lib.flatMap((l) => l.files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.path)).map((f) => ({ id: `lib:${l.id}/${f.path}`, path: f.path }))), ...imported], [lib, imported.length]);
  const sets = useMemo(() => groupPbrSets(pics), [pics]);
  const set = (p: Partial<NonNullable<WorldConfig['surface']['groundTex']>>, label = 'Ground texture') => wc.mutate(label, (d) => { d.config.surface.groundTex = { ...d.config.surface.groundTex, ...p }; });
  const pick = (slot: 'color' | 'normal' | 'height', label: string) => <Row label={label}><span className="wc-seed">
    <select value={g[slot] ?? ''} onChange={(e) => set({ [slot]: e.target.value || undefined })}><option value="">{slot === 'color' ? 'Built-in grass' : 'None'}</option>{pics.map((p) => <option key={p.id} value={p.id}>{fileName(p.id)}{p.id.startsWith('proj:') ? ' (imported)' : ''}</option>)}</select>
    <ImportPicture onDone={(id) => set({ [slot]: id })} /></span></Row>;
  const active = !!g.color;
  return <Section title="Ground texture">
    <Row label="Material set" tip="A set of pictures that belong together (colour, normal, height…), from the library or imported."><select value="" onChange={(e) => { const s = sets.find((x) => x.folder + '/' + x.name === e.target.value); if (s) set({ color: s.maps.color, normal: s.maps.normal, height: s.maps.height }, 'Ground material'); }}><option value="">Choose a set…</option>{sets.map((s) => <option key={s.folder + '/' + s.name} value={s.folder + '/' + s.name}>{s.name}</option>)}</select></Row>
    {pick('color', 'Colour (albedo)')}
    {pick('normal', 'Normal map')}
    {pick('height', 'Height map')}
    {active && <Fields fields={[n('tile', 'Tile size (m)', 0.5, 20, 0.1, 'How far one copy of the picture reaches across the ground.'), b('ownColors', "Picture's own colours", "On: the ground shows the picture's colours. Off: only its light and dark, over the ground's colours (grass growing there matches them).")]} value={{ tile: 3.4, ownColors: false, ...g }} set={(k, v) => set({ [k]: v })} />}
    <div className="wc-tools">{active && <button onClick={() => wc.mutate('Built-in ground texture', (d) => { delete d.config.surface.groundTex; })}>Back to the built-in grass</button>}</div>
    <Hint>Drag a texture or material from the library onto the terrain to use it here too. Height maps give the relief up close; without one the ground is flat-shaded by its normal map.</Hint>
  </Section>;
}

/** An "Import…" button that brings in a picture of your own and hands back its id. */
function ImportPicture({ onDone, label = 'Import…' }: { onDone: (id: string) => void; label?: string }) {
  return <label className="wc-btnlike" title="Use a picture of your own (.png .jpg .webp): it's stored with this world">{label}<input type="file" accept={PICTURE_FILES} hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { onDone(await importAsset(f)); } catch (err) { wc.log(`Couldn't import ${f.name}: ${(err as Error).message}`); } }} /></label>;
}

function TreesPanel() {
  const trees = useWC((st) => st.doc!.config.trees);
  const leaves = useWC((st) => st.doc!.config.leaves);
  const [id, setId] = useFocus(trees[0].id);
  const t = trees.find((x) => x.id === id) ?? trees[0];
  const lib = useLibrary();
  const imgs = lib.flatMap((l) => l.files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.path)).map((f) => `lib:${l.id}/${f.path}`));
  // (Your own imported pictures too: any can be a leaf or the wood.)
  const imported = useWC((st) => st.doc!.assets).filter((a) => a.kind === 'texture').map((a) => a.id);
  const leavesImgs = [...imgs.filter((i) => /\/leaves\//i.test(i)), ...imported], barks = [...imgs.filter((i) => /_Diffuse\./i.test(i)), ...imported];
  const models = lib.flatMap((l) => l.files.filter((f) => /\/trees\/Tree\d+\.fbx$/i.test('/' + f.path) || /(^|\/)trees\/Tree\d+\.fbx$/i.test(f.path)).map((f) => `lib:${l.id}/${f.path}`));
  const [modelPick, setModel] = useState('');
  const model = modelPick || models[0] || '';
  const modelLeaves = useWC((st) => st.doc!.config.modelLeaves);
  const modelWood = useWC((st) => st.doc!.config.modelWood);
  const modelHair = { ...modelHairDefaults(), ...modelLeaves?.[model] };
  const stages = t.cfg.stages ?? [];
  const names = STAGE_NAMES(Math.round(t.cfg.levels));
  const [stageN, setStageN] = useState(1);
  const stage = stages[Math.min(stageN, names.length - 1)] ?? {};
  const shown = stageOf(t.cfg, Math.min(stageN, names.length - 1));
  const setStage = (k: string, v: any, quiet?: boolean) => wc.mutate('Growth stage', (d) => { const c = d.config.trees.find((x) => x.id === t.id)!.cfg; c.stages = c.stages ?? []; const i = Math.min(stageN, names.length - 1); while (c.stages.length <= i) c.stages.push({}); (c.stages[i] as any)[k] = v; }, quiet);
  const set = (k: string, v: any, quiet?: boolean) => wc.mutate('Tree: ' + k, (d) => { (d.config.trees.find((x) => x.id === t.id)!.cfg as any)[k] = v; }, quiet);
  return <>
    <Section title="Tree generator" right={<button className="wc-btn small" onClick={() => wc.mutate('New tree', (d) => { const nid = 'custom' + Date.now().toString(36); d.config.trees.push({ id: nid, name: t.name + ' copy', cfg: deepCopy(t.cfg) }); setId(nid); })}>Duplicate</button>}>
      <Row label="Species"><select value={t.id} onChange={(e) => setId(e.target.value)}>{trees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Row>
      <Row label="Leaf type" tip="Realistic, stylized, toon or pixel-art leaves, with the shapes that suit them. Scattered trees in a world look wear that look's leaves whatever is set here"><select value={t.cfg.leafStyle ?? ''} onChange={(e) => wc.mutate('Leaf type', (d) => { const c = d.config.trees.find((x) => x.id === t.id)!.cfg; if (e.target.value) c.leafStyle = e.target.value as LeafStyle; else delete c.leafStyle; })}><option value="">Its own picture (below)</option>{LEAF_STYLES.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></Row>
      <Fields fields={TREE_FIELDS} value={t.cfg} set={set} path={`tree:${t.id}`} />
      <Row label="Leaf picture" tip="Any picture: its see-through parts cut the leaf's outline. Import your own with the button."><span className="wc-seed"><select value={t.cfg.leafAsset} onChange={(e) => set('leafAsset', e.target.value)}><option value="">Plain cards</option>{leavesImgs.map((i) => <option key={i} value={i}>{fileName(i)}{i.startsWith('proj:') ? ' (imported)' : ''}</option>)}</select><ImportPicture onDone={(id) => set('leafAsset', id)} /></span></Row>
      <Row label="Wood material" tip="The bark's picture. Import your own with the button."><span className="wc-seed"><select value={t.cfg.barkAsset} onChange={(e) => set('barkAsset', e.target.value)}><option value="">Plain colour</option>{barks.map((i) => <option key={i} value={i}>{fileName(i).replace('_Diffuse', '')}{i.startsWith('proj:') ? ' (imported)' : ''}</option>)}</select><ImportPicture onDone={(id) => set('barkAsset', id)} /></span></Row>
      <Fields fields={BARK_UV} value={{ barkU: 1, barkV: 1, barkRot: 0, ...t.cfg }} set={set} path={`tree:${t.id}`} />
      <Hint>Add a species to the world in Scatter (source: the species), or with a Tree Generator brick. Scattered trees each get one of several random shapes. Drop one from the library to place it: then its leaf type, shape and nodes can be changed in its own settings.</Hint>
    </Section>
    <Section title="Draw a tree">
      <Hint>Draw a tree by hand: drag up from the ground for the trunk, then drag out from any node for a branch, and from a branch's nodes for smaller ones. Turn the view (Alt+drag) to draw all round. Then, with the tree selected: move nodes to bend branches, make a branch thicker or thinner, and add leaves. It wears this species' bark and leaves.</Hint>
      <button className="wc-btn" onClick={() => { const v = (window as any).__wc?.view; if (v) v.drawTree = null; drawTool?.(t.id); }}>{'Draw a ' + t.name.toLowerCase()}</button>
    </Section>
    <Section title="Shape and individuals">
      <Fields fields={SHAPE_FIELDS} value={{ asymmetry: 0, curvature: 0, variants: 6, ...t.cfg }} set={set} path={`tree:${t.id}`} />
    </Section>
    <Section title="Growth">
      <Fields fields={GROWTH_FIELDS} value={t.cfg} set={set} path={`tree:${t.id}`} />
    </Section>
    <Section title="Tree logic">
      <Hint>Every setting that builds this species as logic bricks (Trees &amp; leaves): trunk, branches, shape, forks, growth forces, leaves, roots, age, individuals. Edit a brick and the trees follow; settings a brick sets are locked here.</Hint>
      <button className="wc-btn" onClick={() => wc.mutate(`${t.name} as logic bricks`, (d) => { d.logic.sheets[0].events = [...d.logic.sheets[0].events, treeLogicEvent(t.id, t.cfg)]; })}>Show this tree as logic bricks</button>
    </Section>
    <Section title="Growth Stack">
      <div className="wc-tools">{names.map((nm, i) => <button key={i} className={Math.min(stageN, names.length - 1) === i ? 'on' : ''} onClick={() => setStageN(i)}>{nm}</button>)}</div>
      <Fields fields={STAGE_FIELDS} value={{ ...shown, ...stage }} set={setStage} />
      <button className="wc-btn small" disabled={!Object.keys(stage).length} onClick={() => wc.mutate('Reset stage', (d) => { const c = d.config.trees.find((x) => x.id === t.id)!.cfg; if (c.stages) c.stages[Math.min(stageN, names.length - 1)] = {}; })}>Reset this stage</button>
      <Hint>Each stage grows from the one before it. Change Branch levels above to add or remove stages.</Hint>
    </Section>
    <Section title="Leaf particles (this species)">
      <Fields fields={HAIR_FIELDS} value={{ ...hairDefaults(), ...t.cfg.hair }} set={(k, v, quiet) => wc.mutate('Leaf particles', (d) => { const cf = d.config.trees.find((x) => x.id === t.id)!.cfg; (cf.hair ??= {} as any)[k as 'amount'] = v; }, quiet)} path={`tree:${t.id}`} />
      <button className="wc-btn small" disabled={!t.cfg.hair} onClick={() => wc.mutate('Reset leaf particles', (d) => { delete d.config.trees.find((x) => x.id === t.id)!.cfg.hair; })}>Reset</button>
      <Hint>Leaves grow out of the surface of each branch, like hair particles. Size, density and colours are under Tree generator and Leaf Control.</Hint>
    </Section>
    <Section title="Supplied tree models: wood and leaf particles">
      <Row label="Model"><select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{fileName(m)}</option>)}</select></Row>
      {model && <>
        <Fields fields={MODEL_WOOD} value={woodOf({ modelWood } as any, model, Number(/Tree(\d+)/.exec(model)?.[1] ?? 1))} set={(k, v, quiet) => wc.mutate('Model wood', (d) => { const all = (d.config.modelWood ??= {}); (all[model] ??= {} as any)[k as 'u'] = v; }, quiet)} path={`model:${model}`} />
        <Fields fields={MODEL_HAIR_FIELDS} value={modelHair} set={(k, v, quiet) => wc.mutate('Leaf particles', (d) => { const all = (d.config.modelLeaves ??= {}); (all[model] ??= {} as any)[k as 'amount'] = v; }, quiet)} path={`model:${model}`} />
        <Row label="Leaf picture"><select value={modelHair.picture} onChange={(e) => wc.mutate('Leaf particles', (d) => { const all = (d.config.modelLeaves ??= {}); (all[model] ??= {}).picture = e.target.value; })}>{leavesImgs.map((i) => <option key={i} value={i}>{fileName(i)}</option>)}</select></Row>
        <Hint>The same system on the model's own triangles. Set Amount to 0 for bare wood.</Hint>
      </>}
    </Section>
    <Section title="Leaf Control (all generated trees)">
      <Fields fields={LEAF_FIELDS} value={leaves} set={setter('leaves')} path="leaves" />
    </Section>
  </>;
}

const ROCK_FIELDS: Field[] = [n('size', 'Size (m)', 0.1, 12, 0.1), n('detail', 'Resolution', 0, 5, 1), n('roughness', 'Roughness', 0, 1), n('smooth', 'Smoothness', 0, 1), n('deform', 'Deformation', 0, 1), n('fractures', 'Fractures', 0, 1), n('sharpness', 'Edge sharpness', 0, 1), n('elongate', 'Stretch', 0, 1), n('variation', 'Material variation', 0, 1), c('color', 'Colour'), b('lowPoly', 'Low-poly')];
function RocksPanel() {
  const rocks = useWC((st) => st.doc!.config.rocks);
  const [id, setId] = useFocus(rocks[0].id);
  const t = rocks.find((x) => x.id === id) ?? rocks[0];
  const set = (k: string, v: any, quiet?: boolean) => wc.mutate('Rock: ' + k, (d) => { (d.config.rocks.find((x) => x.id === t.id)!.cfg as any)[k] = v; }, quiet);
  return <Section title="Rock generator" right={<button className="wc-btn small" onClick={() => wc.mutate('New rock', (d) => { const nid = 'custom' + Date.now().toString(36); d.config.rocks.push({ id: nid, name: t.name + ' copy', cfg: deepCopy(t.cfg) }); setId(nid); })}>Duplicate</button>}>
    <Row label="Kind"><select value={t.id} onChange={(e) => setId(e.target.value)}>{rocks.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Row>
    <Fields fields={ROCK_FIELDS} value={t.cfg} set={set} path={`rock:${t.id}`} />
  </Section>;
}

/** Each is its own kind of grass: a layer shows one. Another type goes on another layer. */
const GRASS_TYPES: [string, string][] = [
  ['lib:world/grass/RealisticGrass.fbx', 'Realistic (card)'], ['lib:world/grass/Realistic Grass.fbx', 'Realistic, wider card'], ['lib:world/grass/Realistic_Grass_2.fbx', 'Realistic, crossed cards'],
  ['lib:world/grass/Realsitc-ish Grass.fbx', 'Realistic 3D blades'], ['lib:world/grass/StylizedGrass.blend', 'Stylized 3D blades'], ['lib:world/grass/StylizedGrass_2.blend', 'Stylized tall blades'], ['lib:world/grass/StylizedGrass.blend@toon', 'Toon blades'],
  ['lib:world/grass/PixelArtGrass.fbx', 'Pixel art'], ['lib:world/grass/PixelArtGrass2.fbx', 'Pixel art 2'],
];
const LAYER_FIELDS: Field[] =[b('enabled', 'Enabled'), s('kind', 'Kind', ['tree', 'rock', 'grass', 'flower', 'bush', 'prop', 'debris']), n('density', 'Density (per 100 m²)', 0, 1500, 0.05, 'Grass: 240 is a thick meadow, 600 and up a dense carpet. Grass thins out by itself with distance.'), n('minScale', 'Min size', 0.05, 5), n('maxScale', 'Max size', 0.05, 8), b('randomRotation', 'Random rotation'), n('align', 'Surface alignment', 0, 1), n('minSlope', 'Min slope', 0, 1), n('maxSlope', 'Max slope', 0, 1), num('minHeight', 'Min height (m)'), num('maxHeight', 'Max height (m)'), n('clustering', 'Clustering', 0, 1), n('clusterSize', 'Cluster size (m)', 2, 200, 1), n('spacing', 'Min spacing (m)', 0, 40, 0.5), b('avoid', 'Avoid other objects'), b('faceCamera', 'Face camera (2D cards)', 'On: cards turn to the camera round the vertical. Off: crossed cards that stay put.'), b('moves', 'Moves in the wind', 'Animated in WorldCraft with the wind settings under Weather. GameCraft shows it standing still for now.'), b('randomColor', 'Randomize colour', 'Some of the layer take on fall colours: yellow, orange, red or brown, a whole plant at a time. Trunks stay as they are.'), n('fallShare', 'Share in fall colours', 0, 1), b('copyGround', 'Copy the ground colour', 'Each plant takes the colour of the ground right under it. Good with Random green ground, under Terrain.')];

function ScatterPanel() {
  const layers = useWC((st) => st.doc!.config.layers);
  const trees = useWC((st) => st.doc!.config.trees);
  const rocks = useWC((st) => st.doc!.config.rocks);
  const assets = useWC((st) => st.doc!.assets);
  const [id, setId] = useFocus(layers[0]?.id ?? '');
  const l = layers.find((x) => x.id === id) ?? layers[0];
  const lib = useLibrary();
  const fileOpts = useMemo(() => lib.flatMap((x) => x.files.map((f) => `lib:${x.id}/${f.path}`)), [lib]);
  const add = (kind: LayerKind, name: string, sources: string[], extra: Partial<ScatterLayer> = {}) => wc.mutate('New scatter layer', (d) => { const nid = 'l_' + Date.now().toString(36); d.config.layers.push(makeLayer({ id: nid, name, kind, sources, seed: d.config.layers.length + 1, ...extra })); setId(nid); });
  const edit = (fn: (x: ScatterLayer) => void, quiet?: boolean) => wc.mutate('Scatter layer', (d) => { fn(d.config.layers.find((x) => x.id === l.id)!); }, quiet);
  const set = (k: string, v: any, quiet?: boolean) => edit((x) => { (x as any)[k] = v; }, quiet);
  const srcs: { id: string; label: string }[] = [
    ...trees.map((t) => ({ id: 'tree:' + t.id, label: 'Generated tree: ' + t.name })),
    ...rocks.map((t) => ({ id: 'rock:' + t.id, label: 'Generated rock: ' + t.name })),
    ...fileOpts.filter((f) => /\.(fbx|glb|gltf|obj|blend)$/i.test(f)).map((f) => ({ id: f, label: 'Model: ' + fileName(f) })),
    ...fileOpts.filter((f) => /\/leaves\//i.test(f)).map((f) => ({ id: 'card:' + f, label: '2D card: ' + fileName(f) })),
    ...assets.filter((a) => a.kind === 'model').map((a) => ({ id: a.id, label: 'Imported: ' + a.name })),
    ...assets.filter((a) => a.kind === 'texture').map((a) => ({ id: 'card:' + a.id, label: '2D card: ' + a.name })),
  ];
  const [pick, setPick] = useState('');
  return <>
    <WorldLook />
    <Section title="Scatter layers">
      <div className="wc-list">{layers.map((x) => <button key={x.id} className={x.id === l?.id ? 'on' : ''} onClick={() => setId(x.id)}><span>{x.name}</span><em>{x.enabled ? `${x.density}/100m²` : 'off'}</em></button>)}</div>
      <div className="wc-tools">
        <button onClick={() => add('grass', 'Grass', [GRASS_TYPES[0][0]], { density: 800, maxSlope: 0.55, copyGround: true, clustering: 0, clusterSize: 14, minScale: 0.8, maxScale: 1.3 })}>+ Grass layer</button>
        <button onClick={() => add('prop', 'New layer', [], { density: 1 })}>+ Empty</button>
      </div>
    </Section>
    {l && <Section title={l.name} right={<button className="wc-btn small" onClick={() => { const rest = layers.filter((x) => x.id !== l.id); wc.mutate('Delete layer', (d) => { d.config.layers = d.config.layers.filter((x) => x.id !== l.id); }); setId(rest[0]?.id ?? ''); }}>Delete</button>}>
      <Row label="Name"><input type="text" value={l.name} onChange={(e) => set('name', e.target.value, true)} /></Row>
      <Seed value={l.seed} set={(v) => set('seed', v)} />
      {l.kind === 'grass' && <Row label="Grass type" tip="One kind of grass per layer. To grow another kind as well, add another grass layer"><select value={l.sources.length === 1 && GRASS_TYPES.some(([g]) => g === l.sources[0]) ? l.sources[0] : ''} onChange={(e) => { if (e.target.value) set('sources', [e.target.value]); }}>{(l.sources.length !== 1 || !GRASS_TYPES.some(([g]) => g === l.sources[0])) && <option value="">Your own sources (below)</option>}{GRASS_TYPES.map(([g, label]) => <option key={g} value={g}>{label}</option>)}</select></Row>}
      <Fields fields={LAYER_FIELDS} value={l} set={set} path={`layer:${l.id}`} />
      <Row label="Biomes (none = all)"><input type="text" value={l.biomes.join(', ')} placeholder="forest, grassland" onChange={(e) => set('biomes', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Row>
      <div className="wc-sources"><b>Sources</b>{l.sources.map((x) => <div key={x}><span title={x}>{srcs.find((o) => o.id === x)?.label ?? fileName(x)}</span><button onClick={() => edit((y) => { y.sources = y.sources.filter((q) => q !== x); })}>✕</button></div>)}
        <span className="wc-seed"><select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Add a source…</option>{srcs.filter((o) => !l.sources.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select><button disabled={!pick} onClick={() => { edit((y) => { y.sources.push(pick); }); setPick(''); }}>Add</button></span>
      </div>
    </Section>}
    {l && <InteractSection layer={l} edit={edit} />}
  </>;
}

/** Which of a look's grasses this world wears. Picking one sets the grass layer to it, at a thickness that suits it. */
export function GrassPicker({ look, label }: { look: LeafStyle; label: string }) {
  const choice = useWC((st) => st.doc!.config.grassChoice?.[look]);
  const cur = lookGrass({ grassChoice: { [look]: choice } }, look);
  return <Row label={label} tip="One grass at a time for each look"><select value={cur.id} onChange={(e) => wc.mutate('Grass: ' + e.target.value.split('/').pop(), (d) => { (d.config.grassChoice ??= {})[look] = e.target.value; if (d.config.style) applyWorldStyle(d.config, d.config.style); })}>{LOOK_GRASSES[look].map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Row>;
}

const LOOKS: [WorldStyle, string][] = [['realistic', 'Realistic'], ['stylized', 'Stylized'], ['toon', 'Toon'], ['pixel', 'Pixel art'], ['mixed', 'Mixed']];
/** The world's look: which trees, leaves, grass and rocks the tree, rock and grass layers scatter. */
export function WorldLook() {
  const style = useWC((st) => st.doc!.config.style);
  return <Section title="World look">
    <div className="wc-tools">{LOOKS.map(([k, l]) => <button key={k} className={style === k ? 'on' : ''} onClick={() => wc.mutate('World look: ' + l, (d) => { applyWorldStyle(d.config, k); })}>{l}</button>)}</div>
    {style && (style === 'mixed' ? LEAF_STYLES : [style]).map((look) => <GrassPicker key={look} look={look} label={style === 'mixed' ? `${look[0].toUpperCase() + look.slice(1)} grass` : 'Grass'} />)}
    <Hint>Each look has its own trees, leaves, grass and rocks, never mixed with the others. Mixed has all of them, a look to each region of the world. Only the tree, rock and grass layers change; their density and rules stay as they are.</Hint>
  </Section>;
}

function InteractSection({ layer, edit }: { layer: ScatterLayer; edit: (fn: (x: ScatterLayer) => void, quiet?: boolean) => void }) {
  const it = layer.interact ?? { enabled: false, action: 'pickup' as const, distance: 2.2, duration: 0.6, physics: false, fall: 'vanish' as const, resource: '', quantity: 1 };
  const rg = layer.regen ?? { enabled: false, seconds: 120, variation: 0.2 };
  return <Section title="Player interaction (plays in GameCraft)">
    <Fields fields={[b('enabled', 'Player interaction'), s('action', 'Action', ['pickup', 'chop', 'mine', 'cut']), n('distance', 'Distance (m)', 0.5, 10, 0.1), n('duration', 'Duration (s)', 0, 5, 0.1), b('physics', 'Physics'), s('fall', 'Afterwards', ['remain', 'logs', 'drop', 'vanish'], { remain: 'Stays on the ground', logs: 'Breaks into logs', drop: 'Drops resources', vanish: 'Disappears' }), { k: 'resource', l: 'Resource', t: 'txt' as const }, n('quantity', 'Quantity', 0, 50, 1)]} value={it} set={(k, v, q) => edit((x) => { x.interact = { ...it, [k]: v }; }, q)} />
    <Fields fields={[b('enabled', 'Regeneration'), n('seconds', 'Regrow time (s)', 1, 3600, 1), n('variation', 'Variation', 0, 1)]} value={rg} set={(k, v, q) => edit((x) => { x.regen = { ...rg, [k]: v }; }, q)} />
    <Hint>Exported with the world: GameCraft runs it. Chopping and falling use GameCraft's existing interaction behavior and blocks.</Hint>
  </Section>;
}

function BiomesPanel() {
  const bio = useWC((st) => st.doc!.config.biomes);
  return <Section title="Biomes" right={<button className="wc-btn small" onClick={() => wc.mutate('New biome', (d) => { d.config.biomes.custom.push({ id: 'b_' + Date.now().toString(36), name: 'My biome', temperature: 0.5, moisture: 0.5, ground: '#6f9a45', density: 1 }); })}>New biome</button>}>
    <Seed value={bio.seed} set={(v) => setter('biomes')('seed', v)} />
    <Fields fields={[b('enabled', 'Biomes'), n('size', 'Biome size (m)', 40, 3000, 10), n('temperature', 'Temperature shift', -1, 1), n('moisture', 'Moisture shift', -1, 1), n('transition', 'Transition blending', 0.01, 0.6)]} value={bio} set={setter('biomes')} path="biomes" />
    {bio.custom.map((k, i) => <div className="wc-sub" key={k.id}>
      <Fields fields={[{ k: 'name', l: 'Name', t: 'txt' }, n('temperature', 'Temperature', 0, 1), n('moisture', 'Moisture', 0, 1), c('ground', 'Ground material'), n('density', 'Plant density', 0, 2)]} value={k} set={(f, v, q) => wc.mutate('Biome', (d) => { (d.config.biomes.custom[i] as any)[f] = v; }, q)} />
      <button className="wc-btn small" onClick={() => wc.mutate('Delete biome', (d) => { d.config.biomes.custom.splice(i, 1); })}>Delete</button>
    </div>)}
    <Hint>Scatter layers can be limited to biomes. Paint biome boundaries with the Biome brush in Sculpt &amp; Paint.</Hint>
  </Section>;
}

function WaterPanel() {
  const w = useWC((st) => st.doc!.config.water);
  return <>
    <Section title="Sea and lakes"><Fields fields={[b('enabled', 'Water'), n('level', 'Water level (m)', -50, 200, 0.5), n('waves', 'Wave intensity', 0, 2), n('waveDirection', 'Wave direction (°)', 0, 360, 5), n('waveSpeed', 'Wave speed', 0, 4), c('color', 'Colour'), n('opacity', 'Opacity', 5, 100, 1), b('foam', 'Foam'), n('foamWidth', 'Foam width (m)', 0.05, 5, 0.05), c('deepColor', 'Deep colour'), n('clarity', 'Depth to deep colour (m)', 0, 40, 0.5), n('detail', 'Fine ripples', 0, 2), n('highlights', 'Highlights', 0, 3), n('turbulence', 'Turbulence', 0, 1), num('waveSeed', 'Wave seed'), n('lakes', 'Lakes', 0, 12, 1)]} value={{ foamWidth: 0.9, deepColor: '#0b3a66', clarity: 7, detail: 1, highlights: 1.2, turbulence: 0.15, waveSeed: 0, ...w }} set={setter('water')} path="water" /><Hint>This is GameCraft's water: the same shader and the same options, sent across on export.</Hint></Section>
    <Section title="Rivers"><Seed value={w.riverSeed} set={(v) => setter('water')('riverSeed', v)} /><Fields fields={[n('rivers', 'Rivers', 0, 12, 1), n('riverWidth', 'Width (m)', 1, 40, 0.5), n('riverDepth', 'Depth (m)', 0.2, 12, 0.1), n('meander', 'Meander', 0, 1), n('branching', 'Branching', 0, 1), b('waterfalls', 'Waterfalls', "Where a river drops steeply: ParticleCraft's Waterfall pouring over the lip and Waterfall mist at the foot.")]} value={{ ...w, waterfalls: w.waterfalls !== false }} set={setter('water')} path="water" /><Hint>Rivers start on high ground and run downhill in channels cut for them, with banks, so the water always sits in the land. One that doesn't reach the sea ends in a lake. Rivers, lakes and sea are the same water. In an endless world rivers stay within 800 m of the origin.</Hint></Section>
  </>;
}

function RoadsPanel({ brush, setBrush, draft, finish, cancel }: { brush: BrushCfg; setBrush: (p: Partial<BrushCfg>) => void; draft: number; finish: () => void; cancel: () => void }) {
  const roads = useWC((st) => st.doc!.roads);
  return <>
    <Section title="Draw a road">
      <Row label="Type"><select value={brush.roadKind} onChange={(e) => setBrush({ roadKind: e.target.value })}>{Object.keys(ROAD_KINDS).map((k) => <option key={k}>{k}</option>)}</select></Row>
      <div className="wc-tools"><button className={brush.tool === 'road' ? 'on' : ''} onClick={() => setBrush({ tool: brush.tool === 'road' ? 'orbit' : 'road' })}>{brush.tool === 'road' ? 'Drawing: click the terrain' : 'Start drawing'}</button>{draft > 0 && <><button onClick={finish}>Finish ({draft})</button><button onClick={cancel}>Cancel</button></>}</div>
    </Section>
    {roads.map((r, i) => <Section key={r.id} title={`${r.kind} (${r.points.length} points)`} right={<button className="wc-btn small" onClick={() => wc.mutate('Delete road', (d) => { d.roads.splice(i, 1); })}>Delete</button>}>
      <Row label="Surface"><select value={r.kind} onChange={(e) => wc.mutate('Road surface', (d) => { d.roads[i].kind = e.target.value; })}>{Object.keys(ROAD_KINDS).map((k) => <option key={k}>{k}</option>)}</select></Row>
      <Row label="In snow" tip="Ploughed: cleared, with banks of snow pushed up along its sides and a few clumps left on it. Covered: under the snow, with packed tyre tracks"><select value={r.snow ?? 'ploughed'} onChange={(e) => wc.mutate('Road in snow', (d) => { d.roads[i].snow = e.target.value as 'ploughed' | 'covered'; })}><option value="ploughed">Ploughed (snow banks)</option><option value="covered">Snow-covered (tracks)</option></select></Row>
      <Row label="Look" tip="Realistic: a detailed surface lying in the land's shape, edges blending into the ground. Stylized: the cartoon walkway"><select value={r.look ?? ''} onChange={(e) => wc.mutate('Road look', (d) => { const v = e.target.value as 'realistic' | 'stylized' | ''; if (v) d.roads[i].look = v; else delete d.roads[i].look; })}><option value="">The world's look</option><option value="realistic">Realistic</option><option value="stylized">Stylized</option></select></Row>
      <Fields fields={[n('width', 'Width (m)', 0.5, 30, 0.5), n('conform', 'Grade the ground', 0, 1, 0.01, '0: lies on the ground as it is. 1: smooths the ground into a road bed, cutting hills.')]} value={r} set={(k, v, q) => wc.mutate('Road', (d) => { (d.roads[i] as any)[k] = v; }, q)} />
    </Section>)}
  </>;
}

const SNOW_FIELDS: Field[] = [b('enabled', 'Snow'), n('coverage', 'Coverage', 0, 1), n('thickness', 'Depth (m)', 0, 1.5, 0.01, 'How deep the snow lies: the ground rises under it, objects wear a layer this thick on their tops, and walking pushes through it.'), n('startHeight', 'From height (m)', -100, 400, 1), n('blendHeight', 'Blend (m)', 0.5, 100, 0.5), n('peaks', 'Heavier on peaks', 0, 1, 0.01), n('temperature', 'Cold places hold snow', 0, 1, 0.01, 'With biomes on: snow lower down where the climate is cold.'), n('aspect', 'More on shaded slopes', 0, 1, 0.01, 'Slopes facing away from the sun keep more.'), n('maxSlope', 'Steepest slope', 0, 1), n('variation', 'Patchiness / drifts', 0, 1), c('color', 'Colour'), n('onObjects', 'On objects', 0, 1, 0.01, 'A thick layer on the upward faces of rocks, trunks and branches, rounding over their edges; leaves frosted.'), n('icicles', 'Icicles on trees', 0, 1, 0.01, 'Icicles hanging under the branches of generated, edited and drawn trees: more and longer as this goes up.'), n('fall', 'Snowfall', 0, 1)];
const SNOW_RUNTIME: Field[] = [b('footprints', 'Footprints'), n('footprintDepth', 'Footprint depth (m)', 0, 0.5), n('footprintSize', 'Footprint size (m)', 0.05, 2), n('trackLife', 'Track life (s, 0 = keep)', 0, 600, 1), n('recovery', 'Recovery speed', 0, 2), n('resistance', 'Deep snow slows by', 0, 1)];
function SnowPanel() {
  const v = useWC((st) => st.doc!.config.snow);
  return <>
    <Section title="SnowCraft"><Seed value={v.seed} set={(x) => setter('snow')('seed', x)} /><Fields fields={SNOW_FIELDS} value={{ peaks: 0.6, temperature: 0.6, aspect: 0.5, ...v }} set={setter('snow')} path="snow" /></Section>
    <Section title="Footprints and walking through snow"><Fields fields={SNOW_RUNTIME} value={v} set={setter('snow')} path="snow" /><Hint>World › Walk: your footprints press into the snow, left and right, and in deep snow you plough a trench, sink in and slow down. Tracks fill in again over their life. Saved and exported with the world; GameCraft doesn't play footprints yet.</Hint></Section>
  </>;
}

function SeasonsPanel() {
  const v = useWC((st) => st.doc!.config.season);
  return <>
    <Section title="Seasonal foliage">
      <Fields fields={[b('enabled', 'Seasonal colours'), s('season', 'Season', ['spring', 'summer', 'autumn', 'winter']), s('next', 'Blending toward', ['spring', 'summer', 'autumn', 'winter']), n('blend', 'Blend', 0, 1), n('speed', 'Seasons per minute (0 = hold)', 0, 6, 0.1), n('intensity', 'Colour intensity', 0, 1), n('preserve', 'Original colour kept', 0, 1), n('brightness', 'Brightness', 0, 2), n('saturation', 'Saturation', 0, 2), n('hue', 'Hue', -1, 1)]} value={v} set={setter('season')} path="season" />
      <div className="wc-pal">{SEASON_PALETTES[v.season].map((h) => <i key={h} style={{ background: h }} />)}</div>
      <Seed value={v.seed} set={(x) => setter('season')('seed', x)} />
      <Fields fields={[b('treeLeaves', 'Tree leaves'), b('grass', 'Grass'), b('bushes', 'Bushes'), b('flowers', 'Flowers')]} value={v} set={setter('season')} path="season" />
      <Hint>Only colours change, in the shader. Assets are never replaced or altered: turn this off and they look as they did. Snow is a separate system (Snow).</Hint>
    </Section>
    <Section title="World Ecosystem">
      <Hint>Connects season to leaf browning, snow and snowfall with ordinary bricks. Change the season in the first brick and the rest follows.</Hint>
      <button className="wc-btn" onClick={() => wc.mutate('World Ecosystem preset', (d) => { d.logic.sheets[0].events = ecosystemEvents(); })}>Load into the logic</button>
    </Section>
  </>;
}

function WeatherPanel() {
  const w = useWC((st) => st.doc!.config.weather), sky = useWC((st) => st.doc!.config.sky);
  return <>
    <Section title="Weather"><Fields fields={[s('type', 'Weather', ['clear', 'rain', 'snow', 'fog', 'storm', 'dust', 'mist']), n('intensity', 'Intensity', 0, 1), n('fog', 'Fog density', 0, 1), n('clouds', 'Cloud coverage', 0, 1)]} value={w} set={setter('weather')} path="weather" />
      <Row label="Rain / snow" tip="SpriteCraft's weather presets: drops in three depths, streaks slanted by the wind, pixel flakes that sway, splashes"><select value={w.fallPreset ?? ''} onChange={(e) => wc.mutate('Weather preset', (d) => { const p = FALL_PRESETS.find((x) => x.name === e.target.value); d.config.weather.fallPreset = e.target.value || undefined; if (p) d.config.weather.type = p.kind === 'rain' ? (p.name === 'Storm' ? 'storm' : 'rain') : p.kind === 'snow' ? 'snow' : 'dust'; })}><option value="">The weather's own</option>{FALL_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}</select></Row>
      <Fields fields={[b('splashes', 'Splashes where rain lands')]} value={{ splashes: true, ...w }} set={setter('weather')} path="weather" />
      <Fields fields={[b('leaves', 'Falling leaves', "ParticleCraft's falling leaves drifting down under the trees near the camera, in the world's look (blown sideways in a strong wind; more in autumn)."), ...(w.leaves ? [n('leafAmount', 'How many leaves', 0.1, 3, 0.05)] : [])]} value={{ leaves: false, leafAmount: 1, ...w }} set={setter('weather')} path="weather" />
      <Hint>Rain and snow are SpriteCraft's: its presets, depth layers and pixel flakes.</Hint>
    </Section>
    <Section title="Clouds"><Fields fields={[n('clouds', 'Coverage', 0, 1), s('cloudKind', 'Shapes', ['mixed', 'cumulus', 'stratus', 'cirrus', 'towering'], { mixed: 'Mixed by region', cumulus: 'Heaped (cumulus)', stratus: 'Flat sheets (stratus)', cirrus: 'Thin streaks (cirrus)', towering: 'Tall towers' }), n('cloudVariety', 'Variety', 0, 1, 0.01, 'How much clouds differ across the sky: size, height and how full.'), num('cloudSeed', 'Cloud seed'), s('cloudStyle', 'Drawn as', ['both', 'volumetric', 'particles']), n('cloudHeight', 'Height above peaks (m)', 0, 400, 1), n('cloudThickness', 'Thickness ×', 0.2, 4), n('cloudSize', 'Cloud size ×', 0.2, 4), n('cloudDensity', 'Density', 0.1, 2), n('cloudSteps', 'Quality (steps)', 8, 64, 1, 'More is finer and slower.'), n('cloudPuffs', 'Fog particles (thousands)', 1, 30, 1)]} value={{ cloudKind: 'mixed', cloudVariety: 0.7, cloudSeed: 0, cloudStyle: 'both', cloudHeight: 8, cloudThickness: 1, cloudSize: 1, cloudDensity: 1, cloudSteps: 28, cloudPuffs: 8, ...w }} set={setter('weather')} path="weather" /><Hint>A real volume lit through itself, with thousands of your fog particles softening it. Both travel to GameCraft.</Hint></Section>
    <Section title="Wind and swaying"><Fields fields={[n('windDirection', 'Wind direction (°)', 0, 360, 5), n('windSpeed', 'Wind speed', 0, 20, 0.5), n('windStrength', 'Wind strength', 0, 3), n('gusts', 'Gust intensity', 0, 1), b('sway', 'Leaf swaying'), b('grassSway', 'Grass swaying'), n('swayAmount', 'Sway amount', 0, 3)]} value={w} set={setter('weather')} path="weather" /></Section>
    <Section title="Time of day"><Fields fields={[n('time', 'Hour', 0, 24, 0.25), n('sunStrength', 'Sun strength', 0, 8, 0.1), n('ambient', 'Ambient', 0, 2), b('stars', 'Stars')]} value={sky} set={setter('sky')} path="sky" /></Section>
  </>;
}

const SPAWN_FIELDS: Field[] = [b('enabled', 'Enabled'), s('mode', 'Where', ['fixed', 'region', 'scatter'], { fixed: 'Exact coordinates', region: 'Inside a region', scatter: 'Anywhere that fits' }), n('cell', 'One attempt every (m)', 8, 800, 4), n('chance', 'Chance', 0, 1), n('minDistance', 'Min distance (m)', 0, 600, 1), num('minHeight', 'Min height (m)'), num('maxHeight', 'Max height (m)'), n('maxSlope', 'Steepest slope', 0, 1), b('randomRotation', 'Random rotation'), n('fixedRotation', 'Rotation (°)', 0, 360, 5), n('scale', 'Scale', 0.1, 10, 0.1), b('persistent', 'Keep changes (destroyed stays destroyed)')];
function StructuresPanel() {
  const spawns = useWC((st) => st.doc!.config.spawns);
  const allAssets = useWC((st) => st.doc!.assets);
  const [id, setId] = useFocus('');
  const sp = spawns.find((x) => x.id === id) ?? spawns[0];
  // Everything imported, and library models ticked from the Preview.
  const assets = [...allAssets.filter((a) => a.kind === 'model').map((a) => ({ id: a.id, name: a.name })), ...(sp?.assets ?? []).filter((a) => !allAssets.some((x) => x.id === a)).map((a) => ({ id: a, name: fileName(a) }))];
  const PRESETS = ['Forest Cabins', 'Mountain Cabins', 'Small Village', 'Abandoned Buildings', 'Watchtowers', 'Ruined Structures', 'Farm Buildings'];
  const add = (name: string, over: Partial<StructureSpawn> = {}) => wc.mutate('New structure set', (d) => {
    const nid = 's_' + Date.now().toString(36);
    d.config.spawns.push({ id: nid, name, enabled: true, seed: randomSeed(), assets: [], mode: 'scatter', fixed: [], region: { x: 0, z: 0, w: 400, d: 400 }, cell: 80, chance: 0.5, minDistance: 40, minHeight: -1000, maxHeight: 10000, maxSlope: 0.15, biomes: [], fixedRotation: 0, randomRotation: true, scale: 1, persistent: true, ...over });
    setId(nid);
  });
  const edit = (fn: (x: StructureSpawn) => void, q?: boolean) => wc.mutate('Structure set', (d) => { fn(d.config.spawns.find((x) => x.id === sp.id)!); }, q);
  const OVER: Record<string, Partial<StructureSpawn>> = { 'Forest Cabins': { biomes: ['forest'], cell: 90, chance: 0.5 }, 'Mountain Cabins': { biomes: ['rocky', 'tundra'], cell: 120, chance: 0.4, maxSlope: 0.25 }, 'Small Village': { mode: 'region', cell: 24, chance: 0.8, minDistance: 22, region: { x: 0, z: 0, w: 120, d: 120 } }, 'Abandoned Buildings': { cell: 200, chance: 0.35 }, Watchtowers: { cell: 260, chance: 0.5, minDistance: 200 }, 'Ruined Structures': { cell: 160, chance: 0.4 }, 'Farm Buildings': { biomes: ['grassland'], cell: 110, chance: 0.5 } };
  return <>
    <Section title="Structure spawning">
      <Hint>Your own imported buildings, standing in the same places for a seed in finite and endless worlds. Nothing is modelled.</Hint>
      <div className="wc-list">{spawns.map((x) => <button key={x.id} className={x.id === sp?.id ? 'on' : ''} onClick={() => setId(x.id)}><span>{x.name}</span><em>{x.assets.length} assets</em></button>)}</div>
      <Row label="New set"><select value="" onChange={(e) => e.target.value && add(e.target.value, OVER[e.target.value])}><option value="">Choose a preset…</option>{PRESETS.map((p) => <option key={p}>{p}</option>)}</select></Row>
    </Section>
    {sp && <Section title={sp.name} right={<button className="wc-btn small" onClick={() => wc.mutate('Delete set', (d) => { d.config.spawns = d.config.spawns.filter((x) => x.id !== sp.id); })}>Delete</button>}>
      <Seed value={sp.seed} set={(v) => edit((x) => { x.seed = v; })} />
      <Fields fields={SPAWN_FIELDS} value={sp} set={(k, v, q) => edit((x) => { (x as any)[k] = v; }, q)} path={`spawn:${sp.id}`} />
      <Row label="Biomes (none = all)"><input type="text" value={sp.biomes.join(', ')} onChange={(e) => edit((x) => { x.biomes = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); })} /></Row>
      {sp.mode === 'region' && <Fields fields={[num('x', 'Region X'), num('z', 'Region Z'), num('w', 'Width', 10), num('d', 'Depth', 10)]} value={sp.region} set={(k, v) => edit((x) => { (x.region as any)[k] = v; })} />}
      {sp.mode === 'fixed' && <div className="wc-sources"><b>Exact spots</b>{sp.fixed.map((f, i) => <div key={i}><span>{f.x}, {f.z}, {f.ry}°</span><button onClick={() => edit((x) => { x.fixed.splice(i, 1); })}>✕</button></div>)}<FixedAdd add={(x, z, ry) => edit((y) => { y.fixed.push({ x, z, ry }); })} /></div>}
      <div className="wc-sources"><b>Spawnable structures</b>{assets.length === 0 && <Hint>Nothing imported yet. Import your models here, then tick the ones this set may spawn.</Hint>}{assets.map((a) => <label key={a.id} className="wc-check"><input type="checkbox" checked={sp.assets.includes(a.id)} onChange={(e) => edit((x) => { x.assets = e.target.checked ? [...x.assets, a.id] : x.assets.filter((q) => q !== a.id); })} />{a.name}</label>)}
        <label className="wc-btn small">Import models…<input type="file" multiple accept=".glb,.gltf,.fbx,.obj,.blend" style={{ display: 'none' }} onChange={async (e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; for (const f of files) { const id = await importModelFile(f); if (id) edit((x) => { if (!x.assets.includes(id)) x.assets = [...x.assets, id]; }); } }} /></label>
      </div>
    </Section>}
  </>;
}
/** Brings a model into the world's project and returns its id. */
async function importModelFile(f: File) {
  const doc = wc.get().doc; if (!doc) return null;
  const rel = `imported/${f.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`, id = 'proj:' + rel;
  await api.putFile(doc.id, rel, await f.arrayBuffer());
  wc.mutate('Imported ' + f.name, (d) => { if (!d.assets.some((a) => a.id === id)) d.assets.push({ id, name: f.name.replace(/\.[^.]+$/, ''), kind: 'model', group: 'imported', tags: [] }); });
  return id;
}
function FixedAdd({ add }: { add: (x: number, z: number, ry: number) => void }) {
  const [x, setX] = useState(0), [z, setZ] = useState(0), [ry, setRy] = useState(0);
  return <span className="wc-seed"><input type="number" placeholder="X" value={x} onChange={(e) => setX(Number(e.target.value))} /><input type="number" placeholder="Z" value={z} onChange={(e) => setZ(Number(e.target.value))} /><input type="number" placeholder="°" value={ry} onChange={(e) => setRy(Number(e.target.value))} /><button onClick={() => add(x, z, ry)}>Add</button></span>;
}

function CavesPanel() {
  const v = useWC((st) => st.doc!.config.cave), vx = useWC((st) => st.doc!.config.voxel);
  return <>
    <Section title="Cave generator"><Seed value={v.seed} set={(x) => setter('cave')('seed', x)} /><Fields fields={[b('enabled', 'Caves'), s('style', 'Walls', ['smooth', 'voxel'], { smooth: 'Smooth rock', voxel: 'Blocks (voxels)' }), n('tunnels', 'Tunnels per area', 0, 20, 1), n('entrances', 'Openings at the surface', 0, 1), n('y', 'Shallowest (m below ground)', 2, 60, 1), n('depth', 'Deepest (m below ground)', 6, 150, 1), n('size', 'Tunnel length (m)', 20, 300, 1), n('tunnelWidth', 'Tunnel width (m)', 1.5, 16, 0.5), n('chamber', 'Chamber size (m)', 3, 40, 0.5), n('branching', 'Branching and chambers', 0, 1), n('roughness', 'Wall roughness', 0, 1), n('stalactites', 'Stalactites', 0, 1), n('voxel', 'Detail size (m)', 0.6, 4, 0.1)]} value={{ style: 'smooth', depth: 36, entrances: 0.3, ...v }} set={setter('cave')} path="cave" /><Hint>Winding tunnels under the whole world, like Minecraft's: a few in every 96 m square, always below the ground above them, some opening at the surface. Look into an opening, or walk in (Test, Walk). Only the caves near the camera are built.</Hint></Section>
    <Section title="Voxel remesh"><Fields fields={[b('enabled', 'Voxel Remesh'), n('size', 'Voxel size (m)', 0.25, 8, 0.25), b('smooth', 'Smooth shading'), s('target', 'Applies to', ['terrain'], { terrain: 'Terrain' })]} value={vx} set={setter('voxel')} path="voxel" /><Hint>The terrain settings aren't changed: turn this off to go back.</Hint></Section>
  </>;
}

/** Low to Ultra, or Auto. Kept per computer, not in the world. */
export function QualityPicker() {
  const q = useWC((st) => st.quality);
  return <select value={q} title="Drawing quality on this computer" onChange={(e) => wc.set({ quality: e.target.value as any })}>{['auto', 'low', 'medium', 'high', 'ultra'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select>;
}

function OptimizePanel({ stats }: { stats: any }) {
  const o = useWC((st) => st.doc!.config.optimize);
  return <>
    <Section title="Quality on this computer">
      <Row label="Quality" tip="How WorldCraft draws here: pixels, shadows, clouds, water and draw distance. Doesn't change your world or what gets exported"><QualityPicker /></Row>
      <Hint>Auto starts at High and steps down if the frame rate stays low. World optimizer below changes the world's own detail and is saved with it.</Hint>
    </Section>
    <Section title="World optimizer">
      <Fields fields={[b('frustum', 'Don\'t draw what\'s out of view', 'GameCraft\'s culling: anything outside what the camera sees isn\'t drawn. Shadows from it still fall into view.')]} value={{ frustum: true, ...o }} set={setter('optimize')} path="optimize" />
      <Row label="Profile"><select value={o.profile} onChange={(e) => wc.mutate('Profile', (d) => { const p = OPTIMIZE_PROFILES[e.target.value]; d.config.optimize.profile = e.target.value as any; Object.assign(d.config.optimize, { lodDistance: p.lodDistance, cull: p.cull, grassDistance: p.grassDistance, impostors: p.impostors }); })}>{['high', 'balanced', 'performance', 'mobile', 'openworld'].map((p) => <option key={p}>{p}</option>)}</select></Row>
      <Fields fields={[n('lodDistance', 'Full detail up to (m)', 20, 800, 5), n('cull', 'Objects drawn up to (m)', 60, 3000, 10), n('grassDistance', 'Grass drawn up to (m)', 10, 400, 5)]} value={o} set={setter('optimize')} path="optimize" />
    </Section>
    <Section title="Now in view">
      {stats ? <table className="wc-stats"><tbody>
        <tr><td>Frame rate</td><td>{stats.fps} fps</td></tr><tr><td>Chunks</td><td>{stats.chunks}{stats.building ? ` (${stats.building} to build)` : ''}</td></tr>
        <tr><td>Terrain triangles</td><td>{stats.terrainTriangles.toLocaleString()}</td></tr><tr><td>Objects</td><td>{stats.objects.toLocaleString()}</td></tr>
        <tr><td>Instanced</td><td>{stats.instanced.toLocaleString()}</td></tr><tr><td>Object triangles</td><td>{stats.objectTriangles.toLocaleString()}</td></tr>
        <tr><td>Draw calls</td><td>{stats.drawCalls.toLocaleString()}</td></tr><tr><td>Geometry memory (estimate)</td><td>{stats.memoryMb} MB</td></tr>
      </tbody></table> : 'Building…'}
      <Hint>Further chunks use less detail and their trees a simpler model; every repeated object is instanced.</Hint>
    </Section>
  </>;
}

function ParticlesPanel() {
  const refs = useWC((st) => st.doc!.particles);
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => { api.exchangeList().then((l) => setFiles(l.map((x) => x.path).filter((p) => /\.vfx\.json$/i.test(p)))).catch(() => setFiles([])); }, []);
  const target = () => { const v = (window as any).__wc?.view; return v ? v.controls.target : { x: 0, y: 0, z: 0 }; };
  const place = (effect: string, name: string) => { const t = target(); wc.mutate('Place effect', (d) => { d.particles.push({ id: 'p_' + Date.now().toString(36), effect, name, x: t.x, y: t.y + 0.5, z: t.z, scale: 1 }); }); };
  const groups = [...new Set(BUILTIN_EFFECTS.map((x) => x.group))];
  return <Section title="Effects">
    <Row label="Built in" tip="ParticleCraft's presets (fire, smoke, magic, weather and more) and SpriteCraft's (fire, sparks, explosion...): no exporting needed"><select value="" onChange={(e) => { const x = BUILTIN_EFFECTS.find((q) => q.id === e.target.value); if (x) place(x.id, x.name); }}><option value="">Choose an effect…</option>{groups.map((g) => <optgroup key={g} label={g}>{BUILTIN_EFFECTS.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}{x.look && x.look !== 'stylized' ? ` (${x.look})` : ''}</option>)}</optgroup>)}</select></Row>
    <Row label="Your own"><select value="" onChange={(e) => { const f = e.target.value; if (f) place(f, f.replace(/\.vfx\.json$/i, '')); }}><option value="">{files.length ? 'From the exchange folder…' : 'None exported from ParticleCraft yet'}</option>{files.map((f) => <option key={f}>{f}</option>)}</select></Row>
    {refs.map((r, i) => <div className="wc-sub" key={r.id}><b>{r.name}</b><Fields fields={[num('x', 'X'), num('y', 'Y'), num('z', 'Z'), n('rotation', 'Rotation (°)', -180, 180, 1), n('scale', 'Scale', 0.1, 10, 0.1)]} value={{ rotation: 0, ...r }} set={(k, v, q) => wc.mutate('Effect', (d) => { (d.particles[i] as any)[k] = v; }, q)} /><label className="wc-check"><input type="checkbox" checked={r.wind !== false} onChange={(e) => wc.mutate('Effect wind', (d) => { d.particles[i].wind = e.target.checked; })} /> Follows the world's wind</label><button className="wc-btn small" onClick={() => wc.mutate('Remove effect', (d) => { d.particles.splice(i, 1); })}>Remove</button></div>)}
    <Hint>Effects are made in ParticleCraft (File › Export) and referenced here, saved with the world and exported to GameCraft. Placed effects play live in the view (turn, scale and the world's wind included) and in GameCraft.</Hint>
  </Section>;
}

const PRESET_SECTIONS: Record<string, keyof WorldConfig> = { Terrain: 'terrain', Biomes: 'biomes', Water: 'water', Weather: 'weather', Seasons: 'season', Snow: 'snow', 'Leaf Control': 'leaves', Caves: 'cave' };
const WORLD_PRESETS: Record<string, (c: WorldConfig) => void> = {
  'Voxel World': (c) => { c.voxel.enabled = true; c.voxel.size = 1; c.voxel.smooth = false; c.surface.greens = true; c.biomes.enabled = false; },
  'Lush Woodland': (c) => {
    // Soft light through a haze; many greens on the ground, grass that takes them up, shrubs and rocks between the trees.
    Object.assign(c.terrain, TERRAIN_PRESETS['Rolling landscape']);
    c.biomes.enabled = false; c.surface.greens = true; c.surface.greenAmount = 0.9; c.surface.greenScale = 22; c.surface.greenA = '#35682a'; c.surface.greenB = '#5c8f36'; c.surface.greenC = '#8ba548';
    c.weather.fog = 0.3; c.weather.clouds = 0.5; c.sky.time = 10;
    const shrub = TREE_PRESETS.find((t) => t.id === 'shrub'); if (shrub && !c.trees.some((t) => t.id === 'shrub')) c.trees.push(deepCopy(shrub));
    Object.assign(c.layers[0], { enabled: true, density: 0.3, sources: ['tree:oak', 'tree:birch', 'tree:maple'], randomColor: true, fallShare: 0.06, clustering: 0.5 });
    Object.assign(c.layers[1], { enabled: true, density: 0.5, clustering: 0.6 });
    Object.assign(c.layers[2], { enabled: true, density: 70, sources: ['lib:world/grass/RealisticGrass.fbx', 'lib:world/grass/Realistic_Grass_2.fbx'], copyGround: true, clustering: 0.25, maxSlope: 0.6, moves: true });
    if (!c.layers.some((l) => l.id === 'undergrowth')) c.layers.push(makeLayer({ id: 'undergrowth', name: 'Undergrowth', kind: 'bush', sources: ['tree:shrub'], density: 0.9, clustering: 0.7, clusterSize: 14, minScale: 0.6, maxScale: 1.5, maxSlope: 0.5, seed: 11 }));
  },
  'Dense Pine Forest': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Hills); c.layers[0].sources = ['tree:pine']; c.layers[0].density = 2.5; c.layers[0].biomes = []; c.biomes.enabled = false; },
  'Autumn Forest': (c) => { c.layers[0].sources = ['tree:maple', 'tree:oak']; c.layers[0].density = 2; c.season.enabled = true; c.season.season = 'autumn'; c.biomes.enabled = false; c.leaves.healthy = 10; c.leaves.yellow = 30; c.leaves.orange = 40; c.leaves.brown = 20; },
  'Tropical Island': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Island); c.water.level = 2; c.layers[0].sources = ['tree:palm']; c.layers[0].density = 0.8; c.biomes.temperature = 0.4; c.biomes.moisture = 0.4; c.biomes.enabled = false; },
  'Rocky Mountains': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Mountains); c.layers[0].sources = ['tree:pine']; c.layers[0].maxHeight = 60; c.layers[1].density = 1.2; c.snow.enabled = true; c.snow.startHeight = 70; c.biomes.temperature = -0.2; },
  'Desert Canyon': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Canyons); c.biomes.temperature = 0.8; c.biomes.moisture = -0.8; c.water.enabled = false; c.layers[0].sources = ['tree:dead']; c.layers[0].density = 0.05; c.layers[2].density = 3; },
  'Snowy Wilderness': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Hills); c.snow.enabled = true; c.snow.startHeight = -100; c.snow.fall = 0.5; c.season.enabled = true; c.season.season = 'winter'; c.layers[0].sources = ['tree:pine', 'tree:dead']; c.biomes.temperature = -0.6; c.weather.type = 'snow'; },
  'Fantasy Landscape': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS.Valleys); c.layers[0].sources = ['tree:fantasy']; c.layers[0].density = 0.5; c.surface.grass = '#6d5ca8'; c.biomes.enabled = false; c.sky.time = 18; },
  'Endless Grasslands': (c) => { Object.assign(c.terrain, TERRAIN_PRESETS['Rolling landscape'], { endless: true, viewChunks: 5 }); c.biomes.temperature = 0.1; c.biomes.moisture = -0.1; c.layers[0].density = 0.08; c.layers[2].density = 90; },
};

function PresetsPanel() {
  const presets = useWC((st) => st.doc!.presets);
  const [cat, setCat] = useState('Terrain');
  const [name, setName] = useState('');
  const section = PRESET_SECTIONS[cat];
  const saved = presets[cat] ?? {};
  return <>
    <Section title="World presets">
      <div className="wc-list">{Object.keys(WORLD_PRESETS).map((k) => <button key={k} onClick={() => wc.mutate('World preset: ' + k, (d) => { WORLD_PRESETS[k](d.config); })}><span>{k}</span></button>)}</div>
    </Section>
    <Section title="Saved settings">
      <Row label="Category"><select value={cat} onChange={(e) => setCat(e.target.value)}>{Object.keys(PRESET_SECTIONS).map((k) => <option key={k}>{k}</option>)}</select></Row>
      <span className="wc-seed"><input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><button disabled={!name} onClick={() => { wc.mutate('Save preset', (d) => { (d.presets[cat] ??= {})[name] = deepCopy(d.config[section]); }); setName(''); }}>Save</button></span>
      <div className="wc-list">{Object.keys(saved).map((k) => <div key={k} className="wc-preset"><button onClick={() => wc.mutate('Load preset ' + k, (d) => { (d.config as any)[section] = deepCopy((d.presets[cat] as any)[k]); })}>{k}</button><button onClick={() => wc.mutate('Delete preset', (d) => { delete (d.presets[cat] as any)[k]; })}>✕</button></div>)}</div>
      <Hint>Logic setups are saved with the Presets tab of the block editor below.</Hint>
    </Section>
  </>;
}

export function RightPanel({ panel, brush, setBrush, draft, finishRoad, cancelRoad, stats }: { panel: Panel; brush: BrushCfg; setBrush: (p: Partial<BrushCfg>) => void; draft: number; finishRoad: () => void; cancelRoad: () => void; stats: any }) {
  void effective;
  switch (panel) {
    case 'terrain': return <TerrainPanel />;
    case 'paint': return <PaintPanel brush={brush} setBrush={setBrush} />;
    case 'trees': return <TreesPanel />;
    case 'rocks': return <RocksPanel />;
    case 'scatter': return <ScatterPanel />;
    case 'biomes': return <BiomesPanel />;
    case 'water': return <WaterPanel />;
    case 'roads': return <RoadsPanel brush={brush} setBrush={setBrush} draft={draft} finish={finishRoad} cancel={cancelRoad} />;
    case 'snow': return <SnowPanel />;
    case 'seasons': return <SeasonsPanel />;
    case 'weather': return <WeatherPanel />;
    case 'structures': return <StructuresPanel />;
    case 'caves': return <CavesPanel />;
    case 'particles': return <ParticlesPanel />;
    case 'optimize': return <OptimizePanel stats={stats} />;
    case 'presets': return <PresetsPanel />;
    case 'export': return <ExportPanel />;
    default: return null;
  }
}
