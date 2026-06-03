import * as THREE from 'three';
import { Effector, Simulator } from '../../physics/Simulator';
import { GALAXY_HALO_VERT, GALAXY_HALO_FRAG } from '../shaders';

// Galaxy = a gravitationally-associated cluster of stars (with optional
// central/embedded BHs). Detected via union-find linkage: two stars are
// linked if within `linkRadius` of each other. A connected component of
// >= `minStars` is rendered as a single diffuse halo. This drops the older
// "halo per BH" assumption (real galaxies don't need a BH, and post-merger
// galaxies have multiple BHs inside one halo).
//
// linkRadius is wide enough to capture loose stellar associations (real dwarf
// galaxies span ~kpc with stars sparsely placed); minStars is 3 so small
// clusters still register as a halo.
//
// Clustering is O(n²) on the star list, so it's throttled to ~5Hz — halos are
// diffuse and a 200ms lag in their position/scale is imperceptible. On the
// off-frames we still do a cheap frustum-visibility refresh so halos pop in
// and out as the camera turns.
export class GalaxyRenderer {
  private readonly scene: THREE.Scene;
  private readonly halos = new Map<string, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  private parentScratch: Int32Array | null = null;
  private accum = 0;
  private readonly interval = 0.2;
  private readonly linkRadius = 18;
  private readonly minStars = 3;
  private readonly tmpL = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpSphere = new THREE.Sphere();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setVisible(visible: boolean): void {
    for (const { mesh } of this.halos.values()) mesh.visible = visible;
  }

  sync(sim: Simulator, frustum: THREE.Frustum, galaxiesVisible: boolean, frameDt: number): void {
    this.accum += frameDt;
    if (this.accum >= this.interval) {
      this.accum = 0;
      this.cluster(sim, frustum, galaxiesVisible);
    } else {
      // Cheap per-frame frustum-visibility refresh on the cached halos so
      // they pop in/out as the camera turns, without re-running clustering.
      for (const entry of this.halos.values()) {
        this.tmpSphere.center.copy(entry.mesh.position);
        this.tmpSphere.radius = Math.max(entry.mesh.scale.x, entry.mesh.scale.y, entry.mesh.scale.z);
        entry.mesh.visible = galaxiesVisible && frustum.intersectsSphere(this.tmpSphere);
      }
    }
  }

  private cluster(sim: Simulator, frustum: THREE.Frustum, galaxiesVisible: boolean): void {
    const stars: Effector[] = [];
    const bhs: Effector[] = [];
    for (const e of sim.effectors) {
      if (e.type === 'star') stars.push(e);
      else if (e.type === 'blackhole') bhs.push(e);
    }

    // Find seen halo IDs this frame so we can reap stale ones at the end
    const seenIds = new Set<string>();

    if (stars.length >= this.minStars) {
      const n = stars.length;
      if (!this.parentScratch || this.parentScratch.length < n) {
        // Grow with headroom so we don't realloc on every minor star count bump.
        this.parentScratch = new Int32Array(Math.max(n * 2, 32));
      }
      const parent = this.parentScratch;
      for (let i = 0; i < n; i++) parent[i] = i;
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const linkR2 = this.linkRadius * this.linkRadius;
      for (let i = 0; i < n; i++) {
        const a = stars[i];
        for (let j = i + 1; j < n; j++) {
          const b = stars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          if (dx * dx + dy * dy + dz * dz < linkR2) {
            const ra = find(i), rb = find(j);
            if (ra !== rb) parent[ra] = rb;
          }
        }
      }

      const components = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        const list = components.get(r);
        if (list) list.push(i); else components.set(r, [i]);
      }

      for (const [, memberIdx] of components) {
        if (memberIdx.length < this.minStars) continue;

        // Stable ID = oldest member's birth time (galaxies don't lose identity
        // when newer members join or old peripheral members drift away).
        let oldest = stars[memberIdx[0]];
        for (const i of memberIdx) {
          if (stars[i].bornAt < oldest.bornAt) oldest = stars[i];
        }
        const id = `g-${Math.round(oldest.bornAt * 1000)}-${oldest.name ?? ''}`;
        seenIds.add(id);

        // Mass-weighted COM
        let cx = 0, cy = 0, cz = 0, totM = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          cx += s.x * s.strength;
          cy += s.y * s.strength;
          cz += s.z * s.strength;
          totM += s.strength;
        }
        if (totM <= 0) continue;
        cx /= totM; cy /= totM; cz /= totM;

        // Include nearby BHs in COM (they sit at galactic centers) and let
        // them contribute to the halo extent — a post-merger galaxy with
        // multiple BHs still reads as one halo.
        const localBhs: Effector[] = [];
        let bhM = 0;
        for (const bh of bhs) {
          const dx = bh.x - cx, dy = bh.y - cy, dz = bh.z - cz;
          if (dx * dx + dy * dy + dz * dz < linkR2 * 2.25) {
            localBhs.push(bh);
            bhM += bh.strength;
          }
        }
        if (localBhs.length > 0) {
          // Re-center using BH mass too
          let ncx = cx * totM, ncy = cy * totM, ncz = cz * totM;
          for (const bh of localBhs) {
            ncx += bh.x * bh.strength;
            ncy += bh.y * bh.strength;
            ncz += bh.z * bh.strength;
          }
          const total = totM + bhM;
          cx = ncx / total; cy = ncy / total; cz = ncz / total;
        }

        // Radius = RMS distance of stars from COM, with a min floor.
        // RMS is robust against single eccentric-orbit outliers (vs. max).
        let sumR2 = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          const dx = s.x - cx;
          const dy = s.y - cy;
          const dz = s.z - cz;
          sumR2 += dx * dx + dy * dy + dz * dz;
        }
        const rmsR = Math.sqrt(sumR2 / memberIdx.length);
        const radius = Math.max(3.0, rmsR * 1.6 + 1.5);

