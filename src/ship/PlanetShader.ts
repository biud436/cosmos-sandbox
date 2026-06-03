import * as THREE from 'three';
import { Planet, PlanetClass } from './PlanetSystem';
import {
  PLANET_CLASS_GLSL,
  PLANET_VERT_COMMON,
  PLANET_VERT_BEGIN,
  planetFragCommon,
  PLANET_FRAG_MAP,
  PLANET_FRAG_NORMAL,
  PLANET_FRAG_ROUGHNESS,
  PLANET_FRAG_EMISSIVE,
} from './shaders/planet';

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
  // Self-emissive floor. Three.js MeshStandardMaterial uses physically-based
  // lighting where the ambient/PI term is quite dim, and at the wider orbital
  // distances of the current planet system the point light from the host
  // star also falls off heavily. Without a meaningful emissive floor the
  // planet body reads as black against the void, leaving only the atmosphere
  // rim halo visible. 18% of base color keeps the planet self-lit enough to
  // register as a body, without overpowering proper sunlit contrast.
  const baseEmissive = planet.planetClass === 'lava'
    ? new THREE.Color(0.22, 0.08, 0.03)
    : new THREE.Color(planet.color[0] * 0.18, planet.color[1] * 0.18, planet.color[2] * 0.18);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(planet.color[0], planet.color[1], planet.color[2]),
    roughness: planet.planetClass === 'ocean' ? 0.4 : planet.planetClass === 'ice' ? 0.55 : 0.85,
    metalness: planet.planetClass === 'lava' ? 0.0 : 0.05,
    emissive: baseEmissive,
  });

  // Uniforms live on the shader once compiled. We capture references here so
  // setDetail / setTime can poke them every frame without a re-compile.
  const uniformRefs: { uDetail: { value: number }; uTime: { value: number } } = {
    uDetail: { value: 0 },
    uTime: { value: 0 },
  };

  const surface = PLANET_CLASS_GLSL[planet.planetClass];
  const bumpStrength = bumpStrengthFor(planet.planetClass);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniformRefs.uDetail;
    shader.uniforms.uTime = uniformRefs.uTime;
    shader.uniforms.uColor2 = { value: c2 };
    shader.uniforms.uColor3 = { value: c3 };
    shader.uniforms.uSeed = { value: planet.shaderSeed };
    shader.uniforms.uBump = { value: bumpStrength };

    // Vertex: pass the object-space sphere direction to the fragment stage.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', PLANET_VERT_COMMON)
      .replace('#include <begin_vertex>', PLANET_VERT_BEGIN);

    // Fragment: declare uniforms + noise/surface lib, then patch the four
    // procedural hooks (diffuse, normal, roughness, emission). See
    // shaders/planet for the GLSL and the gating rationale of each hook.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', planetFragCommon(surface))
      .replace('#include <map_fragment>', PLANET_FRAG_MAP)
      .replace('#include <normal_fragment_maps>', PLANET_FRAG_NORMAL)
      .replace('#include <roughnessmap_fragment>', PLANET_FRAG_ROUGHNESS)
      .replace('#include <emissivemap_fragment>', PLANET_FRAG_EMISSIVE);
  };

  return {
    material: mat,
    setDetail: (d: number) => { uniformRefs.uDetail.value = d; },
    setTime: (t: number) => { uniformRefs.uTime.value = t; },
  };
}
