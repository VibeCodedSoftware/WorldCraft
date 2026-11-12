// The planet builder: the whole planet as a globe (real geometry, from the same height function the world's chunks use),
// edited with presets and sliders, turned and zoomed with the mouse. Click a spot and build it as the world: the region
// keeps the planet's land under it, so the globe, the region and its close-ups agree.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { deepCopy, type PlanetCfg } from '@shared/src/world/document';
import { gasColor, isGasGiant, PLANET_PRESETS, planetClimate, planetColor, planetDefaults, planetFrame, planetHeight, regionLook } from '@shared/src/world/planet';
import { noise3, randomSeed } from '@shared/src/world/random';
import { useWC, wc } from './store';
import { b, Fields, Hint, n, Row, s, Section, type Field } from './ui';

const PLANET_FIELDS: Field[] = [
  n('radius', 'Radius (km)', 5, 200, 1), n('ocean', 'Sea', 0, 1, 0.01, '0: a dry world. 1: all sea.'), n('continentSize', 'Continent size (km)', 2, 80, 0.5),
  n('mountains', 'Mountains', 0, 1, 0.01), n('relief', 'Highest land (m)', 20, 1500, 5), n('depth', 'Deepest sea (m)', 0, 800, 5),
  n('craters', 'Craters', 0, 1, 0.01), n('canyons', 'Canyons', 0, 1, 0.01), n('iceCaps', 'Ice caps', 0, 1, 0.01, 'How far ice reaches from the poles.'),
  n('temperature', 'Climate (cold .. hot)', -1, 1, 0.01), n('moisture', 'Moisture', 0, 1, 0.01),
  s('palette', 'Colours', ['earth', 'moon', 'mars', 'ice', 'desert', 'volcanic', 'alien', 'mercury', 'venus', 'pluto', 'jupiter', 'saturn', 'uranus', 'neptune']),
  n('atmosphere', 'Atmosphere', 0, 1, 0.01, 'How thick the air is: the glow round the edge. 0: none, like the Moon.'), n('clouds', 'Clouds', 0, 1, 0.01),
  s('kind', 'Kind', ['rocky', 'gas'], { rocky: 'Rocky (land and sea)', gas: 'Gas giant (cloud bands)' }), n('rings', 'Rings', 0, 1, 0.01), n('ringTilt', 'Ring tilt (°)', 0, 90, 1),
];
const GAS_FIELDS: Field[] = [n('bands', 'Cloud bands', 0, 1, 0.01, 'How strongly the light and dark bands differ.'), n('storms', 'Storms', 0, 1, 0.01, 'Big oval storms in the bands.')];

