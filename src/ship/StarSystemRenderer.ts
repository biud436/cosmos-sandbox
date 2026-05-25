import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { PlanetClass, PlanetSystem } from './PlanetSystem';
import { createPlanetMaterial, PlanetMaterialHandle } from './PlanetShader';

// Renders the procedural planets for a single visited star. Each instance
// owns its own scene group so it can be detached cleanly when the LRU
// evicts. Planet positions are advanced from shipProperTime (passed each
// frame to update()), so they don't smear when the user dilates cosmic time.

// 48×32 is high enough that close-flyby silhouettes don't read as facets
// while still cheap for ~10 planets per system.
const SPHERE_GEOM = new THREE.SphereGeometry(1, 48, 32);
const ATMOSPHERE_GEOM = new THREE.SphereGeometry(1, 32, 24);
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

function createAtmosphereMaterial(tint: THREE.Color, thickness: number, hasSun: boolean): AtmosphereHandle {
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
    // We compute everything in world space so the sun direction (a world-space
    // vector pointing from planet → host star) lines up with the geometric
    // normal of the shell directly. BackSide lets us see the dome from inside
    // when the camera is close, while the additive blend over fresnel gives
    // the classic limb-glow look.
    vertexShader: /* glsl */`
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      uniform vec3 uColor;
      uniform float uThickness;
      uniform vec3 uSunDir;
      uniform float uHasSun;
      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float NdotV = abs(dot(N, V));
        // Sharper rim falloff (3.0 instead of 2.5) concentrates the halo at
        // the limb so the rim doesn't bleed inward across the planet edge.
        float rim = pow(1.0 - NdotV, 3.0);
        // Day-side bias: scattering brightest where the planet faces the star,
        // dimmest at midnight. Without a sun (BH/NS host), we skip the bias.
        float day = mix(1.0, max(dot(N, uSunDir), 0.0) * 0.85 + 0.15, uHasSun);
        // Reduce the global multiplier and tighten the alpha cap so the
        // atmosphere reads as glow, not as a wash.
        float a = rim * day * uThickness * 0.65;
        gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.55));
      }
    `,
  });
  const mesh = new THREE.Mesh(ATMOSPHERE_GEOM, material);
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

  constructor(system: PlanetSystem, host: Effector) {
    this.system = system;
    this.host = host;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;

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
      const intensity = Math.min(120, 30 + host.strength * 0.6);
      const tint = new THREE.Color(1.0, 0.95, 0.85);
      // Range = 0 means "infinite" in three.js, which would tint everything
      // in the simulation. Cap it to a few system widths.
      const range = Math.max(40, host.radius * 80);
      this.starLight = new THREE.PointLight(tint, intensity, range, 2);
      this.starLight.position.set(0, 0, 0);
      this.group.add(this.starLight);
    } else {
      this.starLight = null;
    }

    for (const planet of system.planets) {
      const handle = createPlanetMaterial(planet);
      const mesh = new THREE.Mesh(SPHERE_GEOM, handle.material);
      mesh.scale.setScalar(planet.visualRadius);
      // Apply axial tilt once as a rotation around X; spin advances around
      // the planet's local Y in update(). Composing tilt as a separate
      // parent Group would be cleaner but a single rotation is enough since
      // the unit-sphere geometry has no preferred up.
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
        const atmo = createAtmosphereMaterial(atmoSpec.tint, atmoSpec.thickness, hasSun);
        atmo.mesh.scale.setScalar(planet.visualRadius * atmoSpec.scale);
        this.group.add(atmo.mesh);
        this.atmospheres.push(atmo);
      } else {
        this.atmospheres.push(null);
      }

      this.orbitLines.push(this.makeOrbitLine(planet.orbitRadius, planet.inclination));
      this.group.add(this.orbitLines[this.orbitLines.length - 1]);
    }
  }

  private makeOrbitLine(radius: number, inclination: number): THREE.LineLoop {
    const positions = new Float32Array(ORBIT_SEGMENTS * 3);
    const sinI = Math.sin(inclination);
    const cosI = Math.cos(inclination);
    for (let i = 0; i < ORBIT_SEGMENTS; i++) {
      const a = (i / ORBIT_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      // Tilt around X axis by inclination
      const y = z * sinI;
      const z2 = z * cosI;
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z2;
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
    for (let i = 0; i < this.system.planets.length; i++) {
      const p = this.system.planets[i];
      const mesh = this.planetMeshes[i];
      const angle = p.phase0 + (shipTime / p.periodSec) * Math.PI * 2;
      const sinI = Math.sin(p.inclination);
      const cosI = Math.cos(p.inclination);
      const x = Math.cos(angle) * p.orbitRadius;
      const z = Math.sin(angle) * p.orbitRadius;
      mesh.position.set(x, z * sinI, z * cosI);

      // Self-rotation. Tilt is baked into rotation.x; spin advances .y.
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
      const r = p.orbitRadius + p.visualRadius;
      if (r > max) max = r;
    }
    return max;
  }
}
