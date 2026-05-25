import * as THREE from 'three';
import { Planet, PlanetClass } from './PlanetSystem';

// Procedural planet materials. No textures, no image assets — every surface
// pattern is GLSL noise evaluated on the unit-sphere local position.
//
// Pipeline (per planet):
//   - Start with a stock MeshStandardMaterial so the scene's lights (the new
//     per-star point light) keep working with no manual lighting code.
//   - Patch the shader via onBeforeCompile: inject 3D simplex noise + an
//     fbm helper into the common header, then replace the diffuse color
//     fragment with a class-specific procedural color computed from the
//     local sphere direction.
//   - Add a uDetail uniform (0..1) so the procedural color cross-fades from
//     the flat base color (far away) to the full procedural treatment
//     (close-up / orbit). The detail value is driven from JS each frame.
//   - Add a uTime uniform so the few classes that animate (lava cracks,
//     gas-band turbulence, ocean clouds) can advance.
//
// The injection trick deliberately keeps three.js's standard lighting model
// intact — we only override what `diffuseColor` is when no map is bound.
// That's how the star point light still produces a proper terminator on
// the procedural surface.

// 3D simplex noise — Stefan Gustavson's public-domain reference port.
// ~50 lines once formatted; cheap enough for a handful of pixels per frame.
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
  float ridge(vec3 p) {
    float n = abs(fbm(p));
    return 1.0 - n;
  }
`;

// Per-class surface color function. Takes the unit-sphere local direction
// (already normalized) plus base/secondary/tertiary tints derived in JS,
// plus the per-planet seed and time uniforms. Returns the procedural color.
//
// Each class shares a signature, so the dispatcher in the fragment shader
// just calls one based on a compile-time define.
function classGLSL(cls: PlanetClass): string {
  switch (cls) {
    case 'rock': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        float h = fbm(p * 3.0) * 0.5 + 0.5;          // continents
        float craters = ridge(p * 12.0);              // small detail
        float band = smoothstep(0.35, 0.65, h);
        vec3 col = mix(c2 * 0.7, base, band);
        col = mix(col, c3, smoothstep(0.78, 0.95, h));
        col *= 0.85 + 0.25 * craters;
        return col;
      }
    `;
    case 'desert': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        // Strong latitudinal banding evokes wind-shaped dunes
        float lat = p.y;
        float dunes = sin(lat * 14.0 + fbm(p * 2.0) * 3.5);
        float coarse = fbm(p * 4.0);
        float band = smoothstep(-0.3, 0.6, dunes + coarse * 0.4);
        vec3 col = mix(c2, base, band);
        col = mix(col, c3, smoothstep(0.6, 1.0, coarse));
        return col;
      }
    `;
    case 'ocean': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        // Two-tone water + a slow drifting cloud layer in white.
        float h = fbm(p * 2.5);
        float coast = smoothstep(0.0, 0.25, h);
        vec3 water = mix(c2, base, coast);
        float clouds = fbm(p * 3.2 + vec3(t * 0.018, 0.0, t * 0.012));
        float cmask = smoothstep(0.35, 0.65, clouds);
        return mix(water, vec3(0.96, 0.97, 1.0), cmask * 0.55);
      }
    `;
    case 'ice': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        // Cracks: places where two octaves cross zero produce thin lines.
        float n = fbm(p * 6.0);
        float cracks = smoothstep(0.04, 0.0, abs(n));
        float h = fbm(p * 2.0) * 0.5 + 0.5;
        vec3 col = mix(base, c2, smoothstep(0.45, 0.7, h));
        col = mix(col, c3 * 0.6, cracks);
        return col;
      }
    `;
    case 'gas': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        // Banding by latitude with turbulence kneaded in; slow drift over time.
        float lat = p.y;
        float turb = fbm(p * 2.5 + vec3(t * 0.04, 0.0, 0.0));
        float bands = sin(lat * 9.0 + turb * 2.2);
        float storm = smoothstep(0.62, 0.95, fbm(p * 4.0 + vec3(0.0, t * 0.01, 0.0)));
        vec3 col = mix(base, c2, smoothstep(-0.2, 0.4, bands));
        col = mix(col, c3, smoothstep(0.4, 0.95, bands));
        col = mix(col, c3 * 1.15, storm * 0.5);
        return col;
      }
    `;
    case 'lava': return /* glsl */`
      vec3 procColor(vec3 p, vec3 base, vec3 c2, vec3 c3, float seed, float t) {
        p += seed * 100.0;
        // Dark basalt + glowing crack network. Cracks pulse very slowly.
        float n = fbm(p * 5.0 + vec3(0.0, t * 0.03, 0.0));
        float hot = pow(smoothstep(0.15, -0.35, -n), 3.0);
        vec3 dark = c2 * 0.45;
        vec3 col = mix(dark, base * 0.85, smoothstep(-0.5, 0.4, n));
        // c3 acts as the molten color; boost it heavily where 'hot' fires.
        col = mix(col, c3, hot);
        col += c3 * hot * (0.6 + 0.4 * sin(t * 1.5 + seed * 6.28));
        return col;
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

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniformRefs.uDetail;
    shader.uniforms.uTime = uniformRefs.uTime;
    shader.uniforms.uColor2 = { value: c2 };
    shader.uniforms.uColor3 = { value: c3 };
    shader.uniforms.uSeed = { value: planet.shaderSeed };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vLocalDir;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vLocalDir = normalize(position);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vLocalDir;
        uniform float uDetail;
        uniform float uTime;
        uniform vec3 uColor2;
        uniform vec3 uColor3;
        uniform float uSeed;
        ${NOISE_GLSL}
        ${surface}
      `)
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        if (uDetail > 0.001) {
          vec3 base = diffuseColor.rgb;
          vec3 proc = procColor(vLocalDir, base, uColor2, uColor3, uSeed, uTime);
          diffuseColor.rgb = mix(base, proc, uDetail);
        }
      `);
  };

  return {
    material: mat,
    setDetail: (d: number) => { uniformRefs.uDetail.value = d; },
    setTime: (t: number) => { uniformRefs.uTime.value = t; },
  };
}
