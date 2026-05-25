import * as THREE from 'three';
import { Planet, PlanetClass } from './PlanetSystem';

// Procedural planet materials. No textures, no image assets — every surface
// pattern, normal, and roughness map is GLSL noise evaluated on the
// unit-sphere local position.
//
// Pipeline (per planet):
//   - Start from MeshStandardMaterial so the scene's per-star point light and
//     ambient terms keep working with no manual lighting code.
//   - Patch the shader via onBeforeCompile and inject four hooks:
//       1. <map_fragment>          → override `diffuseColor.rgb` with procColor.
//       2. <normal_fragment_maps>  → perturb `normal` from the analytic
//          gradient of a per-class height field, so mountains/craters catch
//          real terminator light instead of staying flat.
//       3. <roughnessmap_fragment> → modulate `roughnessFactor` per pixel
//          (ocean glint, ice gloss, dusty desert).
//       4. <emissivemap_fragment>  → add per-class emission (lava cracks glow
//          on the night side).
//   - All four hooks are driven by a single `uDetail` (0..1) ramp so distant
//     planets stay cheap and dolly-ins reveal the procedural detail.

const NOISE_GLSL = /* glsl */`
  vec3 _mod289v3(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 _mod289v4(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 _permute(vec4 x){ return _mod289v4(((x * 34.0) + 1.0) * x); }
  vec4 _taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = _mod289v3(i);
    vec4 p = _permute(_permute(_permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 pp0 = vec3(a0.xy, h.x);
    vec3 pp1 = vec3(a0.zw, h.y);
    vec3 pp2 = vec3(a1.xy, h.z);
    vec3 pp3 = vec3(a1.zw, h.w);
    vec4 norm = _taylorInvSqrt(vec4(dot(pp0,pp0), dot(pp1,pp1), dot(pp2,pp2), dot(pp3,pp3)));
    pp0 *= norm.x; pp1 *= norm.y; pp2 *= norm.z; pp3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(pp0, x0), dot(pp1, x1), dot(pp2, x2), dot(pp3, x3)));
  }
  float fbm(vec3 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { f += a * snoise(p); p *= 2.0; a *= 0.5; }
    return f;
  }
  float fbm5(vec3 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { f += a * snoise(p); p *= 2.0; a *= 0.5; }
    return f;
  }
  float ridge(vec3 p) { return 1.0 - abs(fbm(p)); }
  // Domain warp: feed an fbm vector back into position. Breaks the gridded
  // look of plain fbm and gives continents/dunes a more organic flow.
  vec3 warp(vec3 p) {
    return p + vec3(fbm(p + 1.7), fbm(p + 9.2), fbm(p + 3.1)) * 0.6;
  }
`;

