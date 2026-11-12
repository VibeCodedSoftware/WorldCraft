// The 3D view: streams terrain chunks round the camera, instances everything scattered on them, and draws water, roads,
// structures, sky and weather. Geometry is never stored: it all comes from the world's settings (Shared/src/world).
import * as THREE from 'three';
import type { BrushShape } from './brushShapes';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadModel } from '@gamecraft/engine/assets';
import { needsDepth, needsScene, patchWaterMaterial, setWaterSky, setWaterUniforms, WaterPass, type WaterUniforms } from '@gamecraft/engine/waterFx';
import { CloudLayer } from '@gamecraft/engine/cloudLayer';
import { makeSkyDome } from '@gamecraft/engine/skyRig';
import { Culler, DEFAULT_RENDER } from '@gamecraft/engine/culling';
import { grassFalloff } from '@gamecraft/engine/endlessWorld';
import { DEFAULT_SKY, skyState, type CloudSettings } from '@shared/src/runtime/sky';
import { riverOptions, waterOptions } from '@shared/src/world/waterLook';
import type { InstanceData } from '@shared/src/runtime/scene';
import { chunksAround, slopeAt, type HeightSampler } from '@shared/src/world/terrain';
import { buildFeatures, ribbonMesh, ROAD_KINDS, smoothPath, terrainChunk, worldHeight, type Features, type RoadSurface, type WorldStats } from '@shared/src/world/features';
import { baseSource, generateRock, generateTree, leafColorOf, leafMesh, resolveRock, resolveTree, treeFromSkeleton, type MeshData } from '@shared/src/world/generators';
import { lakeWaterMesh, riverWaterAttrs, riverWaterMesh } from '@shared/src/world/features';
import { WATER_RIPPLES } from '@shared/src/world/waterLook';
import type { LeafStyle, TreeCfg, TreeSkeleton } from '@shared/src/world/document';
import { FALL_COLORS, fallIndex, placedY, scatterSquare, structuresInSquare } from '@shared/src/world/scatter';
import { groundColor, hexRgb } from '@shared/src/world/biomes';
import { GRASS_SEASON, seasonAt, seasonPalette } from '@shared/src/world/season';
import { hashString, stream } from '@shared/src/world/random';
import type { ParticleRef, Placed, RoadPath, ScatterLayer, WorldConfig, WorldEdits } from '@shared/src/world/document';
import { FxPreview } from './fxPreview';
import { findFalls, WaterfallFx } from './waterfalls';
import { LeafFallFx } from './leafFall';
import { presetFor, WeatherFx, type FallPreset } from './weatherFx';
import { SnowTrail } from './snowTrail';
import { snowAt } from '@shared/src/world/biomes';
import { assetUrl } from './store';
import { makeImpostor } from './thumbs';
import { dressModel, tex } from './modelLook';

const toGeometry = (m: MeshData) => {
  const g = new THREE.BufferGeometry();
  if (m.flex) g.setAttribute('aFlex', new THREE.Float32BufferAttribute(m.flex, 1));
  if (m.roll) g.setAttribute('aRoll', new THREE.Float32BufferAttribute(m.roll, 1));
  if (m.snow) g.setAttribute('aSnow', new THREE.Float32BufferAttribute(m.snow, 1));
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
  // (From the terrain worker the arrays are typed: an index must then be wrapped.)
  g.setIndex(Array.isArray(m.indices) ? m.indices : new THREE.BufferAttribute(m.indices as unknown as Uint32Array, 1));
  return g;
};

/** Shared by every foliage and rock material: wind, season colours and snow on upward faces. */
const shared = {
  uTime: { value: 0 }, uWind: { value: new THREE.Vector4(1, 0, 1, 0.3) }, uSway: { value: 1 }, uGrassSway: { value: 1 },
  uGrassA: { value: new THREE.Color() }, uGrassB: { value: new THREE.Color() },
  uPalA: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] }, uPalB: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
  uSeasonOn: { value: 0 }, uBlend: { value: 0 }, uAdjust: { value: new THREE.Vector4(1, 1, 0, 1) },
  uSnow: { value: 0 }, uSnowColor: { value: new THREE.Color('#ffffff') }, /** How thick the snow lying on objects is (m). */ uSnowThick: { value: 0 },
  uWater: { value: -1e9 }, uCam: { value: new THREE.Vector3() }, uRollSeed: { value: 0 },
  /** The photographed rock (Rock063) the realistic look's stones wear. */ uRockPhoto: { value: null as THREE.Texture | null },
  /** How much snow lies on the ground under each spot of the world (x0, z0, width, depth): objects take only that much,
   * so a tree in a green valley stays green while the peaks above are white. (White until worked out: snow everywhere.) */
  uSnowMap: { value: (() => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; return t; })() as THREE.Texture },
  uSnowBox: { value: new THREE.Vector4(-1e6, -1e6, 2e6, 2e6) },
};

interface PatchOpts { /** The land: it lays its own snow, so the objects' snow on upward faces stays off it. */ terrain?: boolean; /** Cartoon shading: light in a few flat bands ('pixel': more bands, chunkier). */ toon?: 'toon' | 'pixel'; /** Each leaf has its own random number (aRoll): leaves take their own season colour, not one per tree. */ leafRoll?: boolean; foliage?: 'leaf' | 'grass' | 'wood'; season?: boolean; billboard?: boolean; lumKey?: boolean; instanced?: boolean; /** Wind by the wood's own Flex value instead of height. */ flex?: boolean; /** Doesn't move in the wind. */ still?: boolean; /** Linear rgb: the whole plant wears this. */ fallColor?: [number, number, number]; /** The instance colour (the ground below) replaces the picture's colour. */ copyGround?: boolean; /** A far picture card. */ far?: boolean;
  /** Stone: cracks, grain, lichen and moss on its upper faces, worked out in the pixel along each face. */ rock?: boolean }

function patchWorld(m: THREE.MeshStandardMaterial, o: PatchOpts) {
  m.userData.patch = o;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    // The picture's own average brightness, known once it has loaded: so a dark photo and a bright drawing both centre on the ground colour.
    if (o.copyGround) sh.uniforms.uPicMean = { get value() { return Math.max(0.005, Number(m.map?.userData.meanLum) || 0.15); } } as unknown as THREE.IUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uSway, uGrassSway, uRollSeed, uSnow, uSnowThick; uniform vec4 uWind; uniform vec3 uCam;
        uniform sampler2D uSnowMap; uniform vec4 uSnowBox; varying float vSnowHere;
        varying float vRoll; varying vec3 vWN;
        float pwHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float pwNoise(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(pwHash(i), pwHash(i + vec3(1, 0, 0)), f.x), mix(pwHash(i + vec3(0, 1, 0)), pwHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(pwHash(i + vec3(0, 0, 1)), pwHash(i + vec3(1, 0, 1)), f.x), mix(pwHash(i + vec3(0, 1, 1)), pwHash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
        ${o.leafRoll ? 'attribute float aRoll; varying float vLeafRoll;' : ''}
        ${o.flex ? 'attribute float aFlex;' : ''}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        ${o.foliage === 'grass' ? 'objectNormal = vec3(0.0, 1.0, 0.0); // lit like the ground it grows from, from every side' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wBase = ${o.instanced ? 'modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)' : 'modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)'};
        // Each plant's own random number comes from where it stands: the same on every visit, for one seed.
        vRoll = fract(sin(dot(wBase.xz, vec2(12.9898, 78.233)) + uRollSeed) * 43758.5453);
        // The snow lying on the ground where it stands (see uSnowMap).
        vSnowHere = texture2D(uSnowMap, clamp((wBase.xz - uSnowBox.xy) / uSnowBox.zw, 0.0, 1.0)).r;
        ${o.leafRoll ? 'vLeafRoll = fract(aRoll + vRoll * 0.37);' : ''}
        ${!o.terrain && o.foliage !== 'grass' && o.foliage !== 'leaf' && !o.far ? `
        // Snow lying on it has thickness: a lumpy layer on every upward face, thinning round the sides so it rounds
        // over the edges. (In the object's own space, so its scale is undone.)
        if (uSnow > 0.0 && uSnowThick > 0.0) {
          mat3 wM = mat3(modelMatrix)${o.instanced ? ' * mat3(instanceMatrix)' : ''};
          vec3 wNo = normalize(wM * objectNormal);
          vec3 wPw = (modelMatrix * ${o.instanced ? 'instanceMatrix * ' : ''}vec4(position, 1.0)).xyz;
          float wCap = smoothstep(0.05, 0.75, wNo.y) * uSnow * vSnowHere * (0.55 + 0.9 * pwNoise(wPw * 1.7));
          float wSc = max(0.05, length(wM[1]));
          transformed += normalize(objectNormal) * wCap * uSnowThick / wSc;
        }` : ''}
        ${o.billboard ? `
        // Face the camera, round the vertical: the card stays planted where it stands.
        vec3 wl = (${o.instanced ? 'instanceMatrix[0].xyz' : 'vec3(1.0, 0.0, 0.0)'});
        float wScale = length(wl);
        vec2 toCam = normalize(uCam.xz - wBase.xz);
        transformed = vec3(toCam.y * position.x, position.y, -toCam.x * position.x);
        ` : ''}
        ${o.foliage && !o.still ? `
        // Wind: slow sway with gusts, each plant a little different; only the upper part moves.
        float wT = uTime * (1.0 + uWind.z * 0.35) + vRoll * 6.28 + dot(wBase.xz, vec2(0.13, 0.17));
        float gust = 0.6 + 0.4 * sin(wT * 0.37) * uWind.w;
        float wBend = (${o.foliage === 'grass' ? 'uGrassSway * smoothstep(0.0, 1.0, position.y) * 0.16' : o.flex ? 'uSway * 0.9 * aFlex * aFlex' : 'uSway * 0.05 * max(0.0, position.y)'}) * uWind.z * gust;
        transformed.xz += uWind.xy * wBend * (0.7 + 0.5 * sin(wT * 1.6));
        ${o.foliage === 'leaf' ? `transformed.y += sin(wT * 2.3 + position.x * 2.0) * uSway * ${o.flex ? '0.12 * aFlex' : '0.02'} * uWind.z;` : ''}
        ` : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        #ifndef USE_ENVMAP
        #endif
        vWN = normalize(mat3(modelMatrix) * ${o.instanced ? 'mat3(instanceMatrix) * objectNormal' : 'objectNormal'});
        ${o.rock ? `vRP = (modelMatrix * ${o.instanced ? 'instanceMatrix * ' : ''}vec4(transformed, 1.0)).xyz;` : ''}`)
      .replace('varying float vRoll; varying vec3 vWN;', `varying float vRoll; varying vec3 vWN;${o.rock ? ' varying vec3 vRP;' : ''}`);
    if (o.billboard && !sh.vertexShader.includes('worldPosition =')) { /* three adds it when shadows are on */ }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uPalA[4]; uniform vec3 uPalB[4]; uniform vec3 uGrassA, uGrassB; uniform float uSeasonOn, uBlend, uSnow; uniform vec4 uAdjust; uniform vec3 uSnowColor;
        varying float vSnowHere;
        ${o.copyGround ? 'uniform float uPicMean;' : ''}
        ${o.leafRoll ? 'varying float vLeafRoll;' : ''}
        varying float vRoll; varying vec3 vWN;
        ${o.rock ? `varying vec3 vRP; float wRockH = 0.5; uniform sampler2D uRockPhoto;
        vec3 rkP(vec3 p, vec3 w) { return texture2D(uRockPhoto, p.zy).rgb * w.x + texture2D(uRockPhoto, p.xz).rgb * w.y + texture2D(uRockPhoto, p.xy).rgb * w.z; }
        float rkH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rkN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(rkH(i), rkH(i + vec2(1, 0)), f.x), mix(rkH(i + vec2(0, 1)), rkH(i + vec2(1, 1)), f.x), f.y); }
        // (Height, crack) of stone at a point of one face: lumps, grain, and two sets of fractures.
        // (Fractures from Voronoi cells: blocks and soft seams, not noise contours, which drew wavy black lines.)
        vec2 rkH2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
        vec3 rkV(vec2 p) { vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0, id = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)), o = rkH2(i + g), r = g + o - f; float d = dot(r, r); if (d < d1) { d2 = d1; d1 = d; id = o.x; } else if (d < d2) d2 = d; }
          return vec3(sqrt(d1), sqrt(d2), id); }
        vec2 rkS(vec2 p) { vec3 a = rkV(p * 0.6), b = rkV(p * 1.7 + 3.0); float c = smoothstep(0.0, 0.1, a.y - a.x) * mix(1.0, smoothstep(0.0, 0.07, b.y - b.x), 0.4);
          return vec2(min(a.y - a.x, 0.5) * 0.6 + a.z * 0.2 + rkN(p * 1.5) * 0.15 + rkN(p * 4.0) * 0.06, c); }
        vec2 rkT(vec3 p, vec3 w) { return rkS(p.zy) * w.x + rkS(p.xz + 13.0) * w.y + rkS(p.xy - 7.0) * w.z; }` : ''}
        vec3 wHue(vec3 c, float a) { const vec3 k = vec3(0.57735); float co = cos(a); return c * co + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - co); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${o.lumKey ? 'if (dot(diffuseColor.rgb, vec3(1.0)) < 0.09) discard;' : ''}
        ${o.copyGround ? '// The ground colour (instance colour, multiplied in next) with only this picture\'s light and dark, centred on 1.\n        #ifdef USE_MAP\n        diffuseColor.rgb = vec3(clamp(dot(sampledDiffuseColor.rgb, vec3(0.3, 0.55, 0.15)) / uPicMean, 0.45, 1.7));\n        #else\n        diffuseColor.rgb = vec3(1.0);\n        #endif' : ''}`)
      // Foliage is two-sided: its back must not go black because the normal flips.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        ${o.foliage && o.foliage !== 'wood' ? 'normal = normalize(vNormal);' : ''}
        ${o.rock && !o.toon ? `{
          // The stone's relief: its lumps and cracks bend the light (bump from screen derivatives, no extra samples).
          vec3 Nw = normalize(vWN), dpx = dFdx(vRP), dpy = dFdy(vRP);
          float dhx = dFdx(wRockH) * 0.35, dhy = dFdy(wRockH) * 0.35;
          vec3 r1 = cross(dpy, Nw), r2 = cross(Nw, dpx); float det = dot(dpx, r1);
          if (abs(det) > 1e-10) { vec3 nB = normalize(abs(det) * Nw - sign(det) * (dhx * r1 + dhy * r2)); normal = normalize(mix(normal, normalize((viewMatrix * vec4(nB, 0.0)).xyz), 0.85)); }
        }` : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${o.rock && !o.toon ? `{
          // Stone: weathered two-tone surface, dark cracks, pale lichen flecks, and moss where the top faces up.
          vec3 rw = pow(abs(normalize(vWN)), vec3(4.0)); rw /= dot(rw, vec3(1.0));
          // The photographed rock's light and dark over the stone's own colour (its moss greyed out: moss is added below).
          // (The photo is decoded to linear light: its brightness back on the display scale, so 0.5 is a middle grey.)
          float pl = pow(max(dot(rkP(vRP * 0.3, rw), vec3(0.3, 0.55, 0.15)), 1e-4), 0.4545); wRockH = pl * 1.6;
          float moss = smoothstep(0.6, 0.9, vWN.y + (rkN(vRP.xz * 0.6) - 0.5) * 0.5) * smoothstep(0.3, 0.55, rkN(vRP.xz * 0.25 + 3.0));
          // (Centred on the stone's own colour: the photo's light and dark round 1, so no rock turns black.)
          diffuseColor.rgb *= mix(clamp(pl / 0.45, 0.55, 1.5), 1.0, moss * 0.6);
          float lich = smoothstep(0.78, 0.86, rkN(vRP.xz * 3.1 + vRP.y)) * 0.5 * (1.0 - moss);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.6, 0.46), lich);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.32, 0.13) * (0.8 + 0.4 * rkN(vRP.xz * 1.7)), moss * 0.85);
        }` : ''}
        ${o.fallColor ? `{ float wF = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)); vec3 wFC = vec3(${o.fallColor.map((v) => v.toFixed(4)).join(', ')});
          ${o.leafRoll ? '// Leaf by leaf: the tree\'s fall colour, each leaf a little warmer or cooler, lighter or darker.\n          wFC = wHue(wFC, (vLeafRoll - 0.5) * 0.45) * (0.78 + vLeafRoll * 0.44);' : ''}
          diffuseColor.rgb = wFC * (${o.far ? '0.5 + wF * 1.3' : '0.45 + wF * 1.5'}); }` : ''}
        ${o.season && !o.fallColor ? `
        if (uSeasonOn > 0.5) {
          // Keeps the plant's own light and dark; only its colour moves to the season's. Original files are untouched.
          float wL = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
          ${o.foliage === 'grass'
            // Grass takes the season as one colour (a meadow isn't a patchwork); leaves take it leaf by leaf.
            ? 'vec3 wC = mix(uGrassA, uGrassB, uBlend) * (0.9 + 0.2 * vRoll);'
            : `int wI = int(floor(fract(${o.leafRoll ? 'vLeafRoll' : 'vRoll'} * 7.13) * 3.999));
          vec3 wC = mix(uPalA[wI], uPalB[wI], uBlend);`}
          wC = wHue(wC, uAdjust.z * 3.14159);
          float wG = dot(wC, vec3(0.3333)); wC = mix(vec3(wG), wC, uAdjust.y) * uAdjust.x;
          diffuseColor.rgb = mix(diffuseColor.rgb, wC * (0.4 + wL * 1.6), uAdjust.w);
        }` : ''}
        // Snow settles on what faces up.
        ${o.terrain ? '' : o.foliage === 'leaf' || o.foliage === 'grass'
          // (Leaves and grass: frosted and snow-laden on their upper sides.)
          ? 'if (uSnow > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, smoothstep(0.3, 0.85, vWN.y + (vRoll - 0.5) * 0.2) * uSnow * vSnowHere * 0.9);'
          // (Its snow layer: the same faces the vertex shader thickened.)
          : 'if (uSnow > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, smoothstep(0.1, 0.6, vWN.y + (vRoll - 0.5) * 0.1) * min(1.0, uSnow * vSnowHere * 1.3));'}`);
    if (o.toon) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `{
        // Cartoon light: flat bands of brightness, and colours a little richer.
        float tL = max(1e-4, dot(outgoingLight, vec3(0.299, 0.587, 0.114)));
        float tB = ${o.toon === 'pixel' ? '5.0' : '3.2'};
        float tQ = (floor(tL * tB) + 0.65) / tB;
        outgoingLight *= clamp(tQ / tL, 0.0, 4.0);
        outgoingLight = max(vec3(0.0), mix(vec3(dot(outgoingLight, vec3(0.333))), outgoingLight, 1.22));
      }
      #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'world:' + JSON.stringify(o);
  return m;
}

/** One source of a scatter layer: meshes to instance. Near and far detail. */
interface SourceDef { parts: { geo: THREE.BufferGeometry; mat: THREE.Material; tris: number }[]; radius: number; low?: SourceDef['parts']; far?: SourceDef['parts']; billboard?: boolean; variants?: Map<string, SourceDef> }

/**
 * Icicles under a tree's branches: thin cones hanging from the underside of the more level ones (ice forms where
 * meltwater drips off), longest on the thicker wood. Their sway follows the branch's.
 */
function icicleMesh(sk: TreeSkeleton, amount: number, seed: number): MeshData {
  const m: MeshData = { positions: [], normals: [], colors: [], uvs: [], indices: [], flex: [] };
  let s = (seed * 2654435761) >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const SIDES = 6;
  sk.branches.forEach((b) => {
    if (b.l < 1 || b.l > 2) return;
    for (let k = 1; k < b.p.length && m.positions.length < 600 * (SIDES + 1) * 3; k++) {
      const a = b.p[k - 1], e = b.p[k], dx = e[0] - a[0], dy = e[1] - a[1], dz = e[2] - a[2], len = Math.hypot(dx, dy, dz) || 1;
      const level = 1 - Math.abs(dy) / len;
      if (rnd() > amount * 0.7 * level * level) continue;
      const r = b.r[k] ?? 0.05, x = e[0], z = e[2], top = e[1] - r * 0.85;
      const L = (0.08 + rnd() * 0.45) * (0.35 + amount) * Math.min(2, 0.5 + r * 6), w = Math.max(0.012, Math.min(0.06, r * 0.45));
      const flex = Math.min(1, 0.45 + 0.15 * b.l), base = m.positions.length / 3;
      for (let i = 0; i < SIDES; i++) {
        const t = (i / SIDES) * Math.PI * 2, cx = Math.cos(t), cz = Math.sin(t);
        m.positions.push(x + cx * w, top, z + cz * w); m.normals.push(cx, 0.15, cz); m.colors.push(1, 1, 1); m.uvs.push(i / SIDES, 0); m.flex!.push(flex);
      }
      m.positions.push(x + (rnd() - 0.5) * w, top - L, z + (rnd() - 0.5) * w); m.normals.push(0, -1, 0); m.colors.push(1, 1, 1); m.uvs.push(0.5, 1); m.flex!.push(flex);
      for (let i = 0; i < SIDES; i++) m.indices.push(base + i, base + SIDES, base + ((i + 1) % SIDES));
    }
  });
  return m;
}

/** How deep snow lies where it lies fully (m): the Snow panel's depth, or a little for the snow tall land gets anyway. */
const snowDepthOf = (c: WorldConfig) => (c.snow.enabled ? Math.max(0.03, c.snow.thickness) * Math.max(0.2, c.snow.coverage) : c.terrain.height > 40 ? 0.3 : 0);
const dummy = new THREE.Object3D();
const UP = new THREE.Vector3(0, 1, 0), tilt = new THREE.Quaternion(), tiltAxis = new THREE.Vector3();
/**
 * Puts `dummy` where a scattered thing stands, turned by `q`. Trees and bushes are each a little different besides
 * their random shape: taller or squatter, wider or narrower, and leaning a touch, from their own random number.
 */
function placeInstance(it: { x: number; y: number; z: number; scale: number; tint: number }, kind: ScatterLayer['kind'], q: THREE.Quaternion) {
  dummy.position.set(it.x, it.y - (kind === 'tree' ? 0.05 : 0), it.z);
  dummy.quaternion.copy(q);
  if (kind === 'tree' || kind === 'bush') {
    const r1 = (it.tint * 13.7) % 1, r2 = (it.tint * 29.3) % 1, r3 = (it.tint * 51.1) % 1;
    tiltAxis.set(Math.cos(r3 * 6.283), 0, Math.sin(r3 * 6.283)); tilt.setFromAxisAngle(tiltAxis, (r1 - 0.5) * 0.12);
    dummy.quaternion.premultiply(tilt);
    const w = it.scale * (0.88 + r2 * 0.26);
    dummy.scale.set(w, it.scale * (0.86 + r1 * 0.32), w);
  } else dummy.scale.setScalar(it.scale);
  dummy.updateMatrix();
}
/** Copies made of a material for a layer's look: what happens to the original (a missing picture dropped) happens to them. */
const matVariants = new WeakMap<THREE.Material, THREE.Material[]>();
const tintColor = new THREE.Color();

export type BrushTool = 'treedraw' | 'brushplace' | 'orbit' | 'select' | 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise' | 'hole' | 'paint' | 'biome' | 'snow' | 'scatter' | 'erase' | 'place' | 'road' | 'stamp' | 'terrace' | 'push' | 'erode' | 'twist' | 'relief' | 'tilt' | 'align' | 'clone' | 'area' | 'areapaste';
export interface BrushCfg { tool: BrushTool; size: number; strength: number; falloff: number; value: string; asset: string; roadKind: string; spacing: number; randomRotation: boolean; randomScale: boolean;
  /** The brush's shape (alpha) and its turn (°). */ shape?: BrushShape; rotation?: number;
  /** Flatten to this height (m) instead of where the stroke starts; Terrace: the height of each step (m). */ flattenHeight?: number | null; levelStep?: number }
const SCULPTING: BrushTool[] = ['raise', 'lower', 'smooth', 'flatten', 'noise', 'stamp', 'terrace', 'push', 'erode', 'twist', 'relief', 'tilt', 'align', 'clone', 'area', 'areapaste', 'hole', 'paint', 'snow', 'scatter', 'erase', 'brushplace', 'biome'];