/** Builds the globe's geometry: a cube-sphere, each vertex pushed out by the planet's height (exaggerated) and coloured. */
function globeGeometry(p: PlanetCfg, res: number, exaggerate: number): THREE.BufferGeometry {
  const faces: [number[], number[], number[]][] = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  const N = res + 1, pos = new Float32Array(6 * N * N * 3), col = new Float32Array(6 * N * N * 3), idx: number[] = [];
  const R = p.radius * 1000, k = exaggerate / R;
  let v = 0;
  for (let f = 0; f < 6; f++) {
    const [o, a, b] = faces[f], base = v;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      // Tangent-warped grid: cells come out much more even than a plain cube.
      const u = Math.tan(((i / res) * 2 - 1) * Math.PI / 4), w = Math.tan(((j / res) * 2 - 1) * Math.PI / 4);
      let x = o[0] + a[0] * u + b[0] * w, y = o[1] + a[1] * u + b[1] * w, z = o[2] + a[2] * u + b[2] * w;
      const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      const sm = planetHeight(p, x, y, z), cl = planetClimate(p, x, y, z, sm.h);
      let c = isGasGiant(p) ? gasColor(p, x, y, z) : planetColor(p, sm, cl);
      // Under the sea: the water's own colour, shallow and bright over the shelves, dark over the deeps (the sea surface
      // above only adds its gloss, so no land shows through it).
      if (p.ocean > 0.001 && sm.h < 0) {
        const [sh, dp] = SEA[p.palette] ?? SEA.earth!, t = Math.min(1, Math.pow(-sm.h / Math.max(1, p.depth), 0.6));
        c = [sh[0] + (dp[0] - sh[0]) * t, sh[1] + (dp[1] - sh[1]) * t, sh[2] + (dp[2] - sh[2]) * t];
        if (cl.ice > 0.5) c = [0.75, 0.82, 0.9]; // (sea ice at the poles)
      }
      // (Seabed just under the sea surface, every bit of land just above it: low coasts used to sit under the sea shell
      // and vanished once the sea stopped being see-through.)
      const sea = p.ocean > 0.001, wet = sea && sm.h < 0;
      const r = wet ? 0.9994 : 1 + (sea ? Math.max(0, sm.h) : sm.h) * k + (sea ? 0.0009 : 0);
      pos.set([x * r, y * r, z * r], v * 3); col.set(c, v * 3); v++;
    }
    // (Wound to face outward: the other way round, the side facing you was culled and you looked through the planet at
    // the inside of its far side, which is why it looked see-through.)
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { const q = base + j * N + i; idx.push(q, q + 1, q + N, q + 1, q + N + 1, q + N); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** Sea colours (linear): shallow, then deep. */
const SEA: Partial<Record<PlanetCfg['palette'], [[number, number, number], [number, number, number]]>> = {
  // (Shallows a little brighter, so they still show as lighter water under the now nearly opaque sea.)
  earth: [[0.06, 0.32, 0.42], [0.004, 0.025, 0.07]], ice: [[0.12, 0.34, 0.45], [0.01, 0.04, 0.09]],
  volcanic: [[1, 0.3, 0.03], [0.5, 0.06, 0.0]], alien: [[0.1, 0.05, 0.35], [0.02, 0.01, 0.08]],
};
const AIR: Record<PlanetCfg['palette'], [number, number, number]> = { earth: [0.35, 0.6, 1], moon: [0.6, 0.6, 0.6], mars: [0.9, 0.55, 0.38], ice: [0.6, 0.8, 1], desert: [0.95, 0.78, 0.52], volcanic: [0.85, 0.42, 0.2], alien: [0.6, 0.42, 1],
  mercury: [0.6, 0.6, 0.6], venus: [1, 0.85, 0.55], pluto: [0.7, 0.75, 0.9], jupiter: [0.95, 0.85, 0.7], saturn: [0.98, 0.92, 0.75], uranus: [0.6, 0.9, 0.95], neptune: [0.4, 0.6, 1] };

/** Rings round a planet: a flat ring of bands and gaps (from the seed), lit by the sun, tilted. */
function ringMesh(p: PlanetCfg): THREE.Mesh | null {
  const amt = p.rings ?? 0; if (amt <= 0.01) return null;
  const W = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = 1;
  const g = cv.getContext('2d')!, img = g.createImageData(W, 1);
  const tint = p.palette === 'saturn' ? [232, 214, 170] : p.palette === 'uranus' ? [190, 205, 210] : [200, 195, 185];
  for (let i = 0; i < W; i++) {
    const r = i / W;
    // Bands of many widths, a wide gap two-thirds out, fading at both edges.
    let a = 0.55 + 0.25 * noise3(p.seed + 700, r * 40, 0, 0) + 0.2 * noise3(p.seed + 701, r * 160, 0, 0);
    a *= 1 - Math.max(0, 1 - Math.abs(r - 0.66) / 0.025) * 0.9;
    a *= Math.min(1, r / 0.08) * Math.min(1, (1 - r) / 0.1);
    a = Math.max(0, Math.min(1, a)) * Math.min(1, amt * 1.2) * (p.palette === 'saturn' ? 0.95 : 0.45);
    const k = i * 4, sh = 0.8 + 0.4 * noise3(p.seed + 702, r * 90, 0, 0);
    img.data[k] = tint[0] * sh; img.data[k + 1] = tint[1] * sh; img.data[k + 2] = tint[2] * sh; img.data[k + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const inner = 1.25, outer = p.palette === 'saturn' ? 2.3 : 1.9, geo = new THREE.RingGeometry(inner, outer, 256, 1);
  // (UVs across the ring: the band picture runs from the inner edge to the outer.)
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) { const d = Math.hypot(pos.getX(i), pos.getY(i)); uv.setXY(i, (d - inner) / (outer - inner), 0.5); }
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
  m.rotation.x = -Math.PI / 2 + ((p.ringTilt ?? 20) * Math.PI) / 180;
  m.name = 'rings';
  return m;
}

/** The air seen edge-on: a glow round the rim, brightest on the lit side (scattered light), fading to space. */
function atmosphereMesh(): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(4, 2, 3).normalize() }, uK: { value: 1 } },
    vertexShader: 'varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec3 uColor, uSun; uniform float uK; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 V = normalize(cameraPosition - vW); float rim = 1.0 - abs(dot(V, vN));
        float lit = clamp(dot(vN, uSun) * 0.8 + 0.35, 0.0, 1.0);
        float a = pow(rim, 3.5) * lit * uK; gl_FragColor = vec4(uColor * (0.6 + rim), a); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.045, 96, 64), m);
}

