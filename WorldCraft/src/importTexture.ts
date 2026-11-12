// Importing a picture into the world (stored with it, listed under Imported in the library), shared by the library's
// Import button, the texture pickers (ground, leaves, wood) and drag and drop of files from outside.
import { api, wc } from './store';

/** A picture with opaque black where it should be see-through (all corners black) gets real transparency. */
export async function transparentBlack(f: File): Promise<Blob> {
  if (!/\.(png|webp)$/i.test(f.name)) return f;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(bmp, 0, 0); bmp.close();
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, w = c.width, h = c.height;
    const corner = (x: number, y: number) => { const k = (y * w + x) * 4; return px[k + 3] > 250 && px[k] + px[k + 1] + px[k + 2] < 24; };
    if (!(corner(0, 0) && corner(w - 1, 0) && corner(0, h - 1) && corner(w - 1, h - 1))) return f;
    for (let k = 0; k < px.length; k += 4) { const s = px[k] + px[k + 1] + px[k + 2]; if (s < 24) px[k + 3] = 0; else if (s < 60) px[k + 3] = Math.round(((s - 24) / 36) * 255); }
    g.putImageData(d, 0, 0);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? f), 'image/png'));
  } catch { return f; }
}

/** Stores a file with the world and returns its asset id ("proj:imported/…"). Models and pictures alike. */
export async function importAsset(f: File): Promise<string> {
  const doc = wc.get().doc; if (!doc) throw new Error('No world open');
  const rel = `imported/${f.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  const model = /\.(fbx|glb|gltf|obj|blend)$/i.test(f.name);
  await api.putFile(doc.id, rel, await (model ? f : await transparentBlack(f)).arrayBuffer());
  const id = 'proj:' + rel;
  wc.mutate('Imported ' + f.name, (d) => { if (!d.assets.some((a) => a.id === id)) d.assets.push({ id, name: f.name.replace(/\.[^.]+$/, ''), kind: model ? 'model' : 'texture', group: 'imported', tags: [] }); });
  return id;
}
export const PICTURE_FILES = '.png,.jpg,.jpeg,.webp';
