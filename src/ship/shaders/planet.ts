import { PlanetClass } from '../PlanetSystem';

// GLSL source for the procedural planet materials. The TS side (PlanetShader)
// owns material construction, tint derivation, and the onBeforeCompile
// orchestration; this module holds only the shader chunks those hooks inject.

// Shared noise library: Ashima simplex `snoise` + fbm/ridge + a domain warp.
// Evaluated on the unit-sphere local position to drive every surface pattern,
// normal, and roughness map — no textures, no image assets.
export const NOISE_GLSL = /* glsl */`
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
export const PLANET_CLASS_GLSL: Record<PlanetClass, string> = {
  rock: /* glsl */`
    float heightFn(vec3 p) {
      return fbm(p * 2.5) * 0.55 + ridge(p * 8.0) * 0.30 + fbm(p * 18.0) * 0.10;
    }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      vec3 wp = warp(p * 1.4);
      float h = fbm(wp * 2.0) * 0.5 + 0.5;
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
  `,
  desert: /* glsl */`
    float heightFn(vec3 p) {
      float lat = p.y;
      float dunes = sin(lat * 14.0 + fbm(p * 2.0) * 3.5);
      return dunes * 0.18 + fbm(p * 3.0) * 0.25 + fbm(p * 20.0) * 0.08;
    }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      vec3 wp = warp(p * 1.1);
      float lat = n.y;
      float dunes = sin(lat * 14.0 + fbm(wp * 2.0) * 3.5);
      float coarse = fbm(wp * 4.0);
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
  `,
  ocean: /* glsl */`
    float heightFn(vec3 p) {
      // Water is flat; only land contributes relief.
      float h = fbm(p * 2.5);
      float land = smoothstep(0.0, 0.05, h);
      return land * (h * 0.55 + 0.20) + fbm(p * 16.0) * 0.04 * land;
    }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      vec3 wp = warp(p * 1.3);
      float h = fbm(wp * 2.5);
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
      float h = fbm(wp * 2.5);
      float landMask = smoothstep(0.0, 0.04, h);
      // Polar caps are matte ice too
      float caps = smoothstep(0.74, 0.90, abs(n.y));
      return mix(0.22, 0.88, max(landMask, caps));
    }
    float emissionFn(vec3 n, vec3 p, float t) { return 0.0; }
  `,
  ice: /* glsl */`
    float heightFn(vec3 p) {
      float nv = fbm(p * 6.0);
      float cracks = smoothstep(0.04, 0.0, abs(nv));
      return fbm(p * 2.5) * 0.4 - cracks * 0.25;
    }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      vec3 wp = warp(p * 1.4);
      float nv = fbm(wp * 6.0);
      float cracks = smoothstep(0.04, 0.0, abs(nv));
      float h = fbm(wp * 2.0) * 0.5 + 0.5;
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
  `,
  gas: /* glsl */`
    // Gas giants have no solid relief — return 0 so the normal gradient
    // stays flat and the sphere reads as smooth banded atmosphere.
    float heightFn(vec3 p) { return 0.0; }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      vec3 wp = warp(p * 1.5 + vec3(t * 0.02, 0.0, 0.0));
      float lat = n.y;
      float turb = fbm(wp * 2.5 + vec3(t * 0.04, 0.0, 0.0));
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
  `,
  lava: /* glsl */`
    float heightFn(vec3 p) {
      return fbm(p * 4.0) * 0.45 + fbm(p * 12.0) * 0.15;
    }
    vec3 procColor(vec3 n, vec3 p, vec3 base, vec3 c2, vec3 c3, float t) {
      float nv = fbm(p * 5.0 + vec3(0.0, t * 0.03, 0.0));
      float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
      vec3 dark = c2 * 0.40;
      vec3 col = mix(dark, base * 0.85, smoothstep(-0.5, 0.4, nv));
      col = mix(col, c3, hot);
      col += c3 * hot * (0.6 + 0.4 * sin(t * 1.5));
      return col;
    }
    float roughnessFn(vec3 n, vec3 p) {
      float nv = fbm(p * 5.0);
      float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
      // Magma is glossy hot, basalt is rough. Pulls roughness down where hot.
      return mix(0.72, 0.20, hot);
    }
    float emissionFn(vec3 n, vec3 p, float t) {
      float nv = fbm(p * 5.0 + vec3(0.0, t * 0.03, 0.0));
      float hot = pow(smoothstep(0.15, -0.35, -nv), 3.0);
      return hot * (0.85 + 0.20 * sin(t * 1.5));
    }
  `,
};

// --- onBeforeCompile injection chunks ----------------------------------------
// Each const is the full replacement string for a three.js #include hook: it
// re-includes the stock chunk, then appends the procedural override.

export const PLANET_VERT_COMMON = /* glsl */`
  #include <common>
  varying vec3 vLocalDir;
`;

export const PLANET_VERT_BEGIN = /* glsl */`
  #include <begin_vertex>
  vLocalDir = normalize(position);
