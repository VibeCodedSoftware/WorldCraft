// Pictures WorldCraft draws itself ("gen:..."), for looks the library has no picture for: toon leaves, cartoon clumps
// with flat light and shade and a dark outline. Grey on purpose: the leaf colour and seasons colour them, as they do the
// library's leaf pictures.
const made = new Map<string, string>();

export function generatedPicture(id: string): string | null {
  const have = made.get(id); if (have) return have;
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d')!;
  let s = 99; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  if (id === 'gen:leaf-toon') {
    // A clump of round leaves: outline first (a little bigger), then the light, then the shade along each one's bottom.
    const blobs = Array.from({ length: 7 }, (_, i) => ({ x: N * (0.3 + rnd() * 0.4), y: N * (0.28 + rnd() * 0.42) - (i === 0 ? 0 : 0), r: N * (0.16 + rnd() * 0.08) }));
    g.fillStyle = '#2e2e2e'; for (const b of blobs) { g.beginPath(); g.arc(b.x, b.y, b.r + 4, 0, Math.PI * 2); g.fill(); }
    for (const b of blobs) { g.fillStyle = '#9a9a9a'; g.beginPath(); g.arc(b.x, b.y, b.r, 0, Math.PI * 2); g.fill(); }
    for (const b of blobs) { g.fillStyle = '#e6e6e6'; g.beginPath(); g.arc(b.x - b.r * 0.12, b.y - b.r * 0.18, b.r * 0.8, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#ffffff'; for (const b of blobs.slice(0, 3)) { g.beginPath(); g.ellipse(b.x - b.r * 0.35, b.y - b.r * 0.4, b.r * 0.22, b.r * 0.12, -0.5, 0, Math.PI * 2); g.fill(); }
    // A short stalk down to the branch.
    g.fillStyle = '#2e2e2e'; g.fillRect(N / 2 - 3, N * 0.72, 6, N * 0.28);
  } else if (id === 'gen:leaf-toon-needle') {
    // A spray of needles: dark outline strokes, light ones on top.
    const spikes = Array.from({ length: 22 }, () => ({ a: -Math.PI / 2 + (rnd() - 0.5) * 2.2, l: N * (0.32 + rnd() * 0.3) }));
    for (const [w, col] of [[7, '#2e2e2e'], [3.5, '#d8d8d8']] as const) { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; for (const sp of spikes) { g.beginPath(); g.moveTo(N / 2, N * 0.95); g.lineTo(N / 2 + Math.cos(sp.a) * sp.l, N * 0.95 + Math.sin(sp.a) * sp.l); g.stroke(); } }
  } else if (id === 'gen:bark-pixel') {
    // Pixel-art bark: a 16-pixel tile of stepped browns in vertical streaks, drawn sharp.
    c.width = c.height = 16;
    const cols = ['#4a3322', '#5c3f29', '#6e4c31', '#3c2a1c'];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const k = ((x * 7 + (y >> 2) * 3 + (x >> 1)) % 11) / 11; g.fillStyle = cols[k < 0.2 ? 3 : k < 0.55 ? 1 : k < 0.85 ? 0 : 2]; g.fillRect(x, y, 1, 1); }
    for (let x = 2; x < 16; x += 5) { g.fillStyle = '#2e2016'; g.fillRect(x, 0, 1, 16); }
  } else return null;
  // (The stalk is at the picture's bottom edge: that edge sits on the branch.)
  const url = c.toDataURL('image/png');
  made.set(id, url);
  return url;
}
