import * as THREE from 'three';
import { SPECIES } from '../../physics/types';
import { Simulator } from '../../physics/Simulator';
import { GAS_VERT, GAS_FRAG, GAS_HALO_VERT, GAS_HALO_FRAG } from '../shaders';

// Renders the bulk particle field in one of two modes:
//   'solid' — instanced spheres with a two-tier LOD (hi: 320-tri icosa for
//             particles bigger than ~`particleLodPx` on screen, lo: 20-tri for
//             distant dots). Frustum-culled per particle on the CPU.
//   'gas'   — additive point sprites in two passes (a wisp-noised detail pass
//             and a large soft halo pass) so dense clumps read as diffuse nebula.
//
// Owns all particle/gas geometry, buffers, and the render-mode state. The Scene
// forwards the per-frame frustum + camera + LOD inputs and toggles visibility.
export class ParticleRenderer {
  private readonly speciesMeshes: THREE.InstancedMesh[] = [];
  private readonly speciesMeshesLo: THREE.InstancedMesh[] = [];
  private readonly speciesCapacity: number[];
  private readonly maxParticlesTotal: number;
  // Reused per-frame scratch — avoid GC churn in the 60Hz sync path.
  private readonly speciesCountsScratch = new Int32Array(SPECIES.length);
  private readonly speciesCountsLoScratch = new Int32Array(SPECIES.length);
  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpSphere = new THREE.Sphere();

  private readonly gasPoints: THREE.Points;
  private readonly gasHaloPoints: THREE.Points;
  private readonly gasGeom: THREE.BufferGeometry;
  private readonly gasPositions: Float32Array;
  private readonly gasColors: Float32Array;
  private readonly gasSizes: Float32Array;

  private renderMode: 'solid' | 'gas' = 'solid';

