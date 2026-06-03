import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { blackbodyRGB } from '../physics/stellarPhysics';
import { GraphicsSettings } from '../render/GraphicsSettings';
import { Planet, PlanetClass, PlanetSystem, planetPosition } from './PlanetSystem';
import { createPlanetMaterial, PlanetMaterialHandle } from './PlanetShader';
import { ATMOSPHERE_VERT, ATMOSPHERE_FRAG } from './shaders/atmosphere';

// Renders the procedural planets for a single visited star. Each instance
// owns its own scene group so it can be detached cleanly when the LRU
// evicts. Planet positions are advanced from shipProperTime (passed each
// frame to update()), so they don't smear when the user dilates cosmic time.

// Module-level geometry cache, keyed by segments tuple. Multiple star systems
// sharing the same quality preset re-use the same SphereGeometry so we don't
// allocate a fresh vertex buffer per planet. Falls back to a default if no
// settings were passed (mainly for tests / standalone use).
const SPHERE_CACHE = new Map<string, THREE.SphereGeometry>();
const ATMO_CACHE = new Map<string, THREE.SphereGeometry>();
function getSphere(w: number, h: number): THREE.SphereGeometry {
  const key = `${w}x${h}`;
  let g = SPHERE_CACHE.get(key);
  if (!g) { g = new THREE.SphereGeometry(1, w, h); SPHERE_CACHE.set(key, g); }
  return g;
}
function getAtmo(w: number, h: number): THREE.SphereGeometry {
  const key = `${w}x${h}`;
  let g = ATMO_CACHE.get(key);
  if (!g) { g = new THREE.SphereGeometry(1, w, h); ATMO_CACHE.set(key, g); }
  return g;
}
const DEFAULT_PLANET_SEGMENTS: [number, number] = [48, 32];
const DEFAULT_ATMO_SEGMENTS: [number, number] = [32, 24];
const ORBIT_SEGMENTS = 96;

// Per-class atmosphere settings. `null` = airless (lava planets stay bare).
//   tint: rim color
//   thickness: scales rim alpha — thicker for gaseous/oceanic worlds.
//   scale: shell radius relative to planet (1.05 = 5% larger).
//
// Values halved from the original tuning: the previous thicknesses (0.45-1.10)
// pushed the additive rim halo past the planet's silhouette so brightly that
// the surface read as "see-through" at the edge — the user's "행성 표면이
// 너무 투명합니다" complaint. The current values keep a visible limb glow
// without overwhelming the planet's solid body.
function atmosphereOf(cls: PlanetClass): { tint: THREE.Color; thickness: number; scale: number } | null {
  switch (cls) {
    case 'lava':   return null;
    case 'rock':   return { tint: new THREE.Color(0.72, 0.78, 0.92), thickness: 0.22, scale: 1.03 };
    case 'desert': return { tint: new THREE.Color(0.98, 0.78, 0.55), thickness: 0.40, scale: 1.05 };
    case 'ocean':  return { tint: new THREE.Color(0.55, 0.78, 1.00), thickness: 0.55, scale: 1.06 };
    case 'ice':    return { tint: new THREE.Color(0.82, 0.92, 1.00), thickness: 0.18, scale: 1.025 };
    case 'gas':    return { tint: new THREE.Color(0.95, 0.85, 0.65), thickness: 0.50, scale: 1.04 };
  }
}

interface AtmosphereHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uSunDir: { value: THREE.Vector3 };
  uHasSun: { value: number };
}

function createAtmosphereMaterial(tint: THREE.Color, thickness: number, hasSun: boolean, geom: THREE.SphereGeometry): AtmosphereHandle {
  const uSunDir = { value: new THREE.Vector3(1, 0, 0) };
  const uHasSun = { value: hasSun ? 1 : 0 };
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: tint },
      uThickness: { value: thickness },
      uSunDir,
      uHasSun,
    },
    // World-space shaders (see shaders/atmosphere): the sun direction lines up
    // with the shell's geometric normal directly, BackSide shows the dome from
    // inside on close approach, and the additive fresnel gives the limb glow.
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  return { mesh, material, uSunDir, uHasSun };
}

export class StarSystemView {
  readonly group: THREE.Group;
  private readonly planetMeshes: THREE.Mesh[] = [];
  private readonly orbitLines: THREE.LineLoop[] = [];
  private readonly planetMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly planetHandles: PlanetMaterialHandle[] = [];
  // Parallel array, one per planet — `null` for airless (lava). Atmosphere
  // meshes are children of their planet mesh so they inherit position; we
  // counter the parent's spin/tilt by clearing local rotation on the shell.
  private readonly atmospheres: (AtmosphereHandle | null)[] = [];
  private readonly orbitMaterial: THREE.LineBasicMaterial;
  private readonly system: PlanetSystem;
  private readonly host: Effector;
  private readonly starLight: THREE.PointLight | null;