export interface ViewOptions { objects: boolean; clouds: boolean; wire: boolean; slab: boolean }
export interface ViewEvents {
  onBrush(tool: BrushTool, x: number, z: number, dt: number, first: boolean): void;
  onBrushEnd(): void;
  /** A brush setting changed from the keyboard and mouse wheel. */ onBrushChange?(p: Partial<BrushCfg>): void;
  onPlace(x: number, y: number, z: number): void;
  onRoadPoint(x: number, z: number, done: boolean): void;
  onSelect(id: string | null): void;
  onMoved(id: string, x: number, y: number, z: number, ry: number, scale: number): void;
  onStats(s: WorldStats & { building: number; fps: number }): void;
  /** Draw tree: where a new tree's foot goes; a finished stroke (tree space), from node `at` of branch `parent` (-1: the trunk). */
  onTreeStart?(x: number, y: number, z: number): void;
  onTreeStroke?(id: string, points: [number, number, number][], parent: number, at: number): void;
  /** A tree node dragged to a new place (tree space). */
  onTreeNode?(id: string, branch: number, node: number, to: [number, number, number]): void;
  onNodePicked?(n: { b: number; n: number } | null): void;
  onMessage?(text: string): void;
}

interface Chunk { key: string; cx: number; cz: number; lod: number; group: THREE.Group; terrain: THREE.Mesh; tris: number; objects: number; instanced: number; objTris: number; draws: number; sig: string; /** Grass patches, thinned with distance. */ grass: THREE.InstancedMesh[]; /** Trees choosing their own detail. */ trees: TreeDetail[] }
/**
 * One species' trees in one chunk, each drawn at the detail its own distance calls for: the full model close by, the
 * simpler one further off, its picture far away. The same matrices go into whichever of the three each tree uses.
 */
interface TreeDetail { items: { x: number; y: number; z: number }[]; mats: Float32Array; colors: Float32Array | null; bands: Uint8Array; full: THREE.InstancedMesh[]; low: THREE.InstancedMesh[]; far: THREE.InstancedMesh[]; near: number; mid: number; at: THREE.Vector3 }

export class WorldView {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera: THREE.PerspectiveCamera; controls: OrbitControls;
  gizmo: TransformControls;
  private chunks = new Map<string, Chunk>();
  private cfg: WorldConfig | null = null; private edits: WorldEdits | null = null; private placed: Placed[] = []; private roads: RoadPath[] = [];
  height: HeightSampler = () => 0; features: Features | null = null;
  private world = new THREE.Group(); private sun = new THREE.DirectionalLight('#fff', 3); private hemi = new THREE.HemisphereLight('#cfe4ff', '#5a5a44', 0.6);
  private terrainMat: THREE.MeshStandardMaterial;
  private sources = new Map<string, SourceDef | 'loading' | 'failed'>();
  private waterMesh: THREE.Mesh | null = null; private waterU: WaterUniforms | null = null; private waterInst: any = null;
  private extras = new THREE.Group(); private placedGroup = new THREE.Group();
  private clouds = new CloudLayer(() => tex('lib:world/clouds/FogParticle.png'));
  private dome = makeSkyDome();
  private skyLook = { top: new THREE.Color(), low: new THREE.Color(), sun: new THREE.Color(), sunUp: 1 };
  private waterPass = new WaterPass();
  private waters: { u: WaterUniforms; inst: InstanceData }[] = [];
  private stars: THREE.Points | null = null;
  private brushRing: THREE.Line;
  private sunDir = new THREE.Vector3(0.5, 0.8, 0.3);
  private terrainU = { uSand: { value: new THREE.Color('#e4d8bc') }, uBeach: { value: 4 }, uRockA: { value: new THREE.Color('#4d4a48') }, uRockB: { value: new THREE.Color('#8b8378') }, uSnowLine: { value: 1e6 }, uSnowOn: { value: 1 }, uGreens: { value: 0 }, /** A ground look's strength: its colours tone the rock too. */ uLookOn: { value: 0 }, /** A desert world: sand over its open ground. */ uDesert: { value: 0 }, /** 0 realistic, 1 stylized, 2 toon, 3 pixel. */ uLook: { value: 0 },
    /** How deep the snow is where it lies fully (m), and where the sun is (for the snow's glitter). */ uSnowDepth: { value: 0.4 }, uSunDirW: { value: new THREE.Vector3(0, 1, 0) } };
  /** Footprints and trails pressed into the snow round the walker. */
  private trail = new SnowTrail();
  private slab = new THREE.Group();
  /** View options (the View tab). */
  show = { objects: true, clouds: true, wire: false, slab: true };
  heights = { min: 0, max: 0 };
  private clock = new THREE.Clock(); private running = true; private fps = 60; private frames = 0; private fpsT = 0;
  private pointer = new THREE.Vector2(); private ray = new THREE.Raycaster();
  private painting = false; private lastPaint = 0;
  brush: BrushCfg = { tool: 'orbit', size: 12, strength: 0.5, falloff: 0.5, value: 'grass', asset: '', roadKind: 'dirt', spacing: 1, randomRotation: false, randomScale: false };
  selectedId: string | null = null;
  private pending: [number, number][] = [];
  private lodDist = 120; private grassDist = 80; private cullDist = 600; private densityScale = 1;
  private dirtyKeys = new Set<string>(); private rev = 0;
  private buildCap = 2; private lastTarget = new THREE.Vector3(1e9, 0, 0);