`;

// Fragment <common>: declares the uniforms, then injects the noise library and
// the chosen class's surface functions. `surface` is one PLANET_CLASS_GLSL entry.
export function planetFragCommon(surface: string): string {
  return /* glsl */`
    #include <common>
    varying vec3 vLocalDir;
    uniform float uDetail;
    uniform float uTime;
    uniform vec3 uColor2;
    uniform vec3 uColor3;
    uniform float uSeed;
    uniform float uBump;
    // three.js auto-injects normalMatrix into the *vertex* shader prelude
    // but NOT the fragment prelude. We use it below to convert the
    // perturbed object-space normal into view space. Declaring the same
    // uniform name in the fragment shader is enough — three.js's uniform
    // setter recognizes it by name and uploads object.normalMatrix per
    // draw. Without this declaration the shader fails to compile, which
    // silently kills the planet mesh: every fragment is skipped, the
    // body never draws, and only the atmosphere rim halo remains visible.
    uniform mat3 normalMatrix;
    ${NOISE_GLSL}
    ${surface}
  `;
}

// 1. Diffuse color from procedural surface. Gated at uDetail > 0.08:
//    below that, the proc overlay blends in at <8% weight which is
//    imperceptible, so we skip the full noise stack entirely.
export const PLANET_FRAG_MAP = /* glsl */`
  #include <map_fragment>
  if (uDetail > 0.08) {
    vec3 base = diffuseColor.rgb;
    vec3 n0 = normalize(vLocalDir);
    vec3 pp = n0 + uSeed * 100.0;
    vec3 proc = procColor(n0, pp, base, uColor2, uColor3, uTime);
    diffuseColor.rgb = mix(base, proc, uDetail);
  }
`;

// 2. Normal perturbation from height field. Gated harder than color
//    (0.18) because bump is the most expensive hook — it samples
//    heightFn 3 times per fragment, and the visual benefit fades fast
//    once the planet's silhouette is small. Tangent-plane gradient
//    (3 samples) instead of full 3D (4 samples) — same result because
//    the radial component would be projected out anyway.
export const PLANET_FRAG_NORMAL = /* glsl */`
  #include <normal_fragment_maps>
  if (uDetail > 0.18 && uBump > 0.0) {
    const float eps = 0.015;
    vec3 n0 = normalize(vLocalDir);
    vec3 pp = n0 + uSeed * 100.0;
    // Build an orthonormal tangent frame on the unit sphere. Pick the
    // less-aligned cardinal axis to cross with n0 so we never get a
    // degenerate frame at the poles.
    vec3 helper = abs(n0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tang = normalize(cross(helper, n0));
    vec3 bitg = cross(n0, tang);
    float h0 = heightFn(pp);
    float ht = heightFn(pp + tang * eps);
    float hb = heightFn(pp + bitg * eps);
    // Tangent-plane gradient — already lies in the tangent plane, no
    // projection needed.
    vec3 grad = (tang * (ht - h0) + bitg * (hb - h0)) / eps;
    vec3 nLocal = normalize(n0 - grad * uBump);
    vec3 nView = normalize(normalMatrix * nLocal);
    // Ramp the perturbation with detail so distant planets keep the
    // smooth shaded look and don't visibly snap when crossing the LOD.
    normal = normalize(mix(normal, nView, uDetail));
  }
`;

// 3. Per-pixel roughness modulation. Cheap relative to bump but still
//    not free — gate at the same color threshold.
export const PLANET_FRAG_ROUGHNESS = /* glsl */`
  #include <roughnessmap_fragment>
  if (uDetail > 0.08) {
    vec3 n0 = normalize(vLocalDir);
    vec3 pp = n0 + uSeed * 100.0;
    float rr = roughnessFn(n0, pp);
    roughnessFactor = mix(roughnessFactor, rr, uDetail);
  }
`;

// 4. Procedural emission. Only lava is non-trivial; other classes
//    return 0 and the branch costs ~nothing.
//
// Plus a *visibility floor* tied to the current diffuseColor: an
// unconditional addition of 35% of the final diffuse to the emissive
// term. This guarantees the planet's body always registers — even
// when it's on the dark side or far from its host star and the
// direct/ambient terms (heavily ÷PI in three.js's PBR) leave the
// surface near-black. The user's symptom was a planet that read as
// "transparent body, only the atmospheric rim visible," which means
// the diffuse lighting alone wasn't enough to bring the body out
// against the void. Coupling emissive to the procedural diffuse keeps
// the planet's color identity intact while ensuring it's always seen.
export const PLANET_FRAG_EMISSIVE = /* glsl */`
  #include <emissivemap_fragment>
  if (uDetail > 0.08) {
    vec3 n0 = normalize(vLocalDir);
    vec3 pp = n0 + uSeed * 100.0;
    float e = emissionFn(n0, pp, uTime);
    totalEmissiveRadiance += uColor3 * e * 1.6 * uDetail;
  }
  totalEmissiveRadiance += diffuseColor.rgb * 0.35;
`;