  constructor(scene: THREE.Scene, maxPerSpecies: number, initialPixelScale: number) {
    this.speciesCapacity = SPECIES.map(() => maxPerSpecies);
    this.maxParticlesTotal = maxPerSpecies * SPECIES.length;
    this.buildParticleMeshes(scene);

    const cap = this.maxParticlesTotal;
    this.gasPositions = new Float32Array(cap * 3);
    this.gasColors = new Float32Array(cap * 3);
    this.gasSizes = new Float32Array(cap);
    this.gasGeom = new THREE.BufferGeometry();
    this.gasGeom.setAttribute('position', new THREE.BufferAttribute(this.gasPositions, 3));
    this.gasGeom.setAttribute('color', new THREE.BufferAttribute(this.gasColors, 3));
    this.gasGeom.setAttribute('size', new THREE.BufferAttribute(this.gasSizes, 1));
    this.gasGeom.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelScale: { value: initialPixelScale },
        uRedshiftNear: { value: 80 },
        uRedshiftFar: { value: 500 },
      },
      vertexShader: GAS_VERT,
      fragmentShader: GAS_FRAG,
    });
    this.gasPoints = new THREE.Points(this.gasGeom, mat);
    this.gasPoints.frustumCulled = false;
    this.gasPoints.visible = false;
    scene.add(this.gasPoints);

    // Macro halo pass: same buffers, much larger sprite, no wisp noise.
    // Heavy overlap of these big soft Gaussians makes nearby particles read
    // as a single nebula cluster rather than discrete dots.
    const haloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelScale: { value: initialPixelScale },
        uRedshiftNear: { value: 80 },
        uRedshiftFar: { value: 500 },
        uSizeMul: { value: 3.2 },
      },
      vertexShader: GAS_HALO_VERT,
      fragmentShader: GAS_HALO_FRAG,
    });
    this.gasHaloPoints = new THREE.Points(this.gasGeom, haloMat);
    this.gasHaloPoints.frustumCulled = false;
    this.gasHaloPoints.visible = false;
    this.gasHaloPoints.renderOrder = -1; // draw behind the detail pass
    scene.add(this.gasHaloPoints);
  }

  private buildParticleMeshes(scene: THREE.Scene): void {
    // High LOD: detail=2 = 320 triangles per sphere. Looks correctly round
    // for particles big enough to occupy >8 screen pixels.
    const sphereGeoHi = new THREE.IcosahedronGeometry(1, 2);
    // Low LOD: detail=0 = 20 triangles. Indistinguishable from the hi-LOD
    // mesh once a particle shrinks under ~6px on screen, but renders 16x
    // cheaper. Materially the same per-instance setMatrixAt cost, so the
    // CPU side stays flat.
    const sphereGeoLo = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < SPECIES.length; i++) {
      const species = SPECIES[i];
      const matHi = new THREE.MeshBasicMaterial({ color: species.color });
      const meshHi = new THREE.InstancedMesh(sphereGeoHi, matHi, this.speciesCapacity[i]);
      meshHi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshHi.count = 0;
      meshHi.frustumCulled = false;
      scene.add(meshHi);
      this.speciesMeshes.push(meshHi);

      const matLo = new THREE.MeshBasicMaterial({ color: species.color });
      const meshLo = new THREE.InstancedMesh(sphereGeoLo, matLo, this.speciesCapacity[i]);
      meshLo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshLo.count = 0;
      meshLo.frustumCulled = false;
      scene.add(meshLo);
      this.speciesMeshesLo.push(meshLo);
    }
  }

  /** Toggle solid↔gas. No-op if already in `mode`. `particlesVisible` is the
   *  Scene's current particle-visibility flag, applied to the newly-active set. */
  setRenderMode(mode: 'solid' | 'gas', particlesVisible: boolean): void {
    if (mode === this.renderMode) return;
    this.renderMode = mode;
    this.setVisible(particlesVisible);
  }

  /** Apply particle visibility to whichever mode is active (the inactive set
   *  stays hidden). */
  setVisible(visible: boolean): void {
    const useSolid = this.renderMode === 'solid';
    for (const m of this.speciesMeshes) m.visible = visible && useSolid;
    for (const m of this.speciesMeshesLo) m.visible = visible && useSolid;
    this.gasPoints.visible = visible && !useSolid;
    this.gasHaloPoints.visible = visible && !useSolid;
  }

  /** Update the screen-space point-sprite scale (canvas DPR × half-height). */
  setPixelScale(scale: number): void {
    (this.gasPoints.material as THREE.ShaderMaterial).uniforms.uPixelScale.value = scale;
    (this.gasHaloPoints.material as THREE.ShaderMaterial).uniforms.uPixelScale.value = scale;
  }

  sync(sim: Simulator, frustum: THREE.Frustum, camera: THREE.PerspectiveCamera, projScaleY: number, lodPixelThresh: number): void {
    const n = sim.count;
    if (this.renderMode === 'solid') {
      const counts = this.speciesCountsScratch;
      const countsLo = this.speciesCountsLoScratch;
      counts.fill(0);
      countsLo.fill(0);
      // pixelSize ≈ radius * projScaleY / dist. Threshold pulled from the
      // live quality settings — smaller = more particles upgraded to hi-LOD
      // (looks crisper; costs more triangles). Squared for cheap comparison:
      // (radius * projScaleY)² < THRESH² * dist².
      const lodCoef = projScaleY / lodPixelThresh;
      const camX = camera.position.x;
      const camY = camera.position.y;
      const camZ = camera.position.z;
      for (let i = 0; i < n; i++) {
        const s = sim.species[i];
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        const radius = SPECIES[s].sigma * 1.1;
        this.tmpSphere.center.set(px, py, pz);
        this.tmpSphere.radius = radius;
        if (!frustum.intersectsSphere(this.tmpSphere)) continue;
        // LOD pick: hi if (radius * lodCoef) > dist, else lo.
        const dx = px - camX, dy = py - camY, dz = pz - camZ;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const cutoff = radius * lodCoef;
        const useHi = cutoff * cutoff > dist2;
        const targetMesh = useHi ? this.speciesMeshes[s] : this.speciesMeshesLo[s];
        const targetCounts = useHi ? counts : countsLo;
        const slot = targetCounts[s]++;
        if (slot >= this.speciesCapacity[s]) continue;
        this.tmpMat.makeScale(radius, radius, radius);
        this.tmpMat.setPosition(px, py, pz);
        targetMesh.setMatrixAt(slot, this.tmpMat);
      }
      for (let s = 0; s < SPECIES.length; s++) {
        this.speciesMeshes[s].count = counts[s];
        if (counts[s] > 0) this.speciesMeshes[s].instanceMatrix.needsUpdate = true;
        this.speciesMeshesLo[s].count = countsLo[s];
        if (countsLo[s] > 0) this.speciesMeshesLo[s].instanceMatrix.needsUpdate = true;
      }
    } else {
      let write = 0;
      const cap = Math.min(n, this.maxParticlesTotal);
      for (let i = 0; i < cap; i++) {
        const s = sim.species[i];
        const sp = SPECIES[s];
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        this.tmpSphere.center.set(px, py, pz);
        this.tmpSphere.radius = sp.sigma * 1.5;
        if (!frustum.intersectsSphere(this.tmpSphere)) continue;
        const isDM = sp.name === 'DM';
        this.gasPositions[write * 3 + 0] = px;
        this.gasPositions[write * 3 + 1] = py;
        this.gasPositions[write * 3 + 2] = pz;
        const r = ((sp.color >> 16) & 0xff) / 255;
        const g = ((sp.color >> 8) & 0xff) / 255;
        const b = (sp.color & 0xff) / 255;
        // DM: barely visible (halo hint), baryonic gas: full intensity
        const dim = isDM ? 0.28 : 0.85;
        this.gasColors[write * 3 + 0] = r * dim;
        this.gasColors[write * 3 + 1] = g * dim;
        this.gasColors[write * 3 + 2] = b * dim;
        // Large, heavily-overlapping point sprites so additive blending forms
        // diffuse nebulae rather than visibly distinct particles.
        this.gasSizes[write] = sp.sigma * (isDM ? 10.0 : 18.0);
        write++;
      }
      this.gasGeom.setDrawRange(0, write);
      // Only upload the slice that was actually written. updateRange tells
      // three.js to skip the rest of the (possibly large) attribute buffer.
      if (write > 0) {
        const pos = this.gasGeom.getAttribute('position') as THREE.BufferAttribute;
        const col = this.gasGeom.getAttribute('color') as THREE.BufferAttribute;
        const sz  = this.gasGeom.getAttribute('size')  as THREE.BufferAttribute;
        pos.clearUpdateRanges(); pos.addUpdateRange(0, write * 3); pos.needsUpdate = true;
        col.clearUpdateRanges(); col.addUpdateRange(0, write * 3); col.needsUpdate = true;
        sz.clearUpdateRanges();  sz.addUpdateRange(0, write);      sz.needsUpdate  = true;
      }
    }
  }
}