  constructor(private host: HTMLElement, private ev: ViewEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.85;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 6000);
    this.camera.position.set(70, 55, 90);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0); this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.495;
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', (e: any) => { this.controls.enabled = !e.value; if (!e.value) this.commitGizmo(); });
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.world, this.extras, this.placedGroup, this.clouds.group, this.slab, this.sun, this.sun.target, this.hemi, this.dome);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.6; this.sun.shadow.radius = 3.5;
    this.terrainMat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }), { terrain: true });
    // The ground's grain: "2 Seamless Grass Textures" by StarNinjas (OpenGameArt, CC0), green and dry, with a height and
    // normal map worked out from each picture (packaging\world-keep\ground\GrassSN).
    const litter = tex('lib:world/ground/GrassSN/Grass_Color.jpg', { repeat: true });
    const litterN = tex('lib:world/ground/GrassSN/Grass_Normal.jpg', { repeat: true, srgb: false });
    const litterH = tex('lib:world/ground/GrassSN/Grass_Height.jpg', { repeat: true, srgb: false });
    const dryC = tex('lib:world/ground/GrassSN/DryGrass_Color.jpg', { repeat: true });
    const dryN = tex('lib:world/ground/GrassSN/DryGrass_Normal.jpg', { repeat: true, srgb: false });
    const dryH = tex('lib:world/ground/GrassSN/DryGrass_Height.jpg', { repeat: true, srgb: false });
    // Rock: a photographed cliff (Rock063, ambientCG, CC0) for the realistic look; the toon and pixel looks stay flat.
    const rockC = tex('lib:world/rock/Rock063/Rock063_Color.jpg', { repeat: true });
    const rockN = tex('lib:world/rock/Rock063/Rock063_Normal.jpg', { repeat: true, srgb: false });
    shared.uRockPhoto.value = rockC;
    if (litter && litterN && litterH && dryC && dryN && dryH) { // The ground material: grass blades where the ground is green, its grain everywhere else.
      for (const t of [litter, litterN, litterH, dryC, dryN, dryH]) t.anisotropy = 8;
      const m = this.terrainMat, prev = m.onBeforeCompile;
      m.onBeforeCompile = (sh, r) => {
        prev(sh, r);
        // (Kept in this.groundU so a ground texture of your own swaps in without rebuilding the shader.)
        this.builtinGround ={ uDetail: litter, uDetailN: litterN, uDetailH: litterH, uDryC: dryC, uDryN: dryN, uDryH: dryH };
        for (const [k, t] of Object.entries(this.builtinGround)) if (!this.groundU[k as keyof typeof this.groundU].value) (this.groundU as any)[k].value = t;
        Object.assign(sh.uniforms, this.groundU); sh.uniforms.uRockC = { value: rockC }; sh.uniforms.uRockN = { value: rockN }; sh.uniforms.uWater = shared.uWater; sh.uniforms.uTime = shared.uTime;
        sh.uniforms.uSnowDepth = this.terrainU.uSnowDepth; sh.uniforms.uTrail = this.trail.uniforms.uTrail; sh.uniforms.uTrailBox = this.trail.uniforms.uTrailBox; sh.uniforms.uSunDirW = this.terrainU.uSunDirW;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
          attribute float aSnow; varying float vSnow; varying vec2 vWorldUv; varying vec3 vWP;
          uniform float uSnowDepth; uniform sampler2D uTrail; uniform vec3 uTrailBox;
          float vHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(vHash(i), vHash(i + vec2(1, 0)), f.x), mix(vHash(i + vec2(0, 1)), vHash(i + vec2(1, 1)), f.x), f.y); }
          float trailAt(vec2 p) { vec2 t = (p - uTrailBox.xy) / uTrailBox.z + 0.5; return any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0))) ? 0.0 : texture2D(uTrail, t).r; }`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
          vWorldUv = position.xz; vWP = position; vSnow = aSnow;
          // Snow has depth: the ground rises under it, lumpy and drifted, and sinks again where someone walked through it.
          transformed.y += aSnow * uSnowDepth * (0.65 + 0.7 * vNoise(position.xz * 0.23) * vNoise(position.xz * 0.07 + 3.0) * 1.6) * (1.0 - 0.85 * trailAt(position.xz));`);
        sh.uniforms.uLook = this.terrainU.uLook;
        sh.uniforms.uSand = this.terrainU.uSand; sh.uniforms.uBeach = this.terrainU.uBeach; sh.uniforms.uRockA = this.terrainU.uRockA; sh.uniforms.uRockB = this.terrainU.uRockB; sh.uniforms.uSnowLine = this.terrainU.uSnowLine; sh.uniforms.uSnowOn = this.terrainU.uSnowOn; sh.uniforms.uGreens = this.terrainU.uGreens; sh.uniforms.uLookOn = this.terrainU.uLookOn; sh.uniforms.uDesert = this.terrainU.uDesert;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          uniform sampler2D uRockC, uRockN;
          // The photo rock seen from the three axes, blended by how the surface faces: cliffs aren't stretched.
          vec3 rkTri(sampler2D t, vec3 p, vec3 w) { return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z; }
          uniform sampler2D uDetail, uDetailN, uDetailH, uDryC, uDryN, uDryH; uniform float uGScale, uOwnTex; uniform float uWater, uTime, uSnowLine, uSnowOn, uGreens, uLook, uLookOn, uDesert; uniform vec3 uRockA, uRockB; varying vec2 vWorldUv; varying vec3 vWP; varying float vSnow;
          uniform sampler2D uTrail; uniform vec3 uTrailBox, uSunDirW; uniform float uSnowDepth;
          uniform vec3 uSand; uniform float uBeach;
          float trailF(vec2 p) { vec2 t = (p - uTrailBox.xy) / uTrailBox.z + 0.5; return any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0))) ? 0.0 : texture2D(uTrail, t).r; }
          float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }
          float tFbm(vec2 p) { return 0.5 * tNoise(p) + 0.3 * tNoise(p * 2.3 + 3.1) + 0.2 * tNoise(p * 5.1 - 1.7); }
          // Rock: fractured blocks (two sets of cracks), big lumps and grain. 1 on solid rock, toward 0 in a crack.
          // Wind ripples on sand: long wavy crests, bent by slow noise.
          float sRip(vec2 p) { return sin(dot(p, vec2(0.55, 0.83)) * 2.4 + tNoise(p * 0.12) * 7.0 + tNoise(p * 0.5) * 1.5); }
          // Fractured stone from Voronoi cells (nearest and second-nearest point): blocks with bevelled edges and soft seams
          // where they meet, each block a slightly different tone. (Not noise contours: those drew wavy black lines.)
          vec2 tH2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
          vec3 tVor(vec2 p) { vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0, id = 0.0;
            for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)), o = tH2(i + g), r = g + o - f; float d = dot(r, r); if (d < d1) { d2 = d1; d1 = d; id = o.x; } else if (d < d2) d2 = d; }
            return vec3(sqrt(d1), sqrt(d2), id); }
          vec2 rH(vec2 p) {
            // (Strongly bent, so blocks aren't tidy polygons; seams only in places and soft, so it reads as weathered
            // stone rather than paving.)
            vec2 w = p + vec2(tNoise(p * 0.035), tNoise(p * 0.035 + 5.0)) * 9.0 + vec2(tNoise(p * 0.2), tNoise(p * 0.2 + 2.0)) * 1.5;
            vec3 a = tVor(w * 0.13), b = tVor(w * 0.38 + 3.0);
            float show = smoothstep(0.35, 0.7, tNoise(p * 0.05 + 11.0));
            float seamA = smoothstep(0.0, 0.2, a.y - a.x), seamB = smoothstep(0.0, 0.12, b.y - b.x);
            float c = mix(1.0, seamA * mix(1.0, seamB, 0.3), 0.35 + 0.65 * show);
            float hgt = min(a.y - a.x, 0.45) * 0.5 + a.z * 0.3 + tFbm(p * 0.6) * 0.18 + tNoise(p * 2.7) * 0.06;
            return vec2(hgt, c); }
          // Projected along the face's own direction (triplanar), so cliffs aren't stretched streaks. (Height, crack.)
          // Only the faces that matter are worked out.
          vec2 rHt(vec3 p, vec3 w) { vec2 o = vec2(0.0); if (w.x > 0.05) o += rH(p.zy) * w.x; if (w.y > 0.05) o += rH(p.xz + 13.0) * w.y; if (w.z > 0.05) o += rH(p.xy - 7.0) * w.z; return o / max(1e-3, (w.x > 0.05 ? w.x : 0.0) + (w.y > 0.05 ? w.y : 0.0) + (w.z > 0.05 ? w.z : 0.0)); }
          float wCaustic(vec2 p) { float v = 0.0; for (int i = 0; i < 3; i++) { p = mat2(0.8, -0.6, 0.6, 0.8) * p * 1.3 + uTime * 0.07; v += abs(sin(p.x + sin(p.y * 1.3 + uTime * 0.4))) ; } return pow(1.0 - v / 3.0, 3.0); }`)
          .replace('#include <color_fragment>', `#include <color_fragment>
          // Grass at two scales, so its tiling doesn't show. Only its light and dark are used: the ground's colours (random
          // greens, paint) lie over it, and grass standing here takes those same colours.
          // Green blades on green ground, dry blades on the dry ground of the upper slopes.
          float wGrassy0 = smoothstep(0.01, 0.08, diffuseColor.g - diffuseColor.r);
          float wDryTex = smoothstep(0.35, 0.7, tFbm(vWorldUv * 0.018) * 0.6 + (vWP.y - uWater) / max(40.0, uSnowLine - uWater) * 0.7) * (1.0 - uGreens) * (1.0 - wGrassy0);
          // Relief up close (realistic look): the blades' height map shifts what you see by the angle you look at it from
          // (parallax), the gaps between blades are shaded, and blades shadow the ones behind them away from the sun.
          // (Shading only: the ground's surface itself isn't moved.)
          vec3 wV0 = normalize(cameraPosition - vWP);
          float wNear = (1.0 - smoothstep(10.0, 45.0, length(cameraPosition - vWP))) * step(uLook, 0.5);
          vec2 wGuv = vWorldUv * uGScale, wPdir = -wV0.xz / max(wV0.y, 0.35) * 0.02 * wNear;
          #define GH(p) mix(texture2D(uDetailH, p).r, texture2D(uDryH, p).r, wDryTex)
          float wGh = GH(wGuv);
          for (int i = 0; i < 4; i++) { wGuv = vWorldUv * uGScale + wPdir * (1.0 - wGh); wGh = GH(wGuv); }
          float wGsh = 0.0;
          { vec2 sd = uSunDirW.xz / max(uSunDirW.y, 0.25) * 0.03;
            for (int i = 1; i <= 3; i++) { float t = float(i) / 3.0; wGsh = max(wGsh, GH(wGuv + sd * (1.0 - wGh) * t) - (wGh + (1.0 - wGh) * t)); } }
          vec3 wGc = mix(texture2D(uDetail, wGuv).rgb, texture2D(uDryC, wGuv).rgb, wDryTex);
          vec3 wGc2 = mix(texture2D(uDetail, vWorldUv * uGScale * 0.286 + 0.37).rgb, texture2D(uDryC, vWorldUv * uGScale * 0.286 + 0.37).rgb, wDryTex);
          // (Brought to the old ground picture's brightness, which the rest of the colouring was tuned to.)
          vec3 wD = mix(wGc, wGc2, 0.35) * 1.05;
          // (Divided by its own average, so up close the ground is no darker overall than the grass standing on it.)
          float wRelief = mix(1.0, (0.45 + 0.6 * wGh * wGh) * (1.0 - clamp(wGsh * 2.5, 0.0, 0.6)) / 0.62, wNear * (1.0 - uDesert));
          // Each look its own ground: the photograph's grain only for realistic (half for stylized); toon and pixel art
          // flat, pixel art in square steps.
          if (uLook > 0.5) wD = mix(wD, vec3(0.165), uLook > 1.5 ? 1.0 : 0.5);
          if (uLook > 2.5) wD *= 0.85 + 0.3 * tHash(floor(vWorldUv * 2.0));
          float wDL = dot(wD, vec3(0.333)) / 0.13 * 0.33;
          float wBlades = clamp(dot(wD, vec3(0.3, 0.55, 0.15)) / 0.165, 0.45, 1.7);
          float wGrassy = smoothstep(0.01, 0.08, diffuseColor.g - diffuseColor.r);
          // The land's smooth normal (interpolated, not each triangle's own): rock, snow and dry ground blend across the
          // surface instead of following the triangles in hard facets.
          vec3 wN = normalize(vWN); if (wN.y < 0.0) wN = -wN;
          float wBreak = tFbm(vWorldUv * 0.09);
          // Ground in the pixel, not just at the mesh's points: exposed rock in layers on the steep parts, grit on the rest.
          diffuseColor.rgb *= mix(0.72 + wDL * 0.9, wBlades, wGrassy);
          // Dry, tan ground on the upper slopes and in patches, deep green low down: no single flat colour.
          float wDry = smoothstep(0.35, 0.7, tFbm(vWorldUv * 0.018) * 0.6 + (vWP.y - uWater) / max(40.0, uSnowLine - uWater) * 0.7);
          // (Not over green ground: its colour is the one grass copies, so nothing but the blades may change it.)
          // (The cooler tint and the dry tan are in the ground's colour itself now, Shared groundColor, so the grass that
          // copies that colour matches the ground under it.)
          diffuseColor.rgb *= wRelief;
          // Your own ground texture in its own colours (Ground texture › Picture's own colours).
          if (uOwnTex > 0.5) diffuseColor.rgb = mix(wGc, wGc2, 0.25) * wRelief;
          // Rock where it's steep: a crisp edge broken up by noise, so outcrops read as rock and ground as ground.
          // (From about 40 degrees, as on real mountains: earlier only 60 degrees and more, so their sides were grass.)
          // (A broad blend, only lightly broken by noise: a narrow one turned slopes near the threshold into leopard spots.)
          float wSteep = smoothstep(0.86, 0.62, wN.y + (wBreak - 0.5) * 0.1);
          // (And ground painted as rock, e.g. by a terrain layer: stone even where it isn't steep.)
          // (The vertex colours are display values, the rock uniforms linear: compared as display values.)
          // (A wide match, so the edges of painted rock, where its colour is blended with the ground's, are rock too and
          // fade softly: a narrow one left flat brown blotches with stepped edges.)
          // (Not in a desert: its sand is close enough to its rock's colour that the whole desert was drawn as rock.)
          wSteep = max(wSteep, (1.0 - smoothstep(0.06, 0.26, distance(vColor.rgb, pow((uRockA + uRockB) * 0.5, vec3(1.0 / 2.2))))) * 0.97 * (1.0 - uDesert));
          // Layers in the rock, fading out far away where they would only shimmer.
          float wFar = clamp(fwidth(vWP.y) * 1.2, 0.0, 1.0);
          float wBands = mix(0.5 + 0.5 * sin(vWP.y * 0.45 + wBreak * 7.0 + tNoise(vWorldUv * 0.02) * 12.0), 0.5, wFar);
          vec3 wTw = pow(abs(wN), vec3(4.0)); wTw /= dot(wTw, vec3(1.0));
          float wRH = 0.5;
          // (Only a touch of the grass photo's grain: on stone it reads as speckle.)
          // Realistic: the photographed rock, two sizes so its repeat doesn't show, in the Rock colour (its moss and stains
          // greyed out, so snowy peaks don't turn green; the ledges get their own moss below). Stylized: half of it.
          // Toon and pixel art: one flat rock colour, as their trees and rocks are.
          vec3 wRock;
          if (uLook < 1.5) {
            vec3 ph = mix(rkTri(uRockC, vWP * 0.11, wTw), rkTri(uRockC, vWP * 0.031 + 0.4, wTw), 0.4);
            float pl = pow(max(dot(ph, vec3(0.3, 0.55, 0.15)), 1e-4), 0.4545); // (display scale: 0.5 is middle grey)
            vec3 tone = mix(uRockA, uRockB, 0.55 + (wBreak - 0.5) * 0.5);
            // (With a ground look, the rock wears the look's colours, worn and streaked where the erosion run left it.)
            tone = mix(tone, pow(vColor.rgb, vec3(2.2)) * (0.85 + wBreak * 0.3), uLookOn);
            wRock = tone * clamp(pow(pl * 1.9, 2.0), 0.12, 2.2);
            // Rills: runoff streaks running straight down steep faces (stretched along the downhill direction), light
            // ribs and dark grooves, as on weathered mountainsides. (Shading only.)
            vec2 wDn = normalize(wN.xz + vec2(1e-4)), wPr = vec2(-wDn.y, wDn.x);
            float wAc = dot(vWorldUv, wPr), wAl = dot(vWorldUv, wDn);
            float wRill = tNoise(vec2(wAc * 0.32, wAl * 0.022)) * 0.6 + tNoise(vec2(wAc * 1.05, wAl * 0.06) + 7.0) * 0.4;
            wRock *= mix(1.0, 0.7 + 0.6 * wRill, smoothstep(0.88, 0.6, wN.y) * (1.0 - wFar * 0.6));
            if (uLook > 0.5) wRock = mix(mix(uRockA, uRockB, 0.55), wRock, 0.5);
          } else wRock = mix(uRockA, uRockB, 0.55);
          diffuseColor.rgb = mix(diffuseColor.rgb, wRock, wSteep);
          // Moss and grass on the ledges of rock that face up (realistic and stylized looks).
          float wLedge = wSteep * smoothstep(0.82, 0.94, wN.y + (wRH - 0.5) * 0.25) * (1.0 - wFar * 0.5) * step(uLook, 1.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.36, 0.17) * (0.7 + wDL * 0.6), wLedge * 0.6);
          float wRockN = wSteep * (1.0 - wLedge) * (1.0 - wFar) * step(uLook, 1.5);
          // Sand: the shore's own surface (realistic and stylized). Warm and bright with a fine grain and wind ripples;
          // dark and smooth where the waves wet it, a pale line of dried foam and a scatter of washed-up weed at the
          // high-water mark. (Not over rock standing on the beach.)
          float wDw = vWP.y - uWater;
          float wSandAmt = uWater > -1e8 && uLook < 1.5 ? (1.0 - smoothstep(uBeach * 0.7, uBeach * 1.4, wDw)) * smoothstep(0.55, 0.8, wN.y) * (1.0 - wSteep) : 0.0;
          // A desert: the same rippled sand over all its open ground (not on its rock).
          wSandAmt = max(wSandAmt, uDesert * step(uLook, 1.5) * smoothstep(0.62, 0.86, wN.y) * (1.0 - wSteep));
          float wWet = 1.0 - smoothstep(0.08, 0.7 + 0.3 * tNoise(vWorldUv * 0.2), wDw);
          if (wSandAmt > 0.01) {
            float grain = tHash(floor(vWorldUv * 60.0));
            vec3 sand = uSand * (0.94 + 0.08 * tFbm(vWorldUv * 0.25) + 0.07 * (grain - 0.5)) * (1.0 + 0.035 * sRip(vWorldUv) * (1.0 - wFar));
            sand = mix(sand, uSand * vec3(0.6, 0.57, 0.52), wWet * 0.85);
            float wash = (1.0 - smoothstep(0.0, 0.12, abs(wDw - 0.75 - 0.25 * tNoise(vWorldUv * 0.3)))) * 0.5;
            sand = mix(sand, uSand * 1.12, wash * (1.0 - wWet));
            float wrack = smoothstep(0.78, 0.95, tNoise(vWorldUv * 1.3)) * (1.0 - smoothstep(0.0, 0.6, abs(wDw - 1.3))) * smoothstep(0.4, 0.6, tNoise(vWorldUv * 0.07 + 4.0));
            sand = mix(sand, vec3(0.27, 0.24, 0.17), wrack * 0.75);
            diffuseColor.rgb = mix(diffuseColor.rgb, sand, wSandAmt);
          }
          // Snow: the amount worked out for the land (height, cold, slope, shade side, drifts) laid down pixel by pixel. It
          // gathers in drifts and thins to a dusting at its edges, steep spots and ridges shed it so rock shows through,
          // and it is a little blue in its own hollows and glitters: not a flat white sheet.
          float wDrift = tFbm(vWorldUv * 0.32) * 0.55 + tFbm(vWorldUv * 0.055 + 9.0) * 0.45;
          float wCover = smoothstep(0.3, 0.6, vSnow + (wDrift - 0.5) * 0.6) * smoothstep(0.36, 0.62, wN.y + (wBreak - 0.5) * 0.24);
          float wDust = smoothstep(0.05, 0.35, vSnow) * 0.35 * smoothstep(0.3, 0.55, wN.y);
          vec3 wSnowC = uSnowColor * mix(vec3(0.82, 0.88, 1.0), vec3(1.0), smoothstep(0.25, 0.75, wDrift)) * (0.95 + 0.05 * wDL);
          // Footprints: packed snow, a little darker and greyer, at the bottom of each print.
          // (Inside a print the snow is packed and in its own shade: cooler and darker, deepest at its middle.)
          float wTrail = trailF(vWorldUv) * wCover;
          wSnowC *= mix(vec3(1.0), vec3(0.62, 0.68, 0.8), wTrail);
          diffuseColor.rgb = mix(diffuseColor.rgb, wSnowC, clamp(max(wCover, wDust), 0.0, 1.0));
          float wSnowAll = clamp(max(wCover, wDust), 0.0, 1.0);
          if (vWP.y < uWater) diffuseColor.rgb += wCaustic(vWorldUv * 0.45) * 0.6 * smoothstep(uWater - 25.0, uWater - 0.2, vWP.y);`)
          // Snow's surface: soft lumps and wind ripples, and footprints pressed into it, shaped by their own slopes.
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // Sand ripples bend the light (only on dry sand: the waves smooth the wet band).
          if (wSandAmt > 0.01 && wFar < 0.9) {
            float r0 = sRip(vWorldUv), rx = sRip(vWorldUv + vec2(0.05, 0.0)), rz = sRip(vWorldUv + vec2(0.0, 0.05));
            vec2 g = vec2(rx - r0, rz - r0) / 0.05 * 0.06 * wSandAmt * (1.0 - wWet) * (1.0 - wFar);
            normal = normalize(normal + (viewMatrix * vec4(-g.x, 0.0, -g.y, 0.0)).xyz);
          }
          // Rock's relief from the photographed rock's own normal map, from the same three axes (whiteout blend).
          {
            float k = wRockN * (1.0 - wSnowAll) * (uLook > 0.5 ? 0.5 : 1.0);
            if (k > 0.02) {
              vec3 p = vWP * 0.11;
              vec3 tx = texture2D(uRockN, p.zy).xyz * 2.0 - 1.0, ty = texture2D(uRockN, p.xz).xyz * 2.0 - 1.0, tz = texture2D(uRockN, p.xy).xyz * 2.0 - 1.0;
              vec3 nx = vec3(tx.xy + wN.zy, abs(tx.z) * wN.x).zyx, ny = vec3(ty.xy + wN.xz, abs(ty.z) * wN.y).xzy, nz = vec3(tz.xy + wN.xy, abs(tz.z) * wN.z);
              vec3 nR = normalize(nx * wTw.x + ny * wTw.y + nz * wTw.z);
              normal = normalize(mix(normal, normalize((viewMatrix * vec4(nR, 0.0)).xyz), k));
            }
          }
          if (wSnowAll > 0.01) {
            float e = 0.12;
            float hC = tFbm(vWorldUv * 0.9) * 0.6 + sin(dot(vWorldUv, vec2(0.83, 0.55)) * 3.1 + tNoise(vWorldUv * 0.4) * 4.0) * 0.12;
            float hX = tFbm((vWorldUv + vec2(e, 0.0)) * 0.9) * 0.6 + sin(dot(vWorldUv + vec2(e, 0.0), vec2(0.83, 0.55)) * 3.1 + tNoise((vWorldUv + vec2(e, 0.0)) * 0.4) * 4.0) * 0.12;
            float hZ = tFbm((vWorldUv + vec2(0.0, e)) * 0.9) * 0.6 + sin(dot(vWorldUv + vec2(0.0, e), vec2(0.83, 0.55)) * 3.1 + tNoise((vWorldUv + vec2(0.0, e)) * 0.4) * 4.0) * 0.12;
            float t0 = trailF(vWorldUv), tX = trailF(vWorldUv + vec2(0.08, 0.0)), tZ = trailF(vWorldUv + vec2(0.0, 0.08));
            vec2 g = vec2(hX - hC, hZ - hC) / e * 0.35 * (1.0 - wFar) - vec2(tX - t0, tZ - t0) / 0.08 * 1.6 * max(0.25, uSnowDepth);
            normal = normalize(normal + (viewMatrix * vec4(-g.x, 0.0, -g.y, 0.0)).xyz * wSnowAll);
          }`)
          // Snow's light: never black in shade (light scatters through it, a cool blue), and it glitters toward the sun.
          .replace('#include <opaque_fragment>', `
          if (wSnowAll > 0.01) {
            outgoingLight = max(outgoingLight, diffuseColor.rgb * vec3(0.3, 0.36, 0.48) * wSnowAll);
            vec3 wNw = normalize((vec4(normal, 0.0) * viewMatrix).xyz), wV = normalize(cameraPosition - vWP);
            float wSpark = step(0.985, tHash(floor(vWorldUv * 55.0) + floor(uTime * 0.0))) * pow(max(dot(reflect(-wV, wNw), uSunDirW), 0.0), 6.0);
            outgoingLight += vec3(1.6, 1.55, 1.45) * wSpark * wSnowAll * (1.0 - wFar);
          }
          // Toon and pixel-art land: light in flat bands like their trees and rocks; pixel art in fewer colours too.
          if (uLook > 1.5) {
            float tL = max(1e-4, dot(outgoingLight, vec3(0.299, 0.587, 0.114))), tB = uLook > 2.5 ? 5.0 : 3.2;
            outgoingLight *= clamp(((floor(tL * tB) + 0.65) / tB) / tL, 0.0, 4.0);
            if (uLook > 2.5) outgoingLight = floor(outgoingLight * 14.0 + 0.5) / 14.0;
          }
          #include <opaque_fragment>`)
          // The blades catch the light: the material's relief, on grassy flat ground.
          .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          // (From the same shifted spot as the colour, green or dry; on all open ground, not only green.)
          vec2 wBlade = mix(texture2D(uDetailN, wGuv).xy, texture2D(uDryN, wGuv).xy, wDryTex) * 2.0 - 1.0;
          normal = normalize(normal + (viewMatrix * vec4(wBlade.x, 0.0, wBlade.y, 0.0)).xyz * mix(0.35, 0.9, max(wGrassy, wDryTex)) * (1.0 - wSteep) * (1.0 - uDesert) * (uLook > 1.5 ? 0.0 : uLook > 0.5 ? 0.5 : 1.0));`);
      };
      m.customProgramCacheKey = () => 'terrain-detail';
    }
    const ringPts = Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2)));
    this.brushRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: '#ffe680', depthTest: false, transparent: true }));
    this.brushRing.visible = false; this.brushRing.renderOrder = 10; this.scene.add(this.brushRing);
    const d = this.renderer.domElement;
    d.addEventListener('pointermove', this.onMove); d.addEventListener('pointerdown', this.onDown); window.addEventListener('pointerup', this.onUp);
    d.addEventListener('wheel', this.onBrushWheel, { capture: true, passive: false });
    window.addEventListener('keydown', this.onHeldKey); window.addEventListener('keyup', this.onHeldKey);
    window.addEventListener('blur', () => this.held.clear());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose() { this.running = false; this.worker?.terminate(); this.worker = null; this.renderer.setAnimationLoop(null); this.renderer.dispose(); this.renderer.domElement.remove(); window.removeEventListener('pointerup', this.onUp); }

  private resize() { const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  // ------------------------------------------------------------------------------------ settings

  /** New settings. `keep` true: only look settings changed (season, weather), nothing to rebuild. */
  setWorld(cfg: WorldConfig, edits: WorldEdits, placed: Placed[], roads: RoadPath[], densityScale: number) {
    // What a change touches, so only that is redone. The land: its shape and colours (and what carves it: water, roads,
    // caves). The plants' models. Where things stand. A change to the look only (season, weather, sky) rebuilds nothing.
    const water = cfg.water.enabled ? [cfg.water.level, cfg.water.rivers, cfg.water.riverSeed, cfg.water.riverWidth, cfg.water.riverDepth, cfg.water.meander, cfg.water.branching, cfg.water.lakes] : 0;
    const snow = cfg.snow.enabled ? [cfg.snow.coverage, cfg.snow.startHeight, cfg.snow.blendHeight, cfg.snow.maxSlope, cfg.snow.color, cfg.snow.variation, cfg.snow.seed, cfg.snow.thickness, cfg.snow.peaks, cfg.snow.temperature, cfg.snow.aspect] : 0;
    const t = cfg.terrain;
    const layout = JSON.stringify([t.chunkSize, t.endless, t.width, t.depth]);
    // (And the simulation runs and applied node graph: rivers and lakes are laid out on the land they make.)
    const land = JSON.stringify([t, cfg.surface, cfg.biomes, water, snow, cfg.cave, cfg.voxel, roads, cfg.style, (edits.grids ?? []).map((g) => g.id)]);
    const models = JSON.stringify([cfg.trees, cfg.rocks, cfg.leaves, cfg.modelLeaves, cfg.modelWood, cfg.style, cfg.snow.enabled ? cfg.snow.icicles ?? 0 : 0]);
    const where = JSON.stringify([cfg.layers, cfg.spawns, densityScale, cfg.optimize.lodDistance, cfg.optimize.grassDistance, cfg.optimize.cull, cfg.season.season, cfg.season.enabled]);
    const landChanged = land !== this.sig.land, modelsChanged = models !== this.sig.models, whereChanged = where !== this.sig.where, layoutChanged = layout !== this.sig.layout;
    this.sig = { land, models, where, layout };
    this.cfg = cfg; this.edits = edits; this.roads = roads; this.densityScale = densityScale;
    const reach = QUALITY[this.qualityName === 'auto' ? 'high' : this.qualityName].reach;
    this.lodDist = cfg.optimize.lodDistance * reach; this.grassDist = cfg.optimize.grassDistance * reach; this.cullDist = cfg.optimize.cull * reach;
    this.buildCap = Math.max(1, Math.round(cfg.terrain.budget));
    if (landChanged) {
      this.features = buildFeatures(cfg, roads.map((r) => ({ ...r, points: smoothPath(r.points) })), edits);
      this.height = worldHeight(cfg, edits, this.features);
      this.forget(); // (land, and where everything stands on it)
      this.snowMapDirty = true;
      this.postWorld();
      this.rebuildExtras();
      this.slabSig = '';
    } else if (whereChanged || modelsChanged) { this.placeCache.clear(); this.grassCache.clear(); }
    if (modelsChanged) { this.sources.clear(); this.rev++; }
    if (layoutChanged && this.chunks.size) {
      // The chunks themselves are cut differently: the old ones stay in view until the new ones have covered it.
      for (const c of this.chunks.values()) this.retired.add(c.group);
      this.chunks.clear(); this.heights = { min: Infinity, max: -Infinity };
    } else if (landChanged || modelsChanged || whereChanged) {
      // Everything already in view stays there, and is replaced chunk by chunk, nearest first, as its new version is ready.
      // (Their land, when it changed, comes from the worker: its old mesh was forgotten above, so it is asked for again.)
      for (const k of this.chunks.keys()) this.redrawKeys.add(k);
    }
    if (landChanged || modelsChanged || whereChanged || layoutChanged) { this.grassQueue.length = 0; this.lastTarget.set(1e9, 0, 0); }
    this.setPlaced(placed);
    this.applyLook();
  }
  private sig = { land: '', models: '', where: '', layout: '' };
  /** Old chunks kept in view while a new layout fills in. */
  private retired = new Set<THREE.Group>();

  /** After a brush stroke: re-sample the world and rebuild only the chunks it touched. */
  editedAt(x: number, z: number, radius: number) {
    if (!this.cfg) return;
    const size = this.cfg.terrain.chunkSize;
    this.snowMapDirty = true; // (painted snow, or land raised into the snow line)
    for (let a = Math.floor((x - radius) / size); a <= Math.floor((x + radius) / size); a++) for (let b = Math.floor((z - radius) / size); b <= Math.floor((z + radius) / size); b++) this.dirtyKeys.add(`${a},${b}`);
  }

  /** The source (e.g. "tree:oak~3") of the scattered tree nearest (x, z), within `r` metres, or null. */
  nearestTree(x: number, z: number, r: number): string | null {
    const c = this.cfg; if (!c) return null;
    const trees = new Set(c.layers.filter((l) => l.kind === 'tree').map((l) => l.id));
    let best: string | null = null, bd = r;
    for (const [k, list] of this.placeCache) if (trees.has(k.split('|')[1])) for (const it of list) { const d = Math.hypot(it.x - x, it.z - z); if (d < bd) { bd = d; best = it.source; } }
    for (const p of this.placed) if (p.asset.startsWith('tree:')) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p.asset; } }
    return best;
  }
  /** Every chunk in view rebuilt (a setting changed the whole sculpt layer). */
  editedAll() { this.snowMapDirty = true; for (const k of this.chunks.keys()) this.dirtyKeys.add(k); }
  /** Lets go of retired chunks once the new ones cover the view. */
  private dropRetired() {
    for (const g of this.retired) { this.world.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m as any).ownsGeometry) m.geometry.dispose(); if ((m as any).isInstancedMesh) (m as unknown as THREE.InstancedMesh).dispose(); }); }
    this.retired.clear();
  }
  /** Where a screen point meets the ground (for drag and drop). */
  groundAtClient(x: number, y: number) { return this.hitGround({ clientX: x, clientY: y } as PointerEvent); }
  /** Re-apply the View tab's options. */
  refreshLook() { this.applyLook(); }
  private freeChunk(c: Chunk) {
    this.world.remove(c.group);
    c.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m as any).ownsGeometry) m.geometry.dispose(); if ((m as any).isInstancedMesh) (m as unknown as THREE.InstancedMesh).dispose(); });
  }

  private applyLook() {
    const c = this.cfg; if (!c) return;
    const s = c.season, w = c.weather;
    shared.uSeasonOn.value = s.enabled ? 1 : 0;
    shared.uRollSeed.value = (s.seed % 1000) * 0.137;
    shared.uAdjust.value.set(s.brightness, s.saturation, s.hue, Math.max(0, Math.min(1, (1 - s.preserve) * s.intensity)));
    shared.uSnow.value = c.snow.enabled ? c.snow.onObjects * c.snow.coverage : 0;
    shared.uSnowColor.value.set(c.snow.color);
    shared.uWater.value = c.water.enabled ? c.water.level : -1e9;
    const a = (w.windDirection * Math.PI) / 180;
    shared.uWind.value.set(Math.cos(a), Math.sin(a), w.windStrength * Math.max(0.2, w.windSpeed / 2), w.gusts);
    shared.uSway.value = w.sway ? w.swayAmount : 0; shared.uGrassSway.value = w.grassSway ? w.swayAmount : 0;
    // Sky by the hour.
    const t = c.sky.time, elev = Math.sin(((t - 6) / 12) * Math.PI), day = Math.max(0, elev);
    const az = ((t - 6) / 12) * Math.PI;
    this.sunDir.set(Math.cos(az) * 100, Math.max(0.05, elev) * 100, 40).normalize();
    const warm = 1 - Math.min(1, Math.abs(elev) * 2.5);
    const sunC = new THREE.Color('#fff4e3').lerp(new THREE.Color('#ff9a55'), warm);
    this.sun.color.copy(sunC); this.sun.intensity = c.sky.sunStrength * Math.min(1, day * 2.2) * (1 - 0.5 * c.weather.clouds * (c.weather.type === 'clear' ? 0.4 : 1));
    this.hemi.intensity = 1.6 * c.sky.ambient * (0.18 + 0.82 * Math.min(1, day * 1.6)); // (shade under trees shouldn't read as black)
    const skyDay = new THREE.Color('#8ec5ee'), skyDusk = new THREE.Color('#e8996b'), skyNight = new THREE.Color('#0a1226');
    let sky = skyNight.clone().lerp(skyDay, Math.min(1, day * 2)); sky.lerp(skyDusk, warm * 0.6);
    const grey = w.type === 'clear' ? 0 : Math.min(0.85, w.intensity * 0.9); sky = sky.lerp(new THREE.Color(w.type === 'dust' ? '#b59a6d' : '#8a929a'), grey);
    // The sky: GameCraft's atmosphere dome. Its colours are display colours; light and fog need them as linear.
    const st = skyState({ ...DEFAULT_SKY, time: t });
    const greyK = grey; const greyTo = w.type === 'dust' ? [0.71, 0.6, 0.43] as const : [0.54, 0.57, 0.6] as const;
    const domeTop = st.skyColor.map((v, i) => v + (greyTo[i] - v) * greyK) as [number, number, number];
    const domeLow = st.horizonColor.map((v, i) => v + (greyTo[i] - v) * greyK) as [number, number, number];
    const du = this.dome.material.uniforms;
    du.top.value.setRGB(...domeTop); du.horizon.value.setRGB(...domeLow);
    du.sunColor.value.setRGB(...st.sunColor); du.sunUp.value = Math.max(0, Math.min(1, (st.elevation + 3) / 6)) * (1 - greyK);
    du.sunDir.value.copy(this.sunDir); du.haze.value = 2.5 + (w.fog + c.weather.clouds * 0.3) * 6;
    this.skyLook.top.setRGB(...domeTop, THREE.SRGBColorSpace); this.skyLook.low.setRGB(...domeLow, THREE.SRGBColorSpace);
    this.skyLook.sun.setRGB(...st.sunColor, THREE.SRGBColorSpace); this.skyLook.sunUp = Math.min(1, day * 2.2) * (1 - greyK * 0.6);
    sky = this.skyLook.low.clone().lerp(new THREE.Color('#e4e9e6'), 0.4 * Math.min(1, day * 2));
    this.scene.background = null;
    // Finite worlds sit on a table, so the shape and its long shadow read clearly; endless ones have the horizon.
    const finite = !c.terrain.endless && this.show.slab;
    this.terrainU.uSand.value.set(c.surface.sand); this.terrainU.uBeach.value = Math.max(0.5, c.surface.beachWidth);
    // Rock in the pixel: two tones of the world's own Rock colour (grey granite, red Martian, brown desert stone...).
    this.terrainU.uRockA.value.set(c.surface.rock).multiplyScalar(0.7); this.terrainU.uRockB.value.set(c.surface.rock).multiplyScalar(1.25);
    // Snow caps the upper part of whatever height this land reaches.
    this.terrainU.uSnowLine.value = c.terrain.baseHeight + c.terrain.height * 0.52;
    this.terrainU.uSnowOn.value = c.terrain.height > 40 || c.snow.enabled ? 1 : 0;
    this.terrainU.uGreens.value = c.surface.greens ? 1 : 0;
    this.terrainU.uLookOn.value = c.surface.look?.palette && c.surface.look.strength > 0 ? Math.min(1, c.surface.look.strength) : 0;
    this.terrainU.uDesert.value = /^Desert/.test(c.terrain.preset) ? 1 : 0;
    this.applyGroundTex(c.surface.groundTex);
    // How deep the snow is where it lies fully: the Snow panel's thickness (a little for the snow tall land gets anyway).
    this.terrainU.uSnowDepth.value = snowDepthOf(c);
    this.terrainU.uSunDirW.value.copy(this.sunDir);
    this.terrainU.uLook.value = ({ realistic: 0, mixed: 0, stylized: 1, toon: 2, pixel: 3 } as Record<string, number>)[c.style ?? 'realistic'] ?? 0;
    shared.uSnowThick.value = c.snow.enabled ? Math.min(0.45, Math.max(0.03, c.snow.thickness) * 0.5) : 0;
    const fogD = Math.max(0, w.fog) + (w.type === 'fog' ? w.intensity : w.type === 'mist' ? w.intensity * 0.5 : w.type === 'dust' ? w.intensity * 0.7 : w.type === 'storm' || w.type === 'rain' ? w.intensity * 0.25 : w.type === 'snow' ? w.intensity * 0.3 : 0);
    // Aerial perspective: air the colour of the horizon, so distance goes soft and meets the sky.
    // (Finite worlds too, scaled to their size: a faint blue-grey veil on the far side, as real air gives any landscape.)
    const airK = finite ? 0.32 / Math.max(500, Math.max(c.terrain.width, c.terrain.depth) * 1.6) : 0.0002;
    this.scene.fog = new THREE.FogExp2(sky.getHex(), airK + fogD * fogD * 0.018);
    this.rebuildSlab(finite);
    this.terrainMat.wireframe = this.show.wire;
    this.world.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh || o.userData.structure) o.visible = this.show.objects; });
    this.clouds.group.visible = this.show.clouds;
    if (t < 5.5 || t > 18.5) this.ensureStars(c.sky.stars); else if (this.stars) this.stars.visible = false;
    this.updateWeather();
    this.updateWater();
  }

  private slabSig = '';
  /** The block the finite world is cut from: walls down from its edge, standing on a table that catches its shadow. */
  private rebuildSlab(on: boolean) {
    const c = this.cfg!;
    // (The land's own settings too: a template or layer changes the edge heights without touching the edits.)
    const sig = on ? `${this.rev}|${c.terrain.width}|${c.terrain.depth}|${c.water.enabled}|${c.water.level}|${JSON.stringify(this.edits?.height ?? {}).length}|${this.edits?.grids?.length ?? 0}|${this.sig.land}` : 'off';
    if (sig === this.slabSig) return;
    this.slabSig = sig; this.slab.clear();
    if (!on) return;
    const w = c.terrain.width / 2, d = c.terrain.depth / 2, n = 96;
    const edge: [number, number][] = [];
    for (let i = 0; i < n; i++) edge.push([-w + (2 * w * i) / n, -d]);
    for (let i = 0; i < n; i++) edge.push([w, -d + (2 * d * i) / n]);
    for (let i = 0; i < n; i++) edge.push([w - (2 * w * i) / n, d]);
    for (let i = 0; i <= n; i++) edge.push([-w, d - (2 * d * i) / n]);
    let low = Infinity; for (const [x, z] of edge) low = Math.min(low, this.height(x, z));
    if (c.water.enabled) low = Math.min(low, c.water.level);
    const base = low - Math.max(10, c.terrain.height * 0.14);
    const pos: number[] = [], idx: number[] = [];
    edge.forEach(([x, z], i) => { const y = this.height(x, z); pos.push(x, Math.max(y, c.water.enabled ? c.water.level : y), z, x, base, z); if (i + 1 < edge.length) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const walls = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#4f77b8', roughness: 0.6, side: THREE.DoubleSide }));
    walls.castShadow = true; this.slab.add(walls);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(w, d) * 12, Math.max(w, d) * 12), new THREE.MeshStandardMaterial({ color: '#465a84', roughness: 0.95 }));
    table.rotation.x = -Math.PI / 2; table.position.y = base; table.receiveShadow = true; this.slab.add(table);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, d * 2), new THREE.MeshStandardMaterial({ color: '#3b5688' }));
    under.rotation.x = -Math.PI / 2; under.position.y = base + 0.05; this.slab.add(under);
  }

  private ensureStars(on: boolean) {
    if (!this.stars) {
      const r = stream(7, 'stars'), p: number[] = [];
      for (let i = 0; i < 1800; i++) { const a = r.next() * Math.PI * 2, y = r.next() * 0.95 + 0.05, q = Math.sqrt(1 - y * y); p.push(Math.cos(a) * q * 3000, y * 3000, Math.sin(a) * q * 3000); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, fog: false }));
      this.scene.add(this.stars);
    }
    this.stars.visible = on;
  }

  /** The clouds for these settings: the same layer GameCraft draws. Just above the peaks, so they read from above. */
  private cloudSettings(): CloudSettings {
    const s = worldClouds(this.cfg!), q = QUALITY[this.level];
    return { ...s, style: q.clouds === 'particles' ? 'particles' : q.puffs ? s.style : s.style === 'particles' ? 'particles' : 'volumetric', steps: Math.min(s.steps, q.steps), puffs: Math.min(s.puffs, q.puffs || 3) };
  }

  // ------------------------------------------------------------------------------------ quality

  private qualityName: QualityName | 'auto' = 'auto';
  /** What's being drawn at: the choice, or where Auto has settled. */
  private level: QualityName = 'high';
  private slowFor = 0; private fastFor = 0;
  /** Low to Ultra, or Auto: starts at High and steps down when the frame rate stays low, back up when it recovers. */
  setQuality(name: QualityName | 'auto') {
    if (name === this.qualityName) return;
    this.qualityName = name;
    this.applyLevel(name === 'auto' ? 'high' : name);
    this.sig.where = ''; // (how far things are drawn changes, so chunks redraw on the next settings pass)
    if (this.cfg) { this.setWorld(this.cfg, this.edits!, this.placed, this.roads, this.densityScale); }
  }
  get qualityNow() { return this.level; }
  private applyLevel(level: QualityName) {
    this.level = level;
    const q = QUALITY[level], s = this.sun.shadow;
    this.renderer.setPixelRatio(q.ratio > 0 ? q.ratio : Math.min(devicePixelRatio, 1.5));
    this.sun.castShadow = q.shadow > 0;
    if (q.shadow > 0 && s.mapSize.x !== q.shadow) { s.mapSize.set(q.shadow, q.shadow); s.map?.dispose(); (s as { map: THREE.WebGLRenderTarget | null }).map = null; }
    this.resize();
  }
  private autoQuality(dt: number) {
    if (this.qualityName !== 'auto' || document.hidden) return;
    const f = 1 / Math.max(dt, 0.001);
    this.slowFor = f < 26 ? this.slowFor + dt : 0;
    this.fastFor = f > 52 ? this.fastFor + dt : 0;
    const order: QualityName[] = ['low', 'medium', 'high'], i = order.indexOf(this.level);
    if (this.slowFor > 2.5 && i > 0) { this.slowFor = 0; this.applyLevel(order[i - 1]); }
    else if (this.fastFor > 12 && i < 2) { this.fastFor = 0; this.applyLevel(order[i + 1]); }
  }

  /** What falls: SpriteCraft's weather (the chosen preset, or the type's own), or snowfall from the Snow settings. */
  private fall: { preset: FallPreset | null; amount: number } = { preset: null, amount: 0 };
  private updateWeather() {
    const w = this.cfg!.weather;
    const snowFall = this.cfg!.snow.enabled ? this.cfg!.snow.fall : 0;
    const p = presetFor(w.type, w.fallPreset);
    this.fall = p && w.intensity > 0 ? { preset: p, amount: w.intensity } : snowFall > 0 ? { preset: presetFor('snow', 'Light snow'), amount: snowFall } : { preset: null, amount: 0 };
    if (!this.weatherFx.group.parent) this.scene.add(this.weatherFx.group);
  }
  private weatherFx = new WeatherFx();

  private updateWater() {
    const c = this.cfg!, w = c.water;
    if (!w.enabled) { if (this.waterMesh) this.waterMesh.visible = false; return; }
    if (!this.waterMesh) {
      const m = gameCraftWater(w.color, w.opacity);
      this.waterU = patchWaterMaterial(m);
      this.waterInst = { kind: 'box', material: { surface: 'water', water: {} } } as unknown as InstanceData;
      this.waterMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 160, 1, 160), m);
      this.waterMesh.renderOrder = 2; this.scene.add(this.waterMesh);
    }
    const m = this.waterMesh.material as THREE.MeshStandardMaterial;
    m.color.set(w.color); m.opacity = Math.max(0.05, w.opacity / 100);
    for (const o of this.extras.children) if (o.userData.water) { const rm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; rm.color.set(w.color); rm.opacity = m.opacity; }
    this.waterMesh.visible = true;
    this.waterInst.material.water = waterOptions(w, c.terrain.endless ? 4000 : Math.max(c.terrain.width, c.terrain.depth));
  }

  private domeTop = new THREE.Color(); private domeA = new THREE.Color(); private domeB = new THREE.Color();
  private waterUniforms: WaterUniforms[] = [];
  /** Every frame: the water's settings and sky, and the pass it reads (land only, at half size: enough for what's under it). */
  private frustum = new THREE.Frustum(); private projView = new THREE.Matrix4();
  private prepareWater(t: number, c: WorldConfig) {
    // Only water that can be seen costs its extra pass: a sea wholly under the land, or rivers and lakes off screen, don't.
    // (Not from inside a cave: the sea is a solid block under its surface, and caves below sea level are dry.)
    const cam = this.camera.position, underground = c.cave.enabled && cam.y < this.height(cam.x, cam.z) - 0.5;
    if (this.waterMesh) this.waterMesh.visible = !underground && c.water.enabled && (!Number.isFinite(this.heights.min) || c.water.level > this.heights.min - 0.25);
    this.slab.visible = !underground;
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.projView);
    const riversSeen = this.extras.children.some((o) => o.userData.water && this.frustum.intersectsObject(o));
    const list = riversSeen ? [...this.waters] : [];
    if (this.waterMesh?.visible && this.waterU && this.waterInst) list.push({ u: this.waterU, inst: this.waterInst });
    this.waterUniforms = list.map((w) => w.u);
    if (!list.length) return;
    for (const w of list) { setWaterUniforms(w.u, w.inst, t); setWaterSky(w.u, this.sunDir, this.skyLook.sun, this.skyLook.top, this.skyLook.low); }
    const pass = QUALITY[this.level].water;
    if (!pass || !list.some((w) => needsDepth(w.u))) return;
    const hide: THREE.Object3D[] = [this.placedGroup, this.clouds.group, this.brushRing, this.gizmo as unknown as THREE.Object3D];
    if (this.waterMesh) hide.push(this.waterMesh);
    hide.push(this.weatherFx.group);
    if (this.nodeHandles) hide.push(this.nodeHandles); if (this.nodeLines) hide.push(this.nodeLines);
    for (const o of this.extras.children) if (o.userData.water) hide.push(o);
    for (const ch of this.chunks.values()) for (const o of ch.group.children) if ((o as THREE.InstancedMesh).isInstancedMesh) hide.push(o);
    void c;
    this.waterPass.render(this.renderer, this.scene, this.camera, list.map((w) => w.u), hide, list.some((w) => needsScene(w.u)), pass);
  }

  private rebuildExtras() {
    this.extras.clear();
    const c = this.cfg!, f = this.features!;
    // Roads: each kind its own surface (gravel, cobbles, planks, asphalt with lines...), ragged at the edges where it's loose.
    for (const road of this.roads) {
      if (road.points.length < 2) continue;
      const pts = smoothPath(road.points);
      const kind = ROAD_KINDS[road.kind] ?? ROAD_KINDS.dirt;
      if ((road.look ?? (!c.style || c.style === 'realistic' || c.style === 'mixed' ? 'realistic' : 'stylized')) === 'realistic') {
        // Realistic: a strip many vertices across, each on the ground, so it lies in the land's own shape; its surface
        // detailed and lit by its own relief; its edges feathered into the ground instead of cut.
        const t = realisticRoad(kind.surface);
        const mat = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughness: t.roughness, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
        const covered = road.snow === 'covered';
        mat.onBeforeCompile = (sh) => {
          sh.uniforms.uSnowColor = shared.uSnowColor;
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSnow; varying float vRSnow; varying vec2 vRW;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRSnow = aSnow; vRW = (modelMatrix * vec4(position, 1.0)).xz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
            uniform vec3 uSnowColor; varying float vRSnow; varying vec2 vRW;
            float rH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float rN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(rH(i), rH(i + vec2(1, 0)), f.x), mix(rH(i + vec2(0, 1)), rH(i + vec2(1, 1)), f.x), f.y); }`)
            .replace('#include <map_fragment>', `#include <map_fragment>
            // Feathered edges: the road's own material thins into the ground over the outer part of its width, ragged
            // by the surface (loose stones at the side of gravel, a crumbling asphalt edge).
            { float wE = abs(vMapUv.x * 2.0 - 1.0);
              float wN = fract(sin(dot(floor(vMapUv * vec2(40.0, 60.0)), vec2(12.9898, 78.233))) * 43758.5453);
              diffuseColor.a *= 1.0 - smoothstep(${t.edge.toFixed(2)}, 1.0, wE + (wN - 0.5) * ${t.ragged.toFixed(2)});
              // Snow on the road. ${covered ? 'Covered: snow over all of it but the packed, dirty tyre tracks.' : 'Ploughed: lumps the plough left, more toward the edges, and the surface wet and dark.'}
              if (vRSnow > 0.03) {
                float n = rN(vRW * 1.6) * 0.6 + rN(vRW * 5.0) * 0.4;
                ${covered
                  ? `float track = max(exp(-pow((vMapUv.x - 0.3) / 0.08, 2.0)), exp(-pow((vMapUv.x - 0.7) / 0.08, 2.0)));
                float cover = 1.0 - track * (0.55 + 0.3 * n);
                diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.42, 0.4, 0.38), uSnowColor * (0.88 + 0.12 * n), cover), smoothstep(0.1, 0.4, vRSnow));`
                  : `float clump = smoothstep(0.66, 0.8, n + wE * 0.25) * smoothstep(0.05, 0.4, vRSnow);
                diffuseColor.rgb = mix(diffuseColor.rgb * mix(1.0, 0.82, smoothstep(0.05, 0.4, vRSnow)), uSnowColor * (0.9 + 0.1 * n), clump);`}
              } }`);
        };
        mat.customProgramCacheKey = () => 'road-real-' + t.edge + t.ragged + (covered ? '-covered' : '');
        // (A little above the true ground: the land's mesh is straight between its points, so on a bump it rides higher.
        // A covered road rides on top of the snow.)
        const strip = roadStrip(pts, road.width * t.widthK, 10, (x, z) => this.height(x, z) + 0.15 + (covered ? this.snowDepthAt(x, z) * 0.9 : 0));
        strip.snow = []; for (let i = 0; i < strip.positions.length; i += 3) { const x = strip.positions[i], z = strip.positions[i + 2], g = this.height(x, z), sl = slopeAt(this.height, x, z, 1); strip.snow.push(snowAt(c, this.edits, x, z, g, sl.slope, sl.normal)); }
        const mesh = new THREE.Mesh(toGeometry(strip), mat);
        mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.userData.road = road.id; this.extras.add(mesh);
        continue;
      }
      const g = toGeometry(ribbonMesh(pts, () => road.width, (x, z) => this.height(x, z) + 0.12, [1, 1, 1]));
      // (Its pattern repeats about every road width along, so stones stay stone-sized however long the road.)
      const t = roadTexture(kind.surface);
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.45, roughness: kind.surface === 'asphalt' || kind.surface === 'highway' ? 0.8 : 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      mesh.receiveShadow = true; mesh.userData.road = road.id; this.extras.add(mesh);
    }
    // Rivers and lakes: the very same water as the sea (GameCraft's, ripples included), in the channels cut for them.
    this.waters = [];
    if (f.rivers.length || f.lakes.length) {
      const riverMat = gameCraftWater(c.water.color, c.water.opacity, 1);
      const u = patchWaterMaterial(riverMat);
      this.waters.push({ u, inst: { kind: 'plane', material: { surface: 'water', water: riverOptions(c.water) } } as unknown as InstanceData });
      // (Each mesh just above its own base, as the water shader only lifts what's above an object's middle.)
      const add = (m: MeshData) => {
        let low = Infinity; for (let i = 1; i < m.positions.length; i += 3) low = Math.min(low, m.positions[i]);
        for (let i = 1; i < m.positions.length; i += 3) m.positions[i] -= low - 0.02;
        const g = toGeometry(m); g.deleteAttribute('color');
        const mesh = new THREE.Mesh(g, riverMat); mesh.position.y = low - 0.02; mesh.renderOrder = 2; mesh.userData.water = true; this.extras.add(mesh);
      };
      // Rivers flow: their own copy of the water, its ripples running downstream (UVs along each river).
      const flowMat = gameCraftWater(c.water.color, c.water.opacity, 1); flowMat.normalMap = flowMat.normalMap!.clone(); flowMat.normalMap.needsUpdate = true;
      const fu = patchWaterMaterial(flowMat); this.waters.push({ u: fu, inst: this.waters[this.waters.length - 1].inst });
      // Foam streaks drawn on it, running downstream (faster where the river is steeper): the ripples alone barely read
      // as flowing.
      const prevCompile = flowMat.onBeforeCompile;
      flowMat.onBeforeCompile = (sh, rr) => {
        prevCompile.call(flowMat, sh, rr);
        sh.uniforms.uFlowT = this.flowTime;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aFlowUv; attribute float aFlow; attribute vec4 aRiv; attribute vec2 aCap; attribute float aShow; varying vec2 vFlowUv; varying float vFlow; varying vec4 vRiv; varying vec2 vCap; varying float vShow;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlowUv = aFlowUv; vFlow = aFlow; vRiv = aRiv; vCap = aCap; vShow = aShow;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          uniform float uFlowT; varying vec2 vFlowUv; varying float vFlow; varying vec4 vRiv; varying vec2 vCap; varying float vShow;
          float fH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float fN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(fH(i), fH(i + vec2(1, 0)), f.x), mix(fH(i + vec2(0, 1)), fH(i + vec2(1, 1)), f.x), f.y); }`)
          .replace('#include <opaque_fragment>', `{
            // vRiv: across (-1..1), half width (m), metres from the start, metres to the end. vCap: x the start is rounded
            // off, y the end is. vShow: 1, or less where it runs into a lake or the sea.
            float k = vRiv.x, hw = max(0.5, vRiv.y);
            float sp = 0.5 + vFlow * 2.5;
            vec2 q = vec2(vFlowUv.x * 2.2, vFlowUv.y * 0.45 - uFlowT * sp);
            float st = smoothstep(0.66, 0.9, fN(q * vec2(1.0, 0.35)) * 0.65 + fN(q * vec2(2.7, 0.9) + 7.0) * 0.35);
            outgoingLight = mix(outgoingLight, vec3(0.9, 0.95, 1.0) * max(0.6, dot(outgoingLight, vec3(0.33)) * 1.6 + 0.5), clamp(st * (0.12 + 0.55 * vFlow), 0.0, 0.7));
            // Soft banks; rounded ends where it starts on land or stops short; melting into the lake or sea it runs into.
            float show = 1.0 - smoothstep(0.86, 1.0, abs(k));
            float noiseEdge = (fN(vFlowUv * vec2(1.3, 1.3) + 3.0) - 0.5) * 0.25;
            if (vCap.x > 0.5) show *= 1.0 - smoothstep(0.75, 1.0, length(vec2(k, max(0.0, (hw * 1.4 - vRiv.z) / (hw * 1.4)))) + noiseEdge);
            if (vCap.y > 0.5) show *= 1.0 - smoothstep(0.75, 1.0, length(vec2(k, max(0.0, (hw * 1.4 - vRiv.w) / (hw * 1.4)))) + noiseEdge);
            diffuseColor.a *= show * vShow;
          }
          #include <opaque_fragment>`);
      };
      flowMat.customProgramCacheKey = () => 'river-flow';
      for (const r of f.rivers) {
        const m = riverWaterMesh(r); add(m);
        const mesh = this.extras.children[this.extras.children.length - 1] as THREE.Mesh; mesh.material = flowMat; mesh.userData.flow = true;
        // Per vertex: where along and across the river it is (UVs in metres / 4), and how steep the river is there.
        const n = mesh.geometry.getAttribute('position').count, row = n / r.points.length, fl = new Float32Array(n);
        for (let i = 0; i < r.points.length; i++) { const d = Math.max(r.levels[Math.max(0, i - 1)] - r.levels[i], r.levels[i] - r.levels[Math.min(r.points.length - 1, i + 1)]); for (let s = 0; s < row; s++) fl[i * row + s] = Math.min(1, Math.max(0, d / 2.5)); }
        mesh.geometry.setAttribute('aFlowUv', new THREE.BufferAttribute(Float32Array.from(mesh.geometry.getAttribute('uv').array as Float32Array), 2));
        mesh.geometry.setAttribute('aFlow', new THREE.BufferAttribute(fl, 1));
        // Across, width, distance from each end, rounded ends and fading into the lake or sea it joins.
        const at = riverWaterAttrs(r, f.lakes, c.water.enabled ? c.water.level : null);
        const riv = new Float32Array(n * 4), cap = new Float32Array(n * 2);
        for (let v = 0; v < n; v++) { riv[v * 4] = at.k[v]; riv[v * 4 + 1] = at.hw[v]; riv[v * 4 + 2] = at.from[v]; riv[v * 4 + 3] = at.to[v]; cap[v * 2] = at.capStart ? 1 : 0; cap[v * 2 + 1] = at.capEnd ? 1 : 0; }
        mesh.geometry.setAttribute('aRiv', new THREE.BufferAttribute(riv, 4));
        mesh.geometry.setAttribute('aCap', new THREE.BufferAttribute(cap, 2));
        mesh.geometry.setAttribute('aShow', new THREE.BufferAttribute(at.show, 1));
      }
      for (const l of f.lakes) add(lakeWaterMesh(l));
    }
    // Waterfalls where rivers drop steeply: ParticleCraft's Waterfall and Waterfall mist presets.
    if (!this.falls) { this.falls = new WaterfallFx(); this.scene.add(this.falls.group); }
    this.falls.set(c.water.enabled && c.water.waterfalls !== false ? findFalls(f.rivers) : [], c.water.color);
    // (Caves are built with each terrain chunk: see buildChunk.)
  }
  private falls: WaterfallFx | null = null;
  /** The ground's texture maps (the built-in grass, or your own: Ground texture), their tiling, and own-colours. */
  private groundU = { uDetail: { value: null as THREE.Texture | null }, uDetailN: { value: null as THREE.Texture | null }, uDetailH: { value: null as THREE.Texture | null }, uDryC: { value: null as THREE.Texture | null }, uDryN: { value: null as THREE.Texture | null }, uDryH: { value: null as THREE.Texture | null }, uGScale: { value: 0.29 }, uOwnTex: { value: 0 } };
  private builtinGround: Record<string, THREE.Texture | null> | null = null;
  private groundKey = '';
  /** Your own ground texture in place of the built-in grass (or back to it). */
  private applyGroundTex(gt: WorldConfig['surface']['groundTex']) {
    const key = JSON.stringify(gt ?? null); if (key === this.groundKey) return; this.groundKey = key;
    const U = this.groundU, B = this.builtinGround;
    if (!gt?.color) {
      if (B) for (const [k, t] of Object.entries(B)) (U as any)[k].value = t;
      U.uGScale.value = 0.29; U.uOwnTex.value = 0; return;
    }
    const t = (id: string | undefined, srgb: boolean) => { const x = id ? tex(id, { repeat: true, srgb }) : null; if (x) x.anisotropy = 8; return x; };
    const flatN = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); flatN.needsUpdate = true;
    const flatH = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); flatH.needsUpdate = true;
    const col = t(gt.color, true), nrm = t(gt.normal, false) ?? flatN, hgt = t(gt.height, false) ?? flatH;
    // (Your one texture everywhere: on green ground and on dry ground alike.)
    U.uDetail.value = col; U.uDryC.value = col; U.uDetailN.value = nrm; U.uDryN.value = nrm; U.uDetailH.value = hgt; U.uDryH.value = hgt;
    U.uGScale.value = 1 / Math.max(0.25, gt.tile ?? 3.4); U.uOwnTex.value = gt.ownColors ? 1 : 0;
  }
  private leafFall: LeafFallFx | null = null;
  /** Rivers' foam streaks: their clock. */
  private flowTime = { value: 0 };
  private caveMat: THREE.MeshStandardMaterial | null = null;
  private rockPhotoSeen = false;
  /** The snow map (see shared.uSnowMap): worked out again when the land or its snow changes, or an endless world moves on. */
  private snowMapDirty = true; private snowMapAt = 0; private snowMapCentre = new THREE.Vector2(1e9, 0);
  private updateSnowMap() {
    const c = this.cfg; if (!c || !this.height) return;
    const cam = this.camera.position, endless = c.terrain.endless;
    if (!this.snowMapDirty && !(endless && Math.hypot(cam.x - this.snowMapCentre.x, cam.z - this.snowMapCentre.y) > 200)) return;
    if (performance.now() - this.snowMapAt < 500) return;
    this.snowMapDirty = false; this.snowMapAt = performance.now();
    if (!c.snow.enabled) return; // (no snow on objects at all then)
    const w = endless ? 1000 : c.terrain.width, d = endless ? 1000 : c.terrain.depth;
    const x0 = endless ? Math.round(cam.x) - 500 : -w / 2, z0 = endless ? Math.round(cam.z) - 500 : -d / 2;
    this.snowMapCentre.set(x0 + w / 2, z0 + d / 2);
    const n = Math.min(256, Math.max(16, Math.ceil(Math.max(w, d) / 3))), px = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * w, z = z0 + ((j + 0.5) / n) * d;
      const v = Math.round(Math.min(1, Math.max(0, snowAt(c, this.edits, x, z, this.height(x, z), 0))) * 255), k = (j * n + i) * 4;
      px[k] = px[k + 1] = px[k + 2] = v; px[k + 3] = 255;
    }
    const t = new THREE.DataTexture(px, n, n); t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    const old = shared.uSnowMap.value; shared.uSnowMap.value = t; if (old.image?.width > 1) old.dispose();
    shared.uSnowBox.value.set(x0, z0, w, d);
  }

  // ------------------------------------------------------------------------------------ placed objects

  private placedSig = ''; private placedLook = '';
  /** ParticleCraft effects placed in the world, previewed live (`load` reads an effect from the exchange folder). */
  fx: FxPreview | null = null;
  private fxRefs: ParticleRef[] = [];
  setEffects(refs: ParticleRef[], load: (file: string) => Promise<string>) {
    if (!this.fx) { this.fx = new FxPreview(load); this.scene.add(this.fx.group); }
    this.fxRefs = refs;
    this.fx.sync(refs);
  }

  private setPlaced(list: Placed[]) {
    this.placed = list;
    const c = this.cfg, look = c ? JSON.stringify([c.trees, c.rocks, c.leaves, c.modelWood, c.modelLeaves, c.style, c.snow.enabled ? c.snow.icicles ?? 0 : 0]) : '';
    const sig = JSON.stringify(list) + look;
    if (sig === this.placedSig) { return; }
    this.placedSig = sig;
    // Tree settings changed: placed trees are rebuilt, so they show the new wood and leaves.
    if (look !== this.placedLook) { this.placedLook = look; this.gizmo.detach(); this.placedGroup.clear(); }
    const keep = new Set(list.map((p) => p.id));
    for (const o of [...this.placedGroup.children]) if (!keep.has(o.userData.id)) { if (this.gizmo.object === o) this.gizmo.detach(); this.placedGroup.remove(o); }
    for (const p of list) {
      let o = this.placedGroup.children.find((x) => x.userData.id === p.id);
      const look = p.asset + (p.tree?.skeleton ? '#' + hashString(JSON.stringify(p.tree.skeleton)) + (p.tree.leaves === false ? '-bare' : '') : '');
      if (o && o.userData.asset !== look) { if (this.gizmo.object === o) this.gizmo.detach(); this.placedGroup.remove(o); o = undefined; }
      if (!o) {
        o = new THREE.Group(); o.userData = { id: p.id, asset: look };
        const holder = o;
        const url = assetUrl(baseSource(p.asset));
        const res = p.tree?.skeleton && p.asset.startsWith('tree:') ? resolveTree(this.cfg!, p.asset) : null;
        if (res) {
          // Its own wood: nodes edited, or drawn by hand.
          for (const part of this.treeParts(p.tree!.leaves === false ? { ...res.cfg, leafDensity: 0 } : res.cfg, res.seed, res.style, 1, p.tree!.skeleton)) { const m = new THREE.InstancedMesh(part.geo, part.mat, 1); m.setMatrixAt(0, new THREE.Matrix4()); m.frustumCulled = false; m.castShadow = true; m.userData.placed = p.id; holder.add(m); }
        } else if (p.asset.startsWith('tree:') || p.asset.startsWith('rock:')) {
          // A generated tree or rock placed by hand: real size, in metres, drawn exactly as scattered ones are.
          const def = this.source(p.asset, p.asset.startsWith('tree:') ? 'tree' : 'rock');
          if (def) for (const part of def.parts) { const m = new THREE.InstancedMesh(part.geo, part.mat, 1); m.setMatrixAt(0, new THREE.Matrix4()); m.frustumCulled = false; m.castShadow = true; m.userData.placed = p.id; holder.add(m); }
        } else if (url) loadModel(url).then((lm) => {
          const clone = SkeletonUtils.clone(lm.scene);
          dressModel(p.asset, clone, this.cfg);
          const k = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3()).y > 60 ? 0.01 : 1; // Models authored in centimetres.
          clone.scale.setScalar(k);
          clone.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.userData.placed = p.id; } });
          holder.add(clone);
        }).catch(() => { holder.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: '#ff5566', wireframe: true }))); });
        this.placedGroup.add(o);
      }
      o.position.set(p.x, placedY(p, this.height), p.z);
      o.rotation.y = (p.ry * Math.PI) / 180;
      o.scale.setScalar(p.scale);
    }
    this.refreshNodes();
  }

  select(id: string | null) {
    this.selectedId = id;
    if (this.nodeEdit && this.nodeEdit.id !== id) this.editNodes(null);
    const o = id ? this.placedGroup.children.find((x) => x.userData.id === id) : null;
    if (this.nodeEdit) return;
    if (o) this.gizmo.attach(o); else this.gizmo.detach();
  }
  setGizmoMode(m: 'translate' | 'rotate' | 'scale') { this.gizmo.setMode(m); }
  private commitGizmo() {
    const o = this.gizmo.object; if (!o) return;
    if (o === this.nodeProxy && this.nodeEdit && this.nodePick) {
      // A tree node moved: back into the tree's own space, and the tree rebuilt from it.
      const holder = this.placedGroup.children.find((x) => x.userData.id === this.nodeEdit!.id); if (!holder) return;
      holder.updateMatrixWorld(true);
      const local = holder.worldToLocal(o.position.clone());
      this.ev.onTreeNode?.(this.nodeEdit.id, this.nodePick.b, this.nodePick.n, [local.x, local.y, local.z]);
      return;
    }
    this.ev.onMoved(o.userData.id, o.position.x, o.position.y, o.position.z, (o.rotation.y * 180) / Math.PI, o.scale.x);
  }

  // ------------------------------------------------------------------------------------ tree nodes and drawing

  /** Node editing: which placed tree, its skeleton, and how fine a wood shows handles. */
  private nodeEdit: { id: string; skeleton: TreeSkeleton; maxLevel: number } | null = null;
  private nodeHandles: THREE.InstancedMesh | null = null; private nodeLines: THREE.LineSegments | null = null;
  private nodeIndex: { b: number; n: number }[] = [];
  private nodePick: { b: number; n: number } | null = null;
  private nodeProxy = new THREE.Object3D();
  /** Shows the tree's nodes as handles (null: stop). Click one, then drag the arrows; it bends the branch there. */
  editNodes(target: { id: string; skeleton: TreeSkeleton; maxLevel?: number } | null) {
    this.nodeEdit = target ? { id: target.id, skeleton: target.skeleton, maxLevel: target.maxLevel ?? 2 } : null;
    this.nodePick = null;
    if (this.gizmo.object === this.nodeProxy) this.gizmo.detach();
    this.refreshNodes();
    if (!target) { const o = this.selectedId ? this.placedGroup.children.find((x) => x.userData.id === this.selectedId) : null; if (o) this.gizmo.attach(o); }
  }
  get editingNodes() { return this.nodeEdit?.id ?? null; }
  private refreshNodes() {
    for (const o of [this.nodeHandles, this.nodeLines]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    this.nodeHandles = null; this.nodeLines = null; this.nodeIndex = [];
    const ne = this.nodeEdit; if (!ne) return;
    const p = this.placed.find((x) => x.id === ne.id); if (p?.tree?.skeleton) ne.skeleton = p.tree.skeleton;
    const holder = this.placedGroup.children.find((x) => x.userData.id === ne.id); if (!holder) return;
    holder.updateMatrixWorld(true);
    const v = new THREE.Vector3(), pts: number[] = [];
    ne.skeleton.branches.forEach((b, bi) => {
      if (b.l > ne.maxLevel) return;
      b.p.forEach((q, ni) => {
        if (ni + 1 < b.p.length) { v.set(...q).applyMatrix4(holder.matrixWorld); pts.push(v.x, v.y, v.z); v.set(...b.p[ni + 1]).applyMatrix4(holder.matrixWorld); pts.push(v.x, v.y, v.z); }
        if (ni === 0 && b.parent >= 0) return; // (a branch's first node is where it joins: it moves with its parent)
        this.nodeIndex.push({ b: bi, n: ni });
      });
    });
    const scale = holder.scale.x;
    const r = Math.max(0.06, Math.min(0.35, (ne.skeleton.branches[0]?.r[0] ?? 0.2) * 0.9)) * scale;
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.9 }), Math.max(1, this.nodeIndex.length));
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    this.nodeIndex.forEach((ix, k) => {
      const b = ne.skeleton.branches[ix.b];
      v.set(...b.p[ix.n]).applyMatrix4(holder.matrixWorld);
      const s = b.l === 0 ? 1.25 : b.l === 1 ? 1 : 0.7;
      m4.makeScale(s, s, s).setPosition(v); mesh.setMatrixAt(k, m4);
      mesh.setColorAt(k, col.set(this.nodePick && this.nodePick.b === ix.b && this.nodePick.n === ix.n ? '#ff5a3c' : b.l === 0 ? '#ffd84a' : b.l === 1 ? '#7fd6ff' : '#b6f07a'));
    });
    mesh.count = this.nodeIndex.length; mesh.renderOrder = 20; mesh.frustumCulled = false;
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.55 }));
    lines.renderOrder = 19; lines.frustumCulled = false;
    this.nodeHandles = mesh; this.nodeLines = lines;
    this.scene.add(lines, mesh);
    if (this.nodePick && this.gizmo.object === this.nodeProxy) { const b = ne.skeleton.branches[this.nodePick.b]; if (b?.p[this.nodePick.n]) this.nodeProxy.position.set(...b.p[this.nodePick.n]).applyMatrix4(holder.matrixWorld); }
  }
  /** Picks a node handle under the pointer: it gets the move arrows. */
  private pickNode(e: PointerEvent) {
    if (!this.nodeHandles) return false;
    this.setRay(e);
    const hit = this.ray.intersectObject(this.nodeHandles, false)[0];
    if (hit?.instanceId === undefined) return false;
    this.nodePick = this.nodeIndex[hit.instanceId];
    const holder = this.placedGroup.children.find((x) => x.userData.id === this.nodeEdit!.id)!;
    const b = this.nodeEdit!.skeleton.branches[this.nodePick.b];
    if (!this.nodeProxy.parent) this.scene.add(this.nodeProxy);
    this.nodeProxy.position.set(...b.p[this.nodePick.n]).applyMatrix4(holder.matrixWorld);
    this.nodeProxy.rotation.set(0, 0, 0); this.nodeProxy.scale.set(1, 1, 1);
    this.gizmo.setMode('translate'); this.gizmo.attach(this.nodeProxy);
    this.refreshNodes();
    this.ev.onNodePicked?.(this.nodePick);
    return true;
  }
  get pickedNode() { return this.nodePick; }
  private setRay(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
  }

  /** The tree being drawn: strokes become its branches (Draw tree tool). */
  drawTree: { id: string } | null = null;
  private stroke: { pts: THREE.Vector3[]; plane: THREE.Plane; parent: number; at: number; line: THREE.Line; /** The trunk: the tree's foot (its object may not be built yet). */ foot: THREE.Vector3 | null } | null = null;
  private strokeStart(e: PointerEvent) {
    const id = this.drawTree?.id, p = id ? this.placed.find((x) => x.id === id) : null;
    const holder = id ? this.placedGroup.children.find((x) => x.userData.id === id) : null;
    if (!p || !holder) return false;
    holder.updateMatrixWorld(true);
    const sk = p.tree?.skeleton ?? { branches: [] };
    // Starts from the nearest node on screen (or the foot of the tree, for the trunk).
    const r = this.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3();
    let best = 26, parent = -1, at = 0, from = new THREE.Vector3().setFromMatrixPosition(holder.matrixWorld);
    sk.branches.forEach((b, bi) => b.p.forEach((q, ni) => {
      v.set(...q).applyMatrix4(holder.matrixWorld);
      const s = v.clone().project(this.camera), sx = (s.x * 0.5 + 0.5) * r.width + r.left, sy = (-s.y * 0.5 + 0.5) * r.height + r.top;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d < best && s.z < 1) { best = d; parent = bi; at = ni; from = v.clone(); }
    }));
    if (sk.branches.length && parent < 0) { this.ev.onMessage?.('Start a branch on a node of the tree (or right where the trunk is).'); return true; }
    this.beginStroke(from, parent, at);
    return true;
  }
  /** A stroke on the upright plane facing the camera through where it starts. */
  private beginStroke(from: THREE.Vector3, parent: number, at: number) {
    const n = new THREE.Vector3(); this.camera.getWorldDirection(n); n.y = 0; if (n.lengthSq() < 1e-4) n.set(0, 0, 1); n.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, from);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, from]), new THREE.LineBasicMaterial({ color: '#7cff6a', depthTest: false }));
    line.renderOrder = 21; line.frustumCulled = false; this.scene.add(line);
    this.stroke = { pts: [from.clone()], plane, parent, at, line, foot: parent < 0 ? from.clone() : null };
    this.controls.enabled = false;
  }
  private strokeMove(e: PointerEvent) {
    const s = this.stroke; if (!s) return;
    this.setRay(e);
    const q = new THREE.Vector3(); if (!this.ray.ray.intersectPlane(s.plane, q)) return;
    if (q.distanceTo(s.pts[s.pts.length - 1]) < 0.12) return;
    s.pts.push(q); s.line.geometry.dispose(); s.line.geometry = new THREE.BufferGeometry().setFromPoints(s.pts);
  }
  private strokeEnd() {
    const s = this.stroke; if (!s) return;
    this.stroke = null; this.scene.remove(s.line); s.line.geometry.dispose();
    const id = this.drawTree?.id, holder = id ? this.placedGroup.children.find((x) => x.userData.id === id) : null;
    if (!id || s.pts.length < 2 || (!holder && !s.foot)) return;
    holder?.updateMatrixWorld(true);
    const pts = s.pts.map((q) => { const l = holder ? holder.worldToLocal(q.clone()) : q.clone().sub(s.foot!); return [l.x, l.y, l.z] as [number, number, number]; });
    this.ev.onTreeStroke?.(id, pts, s.parent, s.at);
  }
  /** Other things already standing, so scattered objects can avoid them. */
  private obstacles() { return this.placed.map((p) => ({ x: p.x, z: p.z, r: 6 * p.scale })); }

  // ------------------------------------------------------------------------------------ sources

  /** A generated tree's meshes: wood and leaves, in its look. `skeleton`: its own edited or drawn wood. */
  private treeParts(p: TreeCfg, seed: number, style: LeafStyle | undefined, density: number, skeleton?: TreeSkeleton): SourceDef['parts'] {
    const c = this.cfg!;
    const cfg: TreeCfg = { ...p, leafDensity: p.leafDensity * density, leafSize: p.leafSize * (1 / Math.max(0.4, Math.sqrt(density))) };
    const tree = skeleton ? treeFromSkeleton(cfg, skeleton, seed) : generateTree(cfg, seed);
    const toon = style === 'toon' ? 'toon' as const : style === 'pixel' ? 'pixel' as const : undefined;
    const uv: [number, number, number] = [p.barkU ?? 1, p.barkV ?? 1, p.barkRot ?? 0];
    // Each look its own wood: photographic bark for realistic and stylized; plain brown for toon; chunky pixel bark for
    // pixel art (no photograph in either).
    const barkPic = style === 'toon' ? '' : style === 'pixel' ? 'gen:bark-pixel' : p.barkAsset;
    const wood = toGeometry(tree.wood), barkT = barkPic ? tex(barkPic, { repeat: true, uv: style === 'pixel' ? [1, 1, 0] : uv, pixel: style === 'pixel' }) : null;
    if (barkT) wood.deleteAttribute('color'); // (it carries the plain bark colour; over a picture it would darken it)
    // The whole wood set when the picture has one: relief, roughness and shading in the cracks.
    const part = (name: string) => (p.barkAsset && /_Diffuse\./.test(p.barkAsset) && !toon ? tex(p.barkAsset.replace('_Diffuse.', `_${name}.`), { repeat: true, srgb: false, uv }) : null);
    const ao = part('AO'); if (ao) ao.channel = 0;
    const woodMat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: !barkT, map: barkT, normalMap: style === 'pixel' ? null : part('Normal'), roughnessMap: style === 'pixel' ? null : part('Roughness'), aoMap: style === 'pixel' ? null : ao, roughness: barkT ? 1 : 0.95, color: barkT && style !== 'pixel' ? new THREE.Color(2.2, 2.2, 2.2) : barkT ? '#ffffff' : p.bark }), { instanced: true, foliage: 'wood', flex: true, toon });
    const parts: SourceDef['parts'] = [{ geo: wood, mat: woodMat, tris: tree.wood.indices.length / 3 }];
    if (tree.leaves.length) {
      const lm = leafMesh(tree, c.leaves, p.leafOriginal ? '#ffffff' : p.leaf);
      const lt = p.leafAsset ? tex(p.leafAsset, { pixel: p.pixelLeaves }) : null;
      const leafMat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, map: lt, alphaTest: 0.1, side: THREE.DoubleSide, roughness: 0.85, opacity: c.leaves.opacity, transparent: c.leaves.opacity < 1 }), { foliage: 'leaf', season: c.season.treeLeaves, instanced: true, lumKey: false, flex: true, toon, leafRoll: true });
      // The picture gives light and dark; the leaf colour rules give the colour (unless "own colours" is set).
      if (!p.leafOriginal && lt) grayMap(leafMat);
      parts.push({ geo: toGeometry(lm), mat: leafMat, tris: lm.indices.length / 3 });
    }
    // Icicles, in snow: hanging under the more level branches, longer and more of them with the Icicles setting.
    const ice = c.snow.enabled ? Math.max(0, Math.min(1, c.snow.icicles ?? 0)) : 0;
    const sk = skeleton ?? tree.skeleton;
    if (ice > 0 && sk) {
      const m = icicleMesh(sk, ice, seed);
      if (m.indices.length) {
        const mat = patchWorld(new THREE.MeshStandardMaterial({ color: '#d9f0ff', roughness: 0.06, metalness: 0, transparent: true, opacity: 0.8, emissive: '#1a2a38' }), { instanced: true, foliage: 'wood', flex: true });
        parts.push({ geo: toGeometry(m), mat, tris: m.indices.length / 3 });
      }
    }
    return parts;
  }

  private source(id: string, kind: ScatterLayer['kind']): SourceDef | null {
    const key = id;
    const have = this.sources.get(key);
    if (have === 'loading' || have === 'failed') return null;
    if (have) return have;
    const c = this.cfg!;
    if (id.startsWith('tree:')) {
      const res = resolveTree(c, id);
      if (!res) { this.sources.set(key, 'failed'); return null; }
      const p = res.cfg;
      const def: SourceDef = { parts: this.treeParts(p, res.seed, res.style, 1), low: this.treeParts({ ...p, levels: Math.max(1, p.levels - 1) }, res.seed, res.style, 0.3), radius: Math.max(1.5, p.height * 0.28) };
      this.sources.set(key, def);
      this.scheduleImpostor(def);
      return def;
    }
    if (id.startsWith('rock:')) {
      const res = resolveRock(c, id);
      if (!res) { this.sources.set(key, 'failed'); return null; }
      const p = res.cfg;
      const m = generateRock(p, res.seed);
      const toon = res.style === 'toon' ? 'toon' as const : res.style === 'pixel' ? 'pixel' as const : undefined;
      const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: p.lowPoly }), { instanced: true, toon, rock: res.style !== 'stylized' && !p.lowPoly });
      const lowMesh = generateRock({ ...p, detail: Math.max(0, p.detail - 2) }, res.seed);
      const def: SourceDef = { parts: [{ geo: toGeometry(m), mat, tris: m.indices.length / 3 }], low: [{ geo: toGeometry(lowMesh), mat, tris: lowMesh.indices.length / 3 }], radius: p.size };
      this.sources.set(key, def);
      return def;
    }
    if (id.startsWith('card:')) {
      // 2D cards: one that turns to the camera, or two crossed that stay put.
      const asset = id.slice(5), t = tex(asset);
      const layerFace = c.layers.some((l) => l.sources.includes(id) && l.faceCamera);
      const mat = patchWorld(new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.18, side: THREE.DoubleSide, roughness: 0.95 }), { foliage: 'grass', season: c.season.grass, billboard: layerFace, instanced: true });
      const g = layerFace ? new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0) : crossedCards();
      const def: SourceDef = { parts: [{ geo: g, mat, tris: layerFace ? 2 : 4 }], radius: 0.5, billboard: layerFace };
      this.sources.set(key, def);
      return def;
    }
    // A library or imported model: instanced part by part, scaled to a sensible size for its kind. ("@toon" after its
    // path: the same model in cartoon light.)
    const base = baseSource(id), toon = /@toon$/.test(id) ? 'toon' as const : /@pixel$/.test(id) ? 'pixel' as const : undefined;
    const url = assetUrl(base);
    if (!url) { this.sources.set(key, 'failed'); return null; }
    this.sources.set(key, 'loading');
    const rev = this.rev;
    loadModel(url).then((lm) => {
      if (rev !== this.rev) return;
      const target = { tree: 9, rock: 1.5, grass: 0.7, flower: 0.5, bush: 1.4, prop: 1, debris: 0.8 }[kind] ?? 1;
      dressModel(base, lm.scene, this.cfg);
      lm.scene.updateMatrixWorld(true);
      const dressed = new THREE.Box3().setFromObject(lm.scene).getSize(new THREE.Vector3());
      const k = dressed.y > 0 ? target / dressed.y : 1;
      const inv = new THREE.Matrix4().copy(lm.scene.matrixWorld).invert();
      const parts: SourceDef['parts'] = [];
      lm.scene.traverse((o) => {
        const m = o as THREE.Mesh; if (!m.isMesh) return;
        const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)).scale(k, k, k);
        geo.computeBoundingSphere();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        if (mats.length === 1 || !geo.groups.length) parts.push({ geo, mat: this.instanceMaterial(mats[0], kind, toon), tris: (geo.index?.count ?? geo.attributes.position.count) / 3 });
        else for (const gr of geo.groups) {
          const g2 = geo.clone(); g2.clearGroups(); g2.setDrawRange(gr.start, gr.count);
          parts.push({ geo: g2, mat: this.instanceMaterial(mats[gr.materialIndex ?? 0], kind, toon), tris: gr.count / 3 });
        }
      });
      const def: SourceDef = { parts, radius: Math.max(lm.size.x, lm.size.z) * k * 0.5 };
      this.sources.set(key, def);
      if (kind === 'tree' || kind === 'bush') this.scheduleImpostor(def);
      // Chunks built while this was loading get it now.
      for (const ck of this.chunks.values()) this.redrawKeys.add(ck.key);
    }).catch(() => { this.sources.set(key, 'failed'); });
    return null;
  }

  /** The same source with a layer's look: same geometry and pictures, materials standing still, in fall colours, or copying the ground. */
  private variantOf(def: SourceDef, v: { still: boolean; fall: number; copyGround: boolean }): SourceDef {
    if (!v.still && v.fall < 0 && !v.copyGround) return def;
    const fallColor = v.fall >= 0 ? new THREE.Color(FALL_COLORS[v.fall]).toArray() as [number, number, number] : undefined;
    const copy = (parts: SourceDef['parts']) => parts.map((p) => {
      const o = p.mat.userData.patch as PatchOpts | undefined;
      if (!o) return p;
      const living = o.foliage === 'leaf' || o.foliage === 'grass';
      if (!o.foliage && !o.far) return p; // (rocks)
      const opts: PatchOpts = { ...o, still: !!o.foliage && v.still, ...(fallColor && (living || o.far) ? { fallColor } : {}), ...(living && v.copyGround ? { copyGround: true } : {}) };
      const mat = patchWorld((p.mat as THREE.MeshStandardMaterial).clone(), opts);
      if (p.mat.userData.gray) grayMap(mat);
      if (!matVariants.has(p.mat)) matVariants.set(p.mat, []);
      matVariants.get(p.mat)!.push(mat);
      return { ...p, mat };
    });
    const key = JSON.stringify(v), all = (def.variants ??= new Map<string, SourceDef>());
    let s = all.get(key);
    if (!s) { s = { ...def, variants: undefined, parts: copy(def.parts), low: def.low && copy(def.low), far: undefined }; all.set(key, s); }
    if (def.far && !s.far) s.far = copy(def.far);
    return s;
  }

  /** Once its textures have had time to arrive, take its picture for the far distance, and use it there. */
  private scheduleImpostor(def: SourceDef) {
    const rev = this.rev;
    setTimeout(() => {
      if (rev !== this.rev || !this.running || !this.cfg?.optimize.impostors) return;
      def.far = [makeImpostor(def.parts, (t) => patchWorld(new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 }), { instanced: true, far: true }))];
      for (const c of this.chunks.values()) if (c.lod > 0 || c.trees.length) this.redrawKeys.add(c.key);
    }, 4500);
  }

  private instanceMaterial(src: THREE.Material, kind: ScatterLayer['kind'], toon?: 'toon' | 'pixel') {
    const s = src as THREE.MeshStandardMaterial;
    const isWood = src.name === 'Wood' || /trunk|bark/i.test(src.name);
    const m = new THREE.MeshStandardMaterial({ name: src.name, color: s.color, map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap, aoMap: s.aoMap, roughness: s.roughness ?? 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: s.alphaTest || (s.map && !isWood ? 0.3 : 0), vertexColors: !!(src as any).vertexColors });
    // A model may name texture files that didn't come with it: those parts take a plain colour, not black.
    // (Before the far picture is taken, and on the copies layers make of it too.)
    if (s.map && !s.map.image) setTimeout(() => { if (m.map && !m.map.image) for (const x of [m, ...(matVariants.get(m) ?? [])] as THREE.MeshStandardMaterial[]) { x.map = null; x.alphaTest = 0; if (x.color.getHex() === 0xcccccc) x.color.set('#6b5238'); x.needsUpdate = true; } }, 2500);
    const c = this.cfg!.season;
    const foliage = isWood ? 'wood' : kind === 'tree' ? 'leaf' : kind === 'grass' ? 'grass' : kind === 'bush' || kind === 'flower' ? 'leaf' : undefined;
    const season = isWood ? false : kind === 'tree' ? c.treeLeaves && /leaf|foli|green|^material/i.test(src.name || 'leaf') : kind === 'grass' ? c.grass : kind === 'bush' ? c.bushes : kind === 'flower' ? c.flowers : false;
    return patchWorld(m, { foliage, season, instanced: true, toon });
  }

  // ------------------------------------------------------------------------------------ chunks

  private grassCache = new Map<string, ReturnType<typeof scatterSquare>>();
  private placeCache = new Map<string, ReturnType<typeof scatterSquare>>();
  private meshCache = new Map<string, MeshData>();
  /** Forgets what was worked out for chunks (all, or those whose key starts with this). */
  private forget(prefix?: string) {
    for (const m of [this.grassCache, this.placeCache, this.meshCache] as Map<string, unknown>[]) {
      if (prefix === undefined) m.clear(); else for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    }
  }
  private grassQueue: { key: string; chunk: Chunk; dist: number; run: () => void }[] = [];
  /** GameCraft's culling: what's outside the view isn't drawn (shadows are still cast into it). */
  private culler = new Culler();
  private cullEntries = new Map<number, { uid: number; obj: THREE.Object3D; visual: THREE.Object3D }>();

  /** The nearest waiting squares of grass, for a few milliseconds a frame (at least one). */
  private growGrass() {
    const start = performance.now();
    let done = 0;
    while (this.grassQueue.length && (done === 0 || performance.now() - start < 5)) {
      let best = 0;
      for (let i = 1; i < this.grassQueue.length; i++) if (this.grassQueue[i].dist < this.grassQueue[best].dist) best = i;
      const g = this.grassQueue.splice(best, 1)[0];
      if (this.chunks.get(g.key) !== g.chunk) continue; // that chunk has gone or been rebuilt
      g.run(); done++;
    }
  }

  /** Full density near you, thinning to nothing at the grass distance: only the patches that matter cost anything. */
  private thinGrass() {
    const cam = this.camera.position, c = this.cfg!, up = Math.max(0, cam.y - c.terrain.baseHeight - c.terrain.height * 0.5), max = this.grassDist;
    for (const ch of this.chunks.values()) for (const m of ch.grass) {
      const g = m.userData.grass as { x: number; z: number; full: number; fine: boolean };
      const reach = g.fine ? max * 0.35 : max; // (models of hundreds of triangles only close up)
      m.count = Math.round(g.full * grassFalloff(Math.hypot(g.x - cam.x, g.z - cam.z, up), reach));
      m.visible = m.count > 0 && this.show.objects;
    }
  }

  /** A species' trees in a nearby chunk: three sets of instances (full, simpler, picture), filled by updateTreeDetail. */
  private treeDetailGroup(chunk: Chunk, group: THREE.Group, layer: ScatterLayer, def: SourceDef, items: ReturnType<typeof scatterSquare>, below: (x: number, z: number, y: number) => [number, number, number]) {
    const n = items.length, mats = new Float32Array(n * 16), colors = layer.copyGround ? new Float32Array(n * 3) : null;
    const nor = new THREE.Vector3(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
    items.forEach((it, i) => {
      nor.set(it.nx, it.ny, it.nz); q.setFromUnitVectors(UP, nor); qy.setFromAxisAngle(UP, (it.ry * Math.PI) / 180); q.multiply(qy);
      placeInstance(it, layer.kind, q); dummy.matrix.toArray(mats, i * 16);
      if (colors) { const g = below(it.x, it.z, it.y); colors[i * 3] = g[0]; colors[i * 3 + 1] = g[1]; colors[i * 3 + 2] = g[2]; }
    });
    const make = (parts: SourceDef['parts'] | undefined, shadow: boolean) => (parts ?? []).map((part) => {
      const m = new THREE.InstancedMesh(part.geo, part.mat, n);
      if (colors) m.setColorAt(0, tintColor.setRGB(1, 1, 1)); // (makes the colour buffer)
      m.count = 0; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true; m.userData.layer = layer.id; m.visible = this.show.objects;
      group.add(m); chunk.draws++;
      return m;
    });
    // Very detailed supplied models (hundreds of thousands of triangles) go full detail only right beside the camera.
    const heavy = part0Tris(def) > 20000;
    const td: TreeDetail = { items, mats, colors, bands: new Uint8Array(n).fill(255), full: make(def.parts, true), low: make(def.low, true), far: make(def.far, false), near: heavy ? 30 : Math.max(45, this.lodDist * 0.45), mid: this.lodDist * 1.1, at: new THREE.Vector3(1e9, 0, 0) };
    chunk.trees.push(td);
    chunk.instanced += n; chunk.objTris += part0Tris(def) * Math.min(n, 20);
    this.fillTreeDetail(td, this.camera.position);
  }

  /** Puts each tree into the set its distance calls for, with a little leeway at each change so they don't flicker. */
  private fillTreeDetail(td: TreeDetail, cam: THREE.Vector3) {
    td.at.copy(cam);
    const counts = [0, 0, 0], sets = [td.full, td.low, td.far];
    const has = [td.full.length > 0, td.low.length > 0, td.far.length > 0];
    for (let i = 0; i < td.items.length; i++) {
      const it = td.items[i], d = Math.hypot(it.x - cam.x, it.z - cam.z, (it.y - cam.y) * 0.5);
      let b = d < td.near ? 0 : d < td.mid ? 1 : 2;
      const prev = td.bands[i];
      if (prev !== 255 && prev !== b && Math.abs(d - (Math.min(prev, b) === 0 ? td.near : td.mid)) < 5) b = prev;
      // (What a tree lacks, it borrows from the nearer detail: no picture yet means its simpler model.)
      if (b === 2 && !has[2]) b = 1;
      if (b === 1 && !has[1]) b = d < td.mid && has[0] ? 0 : has[2] ? 2 : 0;
      td.bands[i] = b;
      const at = counts[b]++;
      for (const m of sets[b]) {
        (m.instanceMatrix.array as Float32Array).set(td.mats.subarray(i * 16, i * 16 + 16), at * 16);
        if (td.colors && m.instanceColor) (m.instanceColor.array as Float32Array).set(td.colors.subarray(i * 3, i * 3 + 3), at * 3);
      }
    }
    sets.forEach((s, b) => { for (const m of s) { m.count = counts[b]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } });
  }

  /** Every frame: the trees near where the camera has moved choose their detail again. */
  private updateTreeDetail() {
    const cam = this.camera.position;
    for (const ch of this.chunks.values()) for (const td of ch.trees) if (td.at.distanceToSquared(cam) > 2.25) this.fillTreeDetail(td, cam);
  }

  private lodFor(cx: number, cz: number, cam: THREE.Vector3) {
    // (Height counts: from high above, a chunk straight below is still far away.)
    const t = this.cfg!.terrain, x = (cx + 0.5) * t.chunkSize, z = (cz + 0.5) * t.chunkSize, d = Math.hypot(x - cam.x, z - cam.z, Math.max(0, cam.y - t.baseHeight - t.height * 0.5));
    return d < this.lodDist ? 0 : d < this.lodDist * 2.2 ? 1 : 2;
  }

  private buildChunk(cx: number, cz: number, lod: number): Chunk {
    const c = this.cfg!, t = c.terrain, key = `${cx},${cz}`;
    const group = new THREE.Group(); group.name = 'chunk ' + key;
    const res = Math.max(4, Math.round(t.resolution / 2 ** lod));
    const voxel = c.voxel.enabled && c.voxel.target !== 'objects';
    // (Coming back to a detail it had a moment ago, a chunk reuses its land: moving the camera changes detail often.)
    const meshKey = `${key}|${res}`;
    let data = this.meshCache.get(meshKey);
    if (!data) { data = terrainChunk(c, this.edits, this.features!, this.height, cx, cz, res, lod, true); if (this.meshCache.size > 64) this.meshCache.delete(this.meshCache.keys().next().value!); this.meshCache.set(meshKey, data); }
    // (The Max / Min readout: the top surface, not the skirt hanging below it.)
    { const top = (res + 1) * (res + 1); if (!voxel) for (let k = 0; k < top; k++) { const y = data.positions[k * 3 + 1]; if (y > this.heights.max) this.heights.max = y; if (y < this.heights.min) this.heights.min = y; } }
    const terrain = new THREE.Mesh(toGeometry(data), this.terrainMat);
    (terrain as any).ownsGeometry = true;
    terrain.receiveShadow = true; terrain.castShadow = lod === 0; terrain.userData.terrain = true;
    if (voxel && c.voxel.smooth) terrain.geometry.computeVertexNormals();
    group.add(terrain);
    // The caves under this chunk: rock walls seen from inside (and through the openings where tunnels reach the surface).
    const caveData = (data as MeshData & { cave?: MeshData }).cave;
    if (caveData && c.cave.enabled) {
      const smooth = (c.cave.style ?? 'smooth') === 'smooth';
      if (!this.caveMat || this.caveMat.flatShading === smooth) this.caveMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: smooth ? 0.9 : 1, side: THREE.DoubleSide, flatShading: !smooth });
      const cave = new THREE.Mesh(toGeometry(caveData), this.caveMat);
      (cave as any).ownsGeometry = true; cave.receiveShadow = true; cave.castShadow = lod === 0; cave.userData.cave = true;
      group.add(cave);
    }
    const chunk: Chunk = { key, cx, cz, lod, group, terrain, tris: data.indices.length / 3, objects: 0, instanced: 0, objTris: 0, draws: 1, sig: '', grass: [], trees: [] };
    const x0 = cx * t.chunkSize, z0 = cz * t.chunkSize;
    const cam = this.camera.position;
    const dist = Math.hypot(x0 + t.chunkSize / 2 - cam.x, z0 + t.chunkSize / 2 - cam.z, Math.max(0, cam.y - t.baseHeight - t.height * 0.5));
    const ctx = { cfg: c, edits: this.edits, height: this.height, obstacles: this.obstacles(), water: this.features!.water, onRoad: this.features!.onRoad };
    /** A layer over the chunk, or (grass) over one square of it: `sub` is that square's corner and size. */
    const buildLayer = (layer: ScatterLayer, sub: [number, number, number] = [x0, z0, t.chunkSize]) => {
      // Distance: fewer small things further out; the same ones, since density thins the same grid.
      const l: ScatterLayer = this.densityScale !== 1 ? { ...layer, density: layer.density * this.densityScale } : layer;
      // Worked out once a chunk, every layer: where things stand doesn't depend on detail, so a chunk changing detail
      // as the camera moves only redraws them.
      const cacheKey = `${key}|${layer.id}|${sub[0]},${sub[1]}`, grass = layer.kind === 'grass', cache = grass ? this.grassCache : this.placeCache;
      let list = cache.get(cacheKey);
      if (!list) {
        list = scatterSquare(ctx, l, sub[0], sub[1], sub[2]);
        if (this.edits?.removed.length) { const gone = new Set(this.edits.removed); list = list.filter((i) => !gone.has(i.uid)); }
        // Grass in random order, so showing only the first part of a patch far away thins it evenly.
        if (grass) list.sort((a, b) => a.tint - b.tint);
        if (cache.size > (grass ? 1500 : 600)) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, list);
      }
      if (layer.avoid) for (const i of list) if (i.scale) ctx.obstacles.push({ x: i.x, z: i.z, r: 2 * i.scale });
      if (!list.length) return;
      const colorAt = new Map<number, [number, number, number]>();
      const below = (x: number, z: number, y: number) => {
        const k = (Math.floor(x / 2.5) + 1048576) * 2097152 + (Math.floor(z / 2.5) + 1048576);
        // (The green underneath, not the rock or snow: grass growing between rocks is still green.)
        let g = colorAt.get(k); if (!g) { g = groundColor(c, this.edits, x, z, y, 0, { plants: true }); colorAt.set(k, g); }
        return g;
      };
      const bySource = new Map<string, typeof list>();
      // (Away from the camera one shape per species is enough: the random shapes would each cost a draw call for a picture
      // a few pixels wide.)
      // Trees and bushes in nearby chunks choose their detail one by one, as the camera moves (see updateTreeDetail): a
      // tree beside you is always its full model, never its picture, whichever chunk it stands in.
      const dynamic = (layer.kind === 'tree' || layer.kind === 'bush') && lod <= 1;
      for (const i of list) { const k = `${fallIndex(layer, i.tint)}|${lod > 0 && !dynamic ? i.source.replace(/~\d+$/, '') : i.source}`; let a = bySource.get(k); if (!a) { a = []; bySource.set(k, a); } a.push(i); }
      for (const [k, items] of bySource) {
        const fall = Number(k.slice(0, k.indexOf('|'))), src = k.slice(k.indexOf('|') + 1);
        const plain = this.source(src, layer.kind);
        if (!plain) continue;
        const def = this.variantOf(plain, { still: layer.moves === false, fall, copyGround: !!layer.copyGround });
        if (dynamic) { this.treeDetailGroup(chunk, group, layer, def, items, below); chunk.objects += items.length; continue; }
        // Near: full detail. Middle: a simpler model where there is one. Far: its picture on crossed cards.
        // Middle distance: the simpler model only while it really is light; a forest of heavier ones goes as pictures.
        const lowLight = !!def.low && part0Tris({ parts: def.low } as SourceDef) <= 3500;
        const parts = (lod >= 2 || (lod === 1 && !lowLight)) && def.far ? def.far : lod > 0 && def.low ? def.low : def.parts;
        const up = new THREE.Vector3(0, 1, 0), nor = new THREE.Vector3(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
        // Very detailed models (a single supplied tree can be 400,000 triangles): full detail only for the few right by
        // the camera, the rest as their picture, even in a near chunk. Moving the camera rebuilds as chunks change detail.
        const heavy = def.far && parts === def.parts && part0Tris(def) > 20000;
        const sorted = heavy ? [...items].sort((a, b) => (a.x - cam.x) ** 2 + (a.z - cam.z) ** 2 - ((b.x - cam.x) ** 2 + (b.z - cam.z) ** 2)) : items;
        const fullCount = heavy ? sorted.filter((it, n) => n < 3 && Math.hypot(it.x - cam.x, it.z - cam.z) < 70).length : items.length;
        let passes: [typeof parts, typeof items][] = heavy ? [[parts, sorted.slice(0, fullCount)], [def.far!, sorted.slice(fullCount)]] : [[parts, items]];
        // Grass in patches: each is culled by itself when you look away, and thinned by itself with distance.
        if (layer.kind === 'grass') {
          const cells = new Map<number, typeof items>();
          for (const it of items) { const ck = Math.floor((it.x - x0) / 24) * 1000 + Math.floor((it.z - z0) / 24); let a = cells.get(ck); if (!a) { a = []; cells.set(ck, a); } a.push(it); }
          passes = [...cells.values()].map((a) => [parts, a]);
        }
        for (const [useParts, useItems] of passes) if (useItems.length) for (const part of useParts) {
          const mesh = new THREE.InstancedMesh(part.geo, part.mat, useItems.length);
          useItems.forEach((it, n) => {
            nor.set(it.nx, it.ny, it.nz); q.setFromUnitVectors(up, nor);
            qy.setFromAxisAngle(up, (it.ry * Math.PI) / 180); q.multiply(qy);
            // (A billboard turns itself to the camera in the shader; rotating the instance too would undo that.)
            if (def.billboard) q.identity();
            placeInstance(it, layer.kind, q);
            mesh.setMatrixAt(n, dummy.matrix);
            if (layer.copyGround) { const g = below(it.x, it.z, it.y); mesh.setColorAt(n, tintColor.setRGB(g[0], g[1], g[2])); }
          });
          mesh.castShadow = layer.kind !== 'grass' && lod === 0; mesh.receiveShadow = true; // (grass in shade must match the shaded ground)
          mesh.userData.layer = layer.id;
          mesh.computeBoundingSphere(); // (for the view culling; made now, while it holds every instance)
          mesh.visible = this.show.objects;
          if (layer.kind === 'grass') {
            const first = useItems[0];
            mesh.userData.grass = { x: Math.floor((first.x - x0) / 24) * 24 + x0 + 12, z: Math.floor((first.z - z0) / 24) * 24 + z0 + 12, full: useItems.length, fine: part.tris > 40 };
            chunk.grass.push(mesh);
          }
          group.add(mesh);
          chunk.draws++; chunk.instanced += useItems.length; chunk.objTris += part.tris * useItems.length;
        }
        chunk.objects += items.length;
      }
    };
    // Instances per source. A finite world is seen whole, so its trees always stand: far ones are only picture cards.
    if (dist < this.cullDist || !t.endless) for (const layer of c.layers) {
      if (!layer.enabled) continue;
      if (layer.kind === 'grass' && dist > this.grassDist + t.chunkSize) continue;
      if (dist > this.cullDist && layer.kind !== 'tree') continue;
      if ((layer.kind === 'flower' || layer.kind === 'debris') && lod > 0) continue;
      // Grass comes a moment later, a square of about 32 m at a time (nearest first), so moving never waits for it.
      if (layer.kind === 'grass') {
        const n = Math.max(1, Math.ceil(t.chunkSize / 32)), s = t.chunkSize / n;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          const sx = x0 + i * s, sz = z0 + j * s, d = Math.hypot(sx + s / 2 - cam.x, sz + s / 2 - cam.z, Math.max(0, cam.y - t.baseHeight - t.height * 0.5));
          if (d > this.grassDist + s) continue;
          this.grassQueue.push({ key, chunk, dist: d, run: () => buildLayer(layer, [sx, sz, s]) });
        }
      } else buildLayer(layer);
    }
    // Structures.
    for (const sp of c.spawns) {
      for (const st of structuresInSquare(ctx, sp, x0, z0, t.chunkSize)) {
        if (sp.persistent && this.edits?.removed.includes(st.uid)) continue;
        const holder = new THREE.Group(); holder.position.set(st.x, st.y, st.z); holder.rotation.y = (st.ry * Math.PI) / 180; holder.scale.setScalar(st.scale);
        holder.userData.structure = st.uid;
        group.add(holder);
        const url = assetUrl(st.asset);
        if (url) loadModel(url).then((lm) => { const k = lm.size.y > 60 ? 0.01 : 1; const cl = SkeletonUtils.clone(lm.scene); cl.scale.setScalar(k); cl.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); holder.add(cl); }).catch(() => undefined);
        chunk.objects++; chunk.draws++;
      }
    }
    group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh || o.userData.structure) o.visible = this.show.objects; });
    this.world.add(group);
    return chunk;
  }

  private stream(dt: number) {
    const c = this.cfg; if (!c || !this.features) return 0;
    const t = c.terrain, cam = this.controls.target;
    const want = chunksAround(t, cam.x, cam.z);
    const wantKeys = new Set(want.map(([a, b]) => `${a},${b}`));
    let built = 0;
    // A few milliseconds of building a frame (at least one chunk), so moving round never stalls the view: a chunk can
    // take a tenth of a second, and several at once were whole seconds.
    const start = performance.now(), over = () => built > 0 && !this.noBudget && performance.now() - start > 8;
    // Dirty first (the brush is being used), then redraws (a model or far picture arrived), then nearest missing, then detail changes.
    for (const key of [...this.dirtyKeys]) {
      if (built >= Math.max(this.buildCap, 2) || over()) break;
      this.dirtyKeys.delete(key); this.redrawKeys.delete(key);
      this.forget(key + '|'); // (painted or sculpted: what stands here changes)
      const old = this.chunks.get(key); if (!old) continue;
      const n = this.buildChunk(old.cx, old.cz, old.lod); this.freeChunk(old); this.chunks.set(key, n); built++;
    }
    // Redraws nearest first; each old chunk stays in view until its replacement (land from the worker included) is ready.
    const camP = this.camera.position, nearFirst = [...this.redrawKeys].map((key) => ({ key, ch: this.chunks.get(key) })).filter((x) => { if (!x.ch) this.redrawKeys.delete(x.key); return !!x.ch; })
      .sort((a, b) => Math.hypot(a.ch!.cx * t.chunkSize - camP.x, a.ch!.cz * t.chunkSize - camP.z) - Math.hypot(b.ch!.cx * t.chunkSize - camP.x, b.ch!.cz * t.chunkSize - camP.z));
    // (All their land is asked for now, nearest first, so the workers keep busy while the frame budget paces the building.)
    for (const { ch } of nearFirst) this.landReady(ch!.cx, ch!.cz, this.lodFor(ch!.cx, ch!.cz, camP));
    for (const [a, b] of want) if (!this.chunks.has(`${a},${b}`)) this.landReady(a, b, this.lodFor(a, b, camP));
    for (const { key, ch: old } of nearFirst) {
      if (built >= this.buildCap || over()) break;
      const lod = this.lodFor(old!.cx, old!.cz, camP);
      if (!this.landReady(old!.cx, old!.cz, lod)) continue;
      this.redrawKeys.delete(key);
      const n = this.buildChunk(old!.cx, old!.cz, lod); this.freeChunk(old!); this.chunks.set(key, n); built++;
    }
    for (const [a, b] of want) {
      if (built >= this.buildCap || over()) break;
      const key = `${a},${b}`, have = this.chunks.get(key), lod = this.lodFor(a, b, this.camera.position);
      if (have && have.lod === lod) continue;
      // (Its land comes from the worker: until then, an old chunk stays as it is and a new one waits.)
      if (!this.landReady(a, b, lod)) continue;
      const n = this.buildChunk(a, b, lod);
      if (have) this.freeChunk(have);
      this.chunks.set(key, n); built++; this.redrawKeys.delete(key);
    }
    // Recycle what is past the load radius plus its margin (a finite world that shrank: what's now outside it).
    for (const [key, ch] of this.chunks) {
      if (wantKeys.has(key)) continue;
      const d = Math.hypot(ch.cx - cam.x / t.chunkSize, ch.cz - cam.z / t.chunkSize);
      if (!t.endless || d > t.viewChunks + t.unloadMargin + 1) { this.freeChunk(ch); this.chunks.delete(key); this.redrawKeys.delete(key); }
    }
    void dt;
    const missing = want.filter(([a, b]) => !this.chunks.has(`${a},${b}`)).length;
    // A new layout has covered the view: the old chunks kept on show can go.
    if (this.retired.size && missing === 0) this.dropRetired();
    return missing + this.redrawKeys.size;
  }

  /** Blocks until every chunk in view is built: used by tests and export. */
  buildAll() { let guard = 0; const cap = this.buildCap; this.buildCap = 10000; this.noBudget = true; while (this.stream(0) > 0 && guard++ < 50); this.buildCap = cap; this.noBudget = false; }
  private noBudget = false;

  // ------------------------------------------------------------------------------------ terrain worker

  /**
   * Build terrain meshes off the main thread, several at once (one per spare processor core, up to four). Null: they
   * couldn't start, so meshes are built here.
   */
  private workers: Worker[] = (() => {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)), out: Worker[] = [];
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.fromWorker(e.data);
        w.onerror = () => { this.workers = []; this.worker = null; this.workerPending.clear(); };
        out.push(w);
      }
    } catch { for (const w of out) w.terminate(); return []; }
    return out;
  })();
  private worker: { postMessage(m: unknown): void; terminate(): void } | null = this.workers.length ? {
    // (Chunk jobs go round the pool; the world goes to all of them.)
    postMessage: (m: any) => { if (m.type === 'world') for (const w of this.workers) w.postMessage(m); else this.workers[this.nextWorker++ % this.workers.length]?.postMessage(m); },
    terminate: () => { for (const w of this.workers) w.terminate(); },
  } : null;
  private nextWorker = 0;
  private workerRev = 0; private workerPending = new Set<string>();
  /** The worker gets the world as it is now: settings, roads and hand edits. Anything it was still building is dropped. */
  private postWorld() {
    if (!this.worker || !this.cfg) return;
    this.workerRev++; this.workerPending.clear();
    try { this.worker.postMessage({ type: 'world', rev: this.workerRev, cfg: this.cfg, edits: this.edits, roads: this.roads }); } catch { this.worker = null; }
  }
  private fromWorker(m: { type: string; key: string; rev: number; data?: MeshData }) {
    this.workerPending.delete(m.key);
    if (m.type !== 'chunk' || m.rev !== this.workerRev || !m.data) return;
    if (this.meshCache.size > 64) this.meshCache.delete(this.meshCache.keys().next().value!);
    this.meshCache.set(m.key, m.data);
  }
  /** Is this chunk's land ready to build at this detail? If not, it's asked for and the chunk waits. */
  private landReady(cx: number, cz: number, lod: number) {
    if (!this.worker || this.noBudget || !this.cfg) return true;
    const res = Math.max(4, Math.round(this.cfg.terrain.resolution / 2 ** lod)), key = `${cx},${cz}|${res}`;
    if (this.meshCache.has(key)) return true;
    if (!this.workerPending.has(key)) { this.workerPending.add(key); this.worker.postMessage({ type: 'chunk', key, rev: this.workerRev, cx, cz, res, lod }); }
    return false;
  }
  /** Chunks to draw again as they are (a model or far picture arrived), without working anything out again. */
  private redrawKeys = new Set<string>();

  private frame() {
    if (!this.running) return;
    const dt = Math.min(0.1, this.clock.getDelta()), t = this.clock.elapsedTime;
    this.autoQuality(dt);
    if (this.walker) this.stepWalk(dt); else this.controls.update();
    shared.uTime.value = t; shared.uCam.value.copy(this.camera.position);
    // The rock photo arriving: far picture cards baked before it would stay black, so the models and cards are redone.
    if (!this.rockPhotoSeen && shared.uRockPhoto.value?.image) { this.rockPhotoSeen = true; this.sources.clear(); this.rev++; for (const k of this.chunks.keys()) this.redrawKeys.add(k); }
    this.updateSnowMap();
    const missing = this.stream(dt);
    const c = this.cfg;
    if (c) {
      const sea = seasonAt(c.season, t / 60);
      const a = seasonPalette(sea.a), b = seasonPalette(sea.b);
      for (let i = 0; i < 4; i++) { shared.uPalA.value[i].setRGB(a[i][0], a[i][1], a[i][2], THREE.SRGBColorSpace); shared.uPalB.value[i].setRGB(b[i][0], b[i][1], b[i][2], THREE.SRGBColorSpace); }
      shared.uBlend.value = sea.blend;
      shared.uGrassA.value.set(GRASS_SEASON[sea.a]); shared.uGrassB.value.set(GRASS_SEASON[sea.b]);
      // Shadows follow the view.
      const tg = this.controls.target, span = Math.max(80, this.camera.position.distanceTo(tg) * 1.3);
      const sc = this.sun.shadow.camera;
      if (sc.right !== span) { sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.far = span * 6; sc.updateProjectionMatrix(); }
      this.sun.position.copy(tg).addScaledVector(this.sunDir, span * 2.5); this.sun.target.position.copy(tg); this.sun.target.updateMatrixWorld();
      if (this.waterMesh?.visible) {
        const nm = (this.waterMesh.material as THREE.MeshStandardMaterial).normalMap;
        if (c.terrain.endless) {
          const size = 4000, snap = size / 160;
          this.waterMesh.scale.set(size, 1, size);
          this.waterMesh.position.set(Math.round(this.camera.position.x / snap) * snap, c.water.level - 0.5, Math.round(this.camera.position.z / snap) * snap);
          // (The ripples stay put in the world while the sea follows the camera.)
          nm?.repeat.set(size / WATER_RIPPLES.metres, size / WATER_RIPPLES.metres);
          nm?.offset.set(this.waterMesh.position.x / WATER_RIPPLES.metres + t * 0.02 * WATER_RIPPLES.speed, -this.waterMesh.position.z / WATER_RIPPLES.metres + t * 0.013 * WATER_RIPPLES.speed);
        } else { this.waterMesh.scale.set(c.terrain.width, 1, c.terrain.depth); this.waterMesh.position.set(0, c.water.level - 0.5, 0); nm?.repeat.set(c.terrain.width / WATER_RIPPLES.metres, c.terrain.depth / WATER_RIPPLES.metres); nm?.offset.set(t * 0.02 * WATER_RIPPLES.speed, t * 0.013 * WATER_RIPPLES.speed); }
      }
      // GameCraft's ripples drift slowly over rivers and lakes too.
      // (Rivers: downstream, at about a walking pace; their UVs run along the river, V downstream.)
      for (const o of this.extras.children) if (o.userData.water) { const nm = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).normalMap; if (o.userData.flow) nm?.offset.set(t * 0.004, -t * 0.32 * WATER_RIPPLES.speed); else nm?.offset.set(t * 0.02 * WATER_RIPPLES.speed, t * 0.013 * WATER_RIPPLES.speed); }
      const wind = shared.uWind.value;
      // The sky: dome round the camera; over a finite block seen from high up, it fades to the table's colour.
      const skySpan = c.terrain.endless ? 1400 : Math.max(c.terrain.width, c.terrain.depth) / 2;
      this.dome.position.copy(this.camera.position); this.dome.scale.setScalar(Math.min(4000, this.camera.far * 0.8));
      const finite = !c.terrain.endless && this.show.slab;
      const k = finite ? THREE.MathUtils.smoothstep(this.camera.position.y - c.terrain.baseHeight, skySpan * 0.3, skySpan * 0.8) : 0;
      const du = this.dome.material.uniforms;
      du.top.value.copy(this.domeTop.setRGB(0.275, 0.353, 0.518)).lerp(this.domeA.copy(this.skyLook.top).convertLinearToSRGB(), 1 - k);
      du.horizon.value.copy(this.domeTop).lerp(this.domeA.copy(this.skyLook.low).convertLinearToSRGB(), 1 - k);
      this.clouds.update(this.cloudSettings(), { camera: this.camera.position, centre: c.terrain.endless ? this.camera.position : ORIGIN, span: skySpan, dt, windX: wind.x * 2.2 * wind.z, windZ: wind.y * 2.2 * wind.z, sun: this.sunDir, sunColor: this.skyLook.sun, sunStrength: this.skyLook.sunUp, skyTop: this.domeA.copy(this.skyLook.top).lerp(WHITE, 0.3), skyLow: this.domeB.copy(this.skyLook.low).multiplyScalar(0.45) });
      this.clouds.group.visible = this.show.clouds && c.weather.clouds > 0;
      { const w = c.weather, a = (w.windDirection * Math.PI) / 180; this.weatherFx.update(this.fall.preset, this.fall.amount, { time: t, dt, camera: this.camera, pixelHeight: this.renderer.domElement.height, windDir: a, windSpeed: w.windSpeed * w.windStrength, splashes: w.splashes !== false, ground: this.height, floor: c.water.enabled ? c.water.level : -1e9 }); }
      this.prepareWater(t, c);
    }
    if (this.painting) this.paintTick(dt);
    this.growGrass();
    if (this.fx) {
      const wv = shared.uWind.value, h = this.renderer.domElement.height, fov = (this.camera.fov * Math.PI) / 180;
      this.fx.update(dt, h / (2 * Math.tan(fov / 2)), { x: wv.x, z: wv.y, strength: wv.z }, this.fxRefs);
    }
    this.flowTime.value += dt;
    // Falling leaves under the trees round the camera (Weather › Falling leaves).
    if (this.cfg) {
      const c = this.cfg, w = c.weather, on = !!w.leaves && this.show.objects;
      if (on && !this.leafFall) { this.leafFall = new LeafFallFx(); this.scene.add(this.leafFall.group); }
      if (this.leafFall) {
        const h = this.renderer.domElement.height, fov = (this.camera.fov * Math.PI) / 180;
        const amount = (w.leafAmount ?? 1) * (c.season?.enabled && c.season.season === 'autumn' ? 2 : c.season?.enabled && c.season.season === 'winter' ? 0.2 : 1);
        this.leafFall.update(dt, h / (2 * Math.tan(fov / 2)), this.camera.position, on, amount, LeafFallFx.presetFor(c.style, w.windSpeed * w.windStrength > 6), () => {
          const treeLayers = new Set(c.layers.filter((l) => l.kind === 'tree' && l.enabled).map((l) => l.id)), out: { x: number; y: number; z: number; scale: number; colors?: string[]; image?: string | null }[] = [];
          // Each tree's own leaf colours and picture (generated trees), so its falling leaves match it.
          const looks = new Map<string, { colors?: string[]; image?: string | null }>();
          const lookOf = (src: string) => {
            let L = looks.get(src); if (L) return L;
            const res = resolveTree(c, src);
            if (!res || res.cfg.leafDensity <= 0) L = {};
            else {
              const hex = (v: [number, number, number]) => '#' + v.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
              const leafCol = res.cfg.leafOriginal ? '#ffffff' : res.cfg.leaf;
              L = { colors: [0.1, 0.4, 0.7, 0.95].map((roll, k) => hex(leafColorOf(c.leaves, leafCol, roll, 0.3 + k * 0.15))), image: res.cfg.leafAsset ? assetUrl(res.cfg.leafAsset) : null };
            }
            looks.set(src, L); return L;
          };
          for (const [k, list] of this.placeCache) if (treeLayers.has(k.split('|')[1])) for (const it of list) out.push({ x: it.x, y: it.y, z: it.z, scale: it.scale, ...lookOf(it.source) });
          return out;
        });
      }
    }
    if (this.falls?.count) { const h = this.renderer.domElement.height, fov = (this.camera.fov * Math.PI) / 180; this.falls.enabled = this.show.objects; this.falls.update(dt, h / (2 * Math.tan(fov / 2)), this.camera.position); }
    if (this.cfg) {
      this.thinGrass();
      this.updateTreeDetail();
      // Prints in the snow fill in over time.
      this.trail.update(dt, this.cfg.snow.trackLife ?? 60, this.cfg.snow.recovery ?? 0.5);
      this.cullEntries.clear();
      for (const ch of this.chunks.values()) { const uid = this.cullEntries.size + 1; this.cullEntries.set(uid, { uid, obj: ch.group, visual: ch.group }); }
      this.culler.update(this.cullEntries, this.camera, null, { ...DEFAULT_RENDER, lod: false, frustum: this.cfg.optimize.frustum !== false }, this.renderer);
    }
    this.renderer.render(this.scene, this.camera);
    this.drawnTris = this.renderer.info.render.triangles;
    for (const u of this.waterUniforms) { u.uHasDepth.value = 0; u.uHasScene.value = 0; }
    this.frames++; this.fpsT += dt;
    if (this.fpsT >= 0.5) { this.fps = Math.round(this.frames / this.fpsT); this.frames = 0; this.fpsT = 0; this.emitStats(missing); }
  }

  private drawnTris = 0;
  private emitStats(missing: number) {
    let tris = 0, objects = 0, inst = 0, objTris = 0, draws = 0;
    for (const c of this.chunks.values()) { tris += c.tris; objects += c.objects; inst += c.instanced; objTris += c.objTris; draws += c.draws; }
    const mem = (tris * 3 * 44 + inst * 80) / 1048576;
    this.ev.onStats({ chunks: this.chunks.size, terrainTriangles: tris, objects, instanced: inst, objectTriangles: objTris, drawCalls: draws, memoryMb: Math.round(mem), building: missing, fps: this.fps, drawnTriangles: this.drawnTris });
  }

  // ------------------------------------------------------------------------------------ input

  private hitGround(e: PointerEvent): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    // March along the ray against the height function: works for every chunk, loaded or not.
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    let t = 0, prev = 0;
    for (let i = 0; i < 400; i++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y < this.height(x, z)) {
        for (let k = 0; k < 8; k++) { const m = (prev + t) / 2; if (o.y + d.y * m < this.height(o.x + d.x * m, o.z + d.z * m)) t = m; else prev = m; }
        return new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
      }
      prev = t; t += Math.max(0.5, t * 0.012);
      if (t > 3000) break;
    }
    return null;
  }

  private paintXZ: THREE.Vector3 | null = null;
  // ------------------------------------------------------------------------------------ walking the world

  /** First-person preview, at GameCraft's player scale: eye height 1.7 m, walking on the same height function. */
  private walker: { yaw: number; pitch: number; vy: number; eye: number; keys: Set<string>; onEnd: () => void; back: [THREE.Vector3, THREE.Vector3]; fov: number; near: number } | null = null;
  get walking() { return !!this.walker; }
  startWalk(onEnd: () => void) {
    if (this.walker || !this.cfg) return;
    const tg = this.controls.target, cam = this.camera;
    // Where the camera looks, on the ground; facing the way the view faces.
    const dir = new THREE.Vector3().subVectors(tg, cam.position);
    const x = this.cfg.terrain.endless ? tg.x : Math.max(-this.cfg.terrain.width / 2 + 2, Math.min(this.cfg.terrain.width / 2 - 2, tg.x));
    const z = this.cfg.terrain.endless ? tg.z : Math.max(-this.cfg.terrain.depth / 2 + 2, Math.min(this.cfg.terrain.depth / 2 - 2, tg.z));
    this.walker = { yaw: Math.atan2(-dir.x, -dir.z), pitch: 0, vy: 0, eye: 1.7, keys: new Set(), onEnd, back: [cam.position.clone(), tg.clone()], fov: cam.fov, near: cam.near };
    this.controls.enabled = false; this.gizmo.detach(); this.brushRing.visible = false;
    cam.position.set(x, this.height(x, z) + 1.7, z); cam.fov = 70; cam.near = 0.1; cam.updateProjectionMatrix();
    document.addEventListener('keydown', this.walkKey); document.addEventListener('keyup', this.walkKey); document.addEventListener('mousemove', this.walkLook); document.addEventListener('pointerlockchange', this.walkLock);
    // Pointer lock can be refused (embedded previews): dragging looks round instead.
    try { (this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => undefined); } catch { /* drag to look */ }
  }
  stopWalk() {
    const w = this.walker; if (!w) return;
    this.walker = null;
    document.removeEventListener('keydown', this.walkKey); document.removeEventListener('keyup', this.walkKey); document.removeEventListener('mousemove', this.walkLook); document.removeEventListener('pointerlockchange', this.walkLock);
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    const cam = this.camera;
    cam.position.copy(w.back[0]); this.controls.target.copy(w.back[1]); cam.fov = w.fov; cam.near = w.near; cam.updateProjectionMatrix();
    this.controls.enabled = true; this.lastTarget.set(1e9, 0, 0);
    w.onEnd();
  }
  private locked = false;
  private walkLock = () => { const on = document.pointerLockElement === this.renderer.domElement; if (this.locked && !on) this.stopWalk(); this.locked = on; };
  private walkKey = (e: KeyboardEvent) => {
    const w = this.walker; if (!w) return;
    if (e.code === 'Escape' && e.type === 'keydown') { this.stopWalk(); return; }
    if (e.type === 'keydown') w.keys.add(e.code); else w.keys.delete(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  };
  private walkLook = (e: MouseEvent) => {
    const w = this.walker; if (!w) return;
    if (document.pointerLockElement !== this.renderer.domElement && !e.buttons) return;
    w.yaw -= e.movementX * 0.0024; w.pitch = Math.max(-1.45, Math.min(1.45, w.pitch - e.movementY * 0.0024));
  };
  /** Moves the walker, or a test script's keys. */
  walkKeys(keys: string[]) { if (this.walker) this.walker.keys = new Set(keys); }
  private stepWalk(dt: number) {
    const w = this.walker!, cam = this.camera, c = this.cfg!, k = w.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0), s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const groundAt = this.height(cam.position.x, cam.position.z);
    const water = c.water.enabled ? c.water.level : -Infinity;
    const swimming = groundAt + 1.2 < water && cam.position.y - 1.7 < water - 0.9;
    // Snow underfoot: how deep it is here, and what it does to walking (deep snow slows you, by Deep snow slows by).
    const snowHere = this.snowDepthAt(cam.position.x, cam.position.z, groundAt);
    const wade = 1 - Math.max(0, Math.min(1, c.snow.resistance ?? 0.3)) * Math.min(1, snowHere / 0.6);
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 9 : 4.6) * (swimming ? 0.5 : 1) * wade;
    const sin = Math.sin(w.yaw), cos = Math.cos(w.yaw), len = Math.hypot(f, s) || 1;
    let nx = cam.position.x + ((-sin * f + cos * s) / len) * speed * dt, nz = cam.position.z + ((-cos * f - sin * s) / len) * speed * dt;
    // A finite world ends at its edge.
    if (!c.terrain.endless) { nx = Math.max(-c.terrain.width / 2 + 0.5, Math.min(c.terrain.width / 2 - 0.5, nx)); nz = Math.max(-c.terrain.depth / 2 + 0.5, Math.min(c.terrain.depth / 2 - 0.5, nz)); }
    // (Feet push down through snow to near the ground: you stand on what's packed under you, not on its surface.)
    const sinkAt = (x: number, z: number, g: number) => this.snowDepthAt(x, z, g) * 0.18;
    const g0 = this.height(nx, nz), ground = g0 + sinkAt(nx, nz, g0), feet0 = cam.position.y - 1.7;
    // Too steep a step up is a wall; otherwise the ground carries you.
    const ox = cam.position.x, oz = cam.position.z;
    if (ground - feet0 < 1.1) { cam.position.x = nx; cam.position.z = nz; }
    const gh = this.height(cam.position.x, cam.position.z), here = gh + sinkAt(cam.position.x, cam.position.z, gh);
    this.walkPrints(ox, oz, cam.position.x, cam.position.z, w.yaw, gh, dt);
    if (swimming) { w.vy = 0; cam.position.y += (water - 0.2 + 1.7 - 1.45 - cam.position.y) * Math.min(1, dt * 4); }
    else {
      const onGround = feet0 <= here + 0.05;
      if (onGround && k.has('Space')) w.vy = 5.6;
      w.vy -= 16 * dt;
      let feet = feet0 + w.vy * dt;
      if (feet <= here) { feet = onGround && w.vy <= 0 ? here + (feet0 - here) * Math.max(0, 1 - dt * 14) : here; if (w.vy < 0) w.vy = 0; }
      cam.position.y = feet + 1.7;
    }
    cam.rotation.order = 'YXZ'; cam.rotation.set(w.pitch, w.yaw, 0);
    // The world streams, and shadows sharpen, round where you stand.
    this.controls.target.copy(cam.position).addScaledVector(cam.getWorldDirection(new THREE.Vector3()), 12);
  }

  /** How deep the snow lying here is (m), as the land draws it: its amount at this spot times the snow's depth. */
  snowDepthAt(x: number, z: number, ground = this.height(x, z)) {
    const c = this.cfg; const depth = c ? snowDepthOf(c) : 0;
    if (!c || depth <= 0) return 0;
    const { slope, normal } = slopeAt(this.height, x, z, 1);
    return snowAt(c, this.edits, x, z, ground, slope, normal) * depth;
  }

  private stride = 0; private foot = 1;
  /**
   * Prints in the snow from a step from (ox, oz) to (x, z): a footprint every stride, left and right; and where the snow
   * is deep, the trench you plough through it.
   */
  private walkPrints(ox: number, oz: number, x: number, z: number, yaw: number, ground: number, dt: number) {
    const c = this.cfg!, s = c.snow;
    const moved = Math.hypot(x - ox, z - oz);
    void dt;
    if (moved < 1e-4 || s.footprints === false) return;
    const deep = this.snowDepthAt(x, z, ground);
    if (deep < 0.02) { this.stride = 0; return; }
    this.trail.follow(x, z);
    const heading = Math.atan2(z - oz, x - ox), size = Math.max(0.1, s.footprintSize || 0.35);
    // Deeper prints the deeper the snow (Footprint depth adds to that), packed nearly to the ground.
    const press = Math.min(1, 0.55 + (s.footprintDepth ?? 0.08) * 2 + deep * 0.5);
    if (deep > 0.22) this.trail.furrow(ox, oz, x, z, 0.5 + deep * 0.4, Math.min(0.9, 0.35 + deep * 0.6));
    this.stride += moved;
    const step = 0.68 + size * 0.3;
    while (this.stride >= step) {
      this.stride -= step; this.foot = -this.foot;
      // Each print a hand's width to its own side of the line walked, along the way you face.
      const px = x + Math.cos(heading + Math.PI / 2) * 0.13 * this.foot, pz = z + Math.sin(heading + Math.PI / 2) * 0.13 * this.foot;
      this.trail.stamp(px, pz, heading, size * 0.95, size * 0.4, press);
    }
    void yaw;
  }

  /** Shift held: the brush works the other way (raise lowers, noise digs). */
  brushShift = false;
  /** Letter keys held over the view (I, O, P, X, C: brush settings by mouse and wheel). */
  private held = new Set<string>();
  private onHeldKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!['i', 'o', 'p', 'x', 'c'].includes(k)) return;
    const t = e.target as HTMLElement | null; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.type === 'keydown') this.held.add(k); else this.held.delete(k);
  };
  /** The area the area tools act on, outlined on the ground (null: none). */
  private areaLine: THREE.Line | null = null;
  showArea(r: [number, number, number, number] | null) {
    if (this.areaLine) { this.scene.remove(this.areaLine); this.areaLine.geometry.dispose(); this.areaLine = null; }
    if (!r) return;
    const [x0, z0, x1, z1] = r, pts: THREE.Vector3[] = [];
    // (Draped over the ground: along each edge, a point every metre or so.)
    const edge = (ax: number, az: number, bx: number, bz: number) => { const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az))); for (let i = 0; i < n; i++) { const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n; pts.push(new THREE.Vector3(x, this.height(x, z) + 0.4, z)); } };
    edge(x0, z0, x1, z0); edge(x1, z0, x1, z1); edge(x1, z1, x0, z1); edge(x0, z1, x0, z0); pts.push(pts[0].clone());
    this.areaLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#7fd4ff', depthTest: false, transparent: true }));
    this.areaLine.renderOrder = 10; this.scene.add(this.areaLine);
  }
  /**
   * Brush settings from the wheel, while a brush is out: Ctrl radius, Ctrl+Shift smoothness, Ctrl+Alt strength,
   * Alt+Shift rotation. (A plain wheel still zooms.)
   */
  private onBrushWheel = (e: WheelEvent) => {
    const b = this.brush;
    if (!SCULPTING.includes(b.tool) || !(e.ctrlKey || e.altKey)) return;
    e.preventDefault(); e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : -1;
    let p: Partial<BrushCfg> | null = null;
    // Ctrl+X: the height change (level step); Ctrl+C: the flatten height (from the ground under the brush, if unset).
    if (e.ctrlKey && this.held.has('x')) p = { levelStep: Math.min(40, Math.max(0.5, (b.levelStep ?? 5) + dir * 0.5)) };
    else if (e.ctrlKey && this.held.has('c')) { const from = b.flattenHeight ?? (this.paintXZ ? this.height(this.paintXZ.x, this.paintXZ.z) : 0); p = { flattenHeight: Math.round((from + dir * 0.5) * 10) / 10 }; }
    else if (e.ctrlKey && e.shiftKey) p = { falloff: Math.min(1, Math.max(0, b.falloff + dir * 0.05)) };
    else if (e.ctrlKey && e.altKey) p = { strength: Math.min(1, Math.max(0.02, b.strength + dir * 0.04)) };
    else if (e.ctrlKey) p = { size: Math.min(120, Math.max(1, Math.round(b.size * (dir > 0 ? 1.1 : 1 / 1.1)))) };
    else if (e.altKey && e.shiftKey) p = { rotation: (((b.rotation ?? 0) + dir * 10) % 360 + 360) % 360 };
    if (p) { this.brush = { ...b, ...p }; this.ev.onBrushChange?.(p); this.brushRing.scale.set(this.brush.size, 1, this.brush.size); }
  };
  private onMove = (e: PointerEvent) => {
    this.brushShift = e.shiftKey;
    if (this.walker) return;
    if (this.stroke) { this.strokeMove(e); return; }
    const b = this.brush;
    // I, O, P held: drag the mouse sideways to change the radius, smoothness or strength (the ring stays put).
    if (SCULPTING.includes(b.tool) && (this.held.has('i') || this.held.has('o') || this.held.has('p')) && !this.painting) {
      const dx = e.movementX; if (!dx) return;
      const p: Partial<BrushCfg> = this.held.has('i') ? { size: Math.min(120, Math.max(1, Math.round((b.size + dx * 0.25) * 4) / 4)) }
        : this.held.has('o') ? { falloff: Math.min(1, Math.max(0, b.falloff + dx * 0.004)) } : { strength: Math.min(1, Math.max(0.02, b.strength + dx * 0.004)) };
      this.brush = { ...b, ...p }; this.ev.onBrushChange?.(p); this.brushRing.scale.set(this.brush.size, 1, this.brush.size);
      return;
    }
    if (b.tool === 'treedraw') { this.brushRing.visible = false; return; }
    const brushing = !['orbit', 'select', 'place'].includes(b.tool); // ('brushplace' paints objects: it shows the ring too)
    if (!brushing && b.tool !== 'place') { this.brushRing.visible = false; return; }
    const p = this.hitGround(e);
    this.paintXZ = p;
    if (!p) { this.brushRing.visible = false; return; }
    this.brushRing.visible = true;
    const r = b.tool === 'place' ? 1.5 : b.tool === 'road' ? 2 : b.size;
    this.brushRing.scale.set(r, 1, r);
    this.brushRing.position.set(p.x, p.y + 0.3, p.z);
  };
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.walker) return;
    if (this.gizmo.dragging || (this.gizmo as any).axis) return;
    const b = this.brush;
    // Tree nodes come first while they're shown: click one to move it.
    if (this.nodeEdit && b.tool !== 'treedraw' && this.pickNode(e)) { this.controls.enabled = false; return; }
    if (b.tool === 'treedraw') {
      if (e.altKey) return; // (Alt+drag still turns the view)
      if (!this.drawTree) {
        // A new tree: its foot here, and this same drag draws its trunk.
        const p = this.hitGround(e); if (!p) return;
        this.ev.onTreeStart?.(p.x, p.y, p.z);
        if (this.drawTree) this.beginStroke(p, -1, 0);
        return;
      }
      this.strokeStart(e);
      return;
    }
    if (b.tool === 'orbit') return;
    if (b.tool === 'select') {
      this.setRay(e);
      const hit = this.ray.intersectObjects(this.placedGroup.children, true)[0];
      this.ev.onSelect((hit?.object.userData.placed as string) ?? null);
      return;
    }
    const p = this.hitGround(e); if (!p) return;
    this.controls.enabled = false;
    if (b.tool === 'place') { this.ev.onPlace(p.x, p.y, p.z); return; }
    if (b.tool === 'road') { this.ev.onRoadPoint(p.x, p.z, e.detail >= 2); return; }
    this.painting = true; this.paintXZ = p; this.lastPaint = 0; this.brushShift = e.shiftKey;
    this.ev.onBrush(b.tool, p.x, p.z, 0.05, true);
  };
  private onUp = () => {
    this.controls.enabled = true;
    if (this.stroke) this.strokeEnd();
    // (Sculpting or painting changed the land: the worker builds from the new edits from now on.)
    if (this.painting) this.postWorld();
    if (this.painting) { this.painting = false; this.ev.onBrushEnd(); }
  };
  private paintTick(dt: number) {
    this.lastPaint += dt;
    if (this.lastPaint < 0.04 || !this.paintXZ) return;
    this.ev.onBrush(this.brush.tool, this.paintXZ.x, this.paintXZ.z, this.lastPaint, false);
    this.lastPaint = 0;
  }
  /** Sample after a change without moving the camera. */
  refreshHeight() { if (this.cfg && this.features) { this.height = worldHeight(this.cfg, this.edits, this.features); this.postWorld(); } }
  focus(x: number, y: number, z: number, dist = 60) { this.controls.target.set(x, y, z); this.camera.position.set(x + dist * 0.6, y + dist * 0.6, z + dist * 0.8); }
  setPending(p: [number, number][]) { this.pending = p; void this.pending; }
}