// Each class contributes three fragment-shader functions:
//   heightFn(p)   → scalar "elevation" used by the analytic normal gradient.
//                   For flat surfaces (gas, ocean water) it returns near zero.
//   procColor(n, p, base, c2, c3, t) → final diffuse color. `n` is the
//                   unit-sphere local direction (pre-seed) so latitude-based
//                   effects like polar caps work; `p` is the seed-shifted
//                   noise-space position.
//   roughnessFn(n, p) → per-pixel roughness in [0..1]. Ocean water glints,
//                   continents stay matte, ice goes glossy.
//   emissionFn(n, p, t) → scalar [0..1] for additive class-tint emission;
//                   returns 0 for non-lava classes so the hook stays cheap.
//
// All four are inlined into the same fragment shader, picked at compile time.
function classGLSL(cls: PlanetClass): string {
  switch (cls) {
    case 'rock': return /* glsl */`
      float heightFn(vec3 p) {
        return fbm(p * 2.5) * 0.55 + ridge(p * 8.0) * 0.30 + fbm(p * 18.0) * 0.10;
      }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        vec3 wp = warp(p * 1.4);
        float h = fbm5(wp * 2.0) * 0.5 + 0.5;
        float craters = ridge(p * 14.0);
        float band = smoothstep(0.35, 0.62, h);
        vec3 col = mix(c2 * 0.65, base, band);
        col = mix(col, c3, smoothstep(0.78, 0.95, h));
        col *= 0.78 + 0.28 * craters;
        // Cold polar dusting — subtle on bare rocks.
        float lat = abs(n.y);
        col = mix(col, vec3(0.86, 0.89, 0.94), smoothstep(0.85, 0.97, lat) * 0.45);
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) {
        return clamp(0.78 + 0.18 * fbm(p * 6.0), 0.45, 0.98);
      }
      float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
    `;
    case 'desert': return /* glsl */`
      float heightFn(vec3 p) {
        float lat = p.y;
        float dunes = sin(lat * 14.0 + fbm(p * 2.0) * 3.5);
        return dunes * 0.18 + fbm(p * 3.0) * 0.25 + fbm(p * 20.0) * 0.08;
      }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        vec3 wp = warp(p * 1.1);
        float lat = n.y;
        float dunes = sin(lat * 14.0 + fbm(wp * 2.0) * 3.5);
        float coarse = fbm5(wp * 4.0);
        float band = smoothstep(-0.3, 0.6, dunes + coarse * 0.4);
        vec3 col = mix(c2, base, band);
        col = mix(col, c3, smoothstep(0.6, 1.0, coarse));
        // Equator warmth: dust-storm reddening
        float eq = 1.0 - abs(n.y);
        col *= mix(1.0, 1.10, smoothstep(0.6, 1.0, eq) * 0.5);
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) {
        return 0.88 + 0.06 * fbm(p * 8.0);
      }
      float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
    `;
    case 'ocean': return /* glsl */`
      float heightFn(vec3 p) {
        // Water is flat; only land contributes relief.
        float h = fbm(p * 2.5);
        float land = smoothstep(0.0, 0.05, h);
        return land * (h * 0.55 + 0.20) + fbm(p * 16.0) * 0.04 * land;
      }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        vec3 wp = warp(p * 1.3);
        float h = fbm5(wp * 2.5);
        float coast = smoothstep(0.0, 0.04, h);
        vec3 deep = c2 * 0.7;
        vec3 shallow = mix(c2, base, 0.35);
        vec3 water = mix(deep, shallow, smoothstep(-0.1, 0.05, h));
        vec3 land = c3 * (0.7 + 0.4 * fbm(p * 6.0));
        vec3 col = mix(water, land, coast);
        // Polar ice caps — Earth-like. Use unseeded latitude.
        float lat = abs(n.y);
        col = mix(col, vec3(0.95, 0.97, 1.0), smoothstep(0.74, 0.90, lat) * 0.88);
        // Animated cloud layer — drifts independently from continents.
        float clouds = fbm(p * 3.2 + vec3(t * 0.018, 0.0, t * 0.012));
        col = mix(col, vec3(0.96, 0.97, 1.0), smoothstep(0.38, 0.65, clouds) * 0.5);
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) {
        vec3 wp = warp(p * 1.3);
        float h = fbm5(wp * 2.5);
        float landMask = smoothstep(0.0, 0.04, h);
        // Polar caps are matte ice too
        float caps = smoothstep(0.74, 0.90, abs(n.y));
        return mix(0.22, 0.88, max(landMask, caps));
      }
      float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
    `;
    case 'ice': return /* glsl */`
      float heightFn(vec3 p) {
        float nv = fbm(p * 6.0);
        float cracks = smoothstep(0.04, 0.0, abs(nv));
        return fbm(p * 2.5) * 0.4 - cracks * 0.25;
      }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        vec3 wp = warp(p * 1.4);
        float nv = fbm(wp * 6.0);
        float cracks = smoothstep(0.04, 0.0, abs(nv));
        float h = fbm5(wp * 2.0) * 0.5 + 0.5;
        vec3 col = mix(base, c2, smoothstep(0.45, 0.7, h));
        col = mix(col, c3 * 0.55, cracks);
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) {
        float nv = fbm(p * 6.0);
        float cracks = smoothstep(0.04, 0.0, abs(nv));
        return mix(0.35, 0.78, cracks);
      }
      float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
    `;
    case 'gas': return /* glsl */`
      // Gas giants have no solid relief — return 0 so the normal gradient
      // stays flat and the sphere reads as smooth banded atmosphere.
      float heightFn(vec3 p) { return 0.0; }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        vec3 wp = warp(p * 1.5 + vec3(t * 0.02, 0.0, 0.0));
        float lat = n.y;
        float turb = fbm5(wp * 2.5 + vec3(t * 0.04, 0.0, 0.0));
        float bands = sin(lat * 9.0 + turb * 2.4);
        float storm = smoothstep(0.62, 0.95, fbm(wp * 4.0 + vec3(0.0, t * 0.01, 0.0)));
        vec3 col = mix(base, c2, smoothstep(-0.2, 0.4, bands));
        col = mix(col, c3, smoothstep(0.4, 0.95, bands));
        col = mix(col, c3 * 1.15, storm * 0.5);
        // Polar darkening — gas giants commonly show this.
        col *= mix(1.0, 0.80, smoothstep(0.85, 1.0, abs(n.y)));
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) { return 0.65; }
      float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
    `;
    case 'lava': return /* glsl */`
      float heightFn(vec3 p) {
        return fbm(p * 4.0) * 0.45 + fbm(p * 12.0) * 0.15;
      }
      vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
        float nv = fbm5(p * 5.0 + vec3(0.0, t * 0.03, 0.0));
        float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
        vec3 dark = c2 * 0.40;
        vec3 col = mix(dark, base * 0.85, smoothstep(-0.5, 0.4, nv));
        col = mix(col, c3, hot);
        col += c3 * hot * (0.6 + 0.4 * sin(t * 1.5));
        return col;
      }
      float roughnessFn(vec3 n, vec3 p) {
        float nv = fbm5(p * 5.0);
        float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
        // Magma is glossy hot, basalt is rough. Pulls roughness down where hot.
        return mix(0.72, 0.20, hot);
      }
      float emissionFn(vec3 n, vec3 p, float t) {
        float nv = fbm5(p * 5.0 + vec3(0.0, t * 0.03, 0.0));
        float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
        return hot * (0.85 + 0.20 * sin(t * 1.5));
      }
    `;
  }
}