        // Bulk velocity (mass-weighted) so we measure rotation in the COM frame
        let bvx = 0, bvy = 0, bvz = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          bvx += s.vx * s.strength;
          bvy += s.vy * s.strength;
          bvz += s.vz * s.strength;
        }
        bvx /= totM; bvy /= totM; bvz /= totM;

        // Angular momentum L = Σ m·(r × v) about COM. Disks have large coherent
        // L; elliptical/random-motion systems have |L| ~ 0.
        let Lx = 0, Ly = 0, Lz = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          const rx = s.x - cx, ry = s.y - cy, rz = s.z - cz;
          const vx = s.vx - bvx, vy = s.vy - bvy, vz = s.vz - bvz;
          Lx += s.strength * (ry * vz - rz * vy);
          Ly += s.strength * (rz * vx - rx * vz);
          Lz += s.strength * (rx * vy - ry * vx);
        }
        const Lmag = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);

        // Rotational support ≈ |L| / (M · R · σ_v). We approximate σ_v with the
        // halo's RMS extent in lieu of a separate velocity-dispersion calc.
        // Large value → disk; small → spheroidal.
        const rotSupport = Lmag / Math.max(totM * radius, 1e-3);
        const flatness = Math.min(0.65, Math.max(0, rotSupport * 0.45));
        const polarR = radius * (1 - flatness);

        let entry = this.halos.get(id);
        if (!entry) {
          const hue = (this.hashId(id) % 360) / 360;
          const color = new THREE.Color().setHSL(hue, 0.55, 0.55);
          entry = this.createHalo(color, galaxiesVisible);
          this.halos.set(id, entry);
        }
        entry.mesh.position.set(cx, cy, cz);

        // Align mesh's Y axis with the L vector so the oblate scaling
        // (radius, polarR, radius) sits perpendicular to the rotation axis.
        if (Lmag > 1e-3) {
          const inv = 1 / Lmag;
          this.tmpL.set(Lx * inv, Ly * inv, Lz * inv);
          entry.mesh.quaternion.setFromUnitVectors(this.tmpUp, this.tmpL);
        } else {
          entry.mesh.quaternion.identity();
        }
        entry.mesh.scale.set(radius, polarR, radius);

        this.tmpSphere.center.set(cx, cy, cz);
        this.tmpSphere.radius = radius;
        entry.mesh.visible = galaxiesVisible && frustum.intersectsSphere(this.tmpSphere);
      }
    }

    for (const [id, entry] of this.halos) {
      if (!seenIds.has(id)) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mat.dispose();
        this.halos.delete(id);
      }
    }
  }

  private createHalo(color: THREE.Color, galaxiesVisible: boolean): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
    const geo = new THREE.SphereGeometry(1, 32, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: color } },
      vertexShader: GALAXY_HALO_VERT,
      fragmentShader: GALAXY_HALO_FRAG,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = galaxiesVisible;
    this.scene.add(mesh);
    return { mesh, mat };
  }

  private hashId(id: string): number {
    let h = 5381;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
    }
    return h & 0xffffff;
  }
}