const part0Tris = (def: SourceDef) => def.parts.reduce((a, p) => a + p.tris, 0);

const ORIGIN = new THREE.Vector3(), WHITE = new THREE.Color('#ffffff');
export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
/**
 * What each quality setting draws. ratio: pixels per screen pixel (0 = the screen's own). shadow: map size, 0 off.
 * water: size of the pass refraction and foam read, 0 none. reach: how far detail, grass and objects are drawn.
 */
const QUALITY: Record<QualityName, { ratio: number; shadow: number; clouds: 'particles' | 'volume'; steps: number; puffs: number; water: number; reach: number }> = {
  low: { ratio: 0.6, shadow: 0, clouds: 'particles', steps: 8, puffs: 3, water: 0, reach: 0.6 },
  medium: { ratio: 0.8, shadow: 1024, clouds: 'volume', steps: 14, puffs: 0, water: 0.35, reach: 0.8 },
  high: { ratio: 1, shadow: 2048, clouds: 'volume', steps: 24, puffs: 8, water: 0.5, reach: 1 },
  ultra: { ratio: 0, shadow: 4096, clouds: 'volume', steps: 64, puffs: 30, water: 1, reach: 1.4 },
};
/** A world's clouds, as the settings GameCraft's cloud layer takes: view and export use the same. */
export function worldClouds(c: WorldConfig): CloudSettings {
  const w = c.weather, span = c.terrain.endless ? 1400 : Math.max(c.terrain.width, c.terrain.depth) / 2;
  const scale = (w.cloudSize ?? 1) * Math.max(45, Math.min(520, span * 0.34));
  return {
    coverage: w.clouds, base: c.terrain.baseHeight + c.terrain.height * 0.95 + (w.cloudHeight ?? 8),
    thickness: (w.cloudThickness ?? 1) * Math.max(24, Math.min(240, Math.max(c.terrain.height * 0.5, scale * 0.42))),
    scale, density: w.cloudDensity ?? 1, steps: w.cloudSteps ?? 28, style: w.cloudStyle ?? 'both', puffs: w.cloudPuffs ?? 8, span,
    windX: 3, windZ: 1,
    // Not all alike: a mix of kinds and sizes across the sky unless chosen otherwise.
    kind: w.cloudKind ?? 'mixed', variety: w.cloudVariety ?? 0.7, seed: w.cloudSeed ?? c.terrain.seed % 1000,
  };
}

