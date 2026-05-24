import { SpatialGrid } from './SpatialGrid';
import { K_BOLTZMANN_REDUCED, SPECIES, Species, T_REDUCED_TO_KELVIN } from './types';

export interface SimulatorOptions {
  boxHalf: number;
  maxParticles: number;
  cutoff: number;
}

export interface SimStats {
  count: number;
  kineticEnergy: number;
  potentialEnergy: number;
  temperatureK: number;
  temperatureReduced: number;
  fusionEvents: number;
  simTime: number;
  bondCount: number;
}

export interface FusionEvent {
  position: [number, number, number];
  energy: number;
}

export interface MoleculeEntry {
  label: string;
  count: number;
  color: number;
}

export interface BlackHole {
  x: number;
  y: number;
  z: number;
  mass: number;
  radius: number;
  consumed: number;
}

interface PairParams {
  sigma: number;
  sigma2: number;
  epsilon: number;
  rcut2: number;
}

export class Simulator {
  readonly boxHalf: number;
  readonly cutoff: number;
  readonly maxParticles: number;

  positions: Float32Array;
  velocities: Float32Array;
  forces: Float32Array;
  species: Uint8Array;

  count = 0;

  targetTemperatureK = 300;
  gravity = 0;
  thermostatTau = 0.5;
  fusionEnabled = false;
  fusionThresholdReduced = 30;
  fusionEnergyRelease = 8;
  windX = 0;
  selfGravity = 0;
  selfGravitySoftening = 0.6;
  bondingEnabled = false;
  bondStiffness = 80;
  bondFormFactor = 1.2;
  bondBreakFactor = 3.0;
  blackHoleG = 6;
  readonly blackHoles: BlackHole[] = [];

  onFusion: ((event: FusionEvent) => void) | null = null;

  private grid: SpatialGrid;
  private potentialEnergy = 0;
  private pair: PairParams[];
  private readonly numSpecies: number;
  private fusionEvents = 0;
  private readonly fusionQueue: number[] = [];
  private readonly fusedMark: Uint8Array;
  private simTime = 0;

  private readonly bondI: Int32Array;
  private readonly bondJ: Int32Array;
  private readonly bondRest: Float32Array;
  private bondLen = 0;
  private readonly bondCount: Uint8Array;
  private readonly maxBonds: number;

  constructor(opts: SimulatorOptions) {
    this.boxHalf = opts.boxHalf;
    this.cutoff = opts.cutoff;
    this.maxParticles = opts.maxParticles;

    this.positions = new Float32Array(opts.maxParticles * 3);
    this.velocities = new Float32Array(opts.maxParticles * 3);
    this.forces = new Float32Array(opts.maxParticles * 3);
    this.species = new Uint8Array(opts.maxParticles);

    this.grid = new SpatialGrid(
      { min: [-this.boxHalf, -this.boxHalf, -this.boxHalf], max: [this.boxHalf, this.boxHalf, this.boxHalf] },
      this.cutoff,
      opts.maxParticles,
    );

    this.numSpecies = SPECIES.length;
    this.pair = this.buildPairTable();
    this.fusedMark = new Uint8Array(opts.maxParticles);

    this.maxBonds = opts.maxParticles * 4;
    this.bondI = new Int32Array(this.maxBonds);
    this.bondJ = new Int32Array(this.maxBonds);
    this.bondRest = new Float32Array(this.maxBonds);
    this.bondCount = new Uint8Array(opts.maxParticles);
  }

  private buildPairTable(): PairParams[] {
    const table: PairParams[] = [];
    for (let i = 0; i < this.numSpecies; i++) {
      for (let j = 0; j < this.numSpecies; j++) {
        const a = SPECIES[i];
        const b = SPECIES[j];
        const sigma = 0.5 * (a.sigma + b.sigma);
        const epsilon = Math.sqrt(a.epsilon * b.epsilon);
        const rcut = Math.min(this.cutoff, 2.5 * sigma);
        table.push({ sigma, sigma2: sigma * sigma, epsilon, rcut2: rcut * rcut });
      }
    }
    return table;
  }