/** Clouds over the planet, from the seed: a texture wrapped on a shell a little above the land. */
function cloudTexture(p: PlanetCfg): THREE.CanvasTexture | null {
  const amount = p.clouds ?? 0; if (amount <= 0.01) return null;
  const W = 2048, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!, img = g.createImageData(W, H), cut = 1 - amount;
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI, cl = Math.cos(lat), y = Math.sin(lat);
    // (Bands: clouds gather along the storm tracks and near the equator, as on a real planet.)
    const band = 0.12 * Math.cos(lat * 6);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * Math.PI * 2, x = cl * Math.cos(lon), z = cl * Math.sin(lon);
      let n = 0, a = 1, f = 2.2, t = 0;
      for (let o = 0; o < 7; o++) { n += noise3(p.seed + 5000 + o * 31, x * f + y * 0.5 * o, y * f, z * f) * a; t += a; a *= 0.5; f *= 2.1; }
      n = n / t * 0.5 + 0.5 + band;
      const c = Math.min(1, Math.max(0, (n - cut) / 0.17)), k = (j * W + i) * 4; // (crisper edges than before: clouds, not haze)
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 250; img.data[k + 3] = Math.round(c * c * 215);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function PlanetBuilder({ onClose }: { onClose: () => void }) {
  const region = useWC((st) => st.doc!.config.terrain.planet);
  const worldW = useWC((st) => st.doc!.config.terrain.width);
  const [p, setP] = useState<PlanetCfg>(() => region ? deepCopy(region.planet) : planetDefaults());
  const [pick, setPick] = useState<{ lat: number; lon: number } | null>(region ? { lat: region.lat, lon: region.lon } : null);
  const [exag, setExag] = useState(3);
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{ r: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; ctl: OrbitControls; globe: THREE.Mesh; marker: THREE.LineLoop; air: THREE.Mesh; clouds: THREE.Mesh } | null>(null);

  // The renderer, once.
  useEffect(() => {
    const el = host.current!; const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio)); el.appendChild(r.domElement);
    Object.assign(r.domElement.style, { position: 'absolute', inset: '0' });
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#05070d');
    // (Near plane 0.01, not 0.001: at that the depth buffer couldn't tell land a hair above the sea from the sea, so the
    // two fought and the planet looked see-through in patches.)
    const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 50); cam.position.set(0, 0.8, 3.6);
    const ctl = new OrbitControls(cam, r.domElement); ctl.enableDamping = true; ctl.enablePan = false; ctl.minDistance = 1.06; ctl.maxDistance = 8; ctl.zoomSpeed = 0.8;
    // Sunlight from one side and only a little light from space: the night side is dark, as from orbit.
    scene.add(new THREE.AmbientLight('#6070a0', 0.06));
    scene.add(new THREE.HemisphereLight('#9ab0d8', '#000000', 0.08));
    const sun = new THREE.DirectionalLight('#fff4e0', 3.2); sun.position.set(4, 2, 3); scene.add(sun);
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    const globe = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    scene.add(globe);
    const air = atmosphereMesh(); scene.add(air);
    // The sea's surface: only its gloss and the sun's glint (the water's colour is in the seabed below it, which stays
    // hidden: nothing of the land shows through the sea).
    // (Nearly opaque, as a real ocean is from orbit: at 35% the seabed's blocky shelves showed through, and the planet looked
    // like glass. The shallows still show a little lighter.)
    const sea = new THREE.Mesh(new THREE.SphereGeometry(1.0004, 192, 144), new THREE.MeshPhysicalMaterial({ color: '#06203a', roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, opacity: 0.86, depthWrite: true }));
    sea.name = 'sea'; scene.add(sea);
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.018, 96, 64), new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: 1 }));
    scene.add(clouds);
    const marker = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffd23a', depthTest: false }));
    marker.renderOrder = 2; scene.add(marker);
    // Stars.
    const st = new Float32Array(3000); for (let i = 0; i < st.length; i += 3) { const v = new THREE.Vector3().randomDirection().multiplyScalar(30); st.set([v.x, v.y, v.z], i); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(st, 3)); scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#aab', size: 0.06 })));
    three.current = { r, scene, cam, ctl, globe, marker, air, clouds };
    (window as any).__wcPlanet = three.current; // (for checking the globe, like __wc for the view)
    const size = () => { const w = el.clientWidth, h = el.clientHeight; r.setSize(w, h); cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); };
    size(); const ro = new ResizeObserver(size); ro.observe(el);
    let raf = 0; const loop = () => { raf = requestAnimationFrame(loop); ctl.rotateSpeed = 0.25 + 0.75 * Math.min(1, (cam.position.length() - 1) / 2); ctl.update(); r.render(scene, cam); }; loop();
    // A click (not a drag) picks the region.
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const b = r.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), cam);
      const hit = ray.intersectObject(globe)[0]; if (!hit) return;
      const d = hit.point.clone().normalize();
      setPick({ lat: Math.round(Math.asin(d.y) * 180 / Math.PI * 1000) / 1000, lon: Math.round(Math.atan2(d.z, d.x) * 180 / Math.PI * 1000) / 1000 });
    };
    r.domElement.addEventListener('pointerdown', onDown); r.domElement.addEventListener('pointerup', onUp);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose(); globe.geometry.dispose(); r.dispose(); el.removeChild(r.domElement); three.current = null; };
  }, []);

  // The globe, rebuilt (a moment after the last change) whenever the planet changes.
  useEffect(() => {
    setBusy(true);
    const id = setTimeout(() => {
      const t = three.current; if (!t) return;
      // (Finer than before: coastlines and mountains came out as visible squares.)
      const g = globeGeometry(p, 176, exag); t.globe.geometry.dispose(); t.globe.geometry = g;
      // The air's colour and thickness, and the clouds, follow the planet.
      const au = (t.air.material as THREE.ShaderMaterial).uniforms; au.uColor.value.setRGB(...AIR[p.palette]); au.uK.value = (p.atmosphere ?? 1) * 1.4; t.air.visible = (p.atmosphere ?? 1) > 0.01;
      const cm = t.clouds.material as THREE.MeshStandardMaterial; cm.map?.dispose(); cm.map = isGasGiant(p) ? null : cloudTexture(p); cm.needsUpdate = true; t.clouds.visible = !!cm.map;
      if (p.palette === 'mars' || p.palette === 'desert') cm.color.setRGB(1, 0.85, 0.7); else if (p.palette === 'venus') cm.color.setRGB(1, 0.88, 0.6); else cm.color.setRGB(1, 1, 1);
      // Rings (Saturn, Uranus, or any planet given some).
      const oldRing = t.scene.getObjectByName('rings') as THREE.Mesh | undefined;
      if (oldRing) { t.scene.remove(oldRing); oldRing.geometry.dispose(); ((oldRing.material as THREE.MeshStandardMaterial).map)?.dispose(); }
      const ring = ringMesh(p); if (ring) t.scene.add(ring);
      const sea = t.scene.getObjectByName('sea') as THREE.Mesh; sea.visible = p.ocean > 0.001;
      (sea.material as THREE.MeshStandardMaterial).color.set(p.palette === 'volcanic' ? '#ff5a10' : p.palette === 'alien' ? '#1d1450' : '#0b2a4a');
      (sea.material as THREE.MeshStandardMaterial).emissive.set(p.palette === 'volcanic' ? '#ff3a00' : '#000000');
      setBusy(false);
    }, 120);
    return () => clearTimeout(id);
  }, [p, exag]);

  // The region's outline on the globe.
  useEffect(() => {
    const t = three.current; if (!t) return;
    if (!pick) { t.marker.visible = false; return; }
    const { c, e, n: no } = planetFrame(pick.lat, pick.lon), half = worldW / 2 / (p.radius * 1000), pts: number[] = [];
    const lift = 1 + Math.max(0, planetHeight(p, ...c).h) * exag / (p.radius * 1000) + 0.004;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const s2 = Math.max(half, 0.018); const v = new THREE.Vector3(c[0] + (a * e[0] + b * no[0]) * s2, c[1] + (a * e[1] + b * no[1]) * s2, c[2] + (a * e[2] + b * no[2]) * s2).normalize().multiplyScalar(lift);
      pts.push(v.x, v.y, v.z);
    }
    t.marker.geometry.dispose(); t.marker.geometry = new THREE.BufferGeometry(); t.marker.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); t.marker.visible = true;
  }, [pick, p, exag, worldW]);

  const info = pick ? (() => { const L = regionLook(p, pick.lat, pick.lon); return { ...L, h: Math.round(L.sample.h) }; })() : null;
  const build = () => {
    if (!pick) return;
    wc.mutate('World from planet region', (d) => {
      const L = regionLook(p, pick.lat, pick.lon), t = d.config.terrain;
      t.planet = { enabled: true, planet: deepCopy(p), lat: pick.lat, lon: pick.lon, sea: d.config.water.level, detail: region?.detail ?? 0.4 };
      t.island = 0; t.islands = 0;
      // The region's own ground level: on a planet, the base height only marks where "low" is for this world (the land
      // itself comes from the planet), so snow lines and the cooling with height count from here, not from the sea.
      const ground = Math.round(d.config.water.level + Math.max(0, L.sample.h));
      t.baseHeight = ground;
      const cold = L.climate.temperature < -0.3 || L.climate.ice > 0.5;
      d.config.snow.startHeight = cold ? ground - 100 : ground + Math.round(t.height * 0.5 + Math.max(0, L.climate.temperature) * 120);
      d.config.surface.snowLine = d.config.snow.startHeight;
      Object.assign(d.config.surface, L.surface); d.config.surface.greens = p.palette === 'earth' && L.life;
      d.config.water.enabled = L.sea;
      if (L.sea) { d.config.water.color = L.seaColor; d.config.water.deepColor = L.deepColor; }
      if (!L.life) { d.config.water.rivers = 0; d.config.water.lakes = 0; }
      // Climate: biomes follow the latitude, snow comes with cold places and ice caps, and lifeless worlds grow no plants.
      d.config.biomes.temperature = Math.round(L.climate.temperature * 0.6 * 100) / 100;
      d.config.biomes.moisture = Math.round((L.climate.moisture - 0.5) * 0.8 * 100) / 100;
      d.config.snow.enabled = cold; if (cold) d.config.snow.coverage = Math.max(d.config.snow.coverage, L.climate.ice > 0.5 ? 1 : 0.75);
      for (const l of d.config.layers) if (['tree', 'grass', 'flower', 'bush'].includes(l.kind)) l.enabled = L.life && !(L.climate.ice > 0.7);
    });
    onClose();
  };

  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', background: '#05070d' }}>
    <div ref={host} style={{ flex: 1, position: 'relative', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', zIndex: 1, left: 12, top: 10, color: '#cfd6e4', font: '12px system-ui', pointerEvents: 'none' }}>
        Drag to turn, scroll to zoom in and out, click to pick where your world is. {busy ? 'Building the planet…' : ''}
      </div>
    </div>
    <aside className="wc-right" style={{ flex: '0 0 330px', width: 330, maxWidth: 330, overflowY: 'auto', background: '#1c1f26' }}>
      <Section title="Planet">
        <Row label="Preset"><select value={p.preset} onChange={(e) => setP(planetDefaults(e.target.value, p.seed))}>{Object.keys(PLANET_PRESETS).map((k) => <option key={k}>{k}</option>)}</select></Row>
        <Row label="Seed"><span className="wc-seed"><input type="number" value={p.seed} onChange={(e) => setP({ ...p, seed: Math.round(Number(e.target.value)) })} /><button onClick={() => setP({ ...p, seed: randomSeed() })}>Random</button></span></Row>
        <Fields fields={PLANET_FIELDS} value={{ kind: 'rocky', rings: 0, ringTilt: 20, ...p }} set={(k, v) => setP({ ...p, [k]: v })} />
        {isGasGiant(p) && <Fields fields={GAS_FIELDS} value={{ bands: 0.6, storms: 0.3, ...p }} set={(k, v) => setP({ ...p, [k]: v })} />}
        <Row label="Height on the globe ×"><span className="wc-slider"><input type="range" min={1} max={40} value={exag} onChange={(e) => setExag(Number(e.target.value))} /><input type="number" value={exag} onChange={(e) => setExag(Number(e.target.value))} /></span></Row>
        <Hint>The globe is the real land, its heights only stretched by the factor above so mountains show from orbit. Procedural throughout: no maps of real planets are used.</Hint>
      </Section>
      <Section title="Region">
        {isGasGiant(p) ? <Hint>A gas giant has no ground to build a world on: only its cloud tops. Pick a rocky planet (or turn Kind back to rocky) to build a region.</Hint> : pick && info ? <>
          <Hint>{pick.lat.toFixed(2)}° {pick.lat >= 0 ? 'N' : 'S'}, {Math.abs(pick.lon).toFixed(2)}° {pick.lon >= 0 ? 'E' : 'W'} · {info.sample.land < 0.5 && p.ocean > 0 ? `sea, ${-info.h} m deep` : `${info.h} m up`} · {info.climate.ice > 0.5 ? 'ice' : info.climate.temperature < -0.3 ? 'cold' : info.climate.temperature > 0.4 ? 'hot' : 'mild'}{info.life ? '' : ', lifeless'}</Hint>
          <div className="wc-tools"><button onClick={build}>Build this region as the world</button></div>
          <Hint>The world keeps the planet's land under it, with its own terrain settings adding the close-up detail. Ground colours, sea, snow and plants follow the spot; change any of them afterwards.</Hint>
        </> : <Hint>Click the planet to pick a region (the yellow square is your world's size).</Hint>}
      </Section>
      <div className="wc-tools" style={{ padding: 10 }}><button onClick={onClose}>Close</button></div>
    </aside>
  </div>, document.body);
}

/** The Terrain panel's planet section: open the builder, and the region's own settings. */
export function PlanetSection() {
  const region = useWC((st) => st.doc!.config.terrain.planet);
  const [open, setOpen] = useState(false);
  const set = (k: string, v: any, q?: boolean) => wc.mutate(`Planet region: ${k}`, (d) => { (d.config.terrain.planet as any)[k] = v; }, q);
  return <Section title="Planet">
    <Hint>Make a whole planet (Earth-like, Moon, Mars, ice, desert, ocean, volcanic, alien), turn and zoom it, and build any spot of it as this world.</Hint>
    <div className="wc-tools"><button onClick={() => setOpen(true)}>Open planet builder</button></div>
    {region && <Fields fields={[b('enabled', 'On the planet', 'Off: the world goes back to its own terrain.'),n('detail', 'Close-up detail', 0, 1, 0.01, 'How much of the terrain settings above is added on the planet\'s land.'), n('lat', 'Latitude (°)', -89, 89, 0.01), n('lon', 'Longitude (°)', -180, 180, 0.01), n('sea', 'Sea level (m)', -100, 200, 0.5)]} value={region} set={set} path="terrain.planet" />}
    {open && <PlanetBuilder onClose={() => setOpen(false)} />}
  </Section>;
}
