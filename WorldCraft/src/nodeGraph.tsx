// The Node graph window: land built from connected nodes (see Shared/src/world/terrainGraph.ts), with a live 3D
// preview of the node you pick, and Apply to lay the Output into a finite world (heights, plus the look's colours and
// the erosion's data maps). Kept with the world, so it can be changed and applied again.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { defaultGraph, GraphEvaluator, graphOutputInfo, makesLoop, NODE_DEFS, newNode, type GraphNode, type NodeResult, type NodeType, type TerrainGraph } from '@shared/src/world/terrainGraph';
import { packGrid } from '@shared/src/world/terrain';
import type { EditGrid } from '@shared/src/world/document';
import { effective, useWC, wc } from './store';
import { Hint, Row, Section } from './ui';

const NODE_W = 170, HEAD = 24, PORT = 18;
const ADDABLE: NodeType[] = ['world', 'mountain', 'pattern', 'shape', 'combine', 'warp', 'adjust', 'terrace', 'erosion', 'mask', 'colorize', 'output'];
const KIND_COLOR = { height: '#8fb7ff', mask: '#d6d6d6', color: '#f0b45a' } as const;
const portY = (i: number) => HEAD + 8 + i * PORT + PORT / 2;

export function NodeGraphWindow({ onClose }: { onClose: () => void }) {
  const saved = useWC((st) => st.doc!.graph);
  const terrain = useWC((st) => st.doc!.config.terrain);
  const [g, setG] = useState<TerrainGraph>(() => saved ? JSON.parse(JSON.stringify(saved)) : defaultGraph());
  const [sel, setSel] = useState<string>(() => (saved ?? defaultGraph()).nodes.find((n) => n.type === 'output')?.id ?? '');
  const [pan, setPan] = useState<[number, number]>([20, 20]);
  const [drag, setDrag] = useState<{ from: string; port: string; x: number; y: number } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const evalRef = useRef(new GraphEvaluator(128));
  const canvas = useRef<HTMLDivElement>(null);
  const prevHost = useRef<HTMLDivElement>(null);
  const three = useRef<{ mesh: THREE.Mesh } | null>(null);

  // Kept with the world as you go (no undo step per change: Apply is the undoable part).
  useEffect(() => { const id = setTimeout(() => wc.touch((d) => { d.graph = JSON.parse(JSON.stringify(g)); }), 300); return () => clearTimeout(id); }, [g]);

  // ---- the 3D preview
  useEffect(() => {
    const el = prevHost.current!; const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio)); el.appendChild(r.domElement); Object.assign(r.domElement.style, { position: 'absolute', inset: '0' });
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#1a1d24');
    const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 50); cam.position.set(1.2, 1.1, 1.4);
    const ctl = new OrbitControls(cam, r.domElement); ctl.enableDamping = true; ctl.target.set(0, 0.05, 0);
    scene.add(new THREE.HemisphereLight('#c8d8ff', '#3a3226', 0.9));
    const sun = new THREE.DirectionalLight('#fff3e0', 2.2); sun.position.set(2, 2.5, 1); scene.add(sun);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    scene.add(mesh); three.current = { mesh };
    const size = () => { const w = el.clientWidth, h = el.clientHeight; r.setSize(w, h); cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); };
    size(); const ro = new ResizeObserver(size); ro.observe(el);
    let raf = 0; const loop = () => { raf = requestAnimationFrame(loop); ctl.update(); r.render(scene, cam); }; loop();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose(); mesh.geometry.dispose(); r.dispose(); el.removeChild(r.domElement); three.current = null; };
  }, []);

  // ---- work out the picked node (a moment after the last change) and show it
  useEffect(() => {
    let stop = false;
    const id = setTimeout(async () => {
      if (!sel) return;
      setBusy(0);
      evalRef.current.world = worldCtx();
      try {
        const res = await evalRef.current.run(g, sel, (f) => { setBusy(f); return !stop; });
        if (res && !stop) showPreview(res.node, res.out);
        setStatus('');
      } catch (e) { setStatus((e as Error).message === 'loop' ? 'These nodes feed into each other in a loop: remove one link.' : `Couldn't work this out: ${(e as Error).message}`); }
      setBusy(null);
    }, 150);
    return () => { stop = true; clearTimeout(id); };
  }, [g, sel]);

  function showPreview(node: GraphNode, out: NodeResult) {
    const t = three.current; if (!t) return;
    const N = evalRef.current.N;
    // What to draw: a height as land; a mask as a grey sheet; colours over the Output's land (or flat).
    const hgt = out.height ?? (out.mask ? null : null), mask = out.mask ?? out.flow ?? null, col = out.color ?? null;
    const geo = new THREE.PlaneGeometry(1.6, 1.6, N - 1, N - 1); geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute, colors = new Float32Array(N * N * 3);
    const hScale = node.type === 'output' ? 0.45 * Math.min(1, Number(node.params.height) / 200 + 0.3) : 0.4;
    for (let k = 0; k < N * N; k++) {
      const v = hgt ? hgt[k] : 0; pos.setY(k, v * hScale);
      let c: [number, number, number];
      if (col) c = [col[k * 3], col[k * 3 + 1], col[k * 3 + 2]];
      else if (!hgt && mask) c = [mask[k], mask[k], mask[k]];
      else { const a = v; c = a < 0.5 ? [0.33 + a * 0.3, 0.42 + a * 0.2, 0.28] : [0.48 + (a - 0.5) * 0.6, 0.52 + (a - 0.5) * 0.5, 0.45 + (a - 0.5) * 0.7]; }
      colors.set(c, k * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geo.computeVertexNormals();
    t.mesh.geometry.dispose(); t.mesh.geometry = geo;
  }

  /** The World terrain node's land: the terrain settings as the logic bricks leave them, over the world's square. */
  function worldCtx() { const c = effective(); if (!c) return undefined; const t = c.terrain; return { terrain: t, side: t.endless ? 1024 : Math.max(t.width, t.depth) }; }

  // ---- editing
  const node = g.nodes.find((n) => n.id === sel) ?? null;
  const setParam = (k: string, v: number | string) => setG((G) => ({ ...G, nodes: G.nodes.map((n) => n.id === sel ? { ...n, params: { ...n.params, [k]: v } } : n) }));
  const add = (type: NodeType) => {
    if (type === 'output' && g.nodes.some((n) => n.type === 'output')) { setStatus('There is one Output: it is what the graph makes.'); return; }
    const n = newNode(type, -pan[0] + 60 + Math.random() * 80, -pan[1] + 60 + Math.random() * 80);
    // (Building on the world's own land: the Output takes the same height range, so it comes back as it was.)
    const t = effective()?.terrain;
    const nodes = type === 'world' && t ? g.nodes.map((o) => o.type === 'output' ? { ...o, params: { ...o.params, base: t.baseHeight, height: t.height } } : o) : g.nodes;
    if (type === 'world' && t) setStatus(`The Output now uses the world's own range (${t.baseHeight} m, ${t.height} m tall), so the World terrain comes back as it is.`);
    setG({ ...g, nodes: [...nodes, n] }); setSel(n.id);
  };
  const remove = (id: string) => { setG({ nodes: g.nodes.filter((n) => n.id !== id), links: g.links.filter((l) => l.from !== id && l.to !== id) }); if (sel === id) setSel(''); };
  const link = (from: string, port: string, to: string, toPort: string) => {
    if (from === to) return;
    if (makesLoop(g, from, to)) { setStatus("That would make a loop: a node can't feed itself."); return; }
    setG({ ...g, links: [...g.links.filter((l) => !(l.to === to && l.toPort === toPort)), { from, fromPort: port, to, toPort }] });
  };

  // Dragging a node, the canvas, or a new link.
  const moving = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onDownNode = (e: React.PointerEvent, n: GraphNode) => { e.stopPropagation(); setSel(n.id); moving.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }; };
  const onDownCanvas = (e: React.PointerEvent) => { moving.current = { id: null, sx: e.clientX, sy: e.clientY, ox: pan[0], oy: pan[1] }; };
  const onMove = (e: React.PointerEvent) => {
    const m = moving.current;
    if (m) { const dx = e.clientX - m.sx, dy = e.clientY - m.sy; if (m.id) setG((G) => ({ ...G, nodes: G.nodes.map((n) => n.id === m.id ? { ...n, x: m.ox + dx, y: m.oy + dy } : n) })); else setPan([m.ox + dx, m.oy + dy]); }
    if (drag) { const b = canvas.current!.getBoundingClientRect(); setDrag({ ...drag, x: e.clientX - b.left - pan[0], y: e.clientY - b.top - pan[1] }); }
  };
  const onUp = () => { moving.current = null; setDrag(null); };

  const outPos = (n: GraphNode, port: string) => { const i = NODE_DEFS[n.type].outputs.findIndex((o) => o.port === port); return [n.x + NODE_W, n.y + portY(Math.max(0, i))]; };
  const inPos = (n: GraphNode, port: string) => { const i = NODE_DEFS[n.type].inputs.findIndex((o) => o.port === port); return [n.x, n.y + portY(Math.max(0, i))]; };
  const curve = (a: number[], b: number[]) => { const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5); return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`; };

  // ---- apply to the world
  const apply = async () => {
    const doc = wc.get().doc, v = (window as any).__wc?.view; if (!doc || !v) return;
    const t = doc.config.terrain;
    if (t.endless) { setStatus('Apply is for finite worlds: the graph works the whole land out at once. (Endless worlds: use the Terrain settings and terrain bricks.)'); return; }
    const out = g.nodes.find((n) => n.type === 'output'); if (!out) { setStatus('Add an Output node and connect the land into it.'); return; }
    const cell = doc.edits.cell, ax = Math.round(-t.width / 2 / cell), az = Math.round(-t.depth / 2 / cell), nx = Math.round(t.width / cell) + 1, nz = Math.round(t.depth / cell) + 1;
    const N = Math.min(1025, Math.max(nx, nz));
    setStatus(`Working out the land at ${N} × ${N}…`); setBusy(0);
    const ev = new GraphEvaluator(N, worldCtx());
    let res: Awaited<ReturnType<GraphEvaluator['run']>>;
    try { res = await ev.run(g, out.id, (f) => { setBusy(f); }); } catch (e) { setBusy(null); setStatus(`Couldn't work it out: ${(e as Error).message}`); return; }
    setBusy(null); if (!res) return;
    const info = graphOutputInfo(g), H = res.out.height, side = Math.max(t.width, t.depth);
    // Stored as the land itself (not a change to what the terrain settings make), so logic bricks that change the
    // terrain later don't bend it; rivers, roads and hand sculpting still apply on top.
    const at = (a: Float32Array, x: number, z: number) => { const u = Math.max(0, Math.min(N - 1.001, ((x + side / 2) / side) * (N - 1))), w = Math.max(0, Math.min(N - 1.001, ((z + side / 2) / side) * (N - 1))), i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j, k = j * N + i; return (a[k] * (1 - fu) + a[k + 1] * fu) * (1 - fw) + (a[k + N] * (1 - fu) + a[k + N + 1] * fu) * fw; };
    const M = nx * nz, hgt = new Int16Array(M), maps: Record<string, Uint8Array> = {};
    for (const k of ['flow', 'wear', 'deposit']) if (res.out[k]) maps[k] = new Uint8Array(M);
    let clipped = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = (ax + i) * cell, z = (az + j) * cell, q = j * nx + i;
      const want = info.base + at(H, x, z) * info.height;
      if (Math.abs(want) > 1638) clipped++;
      hgt[q] = Math.round(Math.max(-1638, Math.min(1638, want)) * 20);
      for (const k of Object.keys(maps)) maps[k][q] = Math.round(255 * Math.min(1, Math.max(0, at(res.out[k], x, z))));
    }
    wc.mutate('Applied the node graph', (d) => {
      const grid: EditGrid = { id: 'eg_' + Date.now().toString(36), label: 'Node graph', x0: ax * cell, z0: az * cell, nx, nz, cell, height: packGrid(hgt), absolute: true };
      if (Object.keys(maps).length) grid.maps = Object.fromEntries(Object.entries(maps).map(([k, a]) => [k, packGrid(a)]));
      d.edits.grids = [...(d.edits.grids ?? []).filter((x) => x.label !== 'Node graph'), grid];
      if (info.palette) d.config.surface.look = { palette: info.palette, strength: info.strength };
      d.graph = JSON.parse(JSON.stringify(g));
    });
    setTimeout(() => { v.refreshHeight(); v.editedAll(); }, 80);
    setStatus(`Applied to the world.${clipped ? ` (${clipped} points were beyond ±1638 m and were capped.)` : ''}${(effective()?.terrain.graphBlend ?? 1) < 1 ? ` A "Node graph land" brick shows only ${Math.round((effective()!.terrain.graphBlend ?? 1) * 100)}% of it.` : ''}`);
  };
  const applied = useWC((st) => (st.doc!.edits.grids ?? []).some((x) => x.label === 'Node graph'));
  const removeFromWorld = () => { wc.mutate('Removed the node graph from the world', (d) => { d.edits.grids = (d.edits.grids ?? []).filter((x) => x.label !== 'Node graph'); }); const v = (window as any).__wc?.view; setTimeout(() => { v?.refreshHeight(); v?.editedAll(); }, 80); setStatus('Removed from the world (the graph is kept here).'); };

  const def = node ? NODE_DEFS[node.type] : null;
  const linksSvg = useMemo(() => g.links.map((l, i) => {
    const a = g.nodes.find((n) => n.id === l.from), b = g.nodes.find((n) => n.id === l.to); if (!a || !b) return null;
    const kind = NODE_DEFS[a.type].outputs.find((o) => o.port === l.fromPort)?.kind ?? 'height';
    return <path key={i} d={curve(outPos(a, l.fromPort), inPos(b, l.toPort))} stroke={KIND_COLOR[kind]} strokeWidth={2.2} fill="none" style={{ cursor: 'pointer', pointerEvents: 'stroke' }} onClick={() => setG({ ...g, links: g.links.filter((_, j) => j !== i) })}><title>Click to remove this link</title></path>;
  }), [g]);

  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', background: '#14161b', color: '#e3e6ec', font: '12px system-ui' }} onPointerMove={onMove} onPointerUp={onUp}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="wc-tools" style={{ padding: '6px 8px', borderBottom: '1px solid #2a2e37', flexWrap: 'wrap' }}>
        <span style={{ alignSelf: 'center', marginRight: 6, opacity: 0.8 }}>Add:</span>
        {ADDABLE.map((t) => <button key={t} title={NODE_DEFS[t].tip} onClick={() => add(t)}>{NODE_DEFS[t].name}</button>)}
      </div>
      <div ref={canvas} onPointerDown={onDownCanvas} style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: moving.current && !moving.current.id ? 'grabbing' : 'default', backgroundImage: 'radial-gradient(#2a2e37 1px, transparent 1px)', backgroundSize: '22px 22px', backgroundPosition: `${pan[0]}px ${pan[1]}px` }}>
        <div style={{ position: 'absolute', left: pan[0], top: pan[1] }}>
          <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', width: 1, height: 1 }}>
            {linksSvg}
            {drag && (() => { const a = g.nodes.find((n) => n.id === drag.from); return a ? <path d={curve(outPos(a, drag.port), [drag.x, drag.y])} stroke="#fff" strokeDasharray="4 3" strokeWidth={2} fill="none" /> : null; })()}
          </svg>
          {g.nodes.map((n) => {
            const d = NODE_DEFS[n.type], rows = Math.max(d.inputs.length, d.outputs.length, 1);
            return <div key={n.id} onPointerDown={(e) => onDownNode(e, n)} style={{ position: 'absolute', left: n.x, top: n.y, width: NODE_W, height: HEAD + 16 + rows * PORT, background: '#232731', border: `1px solid ${sel === n.id ? '#6aa0ff' : '#3a3f4b'}`, borderRadius: 6, boxShadow: '0 2px 8px #0006', userSelect: 'none' }}>
              <div style={{ height: HEAD, lineHeight: `${HEAD}px`, padding: '0 8px', background: n.type === 'output' ? '#3a2f52' : '#2c3240', borderRadius: '6px 6px 0 0', display: 'flex', justifyContent: 'space-between' }} title={d.tip}>
                <b>{d.name}</b>{n.type !== 'output' && <span style={{ cursor: 'pointer', opacity: 0.7 }} title="Delete this node" onPointerDown={(e) => { e.stopPropagation(); remove(n.id); }}>×</span>}
              </div>
              {d.inputs.map((p, i) => <div key={p.port} style={{ position: 'absolute', left: 0, top: portY(i) - PORT / 2, height: PORT, display: 'flex', alignItems: 'center' }}
                onPointerUp={(e) => { if (drag) { e.stopPropagation(); link(drag.from, drag.port, n.id, p.port); setDrag(null); } }}>
                <span title={`${p.label} (click to unlink)`} onPointerDown={(e) => { e.stopPropagation(); setG({ ...g, links: g.links.filter((l) => !(l.to === n.id && l.toPort === p.port)) }); }} style={{ width: 10, height: 10, borderRadius: 5, marginLeft: -5, background: g.links.some((l) => l.to === n.id && l.toPort === p.port) ? KIND_COLOR[p.kind] : '#14161b', border: `2px solid ${KIND_COLOR[p.kind]}`, cursor: 'pointer' }} />
                <span style={{ marginLeft: 5, opacity: 0.85 }}>{p.label}</span>
              </div>)}
              {d.outputs.map((p, i) => <div key={p.port} style={{ position: 'absolute', right: 0, top: portY(i) - PORT / 2, height: PORT, display: 'flex', alignItems: 'center' }}>
                <span style={{ marginRight: 5, opacity: 0.85 }}>{p.label}</span>
                <span title="Drag to an input to connect" onPointerDown={(e) => { e.stopPropagation(); const b = canvas.current!.getBoundingClientRect(); setDrag({ from: n.id, port: p.port, x: e.clientX - b.left - pan[0], y: e.clientY - b.top - pan[1] }); }} style={{ width: 10, height: 10, borderRadius: 5, marginRight: -5, background: KIND_COLOR[p.kind], cursor: 'crosshair' }} />
              </div>)}
            </div>;
          })}
        </div>
        <div style={{ position: 'absolute', left: 10, bottom: 8, opacity: 0.7, pointerEvents: 'none' }}>Drag nodes to move them, the background to pan. Drag from an output dot (right) to an input dot (left) to connect; click a link or a filled input dot to unlink. Click a node to preview it.</div>
      </div>
    </div>
    <aside className="wc-right" style={{ flex: '0 0 360px', width: 360, maxWidth: 360, display: 'flex', flexDirection: 'column', background: '#1c1f26', borderLeft: '1px solid #2a2e37' }}>
      <div ref={prevHost} style={{ position: 'relative', height: 280, flex: '0 0 280px' }}>
        <div style={{ position: 'absolute', zIndex: 1, left: 8, top: 6, pointerEvents: 'none', opacity: 0.85 }}>{node ? `Preview: ${NODE_DEFS[node.type].name}` : 'Click a node to preview it'}{busy !== null ? ` · working ${Math.round(busy * 100)}%` : ''}</div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {node && def ? <Section title={def.name}>
          <Hint>{def.tip}</Hint>
          {def.params.map((p) => <Row key={p.key} label={p.label} tip={p.tip}>
            {p.kind === 'choice'
              ? <select value={String(node.params[p.key])} onChange={(e) => setParam(p.key, e.target.value)}>{p.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              : <span className="wc-slider"><input type="range" min={p.min} max={p.max} step={p.step} value={Number(node.params[p.key])} onChange={(e) => setParam(p.key, Number(e.target.value))} /><input type="number" step={p.step} value={Number(node.params[p.key])} onChange={(e) => setParam(p.key, Number(e.target.value))} /></span>}
          </Row>)}
        </Section> : <Section title="Node"><Hint>Click a node to change it.</Hint></Section>}
        <Section title="World">
          <Hint>{terrain.endless ? 'This world is endless: Apply needs a finite world (the graph works the whole land out at once).' : `Apply lays the Output into this ${terrain.width} × ${terrain.depth} m world: its land, and (if a Colorize feeds the Output) the ground look with the erosion's flow, wear and sediment. Undo takes it back; hand sculpting stays on top.`}</Hint>
          <div className="wc-tools">
            <button disabled={terrain.endless || busy !== null} onClick={apply}>Apply to world</button>
            {applied && <button onClick={removeFromWorld}>Remove from world</button>}
            <button onClick={() => { if (window.confirm('Start again from the starter graph?')) { const d = defaultGraph(); setG(d); setSel('out'); } }}>Starter graph</button>
          </div>
          {status && <Hint>{status}</Hint>}
        </Section>
        <div className="wc-tools" style={{ padding: 10 }}><button onClick={onClose}>Close</button></div>
      </div>
    </aside>
  </div>, document.body);
}
