import * as THREE from 'three';
import { Effector, Simulator } from '../../physics/Simulator';

// Renders two things tied to the selected effector:
//   1. Trail — the actual path the body has travelled, kept in a ring buffer
//      and drawn oldest→newest with a vertex-color fade.
//   2. Predicted orbit — the analytic Kepler ellipse around its bound host,
//      plus a dashed connector line from the body to that host.
//
// The Kepler solve and computeLineDistances are expensive for large orbits, so
// the prediction is recomputed at ~12Hz (or immediately when the selection
// changes); the trail records at ~60Hz. Both are owned here — the Scene only
// forwards the current selection, the orbits-visibility flag, and frameDt.
export class OrbitTrailRenderer {
  private readonly trailLines: THREE.Line;
  private readonly trailGeom: THREE.BufferGeometry;
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailCapacity = 512;
  private trailWriteIdx = 0;
  private trailCount = 0;
  private trailLastEffector: Effector | null = null;
  private trailSampleAccum = 0;
  private readonly trailSampleInterval = 1 / 60; // record at ~60Hz max
  private trailLinearScratch: Float32Array | null = null;

  private readonly selectedOrbitLines: THREE.LineSegments;
  private readonly selectedOrbitGeom: THREE.BufferGeometry;
  private readonly selectedOrbitPositions: Float32Array;
  private readonly selectedOrbitLink: THREE.Line;
  private readonly selectedOrbitLinkGeom: THREE.BufferGeometry;
  private readonly selectedOrbitLinkPositions: Float32Array;
  private readonly orbitSegments = 96;
  private orbitAccum = 0;
  private readonly orbitInterval = 1 / 12;