  constructor(system: PlanetSystem, host: Effector, gfx?: GraphicsSettings) {
    this.system = system;
    this.host = host;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;

    const sphereSegs = gfx?.planetSphereSegments ?? DEFAULT_PLANET_SEGMENTS;
    const atmoSegs = gfx?.atmoSphereSegments ?? DEFAULT_ATMO_SEGMENTS;
    const sphereGeom = getSphere(sphereSegs[0], sphereSegs[1]);
    const atmoGeom = getAtmo(atmoSegs[0], atmoSegs[1]);

    this.orbitMaterial = new THREE.LineBasicMaterial({
      color: 0x668cb8,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });

    // Stars emit light. Compact objects (BH, NS) don't — their "system" is
    // ruins/captures, not insolation, so we leave the scene's ambient/key
    // light to do the work. Range is set roughly to the outer planet so the
    // light doesn't leak across the entire scene.
    if (host.type === 'star') {
      // Tint from blackbody color at the star's effective T. A red M-dwarf
      // bathes its planets in reddish light; a blue O-giant in cold white.
      // Falls back to a warm cream if T isn't set (legacy stars).
      const tempK = host.temperatureK ?? 5800;
      const [r, g, b] = blackbodyRGB(tempK);
      const tint = new THREE.Color(r, g, b);
      // Intensity from bolometric luminosity (L⊙), log-compressed so a
      // bright O-giant doesn't whiteout the scene next to a tiny M-dwarf.
      // Compression matches what the eye does (mag scale).
      const L = host.luminositySolar ?? 1;
      const intensity = Math.min(280, 70 + 35 * Math.log10(Math.max(0.01, L) * 10 + 1));
      // Range = 0 means "infinite" in three.js, which would tint everything
      // in the simulation. Cap it to a few system widths.
      const range = Math.max(80, host.radius * 120);
      this.starLight = new THREE.PointLight(tint, intensity, range, 1);
      this.starLight.position.set(0, 0, 0);
      this.group.add(this.starLight);
    } else {
      this.starLight = null;
    }

    for (const planet of system.planets) {
      const handle = createPlanetMaterial(planet);
      const mesh = new THREE.Mesh(sphereGeom, handle.material);
      // Oblateness: equator > pole. Scale equatorial axes (X, Z) by the
      // visual radius and squash the polar axis (Y) by (1 - oblateness).
      // The mesh is later rotated around X by axialTilt — applied as a
      // parent rotation by the renderer's update loop's mesh.rotation.x
      // already, so the squash stays aligned with the local equator.
      const re = planet.visualRadius;
      const rp = planet.visualRadius * (1 - planet.oblateness);
      mesh.scale.set(re, rp, re);
      // Apply axial tilt once as a rotation around X; spin advances around
      // the planet's local Y in update().
      mesh.rotation.x = planet.axialTilt;
      this.group.add(mesh);
      this.planetMeshes.push(mesh);
      this.planetMaterials.push(handle.material);
      this.planetHandles.push(handle);

      // Atmosphere shell — parented to the planet mesh so position tracking
      // is free, but we drop its inherited rotation by setting it as a peer
      // child of the group instead. We use a peer-child so the atmosphere
      // doesn't spin with the planet (atmospheres are visually invariant
      // under rotation; we just want the position to track).
      const atmoSpec = atmosphereOf(planet.planetClass);
      if (atmoSpec) {
        const hasSun = this.host.type === 'star';
        const atmo = createAtmosphereMaterial(atmoSpec.tint, atmoSpec.thickness, hasSun, atmoGeom);
        // Match the planet's oblateness so the atmosphere doesn't sit as a
        // perfect sphere around a squashed gas giant.
        const re = planet.visualRadius * atmoSpec.scale;
        const rp = re * (1 - planet.oblateness);
        atmo.mesh.scale.set(re, rp, re);
        this.group.add(atmo.mesh);
        this.atmospheres.push(atmo);
      } else {
        this.atmospheres.push(null);
      }

      this.orbitLines.push(this.makeOrbitLine(planet));
      this.group.add(this.orbitLines[this.orbitLines.length - 1]);
    }
  }