/** GameCraft's ripple picture (sceneView's waterNormals): the same pattern, made once. */
let rippleImage: HTMLCanvasElement | null = null;
function waterNormals(): THREE.Texture {
  if (!rippleImage) {
    const n = 128, c = document.createElement('canvas'); c.width = c.height = n;
    const g = c.getContext('2d')!, img = g.createImageData(n, n);
    const h = (x: number, y: number) => Math.sin((x / n) * Math.PI * 6) * 0.5 + Math.sin(((x + y) / n) * Math.PI * 10) * 0.3 + Math.cos((y / n) * Math.PI * 8 + Math.sin((x / n) * Math.PI * 4)) * 0.4;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), k = (y * n + x) * 4;
      img.data[k] = 128 + dx * 60; img.data[k + 1] = 128 + dy * 60; img.data[k + 2] = 255; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0); rippleImage = c;
  }
  const t = new THREE.CanvasTexture(rippleImage); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
/**
 * Water exactly as GameCraft makes it for an object with Surface: Water: see-through and glossy, with its scrolling
 * ripple normal map. `repeat`: ripple pictures per UV unit (sea: set by its size each frame; rivers: UVs in 4 m).
 */
function gameCraftWater(color: string, opacity: number, repeat = 4 / WATER_RIPPLES.metres) {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: Math.max(0.05, opacity / 100), roughness: 0.08, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide });
  m.normalMap = waterNormals(); m.normalMap.repeat.set(repeat, repeat); m.normalScale.set(WATER_RIPPLES.strength, WATER_RIPPLES.strength);
  m.userData.waves = WATER_RIPPLES.speed;
  return m;
}