  private pairOf(si: number, sj: number): PairParams {
    return this.pair[si * this.numSpecies + sj];
  }

  reset(distribution: Record<string, number>): void {
    this.count = 0;
    this.potentialEnergy = 0;
    this.fusionEvents = 0;
    this.fusedMark.fill(0);
    this.simTime = 0;
    this.bondLen = 0;
    this.bondCount.fill(0);
    this.blackHoles.length = 0;
    const half = this.boxHalf * 0.9;
    const targetT = this.targetTemperatureK / T_REDUCED_TO_KELVIN;

    for (const [name, n] of Object.entries(distribution)) {
      const species = SPECIES.find((s) => s.name === name);
      if (!species) continue;
      for (let k = 0; k < n; k++) {
        if (this.count >= this.maxParticles) return;
        this.addParticle(species, half, targetT);
      }
    }
    this.removeCenterOfMassMotion();
  }

  private addParticle(species: Species, half: number, targetTReduced: number): void {
    const i = this.count++;
    this.species[i] = species.id;
    this.positions[i * 3 + 0] = (Math.random() * 2 - 1) * half;
    this.positions[i * 3 + 1] = (Math.random() * 2 - 1) * half;
    this.positions[i * 3 + 2] = (Math.random() * 2 - 1) * half;

    const sigma = Math.sqrt((K_BOLTZMANN_REDUCED * targetTReduced) / Math.max(species.mass, 1e-6));
    this.velocities[i * 3 + 0] = gaussian() * sigma;
    this.velocities[i * 3 + 1] = gaussian() * sigma;
    this.velocities[i * 3 + 2] = gaussian() * sigma;
  }

  private removeCenterOfMassMotion(): void {
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let totalMass = 0;
    for (let i = 0; i < this.count; i++) {
      const m = SPECIES[this.species[i]].mass;
      vx += this.velocities[i * 3 + 0] * m;
      vy += this.velocities[i * 3 + 1] * m;
      vz += this.velocities[i * 3 + 2] * m;
      totalMass += m;
    }
    if (totalMass === 0) return;
    vx /= totalMass;
    vy /= totalMass;
    vz /= totalMass;
    for (let i = 0; i < this.count; i++) {
      this.velocities[i * 3 + 0] -= vx;
      this.velocities[i * 3 + 1] -= vy;
      this.velocities[i * 3 + 2] -= vz;
    }
  }

  step(dt: number): void {
    const n = this.count;
    if (n === 0) return;

    for (let i = 0; i < n; i++) {
      const m = SPECIES[this.species[i]].mass;
      const inv2m = 0.5 / m;
      this.velocities[i * 3 + 0] += this.forces[i * 3 + 0] * inv2m * dt;
      this.velocities[i * 3 + 1] += this.forces[i * 3 + 1] * inv2m * dt;
      this.velocities[i * 3 + 2] += this.forces[i * 3 + 2] * inv2m * dt;
      this.positions[i * 3 + 0] += this.velocities[i * 3 + 0] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }

    this.computeForces();

    for (let i = 0; i < n; i++) {
      const m = SPECIES[this.species[i]].mass;
      const inv2m = 0.5 / m;
      this.velocities[i * 3 + 0] += this.forces[i * 3 + 0] * inv2m * dt;
      this.velocities[i * 3 + 1] += this.forces[i * 3 + 1] * inv2m * dt;
      this.velocities[i * 3 + 2] += this.forces[i * 3 + 2] * inv2m * dt;
    }

    this.applyBoundary();
    this.applyThermostat(dt);
    this.simTime += dt;
  }