// Derive secondary/tertiary tints from the base color. Hand-tuned per class:
//   c2: contrasting shade for the dominant band/zone
//   c3: highlight tint (oceans → land, gas → ribbon highlight, lava → magma)
function deriveTints(planet: Planet): { c2: THREE.Color; c3: THREE.Color } {
  const [r, g, b] = planet.color;
  switch (planet.planetClass) {
    case 'rock':   return { c2: new THREE.Color(r*0.55, g*0.55, b*0.55), c3: new THREE.Color(Math.min(1, r*1.35), Math.min(1, g*1.35), Math.min(1, b*1.35)) };
    case 'desert': return { c2: new THREE.Color(r*0.75, g*0.6,  b*0.45), c3: new THREE.Color(Math.min(1, r*1.15), Math.min(1, g*0.95), Math.min(1, b*0.7)) };
    case 'ocean':  return { c2: new THREE.Color(r*0.45, g*0.55, b*0.85), c3: new THREE.Color(0.35, 0.55, 0.25) }; // land green
    case 'ice':    return { c2: new THREE.Color(0.78, 0.88, 0.98), c3: new THREE.Color(0.55, 0.7, 0.92) }; // crevasse blue
    case 'gas':    return { c2: new THREE.Color(r*0.65, g*0.7,  b*0.85), c3: new THREE.Color(Math.min(1, r*1.25), Math.min(1, g*0.85), Math.min(1, b*0.65)) };
    case 'lava':   return { c2: new THREE.Color(0.18, 0.10, 0.08), c3: new THREE.Color(1.0, 0.55, 0.18) }; // magma
  }
}

// How aggressively each class bends the normal from the height gradient.
// Gas giants and oceans have ~no relief; rock/lava/ice get meaningful bump.
// Values tuned down from earlier so the perturbed normals don't flip past
// the geometric outward — strong noise gradients × high uBump was creating
// "noisy" shading that read as a thin/transparent surface.
function bumpStrengthFor(cls: PlanetClass): number {
  switch (cls) {
    case 'rock':   return 0.45;
    case 'desert': return 0.30;
    case 'ocean':  return 0.30;  // only continents bump; water stays flat by heightFn
    case 'ice':    return 0.38;
    case 'gas':    return 0.0;
    case 'lava':   return 0.50;
  }
}

/** Reference returned to the caller so it can drive uniforms per frame. */
export interface PlanetMaterialHandle {
  material: THREE.MeshStandardMaterial;
  /** Smoothly transitions the procedural overlay in/out (0 = flat, 1 = full). */
  setDetail(d: number): void;
  /** Advance class-animated shaders (lava, gas, ocean clouds). */
  setTime(t: number): void;
}

