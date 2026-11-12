// Builds terrain chunk meshes off the main thread, so moving round the world never waits for new land: the view asks
// for a chunk, keeps drawing, and uses the mesh when it arrives. The same functions as everywhere else
// (Shared/src/world), so a chunk built here is exactly the one the view would have built.
import { buildFeatures, smoothPath, terrainChunk, worldHeight, type Features } from '@shared/src/world/features';
import type { HeightSampler } from '@shared/src/world/terrain';
import type { MeshData } from '@shared/src/world/generators';
import type { RoadPath, WorldConfig, WorldEdits } from '@shared/src/world/document';

let world: { rev: number; cfg: WorldConfig; edits: WorldEdits | null; features: Features; height: HeightSampler } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'world') {
    const cfg = m.cfg as WorldConfig, roads = (m.roads as RoadPath[]).map((r) => ({ ...r, points: smoothPath(r.points) }));
    const features = buildFeatures(cfg, roads, m.edits);
    world = { rev: m.rev, cfg, edits: m.edits, features, height: worldHeight(cfg, m.edits, features) };
    return;
  }
  if (m.type === 'chunk') {
    if (!world || world.rev !== m.rev) { (self as unknown as Worker).postMessage({ type: 'stale', key: m.key, rev: m.rev }); return; }
    const d = terrainChunk(world.cfg, world.edits, world.features, world.height, m.cx, m.cz, m.res, m.lod, true);
    const pack = (x: MeshData) => ({ positions: new Float32Array(x.positions), normals: new Float32Array(x.normals), colors: new Float32Array(x.colors), uvs: new Float32Array(x.uvs), indices: new Uint32Array(x.indices) });
    const out = { ...pack(d), ...(d.snow ? { snow: new Float32Array(d.snow) } : {}), ...(d.cave ? { cave: pack(d.cave) } : {}) };
    const moved = [out.positions.buffer, out.normals.buffer, out.colors.buffer, out.uvs.buffer, out.indices.buffer, ...(out.snow ? [out.snow.buffer] : []),
      ...(out.cave ? [out.cave.positions.buffer, out.cave.normals.buffer, out.cave.colors.buffer, out.cave.uvs.buffer, out.cave.indices.buffer] : [])];
    (self as unknown as Worker).postMessage({ type: 'chunk', key: m.key, rev: m.rev, data: out }, moved);
  }
};