  /** Build an ellipse outline matching the planet's Kepler orbit. The host
   *  sits at one focus (not the center), so we use planetPosition() rather
   *  than parametrizing a circle: that way the line traces exactly where the
   *  planet actually goes, including periapsis bias from argPeriapsis. */
  private makeOrbitLine(planet: Planet): THREE.LineLoop {
    const positions = new Float32Array(ORBIT_SEGMENTS * 3);
    // Sample by mean anomaly so spacing on the orbit line is uniform in time
    // (denser near apoapsis where the planet moves slowly — matches reality).
    // For pure visual evenness we'd sample by true anomaly, but uniform-time
    // sampling gives a subtle hint that the planet lingers far out.
    const out: [number, number, number] = [0, 0, 0];
    // The planet's phase0 doesn't matter for the orbit-line shape — only e
    // and argPeriapsis and inclination do. Sample with phase0 cleared so the
    // line doesn't shift if we ever regenerate from a different t.
    const proxy: Planet = { ...planet, phase0: 0 };
    for (let i = 0; i < ORBIT_SEGMENTS; i++) {
      const t = (i / ORBIT_SEGMENTS) * proxy.periodSec;
      planetPosition(proxy, t, out);
      positions[i * 3 + 0] = out[0];
      positions[i * 3 + 1] = out[1];
      positions[i * 3 + 2] = out[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const loop = new THREE.LineLoop(geo, this.orbitMaterial);
    loop.frustumCulled = false;
    return loop;
  }

  /** Move planets along their orbits, advance per-planet spin, and drive
   *  the procedural-shader LOD from camera distance. `cameraPos` is
   *  optional — when omitted, planets stay in their flat-color (uDetail=0)
   *  state, which is the right behavior outside ship mode. */
  update(shipTime: number, cameraPos?: THREE.Vector3): void {
    // Keep the system pinned to the host star (which may itself be moving).
    this.group.position.set(this.host.x, this.host.y, this.host.z);

    const tmp = new THREE.Vector3();
    const sunWorld = new THREE.Vector3();
    const posOut: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.system.planets.length; i++) {
      const p = this.system.planets[i];
      const mesh = this.planetMeshes[i];
      // Kepler ellipse: solve E - e sin E = M analytically each frame.
      planetPosition(p, shipTime, posOut);
      mesh.position.set(posOut[0], posOut[1], posOut[2]);

      // Self-rotation. Tilt is baked into rotation.x; spin advances .y.
      // Negative spinPeriodSec = retrograde.
      mesh.rotation.y = (shipTime / p.spinPeriodSec) * Math.PI * 2;

      // Atmosphere tracks position (no rotation needed — sphere is invariant).
      // Sun direction is the unit vector from the planet to the host star.
      // Host sits at group origin, so in group-local coords this is just
      // -mesh.position normalized; group has no rotation, so it matches world.
      const atmo = this.atmospheres[i];
      if (atmo) {
        atmo.mesh.position.copy(mesh.position);
        sunWorld.copy(mesh.position).multiplyScalar(-1).normalize();
        atmo.uSunDir.value.copy(sunWorld);
      }

      const handle = this.planetHandles[i];
      handle.setTime(shipTime);

      if (cameraPos) {
        // World-space distance from camera to planet center.
        tmp.copy(mesh.position).add(this.group.position);
        const d = tmp.distanceTo(cameraPos);
        // Detail ramp: fully procedural within ~15× the planet's radius,
        // pure base color past ~80×. Tuned so a fly-by reveals texture
        // around the same moment the planet visibly grows in the viewport.
        const r = p.visualRadius;
        const near = r * 15;
        const far = r * 80;
        const detail = 1.0 - Math.min(1, Math.max(0, (d - near) / (far - near)));
        handle.setDetail(detail);
      } else {
        handle.setDetail(0);
      }
    }
  }

  /** Release GPU resources. Geometry is shared (module-level), so we only
   * dispose per-instance materials and orbit-line geometries. */
  dispose(): void {
    for (const m of this.planetMaterials) m.dispose();
    for (const a of this.atmospheres) if (a) a.material.dispose();
    for (const l of this.orbitLines) l.geometry.dispose();
    this.orbitMaterial.dispose();
    this.group.parent?.remove(this.group);
  }

  /** Identify which planet (if any) the ship is closest to. Used by HUD. */
  nearestPlanetTo(point: THREE.Vector3): { planetIndex: number; distance: number } | null {
    let best = -1;
    let bestD = Infinity;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < this.planetMeshes.length; i++) {
      tmp.copy(this.planetMeshes[i].position).add(this.group.position);
      const d = tmp.distanceTo(point);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? { planetIndex: best, distance: bestD } : null;
  }

  get planetSystem(): PlanetSystem {
    return this.system;
  }

  /** Outer planet's orbit radius, plus the planet's own radius — the
   * largest distance from the host star at which a visit still passes
   * through actual content. Used to size the visit-detection sphere so
   * outer planets don't fall outside the trigger when flying through. */
  get outerExtent(): number {
    if (this.system.planets.length === 0) return 0;
    let max = 0;
    for (const p of this.system.planets) {
      // Apoapsis = a(1+e), the farthest a planet ever travels from its host
      // — use this so the visit-detection sphere doesn't fall short of an
      // eccentric outer planet at the wrong moment in its orbit.
      const apoapsis = p.orbitRadius * (1 + p.eccentricity);
      const r = apoapsis + p.visualRadius;
      if (r > max) max = r;
    }
    return max;
  }
}