export function createPlanetMaterial(planet: Planet): PlanetMaterialHandle {
  const { c2, c3 } = deriveTints(planet);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(planet.color[0], planet.color[1], planet.color[2]),
    roughness: planet.planetClass === 'ocean' ? 0.4 : planet.planetClass === 'ice' ? 0.55 : 0.85,
    metalness: planet.planetClass === 'lava' ? 0.0 : 0.05,
    emissive: planet.planetClass === 'lava'
      ? new THREE.Color(0.12, 0.04, 0.02)
      : new THREE.Color(planet.color[0] * 0.04, planet.color[1] * 0.04, planet.color[2] * 0.05),
  });

  // Uniforms live on the shader once compiled. We capture references here so
  // setDetail / setTime can poke them every frame without a re-compile.
  const uniformRefs: { uDetail: { value: number }; uTime: { value: number } } = {
    uDetail: { value: 0 },
    uTime: { value: 0 },
  };

  const surface = classGLSL(planet.planetClass);
  const bumpStrength = bumpStrengthFor(planet.planetClass);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniformRefs.uDetail;
    shader.uniforms.uTime = uniformRefs.uTime;
    shader.uniforms.uColor2 = { value: c2 };
    shader.uniforms.uColor3 = { value: c3 };
    shader.uniforms.uSeed = { value: planet.shaderSeed };
    shader.uniforms.uBump = { value: bumpStrength };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vLocalDir;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vLocalDir = normalize(position);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vLocalDir;
        uniform float uDetail;
        uniform float uTime;
        uniform vec3 uColor2;
        uniform vec3 uColor3;
        uniform float uSeed;
        uniform float uBump;
        ${NOISE_GLSL}
        ${surface}
      `)
      // 1. Diffuse color from procedural surface.
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        if (uDetail > 0.001) {
          vec3 base = diffuseColor.rgb;
          vec3 n0 = normalize(vLocalDir);
          vec3 pp = n0 + uSeed * 100.0;
          vec3 proc = procColor(n0, pp, base, uColor2, uColor3, uTime);
          diffuseColor.rgb = mix(base, proc, uDetail);
        }
      `)
      // 2. Normal perturbation from height field's analytic gradient.
      //    Works without a tangent frame because the geometric normal on a
      //    unit sphere IS the local position — we synthesize a bumped normal
      //    in object space by projecting the height gradient onto the tangent
      //    plane, then transform to view space with normalMatrix.
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        if (uDetail > 0.001 && uBump > 0.0) {
          const float eps = 0.015;
          vec3 n0 = normalize(vLocalDir);
          vec3 pp = n0 + uSeed * 100.0;
          float h0 = heightFn(pp);
          float hx = heightFn(pp + vec3(eps, 0.0, 0.0));
          float hy = heightFn(pp + vec3(0.0, eps, 0.0));
          float hz = heightFn(pp + vec3(0.0, 0.0, eps));
          vec3 grad = (vec3(hx, hy, hz) - h0) / eps;
          // Project gradient onto tangent plane so the perturbation stays
          // tangential — moving the normal off the sphere is meaningless.
          grad -= n0 * dot(grad, n0);
          vec3 nLocal = normalize(n0 - grad * uBump);
          vec3 nView = normalize(normalMatrix * nLocal);
          // Ramp the perturbation with detail so distant planets keep the
          // smooth shaded look and don't visibly snap when crossing the LOD.
          normal = normalize(mix(normal, nView, uDetail));
        }
      `)
      // 3. Per-pixel roughness modulation.
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        if (uDetail > 0.001) {
          vec3 n0 = normalize(vLocalDir);
          vec3 pp = n0 + uSeed * 100.0;
          float rr = roughnessFn(n0, pp);
          roughnessFactor = mix(roughnessFactor, rr, uDetail);
        }
      `)
      // 4. Procedural emission. Only lava is non-trivial; other classes
      //    return 0 and the branch costs ~nothing.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        if (uDetail > 0.001) {
          vec3 n0 = normalize(vLocalDir);
          vec3 pp = n0 + uSeed * 100.0;
          float e = emissionFn(n0, pp, uTime);
          totalEmissiveRadiance += uColor3 * e * 1.6 * uDetail;
        }
      `);
  };

  return {
    material: mat,
    setDetail: (d: number) => { uniformRefs.uDetail.value = d; },
    setTime: (t: number) => { uniformRefs.uTime.value = t; },
  };
}