/** A road surface's picture: across the road (u) and one road-width along it (v). Loose surfaces fray at the edges. */
const roadTextures = new Map<string, THREE.Texture>();
function roadTexture(kind: RoadSurface): THREE.Texture {
  const have = roadTextures.get(kind); if (have) return have;
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  let seed = 1 + kind.length * 977; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const fill = (c: string) => { g.fillStyle = c; g.fillRect(0, 0, N, N); };
  const speckle = (n: number, cols: string[], rMin: number, rMax: number, round = true) => { for (let i = 0; i < n; i++) { g.fillStyle = cols[Math.floor(rnd() * cols.length)]; const x = rnd() * N, y = rnd() * N, r = rMin + rnd() * (rMax - rMin); g.beginPath(); if (round) g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2); else g.rect(x, y, r, r); g.fill(); } };
  const loose = ['dirt', 'gravel', 'trail', 'sand', 'mud', 'snow'].includes(kind);
  switch (kind) {
    case 'gravel': fill('#867f74'); speckle(2600, ['#9d968a', '#6f6a62', '#b3ab9d', '#5c5853', '#a49580'], 1.2, 3.6); break;
    case 'dirt': fill('#76604a'); speckle(900, ['#6a533e', '#836b52', '#5e4a37'], 2, 9); g.fillStyle = 'rgba(60,45,32,0.45)'; g.fillRect(N * 0.27, 0, N * 0.08, N); g.fillRect(N * 0.65, 0, N * 0.08, N); speckle(160, ['#8f8778'], 1, 2.4); break;
    case 'trail': fill('#5d4c37'); speckle(1200, ['#6b5840', '#4f402f', '#6f5f45', '#3f5a2c'], 1.5, 6); break;
    case 'sand': fill('#cbb68a'); speckle(1800, ['#d8c59a', '#bba578', '#e0d1a8'], 0.8, 2.5); break;
    case 'mud': fill('#4f3e2b'); speckle(500, ['#5e4a34', '#3f3122', '#665139'], 4, 14); g.fillStyle = 'rgba(120,140,150,0.25)'; speckle(25, ['rgba(140,160,170,0.35)'], 6, 16); break;
    case 'snow': fill('#e3e9ee'); speckle(900, ['#f4f7fa', '#cfd8e0', '#dde4ea'], 1.5, 6); g.fillStyle = 'rgba(160,175,190,0.5)'; g.fillRect(N * 0.3, 0, N * 0.07, N); g.fillRect(N * 0.63, 0, N * 0.07, N); break;
    case 'concrete': fill('#9a9894'); speckle(1500, ['#a6a4a0', '#8d8b87', '#aeaca7'], 0.6, 1.8); g.fillStyle = '#6d6b67'; g.fillRect(0, 0, N, 2); g.fillRect(N / 2 - 1, 0, 2, N); break;
    case 'asphalt': case 'highway': {
      fill('#3a3c40'); speckle(3000, ['#45474c', '#303236', '#4d4f54'], 0.5, 1.4);
      g.fillStyle = '#d9d6cc'; g.fillRect(N * 0.04, 0, N * 0.02, N); g.fillRect(N * 0.94, 0, N * 0.02, N);
      if (kind === 'highway') { g.fillStyle = '#f1f0ea'; for (const u of [0.35, 0.65]) g.fillRect(N * u - 2, 0, 4, N * 0.45); g.fillStyle = '#e6b937'; g.fillRect(N * 0.5 - 3, 0, 6, N); }
      else { g.fillStyle = '#e6c84a'; g.fillRect(N * 0.5 - 2, 0, 4, N * 0.5); }
      break;
    }
    case 'planks': { fill('#6e5032'); for (let y = 0; y < N; y += N / 8) { g.fillStyle = ['#7d5c38', '#73543a', '#86633d', '#6b4d30'][Math.floor(rnd() * 4)]; g.fillRect(0, y + 2, N, N / 8 - 4); g.fillStyle = '#2d2014'; g.fillRect(N * 0.08, y + N / 16 - 2, 4, 4); g.fillRect(N * 0.9, y + N / 16 - 2, 4, 4); } break; }
    case 'flagstone': case 'cobble': case 'brick': {
      const brick = kind === 'brick', cob = kind === 'cobble';
      fill(brick ? '#5c4a40' : '#55524d');
      const rows = brick ? 12 : cob ? 9 : 5, cols = brick ? 4 : cob ? 9 : 4;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols + 1; c++) {
        const w = N / cols, h = N / rows, x = (c - (r % 2) * 0.5) * w, y = r * h;
        g.fillStyle = brick ? ['#8f4e3a', '#9b573f', '#82452f', '#a2604a'][Math.floor(rnd() * 4)] : ['#8a8780', '#7b7770', '#96928a', '#6f6c66'][Math.floor(rnd() * 4)];
        const gap = brick ? 2 : cob ? 3 : 4, jx = cob ? (rnd() - 0.5) * 4 : 0, jy = cob ? (rnd() - 0.5) * 4 : 0;
        g.beginPath(); if (cob) g.ellipse(x + w / 2 + jx, y + h / 2 + jy, w / 2 - gap, h / 2 - gap, 0, 0, Math.PI * 2); else g.rect(x + gap, y + gap, w - gap * 2, h - gap * 2); g.fill();
      }
      break;
    }
  }
  // Loose surfaces fray into the ground at their edges; paved ones keep a clean edge.
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, e = Math.min(u, 1 - u), k = (y * N + x) * 4;
    if (loose) { const wob = 0.06 + 0.05 * Math.sin(y * 0.11 + Math.sin(y * 0.031) * 3) + (rnd() - 0.5) * 0.05; d[k + 3] = e < wob ? 0 : 255; }
    else d[k + 3] = e < 0.012 ? 0 : 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  roadTextures.set(kind, t);
  return t;
}

