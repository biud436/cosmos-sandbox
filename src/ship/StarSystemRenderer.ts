import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { PlanetSystem } from './PlanetSystem';

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
  private readonly orbitMaterial: THREE.LineBasicMaterial;
  private readonly system: PlanetSystem;
  private readonly host: Effector;

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

    for (const planet of system.planets) {
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(planet.color[0], planet.color[1], planet.color[2]),
        roughness: 0.85,
        metalness: 0.05,
        emissive: new THREE.Color(planet.color[0] * 0.15, planet.color[1] * 0.15, planet.color[2] * 0.15),
      });
      const mesh = new THREE.Mesh(SPHERE_GEOM, mat);
      mesh.scale.setScalar(planet.visualRadius);
      this.group.add(mesh);
      this.planetMeshes.push(mesh);
      this.planetMaterials.push(mat);

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

  /** Move planets along their orbits. `shipTime` is monotonic seconds. */
  update(shipTime: number): void {
    // Keep the system pinned to the host star (which may itself be moving).
    this.group.position.set(this.host.x, this.host.y, this.host.z);

    for (let i = 0; i < this.system.planets.length; i++) {
      const p = this.system.planets[i];
      const mesh = this.planetMeshes[i];
      const angle = p.phase0 + (shipTime / p.periodSec) * Math.PI * 2;
      const sinI = Math.sin(p.inclination);
      const cosI = Math.cos(p.inclination);
      const x = Math.cos(angle) * p.orbitRadius;
      const z = Math.sin(angle) * p.orbitRadius;
      mesh.position.set(x, z * sinI, z * cosI);
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
}
