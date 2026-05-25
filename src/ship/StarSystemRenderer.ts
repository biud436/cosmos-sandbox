import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { PlanetSystem } from './PlanetSystem';
import { createPlanetMaterial, PlanetMaterialHandle } from './PlanetShader';

// Renders the procedural planets for a single visited star. Each instance
// owns its own scene group so it can be detached cleanly when the LRU
// evicts. Planet positions are advanced from shipProperTime (passed each
// frame to update()), so they don't smear when the user dilates cosmic time.

const SPHERE_GEOM = new THREE.SphereGeometry(1, 12, 10);
const ORBIT_SEGMENTS = 96;

export class StarSystemView {
  readonly group: THREE.Group;
  private readonly planetMeshes: THREE.Mesh[] = [];
  private readonly orbitLines: THREE.LineLoop[] = [];
  private readonly planetMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly planetHandles: PlanetMaterialHandle[] = [];
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