/** A road's strip: `across` vertices across each point, each on the ground. UV x across (0..1), y along in road widths. */
function roadStrip(points: [number, number][], width: number, across: number, y: (x: number, z: number) => number): MeshData {
  const m: MeshData = { positions: [], normals: [], colors: [], uvs: [], indices: [] };
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l;
    if (i) along += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    for (let s = 0; s <= across; s++) {
      const k = s / across - 0.5, x = points[i][0] + nx * width * k, z = points[i][1] + nz * width * k;
      m.positions.push(x, y(x, z), z); m.normals.push(0, 1, 0); m.colors.push(1, 1, 1); m.uvs.push(s / across, along / width);
    }
    // (Wound to face up.)
    if (i + 1 < points.length) for (let s = 0; s < across; s++) { const q = i * (across + 1) + s, r = q + across + 1; m.indices.push(q, q + 1, r, q + 1, r + 1, r); }
  }
  // Lit by the ground's own slope, worked out from the strip.
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3)); g.setIndex(m.indices); g.computeVertexNormals();
  m.normals = Array.from(g.getAttribute('normal').array as Float32Array);
  return m;
}

/**
 * Realistic road surfaces, drawn here (no outside pictures): a colour and a matching relief (normal) map one road
 * width square, from layered noise and the surface's own pieces: aggregate in asphalt with worn wheel tracks, cracks
 * and faded lines; packed gravel with loose stones; rutted dirt with pebbles; laid stones and bricks with mortar.
 */
