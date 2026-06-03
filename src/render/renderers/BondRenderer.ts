import * as THREE from 'three';
import { Simulator } from '../../physics/Simulator';

// Draws inter-particle bonds as a single LineSegments batch. Owns its geometry
// and position buffer; the Scene only forwards visibility toggles and the
// per-frame sync. Capacity is fixed at construction (4 bonds per particle).
export class BondRenderer {
  private readonly geom: THREE.BufferGeometry;
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;

  constructor(scene: THREE.Scene, maxParticlesTotal: number) {
    const maxBonds = maxParticlesTotal * 4;
    this.positions = new Float32Array(maxBonds * 2 * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x6688ff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(this.geom, mat);
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }

  setVisible(visible: boolean): void {
    this.lines.visible = visible;
  }

  sync(sim: Simulator): void {
    const positions = this.positions;
    const m = sim.bondListLength;
    const cap = positions.length / 6;
    const k = Math.min(m, cap);
    for (let b = 0; b < k; b++) {
      const i = sim.getBondVertex(b, 'i');
      const j = sim.getBondVertex(b, 'j');
      const off = b * 6;
      positions[off + 0] = sim.positions[i * 3 + 0];
      positions[off + 1] = sim.positions[i * 3 + 1];
      positions[off + 2] = sim.positions[i * 3 + 2];
      positions[off + 3] = sim.positions[j * 3 + 0];
      positions[off + 4] = sim.positions[j * 3 + 1];
      positions[off + 5] = sim.positions[j * 3 + 2];
    }
    this.geom.setDrawRange(0, k * 2);
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