  private computeForces(): void {
    const n = this.count;
    this.forces.fill(0, 0, n * 3);
    this.potentialEnergy = 0;
    this.grid.rebuild(this.positions, n);

    const g = this.gravity;
    const wx = this.windX;
    if (g !== 0 || wx !== 0) {
      for (let i = 0; i < n; i++) {
        const m = SPECIES[this.species[i]].mass;
        if (g !== 0) this.forces[i * 3 + 1] -= g * m;
        if (wx !== 0) this.forces[i * 3 + 0] += wx * m;
      }
    }

    this.fusionQueue.length = 0;
    const fusionCheck = this.fusionEnabled;
    const fusionR2 = 0.6 * 0.6;
    const fusionKE = this.fusionThresholdReduced;
    const bondCheck = this.bondingEnabled;
    const bondFormFactor = this.bondFormFactor;

    for (let i = 0; i < n; i++) {
      const si = this.species[i];
      const xi = this.positions[i * 3 + 0];
      const yi = this.positions[i * 3 + 1];
      const zi = this.positions[i * 3 + 2];

      this.grid.forEachNeighbor(i, this.positions, (j) => {
        const sj = this.species[j];
        const p = this.pairOf(si, sj);
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > p.rcut2 || r2 < 1e-8) return;

        const inv2 = p.sigma2 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const inv12 = inv6 * inv6;
        const fscalar = (48 * p.epsilon * (inv12 - 0.5 * inv6)) / r2;
        const fx = fscalar * dx;
        const fy = fscalar * dy;
        const fz = fscalar * dz;

        this.forces[i * 3 + 0] -= fx;
        this.forces[i * 3 + 1] -= fy;
        this.forces[i * 3 + 2] -= fz;
        this.forces[j * 3 + 0] += fx;
        this.forces[j * 3 + 1] += fy;
        this.forces[j * 3 + 2] += fz;

        this.potentialEnergy += 4 * p.epsilon * (inv12 - inv6);

        if (bondCheck && si === sj && SPECIES[si].maxValence > 0) {
          const formR2 = (p.sigma * bondFormFactor) * (p.sigma * bondFormFactor);
          if (r2 < formR2 && this.bondCount[i] < SPECIES[si].maxValence && this.bondCount[j] < SPECIES[sj].maxValence) {
            this.tryFormBond(i, j, p.sigma);
          }
        }

        if (fusionCheck && si === 0 && sj === 0 && r2 < fusionR2) {
          const dvx = this.velocities[j * 3 + 0] - this.velocities[i * 3 + 0];
          const dvy = this.velocities[j * 3 + 1] - this.velocities[i * 3 + 1];
          const dvz = this.velocities[j * 3 + 2] - this.velocities[i * 3 + 2];
          const mH = SPECIES[0].mass;
          const reducedMass = mH * 0.5;
          const keRel = 0.5 * reducedMass * (dvx * dvx + dvy * dvy + dvz * dvz);
          if (keRel > fusionKE) {
            this.fusionQueue.push(i, j);
          }
        }
      });
    }

    if (this.selfGravity !== 0) this.applySelfGravity();

    if (this.bondLen > 0) this.applyBondForces();

    if (fusionCheck && this.fusionQueue.length > 0) this.processFusion();