const realRoads = new Map<string, { map: THREE.Texture; normal: THREE.Texture; roughness: number; edge: number; ragged: number; widthK: number }>();
function realisticRoad(kind: RoadSurface) {
  const have = realRoads.get(kind); if (have) return have;
  const N = 512, H = new Float32Array(N * N), C = new Float32Array(N * N * 3);
  let seed = 7 + kind.length * 131; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const lat = new Float32Array(64 * 64).map(() => rnd());
  const vn = (x: number, y: number, f: number) => { // tiling value noise, f cells across
    const fx = x * f / N, fy = y * f / N, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, s = (t: number) => t * t * (3 - 2 * t);
    const at = (a: number, b: number) => lat[((a % f) + f) % f + (((b % f) + f) % f) * 64];
    return (at(i, j) * (1 - s(u)) + at(i + 1, j) * s(u)) * (1 - s(v)) + (at(i, j + 1) * (1 - s(u)) + at(i + 1, j + 1) * s(u)) * s(v);
  };
  const fbm = (x: number, y: number) => vn(x, y, 4) * 0.5 + vn(x, y, 9) * 0.25 + vn(x, y, 21) * 0.15 + vn(x, y, 47) * 0.1;
  const set = (i: number, r: number, g: number, b: number, h: number) => { C[i * 3] = r; C[i * 3 + 1] = g; C[i * 3 + 2] = b; H[i] = h; };
  const base: Record<string, [number, number, number]> = {
    asphalt: [0.2, 0.205, 0.215], highway: [0.18, 0.185, 0.195], gravel: [0.5, 0.48, 0.44], dirt: [0.4, 0.31, 0.22], trail: [0.33, 0.26, 0.18], sand: [0.74, 0.66, 0.5],
    mud: [0.27, 0.21, 0.15], snow: [0.86, 0.88, 0.9], concrete: [0.58, 0.57, 0.55], planks: [0.43, 0.31, 0.2], flagstone: [0.47, 0.46, 0.43], cobble: [0.42, 0.41, 0.39], brick: [0.5, 0.27, 0.19],
  };
  const [br, bg, bb] = base[kind] ?? base.dirt;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, u = x / N, n = fbm(x, y), fine = vn(x, y, 47), tone = 0.82 + n * 0.36;
    // Wheel tracks: two worn bands along the road.
    const track = Math.max(Math.exp(-(((u - 0.3) / 0.07) ** 2)), Math.exp(-(((u - 0.7) / 0.07) ** 2)));
    let r = br * tone, g = bg * tone, b = bb * tone, h = n * 0.4;
    if (kind === 'asphalt' || kind === 'highway') {
      const agg = rnd() < 0.08 ? 0.12 * (rnd() - 0.3) : 0; r += agg; g += agg; b += agg; h += fine * 0.25 + agg;
      r += track * 0.03; g += track * 0.03; b += track * 0.03; // polished by tyres
    } else if (kind === 'gravel' || kind === 'dirt' || kind === 'trail' || kind === 'mud' || kind === 'sand' || kind === 'snow') {
      h -= track * (kind === 'mud' || kind === 'snow' ? 0.45 : 0.25); const dark = track * (kind === 'snow' ? -0.06 : 0.06); r -= dark; g -= dark; b -= dark;
    }
    set(i, r, g, b, h);
  }
  // Pieces laid on top: stones, pebbles, cracks, paint, joints.
  const stone = (cx: number, cy: number, rad: number, col: [number, number, number], lift: number) => {
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const dx = (x - cx) / rad, dy = (y - cy) / rad, d = dx * dx + dy * dy; if (d > 1) continue;
      const i = (((y % N) + N) % N) * N + (((x % N) + N) % N), dome = Math.sqrt(1 - d), lit = 0.75 + 0.35 * (-dx * 0.6 - dy * 0.6) * dome + 0.15 * dome;
      set(i, col[0] * lit, col[1] * lit, col[2] * lit, H[i] * 0.3 + lift * dome);
    }
  };
  if (kind === 'gravel') for (let k = 0; k < 2600; k++) { const g = 0.38 + rnd() * 0.3; stone(rnd() * N, rnd() * N, 1.5 + rnd() * 3.5, [g * 1.05, g, g * 0.92], 0.6 + rnd() * 0.4); }
  if (kind === 'dirt' || kind === 'trail' || kind === 'mud') for (let k = 0; k < 260; k++) { const g = 0.3 + rnd() * 0.25; stone(rnd() * N, rnd() * N, 1 + rnd() * 2.5, [g * 1.1, g, g * 0.85], 0.4); }
  if (kind === 'cobble' || kind === 'flagstone' || kind === 'brick') {
    const rows = kind === 'brick' ? 16 : kind === 'cobble' ? 11 : 5, cols = kind === 'brick' ? 6 : kind === 'cobble' ? 11 : 4;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const w = N / cols, h = N / rows, row = Math.floor(y / h), off = (row % 2) * 0.5 * w, cxi = Math.floor((x + off) / w);
      const gx = ((x + off) % w) / w, gy = (y % h) / h, edge = Math.min(gx, 1 - gx, gy, 1 - gy) * (kind === 'cobble' ? 1.6 : 4);
      const i = y * N + x, hash = lat[(cxi * 7 + row * 13) % 4096], mortar = edge < 0.12;
      const c: [number, number, number] = mortar ? [0.33, 0.32, 0.3] : kind === 'brick' ? [0.48 + hash * 0.12, 0.24 + hash * 0.06, 0.17] : [0.38 + hash * 0.16, 0.37 + hash * 0.15, 0.35 + hash * 0.13];
      const k2 = 0.85 + fbm(x, y) * 0.3;
      set(i, c[0] * k2, c[1] * k2, c[2] * k2, mortar ? 0 : 0.5 + Math.min(1, edge) * 0.5 + fbm(x, y) * 0.1);
    }
  }
  if (kind === 'planks') for (let y = 0; y < N; y++) { const row = Math.floor(y / (N / 9)), gap = y % (N / 9) < 3, tone = 0.8 + lat[row * 17 % 4096] * 0.35; for (let x = 0; x < N; x++) { const i = y * N + x, grain = 0.85 + 0.15 * Math.sin(x * 0.09 + vn(x, y, 9) * 6); set(i, gap ? 0.12 : br * tone * grain, gap ? 0.09 : bg * tone * grain, gap ? 0.06 : bb * tone * grain, gap ? 0 : 0.6 + grain * 0.2); } }
  if (kind === 'asphalt' || kind === 'highway' || kind === 'concrete') {
    // Cracks: thin dark wandering lines.
    for (let k = 0; k < (kind === 'concrete' ? 3 : 7); k++) { let x = rnd() * N, y = rnd() * N, a = rnd() * 6.28; for (let s = 0; s < 160; s++) { a += (rnd() - 0.5) * 0.7; x += Math.cos(a); y += Math.sin(a); const i = (((Math.floor(y) % N) + N) % N) * N + (((Math.floor(x) % N) + N) % N); C[i * 3] *= 0.45; C[i * 3 + 1] *= 0.45; C[i * 3 + 2] *= 0.45; H[i] -= 0.4; } }
    if (kind === 'concrete') for (let y = 0; y < N; y++) for (const x of [0, 1, N / 2, N / 2 + 1]) { const i = y * N + x; H[i] -= 0.5; C[i * 3] *= 0.7; C[i * 3 + 1] *= 0.7; C[i * 3 + 2] *= 0.7; }
    // Paint, worn: edge lines, and a centre line (dashed on roads, double on highways).
    const paint = (u0: number, u1: number, dashed: boolean, col: [number, number, number]) => { for (let y = 0; y < N; y++) { if (dashed && y > N * 0.55) continue; for (let x = Math.floor(u0 * N); x < u1 * N; x++) { const i = y * N + x, wear = vn(x, y, 47) > 0.32 ? 1 : 0.35; for (let c = 0; c < 3; c++) C[i * 3 + c] = C[i * 3 + c] * (1 - 0.85 * wear) + col[c] * 0.85 * wear; } } };
    if (kind !== 'concrete') {
      paint(0.045, 0.06, false, [0.85, 0.85, 0.82]); paint(0.94, 0.955, false, [0.85, 0.85, 0.82]);
      if (kind === 'highway') { paint(0.485, 0.495, false, [0.85, 0.66, 0.15]); paint(0.505, 0.515, false, [0.85, 0.66, 0.15]); } else paint(0.495, 0.508, true, [0.88, 0.88, 0.85]);
    }
  }
  // Colour, and relief from the heights.
  const cc = document.createElement('canvas'); cc.width = cc.height = N; const g1 = cc.getContext('2d')!, img = g1.createImageData(N, N);
  const nc = document.createElement('canvas'); nc.width = nc.height = N; const g2 = nc.getContext('2d')!, nimg = g2.createImageData(N, N);
  const k = kind === 'gravel' || kind === 'cobble' || kind === 'brick' || kind === 'flagstone' || kind === 'planks' ? 3.5 : 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, p = i * 4;
    img.data[p] = Math.min(255, C[i * 3] * 255); img.data[p + 1] = Math.min(255, C[i * 3 + 1] * 255); img.data[p + 2] = Math.min(255, C[i * 3 + 2] * 255); img.data[p + 3] = 255;
    const hx = H[y * N + ((x + 1) % N)] - H[y * N + ((x - 1 + N) % N)], hy = H[((y + 1) % N) * N + x] - H[((y - 1 + N) % N) * N + x];
    nimg.data[p] = 128 - hx * 127 * k; nimg.data[p + 1] = 128 + hy * 127 * k; nimg.data[p + 2] = 255; nimg.data[p + 3] = 255;
  }
  g1.putImageData(img, 0, 0); g2.putImageData(nimg, 0, 0);
  const map = new THREE.CanvasTexture(cc); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = THREE.ClampToEdgeWrapping; map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  const normal = new THREE.CanvasTexture(nc); normal.wrapS = THREE.ClampToEdgeWrapping; normal.wrapT = THREE.RepeatWrapping; normal.anisotropy = 8;
  const loose = ['gravel', 'dirt', 'trail', 'sand', 'mud', 'snow'].includes(kind);
  const out = { map, normal, roughness: kind === 'mud' ? 0.55 : kind === 'snow' ? 0.7 : kind === 'asphalt' || kind === 'highway' ? 0.82 : 0.95, edge: loose ? 0.55 : 0.86, ragged: loose ? 0.45 : 0.08, widthK: loose ? 1.25 : 1.06 };
  realRoads.set(kind, out);
  return out;
}

/** Crossed quads: standing grass that doesn't turn. */
function crossedCards() {
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), b = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const merge = (name: string, size: number) => { const x = a.getAttribute(name).array, y = b.getAttribute(name).array; const out = new Float32Array(x.length + y.length); out.set(x as any); out.set(y as any, x.length); g.setAttribute(name, new THREE.BufferAttribute(out, size)); };
  merge('position', 3); merge('normal', 3); merge('uv', 2);
  const ia = Array.from(a.index!.array), ib = Array.from(b.index!.array).map((i) => i + a.getAttribute('position').count);
  g.setIndex([...ia, ...ib]);
  return g;
}

/** Leaf pictures become light and dark over the leaf colour. Adds to whatever the material already patches. */
function grayMap(m: THREE.MeshStandardMaterial) {
  m.userData.gray = true;
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb = vec3(0.45 + 0.9 * dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)));`);
  };
  m.customProgramCacheKey = () => prevKey + '|gray';
}