  constructor(scene: THREE.Scene, orbitsVisible: boolean) {
    // Trail: actual path the selected effector has traveled, with vertex-color fade
    this.trailPositions = new Float32Array(this.trailCapacity * 3);
    this.trailColors = new Float32Array(this.trailCapacity * 3);
    this.trailGeom = new THREE.BufferGeometry();
    this.trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeom.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    this.trailGeom.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.trailLines = new THREE.Line(this.trailGeom, trailMat);
    this.trailLines.frustumCulled = false;
    this.trailLines.visible = orbitsVisible;
    scene.add(this.trailLines);

    const verticesPerOrbit = this.orbitSegments * 2;
    this.selectedOrbitPositions = new Float32Array(verticesPerOrbit * 3);
    this.selectedOrbitGeom = new THREE.BufferGeometry();
    this.selectedOrbitGeom.setAttribute('position', new THREE.BufferAttribute(this.selectedOrbitPositions, 3));
    this.selectedOrbitGeom.setDrawRange(0, 0);
    const selMat = new THREE.LineBasicMaterial({
      color: 0x6688aa,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.selectedOrbitLines = new THREE.LineSegments(this.selectedOrbitGeom, selMat);
    this.selectedOrbitLines.frustumCulled = false;
    this.selectedOrbitLines.visible = orbitsVisible;
    scene.add(this.selectedOrbitLines);

    this.selectedOrbitLinkPositions = new Float32Array(2 * 3);
    this.selectedOrbitLinkGeom = new THREE.BufferGeometry();
    this.selectedOrbitLinkGeom.setAttribute('position', new THREE.BufferAttribute(this.selectedOrbitLinkPositions, 3));
    this.selectedOrbitLinkGeom.setDrawRange(0, 0);
    const linkMat = new THREE.LineDashedMaterial({
      color: 0xffd66a,
      transparent: true,
      opacity: 0.65,
      dashSize: 0.6,
      gapSize: 0.4,
      depthWrite: false,
    });
    this.selectedOrbitLink = new THREE.Line(this.selectedOrbitLinkGeom, linkMat);
    this.selectedOrbitLink.frustumCulled = false;
    this.selectedOrbitLink.visible = orbitsVisible;
    scene.add(this.selectedOrbitLink);
  }

  setVisible(visible: boolean): void {
    this.selectedOrbitLines.visible = visible;
    this.selectedOrbitLink.visible = visible;
    this.trailLines.visible = visible;
  }

  sync(sim: Simulator, selected: Effector | null, orbitsVisible: boolean, frameDt: number): void {
    this.orbitAccum += frameDt;
    if (this.orbitAccum >= this.orbitInterval || selected !== this.trailLastEffector) {
      this.orbitAccum = 0;
      this.syncOrbits(sim, selected, orbitsVisible);
    }
    this.recordTrail(selected, orbitsVisible, frameDt);
  }

  private recordTrail(sel: Effector | null, orbitsVisible: boolean, dt: number): void {
    if (!orbitsVisible || !sel) {
      this.trailGeom.setDrawRange(0, 0);
      this.trailLastEffector = null;
      this.trailCount = 0;
      this.trailWriteIdx = 0;
      return;
    }
    if (sel !== this.trailLastEffector) {
      this.trailCount = 0;
      this.trailWriteIdx = 0;
      this.trailLastEffector = sel;
      this.trailSampleAccum = 0;
    }
    this.trailSampleAccum += dt;
    if (this.trailSampleAccum < this.trailSampleInterval && this.trailCount > 0) {
      // still draw existing trail with updated last-segment to current position
      this.drawTrailBuffer(sel);
      return;
    }
    this.trailSampleAccum = 0;
    // Push current position into ring buffer
    const idx = this.trailWriteIdx;
    this.trailPositions[idx * 3 + 0] = sel.x;
    this.trailPositions[idx * 3 + 1] = sel.y;
    this.trailPositions[idx * 3 + 2] = sel.z;
    this.trailWriteIdx = (idx + 1) % this.trailCapacity;
    if (this.trailCount < this.trailCapacity) this.trailCount++;
    this.drawTrailBuffer(sel);
  }

  private drawTrailBuffer(sel: Effector): void {
    const cap = this.trailCapacity;
    const count = this.trailCount;
    // Three.js Line draws in attribute order, so we copy the ring buffer into a
    // contiguous oldest→newest linear buffer each frame.
    const linear = this.trailLinearScratch ??= new Float32Array(this.trailCapacity * 3);
    const colors = this.trailColors;
    const start = (this.trailWriteIdx - count + cap) % cap;
    for (let i = 0; i < count; i++) {
      const r = (start + i) % cap;
      linear[i * 3 + 0] = this.trailPositions[r * 3 + 0];
      linear[i * 3 + 1] = this.trailPositions[r * 3 + 1];
      linear[i * 3 + 2] = this.trailPositions[r * 3 + 2];
      // Fade: oldest dim, newest bright (warm gold)
      const t = count > 1 ? i / (count - 1) : 1;
      const a = t * t; // ease-in for tail
      colors[i * 3 + 0] = 1.0 * a;
      colors[i * 3 + 1] = 0.84 * a;
      colors[i * 3 + 2] = 0.42 * a;
    }
    // Append current position so the trail reaches the live effector
    if (count < cap) {
      linear[count * 3 + 0] = sel.x;
      linear[count * 3 + 1] = sel.y;
      linear[count * 3 + 2] = sel.z;
      colors[count * 3 + 0] = 1.0;
      colors[count * 3 + 1] = 0.85;
      colors[count * 3 + 2] = 0.5;
    }
    const posAttr = this.trailGeom.getAttribute('position') as THREE.BufferAttribute;
    (posAttr.array as Float32Array).set(linear);
    posAttr.needsUpdate = true;
    (this.trailGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.trailGeom.setDrawRange(0, Math.min(cap, count + 1));
  }

  private syncOrbits(sim: Simulator, sel: Effector | null, orbitsVisible: boolean): void {
    const clearAll = () => {
      this.selectedOrbitGeom.setDrawRange(0, 0);
      this.selectedOrbitLinkGeom.setDrawRange(0, 0);
    };

    if (!orbitsVisible) { clearAll(); return; }
    if (!sel || (sel.type !== 'star' && sel.type !== 'blackhole' && sel.type !== 'neutron_star')) {
      clearAll();
      return;
    }

    // Anything massive can act as a Kepler host — light BHs and NS still pull.
    const massive: Effector[] = [];
    for (const e of sim.effectors) {
      if (e === sel) continue;
      if (e.type === 'blackhole' || e.type === 'star' || e.type === 'neutron_star') {
        massive.push(e);
      }
    }

    const G = sim.effectorPairG;

    // The effective central GM should include the diffuse DM halo + gas the
    // body actually feels through Barnes-Hut self-gravity, not just the point
    // mass of a single companion. We add an "environment boost" proportional
    // to selfGravity so deeply-embedded bodies get a sensible orbit even
    // when their pointmass companion is weak.
    //
    // Plus a Hubble-expansion compensation factor: lab-frame separation grew
    // by effectorScaleFactor since Dark Energy began, which made PE = -GM/r
    // shrink. Boost GM by the same factor so previously-bound orbits remain
    // recognized as bound in the Kepler predictor.
    const envBoost = (sim.selfGravity > 0 ? 1.0 + sim.selfGravity * 1.5 : 1.0)
                   * sim.effectorScaleFactor;

    let host: { x: number; y: number; z: number } | null = null;
    let hostGM = 0, hostEnergy = 0;
    let hostRx = 0, hostRy = 0, hostRz = 0;
    let hostVx = 0, hostVy = 0, hostVz = 0;
    let hostRMag = 0;

    // Pass 1: any individual heavier body that produces a bound orbit.
    for (const m of massive) {
      if (m.strength < sel.strength * 0.5) continue; // need at least half our mass
      const rxB = sel.x - m.x;
      const ryB = sel.y - m.y;
      const rzB = sel.z - m.z;
      const rMagB = Math.sqrt(rxB * rxB + ryB * ryB + rzB * rzB);
      if (rMagB < 1e-3) continue;
      const vxB = sel.vx - m.vx;
      const vyB = sel.vy - m.vy;
      const vzB = sel.vz - m.vz;
      const v2B = vxB * vxB + vyB * vyB + vzB * vzB;
      const GMB = G * m.strength * envBoost;
      const eB = 0.5 * v2B - GMB / rMagB;
      if (eB >= 0) continue;
      if (!host || eB < hostEnergy) {
        host = m;
        hostEnergy = eB; hostGM = GMB;
        hostRx = rxB; hostRy = ryB; hostRz = rzB;
        hostVx = vxB; hostVy = vyB; hostVz = vzB;
        hostRMag = rMagB;
      }
    }

    // Pass 2 (fallback): cluster center of mass. Works even with a single
    // companion, and lets dwarf clusters / DM-bound stars show an orbit.
    if (!host && massive.length >= 1) {
      let mx = 0, my = 0, mz = 0, mvx = 0, mvy = 0, mvz = 0, totM = 0;
      for (const m of massive) {
        mx += m.x * m.strength;
        my += m.y * m.strength;
        mz += m.z * m.strength;
        mvx += m.vx * m.strength;
        mvy += m.vy * m.strength;
        mvz += m.vz * m.strength;
        totM += m.strength;
      }
      if (totM > 0) {
        mx /= totM; my /= totM; mz /= totM;
        mvx /= totM; mvy /= totM; mvz /= totM;
        const rxC = sel.x - mx;
        const ryC = sel.y - my;
        const rzC = sel.z - mz;
        const rMagC = Math.sqrt(rxC * rxC + ryC * ryC + rzC * rzC);
        if (rMagC > 1e-3) {
          const vxC = sel.vx - mvx;
          const vyC = sel.vy - mvy;
          const vzC = sel.vz - mvz;
          const v2C = vxC * vxC + vyC * vyC + vzC * vzC;
          // Inflate GM by the env boost too — bodies orbit the cluster +
          // its embedded DM halo, not just visible stars.
          const GMC = G * totM * envBoost * 1.3;
          const eC = 0.5 * v2C - GMC / rMagC;
          if (eC < 0) {
            host = { x: mx, y: my, z: mz };
            hostEnergy = eC; hostGM = GMC;
            hostRx = rxC; hostRy = ryC; hostRz = rzC;
            hostVx = vxC; hostVy = vyC; hostVz = vzC;
            hostRMag = rMagC;
          }
        }
      }
    }

    // No bound system found — body is unbound or in free streaming. The
    // recorded trail (drawn by recordTrail) is the only valid indicator.
    if (!host) { clearAll(); return; }

    const GM = hostGM;
    const rx = hostRx, ry = hostRy, rz = hostRz;
    const vx = hostVx, vy = hostVy, vz = hostVz;
    const rMag = hostRMag;
    const a = -GM / (2 * hostEnergy);

    const Lx = ry * vz - rz * vy;
    const Ly = rz * vx - rx * vz;
    const Lz = rx * vy - ry * vx;
    if (Lx * Lx + Ly * Ly + Lz * Lz < 1e-6) { clearAll(); return; }

    const evx = (vy * Lz - vz * Ly) / GM - rx / rMag;
    const evy = (vz * Lx - vx * Lz) / GM - ry / rMag;
    const evz = (vx * Ly - vy * Lx) / GM - rz / rMag;
    const e = Math.sqrt(evx * evx + evy * evy + evz * evz);
    // Allow highly eccentric orbits — only reject literally unbound.
    if (e >= 0.99) { clearAll(); return; }

    const eHatX = e > 1e-6 ? evx / e : rx / rMag;
    const eHatY = e > 1e-6 ? evy / e : ry / rMag;
    const eHatZ = e > 1e-6 ? evz / e : rz / rMag;
    const pPx = Ly * eHatZ - Lz * eHatY;
    const pPy = Lz * eHatX - Lx * eHatZ;
    const pPz = Lx * eHatY - Ly * eHatX;
    const pMag = Math.sqrt(pPx * pPx + pPy * pPy + pPz * pPz);
    if (pMag < 1e-6) { clearAll(); return; }
    const perpX = pPx / pMag;
    const perpY = pPy / pMag;
    const perpZ = pPz / pMag;

    const segments = this.orbitSegments;
    const semiLatus = a * (1 - e * e);
    const selPositions = this.selectedOrbitPositions;
    let write = 0;
    let prevX = 0, prevY = 0, prevZ = 0;
    for (let i = 0; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;
      const r = semiLatus / (1 + e * Math.cos(theta));
      const cT = Math.cos(theta);
      const sT = Math.sin(theta);
      const x = host.x + r * (cT * eHatX + sT * perpX);
      const y = host.y + r * (cT * eHatY + sT * perpY);
      const z = host.z + r * (cT * eHatZ + sT * perpZ);
      if (i > 0 && write + 1 < segments * 2) {
        selPositions[write * 3 + 0] = prevX;
        selPositions[write * 3 + 1] = prevY;
        selPositions[write * 3 + 2] = prevZ;
        write++;
        selPositions[write * 3 + 0] = x;
        selPositions[write * 3 + 1] = y;
        selPositions[write * 3 + 2] = z;
        write++;
      }
      prevX = x; prevY = y; prevZ = z;
    }
    this.selectedOrbitGeom.setDrawRange(0, write);
    (this.selectedOrbitGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    const p = this.selectedOrbitLinkPositions;
    p[0] = sel.x; p[1] = sel.y; p[2] = sel.z;
    p[3] = host.x; p[4] = host.y; p[5] = host.z;
    this.selectedOrbitLinkGeom.setDrawRange(0, 2);
    (this.selectedOrbitLinkGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.selectedOrbitLink.computeLineDistances();
  }
}