    if (this.blackHoles.length > 0) this.applyBlackHoles();
  }

  addBlackHole(x: number, y: number, z: number, mass = 80, radius = 1.2): void {
    this.blackHoles.push({ x, y, z, mass, radius, consumed: 0 });
  }

  clearBlackHoles(): void {
    this.blackHoles.length = 0;
  }

  private applyBlackHoles(): void {
    const G = this.blackHoleG;
    const eps2 = 0.05;
    const consume = new Set<number>();
    for (const bh of this.blackHoles) {
      const r2horizon = bh.radius * bh.radius;
      for (let i = 0; i < this.count; i++) {
        const dx = bh.x - this.positions[i * 3 + 0];
        const dy = bh.y - this.positions[i * 3 + 1];
        const dz = bh.z - this.positions[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < r2horizon) {
          consume.add(i);
          bh.consumed++;
          continue;
        }
        const m = SPECIES[this.species[i]].mass;
        const invR = 1 / Math.sqrt(r2 + eps2);
        const f = G * bh.mass * m * invR * invR * invR;
        this.forces[i * 3 + 0] += f * dx;
        this.forces[i * 3 + 1] += f * dy;
        this.forces[i * 3 + 2] += f * dz;
      }
    }
    if (consume.size === 0) return;
    const sorted = Array.from(consume).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx < this.count) this.removeParticle(idx);
    }
  }

  private tryFormBond(i: number, j: number, sigma: number): void {
    if (this.bondLen >= this.maxBonds) return;
    for (let b = 0; b < this.bondLen; b++) {
      if ((this.bondI[b] === i && this.bondJ[b] === j) || (this.bondI[b] === j && this.bondJ[b] === i)) return;
    }
    const idx = this.bondLen++;
    this.bondI[idx] = i;
    this.bondJ[idx] = j;
    this.bondRest[idx] = sigma;
    this.bondCount[i]++;
    this.bondCount[j]++;
  }

  private applyBondForces(): void {
    const k = this.bondStiffness;
    const breakFactor = this.bondBreakFactor;
    let write = 0;
    for (let b = 0; b < this.bondLen; b++) {
      const i = this.bondI[b];
      const j = this.bondJ[b];
      const r0 = this.bondRest[b];
      const dx = this.positions[j * 3 + 0] - this.positions[i * 3 + 0];
      const dy = this.positions[j * 3 + 1] - this.positions[i * 3 + 1];
      const dz = this.positions[j * 3 + 2] - this.positions[i * 3 + 2];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r > r0 * breakFactor || r < 1e-6) {
        this.bondCount[i]--;
        this.bondCount[j]--;
        continue;
      }
      const inv = 1 / r;
      const ux = dx * inv;
      const uy = dy * inv;
      const uz = dz * inv;
      const fmag = k * (r - r0);
      const fx = fmag * ux;
      const fy = fmag * uy;
      const fz = fmag * uz;
      this.forces[i * 3 + 0] += fx;
      this.forces[i * 3 + 1] += fy;
      this.forces[i * 3 + 2] += fz;
      this.forces[j * 3 + 0] -= fx;
      this.forces[j * 3 + 1] -= fy;
      this.forces[j * 3 + 2] -= fz;
      const dr = r - r0;
      this.potentialEnergy += 0.5 * k * dr * dr;

      if (write !== b) {
        this.bondI[write] = i;
        this.bondJ[write] = j;
        this.bondRest[write] = r0;
      }
      write++;
    }
    this.bondLen = write;
  }

  private removeBondsForParticle(p: number): void {
    let write = 0;
    for (let b = 0; b < this.bondLen; b++) {
      const i = this.bondI[b];
      const j = this.bondJ[b];
      if (i === p || j === p) {
        if (i !== p) this.bondCount[i]--;
        if (j !== p) this.bondCount[j]--;
        continue;
      }
      if (write !== b) {
        this.bondI[write] = i;
        this.bondJ[write] = j;
        this.bondRest[write] = this.bondRest[b];
      }
      write++;
    }
    this.bondLen = write;
    this.bondCount[p] = 0;
  }

  private relabelBondParticle(oldIdx: number, newIdx: number): void {
    for (let b = 0; b < this.bondLen; b++) {
      if (this.bondI[b] === oldIdx) this.bondI[b] = newIdx;
      if (this.bondJ[b] === oldIdx) this.bondJ[b] = newIdx;
    }
  }

  get bondListLength(): number {
    return this.bondLen;
  }

  getBondVertex(b: number, out: 'i' | 'j'): number {
    return out === 'i' ? this.bondI[b] : this.bondJ[b];
  }

  getMoleculeBreakdown(): MoleculeEntry[] {
    const n = this.count;
    if (n === 0) return [];

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let b = 0; b < this.bondLen; b++) {
      const ra = find(this.bondI[b]);
      const rb = find(this.bondJ[b]);
      if (ra !== rb) parent[ra] = rb;
    }

    const componentSize = new Int32Array(n);
    const componentSpeciesMask = new Int32Array(n);
    const componentFirstMember = new Int32Array(n);
    for (let i = 0; i < n; i++) componentFirstMember[i] = -1;
    for (let i = 0; i < n; i++) {
      const r = find(i);
      componentSize[r]++;
      componentSpeciesMask[r] |= 1 << this.species[i];
      if (componentFirstMember[r] === -1) componentFirstMember[r] = i;
    }

    const tally = new Map<string, MoleculeEntry>();
    for (let r = 0; r < n; r++) {
      if (componentSize[r] === 0) continue;
      const size = componentSize[r];
      const mask = componentSpeciesMask[r];
      const repSpecies = this.species[componentFirstMember[r]];
      const repSpeciesObj = SPECIES[repSpecies];
      const label = this.labelComponent(size, mask, repSpecies);
      const existing = tally.get(label);
      if (existing) {
        existing.count++;
      } else {
        tally.set(label, { label, count: 1, color: repSpeciesObj.color });
      }
    }

    const out = Array.from(tally.values());
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  private labelComponent(size: number, speciesMask: number, repSpecies: number): string {
    const repName = SPECIES[repSpecies].name;
    if (size === 1) return repName;

    const single = (speciesMask & (speciesMask - 1)) === 0;

    if (size === 2 && single) return `${repName}₂`;

    if (single) {
      return `${repName} ×${size}`;
    }

    const names: string[] = [];
    for (let s = 0; s < SPECIES.length; s++) {
      if (speciesMask & (1 << s)) names.push(SPECIES[s].name);
    }
    return `${names.join('·')} ×${size}`;
  }

  private applySelfGravity(): void {
    const n = this.count;
    const G = this.selfGravity;
    const eps2 = this.selfGravitySoftening * this.selfGravitySoftening;
    for (let i = 0; i < n - 1; i++) {
      const mi = SPECIES[this.species[i]].mass;
      const xi = this.positions[i * 3 + 0];
      const yi = this.positions[i * 3 + 1];
      const zi = this.positions[i * 3 + 2];
      for (let j = i + 1; j < n; j++) {
        const mj = SPECIES[this.species[j]].mass;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const invR = 1 / Math.sqrt(r2);
        const fmag = (G * mi * mj) * invR * invR * invR;
        const fx = fmag * dx;
        const fy = fmag * dy;
        const fz = fmag * dz;
        this.forces[i * 3 + 0] += fx;
        this.forces[i * 3 + 1] += fy;
        this.forces[i * 3 + 2] += fz;
        this.forces[j * 3 + 0] -= fx;
        this.forces[j * 3 + 1] -= fy;
        this.forces[j * 3 + 2] -= fz;
      }
    }
  }

  private processFusion(): void {
    const heId = SPECIES.findIndex((s) => s.name === 'He');
    if (heId < 0) {
      this.fusionQueue.length = 0;
      return;
    }
    this.fusedMark.fill(0, 0, this.count);
    const toRemove: number[] = [];

    for (let q = 0; q < this.fusionQueue.length; q += 2) {
      const i = this.fusionQueue[q];
      const j = this.fusionQueue[q + 1];
      if (this.fusedMark[i] || this.fusedMark[j]) continue;
      this.fusedMark[i] = 1;
      this.fusedMark[j] = 1;

      const mH = SPECIES[0].mass;
      const mHe = SPECIES[heId].mass;
      const total = mH * 2;
      const px = (this.positions[i * 3 + 0] + this.positions[j * 3 + 0]) * 0.5;
      const py = (this.positions[i * 3 + 1] + this.positions[j * 3 + 1]) * 0.5;
      const pz = (this.positions[i * 3 + 2] + this.positions[j * 3 + 2]) * 0.5;
      const vx = (this.velocities[i * 3 + 0] * mH + this.velocities[j * 3 + 0] * mH) / total;
      const vy = (this.velocities[i * 3 + 1] * mH + this.velocities[j * 3 + 1] * mH) / total;
      const vz = (this.velocities[i * 3 + 2] * mH + this.velocities[j * 3 + 2] * mH) / total;

      const dirLen = Math.hypot(vx, vy, vz) || 1;
      const boost = Math.sqrt((2 * this.fusionEnergyRelease) / Math.max(mHe, 1e-6));
      const bx = (vx / dirLen) * boost;
      const by = (vy / dirLen) * boost;
      const bz = (vz / dirLen) * boost;

      this.removeBondsForParticle(i);

      this.species[i] = heId;
      this.positions[i * 3 + 0] = px;
      this.positions[i * 3 + 1] = py;
      this.positions[i * 3 + 2] = pz;
      this.velocities[i * 3 + 0] = vx + bx;
      this.velocities[i * 3 + 1] = vy + by;
      this.velocities[i * 3 + 2] = vz + bz;
      this.forces[i * 3 + 0] = 0;
      this.forces[i * 3 + 1] = 0;
      this.forces[i * 3 + 2] = 0;

      toRemove.push(j);
      this.fusionEvents++;
      this.onFusion?.({ position: [px, py, pz], energy: this.fusionEnergyRelease });
    }

    toRemove.sort((a, b) => b - a);
    for (const idx of toRemove) this.removeParticle(idx);
    this.fusionQueue.length = 0;
  }

  private removeParticle(idx: number): void {
    this.removeBondsForParticle(idx);
    const last = this.count - 1;
    if (idx !== last) {
      this.species[idx] = this.species[last];
      this.bondCount[idx] = this.bondCount[last];
      for (let k = 0; k < 3; k++) {
        this.positions[idx * 3 + k] = this.positions[last * 3 + k];
        this.velocities[idx * 3 + k] = this.velocities[last * 3 + k];
        this.forces[idx * 3 + k] = this.forces[last * 3 + k];
      }
      this.relabelBondParticle(last, idx);
    }
    this.bondCount[last] = 0;
    this.count = last;
  }

  private applyBoundary(): void {
    const h = this.boxHalf;
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        if (this.positions[idx] > h) {
          this.positions[idx] = h - (this.positions[idx] - h);
          if (this.velocities[idx] > 0) this.velocities[idx] = -this.velocities[idx];
        } else if (this.positions[idx] < -h) {
          this.positions[idx] = -h + (-h - this.positions[idx]);
          if (this.velocities[idx] < 0) this.velocities[idx] = -this.velocities[idx];
        }
      }
    }
  }

  private applyThermostat(dt: number): void {
    if (this.count < 2) return;
    const ke = this.kineticEnergy();
    const dof = 3 * this.count;
    const tCurrent = (2 * ke) / (dof * K_BOLTZMANN_REDUCED);
    if (tCurrent < 1e-8) return;
    const tTarget = this.targetTemperatureK / T_REDUCED_TO_KELVIN;
    const lambda = Math.sqrt(1 + (dt / this.thermostatTau) * (tTarget / tCurrent - 1));
    if (!Number.isFinite(lambda) || lambda <= 0) return;
    for (let i = 0; i < this.count * 3; i++) this.velocities[i] *= lambda;
  }

  kineticEnergy(): number {
    let ke = 0;
    for (let i = 0; i < this.count; i++) {
      const m = SPECIES[this.species[i]].mass;
      const vx = this.velocities[i * 3 + 0];
      const vy = this.velocities[i * 3 + 1];
      const vz = this.velocities[i * 3 + 2];
      ke += 0.5 * m * (vx * vx + vy * vy + vz * vz);
    }
    return ke;
  }

  stats(): SimStats {
    const ke = this.kineticEnergy();
    const dof = Math.max(1, 3 * this.count);
    const tReduced = (2 * ke) / (dof * K_BOLTZMANN_REDUCED);
    return {
      count: this.count,
      kineticEnergy: ke,
      potentialEnergy: this.potentialEnergy,
      temperatureReduced: tReduced,
      temperatureK: tReduced * T_REDUCED_TO_KELVIN,
      fusionEvents: this.fusionEvents,
      simTime: this.simTime,
      bondCount: this.bondLen,
    };
  }
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
