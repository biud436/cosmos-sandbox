import { BarnesHut } from './BarnesHut';
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
  starsFormed: number;
  scaleFactor: number;
  darkMass: number;
  baryonMass: number;
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

export interface CosmicEvent {
  time: number;
  name: string;
  description: string;
  action: (sim: Simulator) => void;
}

export type EffectorType = 'blackhole' | 'star' | 'repulsor' | 'freezer';

export interface Effector {
  type: EffectorType;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  strength: number;
  consumed: number;
  name?: string;
  bornAt: number;
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
  thermostatCoolOnly = false;
  initialPattern: 'uniform' | 'clumpy' = 'uniform';
  initialClumpCount = 6;
  initialClumpSpread = 0.18;
  initialBoundingRadius = 0.9;
  initialVelocityScale = 1.0;
  fusionEnabled = false;
  fusionThresholdReduced = 30;
  fusionEnergyRelease = 8;
  windX = 0;
  selfGravity = 0;
  selfGravitySoftening = 0.6;
  bhTheta = 0.6;
  hubbleRate = 0;
  hubbleDecay = 0;
  scaleFactor = 1.0;
  openBoundary = false;
  starFormationEnabled = false;
  starFormationRadius = 1.4;
  starFormationCount = 8;
  starFormationCooldown = 0.2;
  private starFormationTimer = 0;
  private starsFormed = 0;
  bondingEnabled = false;
  bondStiffness = 80;
  bondFormFactor = 1.2;
  bondBreakFactor = 3.0;
  blackHoleG = 1.6;
  starG = 2;
  starHeatRate = 0.4;
  repulsorG = 4;
  freezerDamp = 0.92;
  effectorPairG = 0.6;
  readonly effectors: Effector[] = [];
  onEffectorRemoved: ((eff: Effector, reason: 'merged' | 'consumed' | 'manual') => void) | null = null;

  onFusion: ((event: FusionEvent) => void) | null = null;
  onStarFormation: ((position: [number, number, number], atoms: number) => void) | null = null;
  onCosmicEvent: ((event: CosmicEvent) => void) | null = null;
  onSupernova: ((position: [number, number, number], mass: number) => void) | null = null;
  onStellarMerger: ((position: [number, number, number], totalMass: number) => void) | null = null;
  supernovaMassThreshold = 220;

  cosmicEvents: CosmicEvent[] = [];
  firedEvents: { event: CosmicEvent; firedAt: number }[] = [];
  private firedEventCount = 0;
  private starCounter = 0;
  private bhCounter = 0;

  private grid: SpatialGrid;
  private bh: BarnesHut;
  private massCache: Float64Array;
  private bhAccel: [number, number, number] = [0, 0, 0];
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
    this.bh = new BarnesHut(opts.maxParticles, this.bhTheta, this.selfGravitySoftening);
    this.massCache = new Float64Array(opts.maxParticles);

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
    this.effectors.length = 0;
    this.starsFormed = 0;
    this.starFormationTimer = 0;
    this.scaleFactor = 1.0;
    this.firedEventCount = 0;
    this.firedEvents = [];
    this.starCounter = 0;
    this.bhCounter = 0;
    const half = this.boxHalf * this.initialBoundingRadius;
    const targetT = this.targetTemperatureK / T_REDUCED_TO_KELVIN;

    let clumps: [number, number, number][] = [];
    if (this.initialPattern === 'clumpy') {
      const n = Math.max(2, this.initialClumpCount);
      const inner = half * 0.7;
      for (let k = 0; k < n; k++) {
        clumps.push([
          (Math.random() * 2 - 1) * inner,
          (Math.random() * 2 - 1) * inner,
          (Math.random() * 2 - 1) * inner,
        ]);
      }
    }

    for (const [name, n] of Object.entries(distribution)) {
      const species = SPECIES.find((s) => s.name === name);
      if (!species) continue;
      for (let k = 0; k < n; k++) {
        if (this.count >= this.maxParticles) return;
        this.addParticle(species, half, targetT, clumps);
      }
    }
    this.removeCenterOfMassMotion();
  }

  private addParticle(species: Species, half: number, targetTReduced: number, clumps: [number, number, number][]): void {
    const i = this.count++;
    this.species[i] = species.id;
    if (clumps.length > 0) {
      const c = clumps[(Math.random() * clumps.length) | 0];
      const spread = half * this.initialClumpSpread;
      let x = c[0] + gaussian() * spread;
      let y = c[1] + gaussian() * spread;
      let z = c[2] + gaussian() * spread;
      x = Math.max(-half, Math.min(half, x));
      y = Math.max(-half, Math.min(half, y));
      z = Math.max(-half, Math.min(half, z));
      this.positions[i * 3 + 0] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    } else {
      this.positions[i * 3 + 0] = (Math.random() * 2 - 1) * half;
      this.positions[i * 3 + 1] = (Math.random() * 2 - 1) * half;
      this.positions[i * 3 + 2] = (Math.random() * 2 - 1) * half;
    }

    const sigma = Math.sqrt((K_BOLTZMANN_REDUCED * targetTReduced) / Math.max(species.mass, 1e-6)) * this.initialVelocityScale;
    this.velocities[i * 3 + 0] = gaussian() * sigma;
    this.velocities[i * 3 + 1] = gaussian() * sigma;
    this.velocities[i * 3 + 2] = gaussian() * sigma;
  }

  coolAllParticles(factor: number): void {
    for (let i = 0; i < this.count * 3; i++) this.velocities[i] *= factor;
  }

  seedGalaxies(opts: {
    galaxyCount: number;
    starsPerGalaxy: number;
    radius: number;
    starClusterSize: number;
    orbitalSpeed: number;
  }): { galaxies: number; stars: number } {
    let galaxiesFormed = 0;
    let totalStars = 0;
    const usedCenters: [number, number, number][] = [];
    const minSeparation2 = (opts.radius * 1.3) * (opts.radius * 1.3);
    const R2 = opts.radius * opts.radius;
    const groupSize = Math.max(2, opts.starClusterSize);
    const maxAttempts = opts.galaxyCount * 4;
    let attempts = 0;
    while (galaxiesFormed < opts.galaxyCount && attempts < maxAttempts) {
      attempts++;
      const seed = this.findDensestHSeed(opts.radius, usedCenters, minSeparation2);
      if (seed === -1) break;
      const cx = this.positions[seed * 3 + 0];
      const cy = this.positions[seed * 3 + 1];
      const cz = this.positions[seed * 3 + 2];

      const pool: number[] = [];
      for (let j = 0; j < this.count; j++) {
        if (this.species[j] !== 0) continue;
        const dx = this.positions[j * 3 + 0] - cx;
        const dy = this.positions[j * 3 + 1] - cy;
        const dz = this.positions[j * 3 + 2] - cz;
        if (dx * dx + dy * dy + dz * dz < R2) pool.push(j);
      }
      if (pool.length < groupSize) {
        usedCenters.push([cx, cy, cz]);
        continue;
      }

      pool.sort((a, b) => {
        const ax = this.positions[a * 3 + 0] - cx;
        const ay = this.positions[a * 3 + 1] - cy;
        const az = this.positions[a * 3 + 2] - cz;
        const bx = this.positions[b * 3 + 0] - cx;
        const by = this.positions[b * 3 + 1] - cy;
        const bz = this.positions[b * 3 + 2] - cz;
        return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz);
      });

      const maxStars = Math.min(opts.starsPerGalaxy, Math.floor(pool.length / groupSize));
      if (maxStars < 1) {
        usedCenters.push([cx, cy, cz]);
        continue;
      }

      const newStars: Effector[] = [];
      const toRemove: number[] = [];
      for (let k = 0; k < maxStars; k++) {
        const slice = pool.slice(k * groupSize, (k + 1) * groupSize);
        const star = this.spawnStarFromCluster(slice);
        if (star) {
          newStars.push(star);
          for (const idx of slice) toRemove.push(idx);
        }
      }

      if (newStars.length >= 2) {
        let ax = Math.random() * 2 - 1;
        let ay = Math.random() * 2 - 1;
        let az = Math.random() * 2 - 1;
        const len = Math.hypot(ax, ay, az) || 1;
        ax /= len; ay /= len; az /= len;
        this.spinAroundAxis(newStars, [ax, ay, az], [cx, cy, cz], opts.orbitalSpeed);
      }

      toRemove.sort((a, b) => b - a);
      for (const idx of toRemove) if (idx < this.count) this.removeParticle(idx);

      galaxiesFormed++;
      totalStars += newStars.length;
      usedCenters.push([cx, cy, cz]);
    }
    return { galaxies: galaxiesFormed, stars: totalStars };
  }

  private findDensestHSeed(radius: number, excludeCenters: [number, number, number][], minSep2: number): number {
    const R2 = radius * radius;
    let bestIdx = -1;
    let bestCount = -1;
    for (let i = 0; i < this.count; i++) {
      if (this.species[i] !== 0) continue;
      const xi = this.positions[i * 3 + 0];
      const yi = this.positions[i * 3 + 1];
      const zi = this.positions[i * 3 + 2];
      let tooClose = false;
      for (const c of excludeCenters) {
        const dx = xi - c[0];
        const dy = yi - c[1];
        const dz = zi - c[2];
        if (dx * dx + dy * dy + dz * dz < minSep2) { tooClose = true; break; }
      }
      if (tooClose) continue;
      let cnt = 0;
      for (let j = 0; j < this.count; j++) {
        if (j === i || this.species[j] !== 0) continue;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        if (dx * dx + dy * dy + dz * dz < R2) cnt++;
      }
      if (cnt > bestCount) {
        bestCount = cnt;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private spinAroundAxis(stars: Effector[], axis: [number, number, number], center: [number, number, number], orbitalSpeed: number): void {
    const ax = axis[0], ay = axis[1], az = axis[2];
    const cx = center[0], cy = center[1], cz = center[2];
    for (const s of stars) {
      const rx = s.x - cx;
      const ry = s.y - cy;
      const rz = s.z - cz;
      const tx = ay * rz - az * ry;
      const ty = az * rx - ax * rz;
      const tz = ax * ry - ay * rx;
      const len = Math.hypot(tx, ty, tz);
      if (len < 1e-3) continue;
      const k = orbitalSpeed / len;
      s.vx += tx * k;
      s.vy += ty * k;
      s.vz += tz * k;
    }
  }

  spinUpRecentStars(orbitalSpeed: number, withinSimTime: number): number {
    const cutoff = this.simTime - withinSimTime;
    const recent: Effector[] = [];
    for (const e of this.effectors) if (e.type === 'star' && e.bornAt >= cutoff) recent.push(e);
    if (recent.length < 2) return 0;
    let cx = 0, cy = 0, cz = 0, totM = 0;
    for (const s of recent) {
      cx += s.x * s.strength;
      cy += s.y * s.strength;
      cz += s.z * s.strength;
      totM += s.strength;
    }
    if (totM <= 0) return 0;
    cx /= totM; cy /= totM; cz /= totM;
    const axisX = 0;
    const axisY = 1;
    const axisZ = 0;
    for (const s of recent) {
      const rx = s.x - cx;
      const ry = s.y - cy;
      const rz = s.z - cz;
      const tx = axisY * rz - axisZ * ry;
      const ty = axisZ * rx - axisX * rz;
      const tz = axisX * ry - axisY * rx;
      const len = Math.hypot(tx, ty, tz);
      if (len < 1e-3) continue;
      const k = orbitalSpeed / len;
      s.vx += tx * k;
      s.vy += ty * k;
      s.vz += tz * k;
    }
    return recent.length;
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

    if (!this.openBoundary) this.applyBoundary();
    else this.applyPeriodicBoundary();
    this.applyThermostat(dt);
    this.integrateEffectors(dt);

    if (this.hubbleRate > 0) this.applyHubble(dt);
    if (this.openBoundary) this.applyPeriodicBoundary();

    if (this.starFormationEnabled) {
      this.starFormationTimer += dt;
      if (this.starFormationTimer >= this.starFormationCooldown) {
        this.starFormationTimer = 0;
        this.checkStarFormation();
      }
    }

    this.simTime += dt;

    while (this.firedEventCount < this.cosmicEvents.length) {
      const ev = this.cosmicEvents[this.firedEventCount];
      if (ev.time > this.simTime) break;
      ev.action(this);
      this.firedEvents.push({ event: ev, firedAt: this.simTime });
      this.onCosmicEvent?.(ev);
      this.firedEventCount++;
    }
  }

  private applyHubble(dt: number): void {
    const H = this.currentHubble();
    if (H <= 0) return;
    const factor = 1 + H * dt;
    this.scaleFactor *= factor;
    const drag = 1 / factor;
    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3 + 0] *= factor;
      this.positions[i * 3 + 1] *= factor;
      this.positions[i * 3 + 2] *= factor;
      this.velocities[i * 3 + 0] *= drag;
      this.velocities[i * 3 + 1] *= drag;
      this.velocities[i * 3 + 2] *= drag;
    }
    for (const e of this.effectors) {
      e.x *= factor;
      e.y *= factor;
      e.z *= factor;
    }
  }

  currentHubble(): number {
    if (this.hubbleRate <= 0) return 0;
    if (this.hubbleDecay <= 0) return this.hubbleRate;
    return this.hubbleRate / (1 + this.hubbleDecay * this.simTime);
  }

  private checkStarFormation(): void {
    const R = this.starFormationRadius;
    const R2 = R * R;
    const threshold = this.starFormationCount;
    const targetSize = Math.max(threshold, Math.min(threshold + 2, 8));
    const claimed = new Uint8Array(this.count);
    const removed: number[] = [];

    const candidateSeeds: { idx: number; sp: number; score: number }[] = [];
    for (let i = 0; i < this.count; i++) {
      const si = this.species[i];
      if (si !== 0 && si !== 4) continue;
      const xi = this.positions[i * 3 + 0];
      const yi = this.positions[i * 3 + 1];
      const zi = this.positions[i * 3 + 2];
      let cnt = 0;
      for (let j = 0; j < this.count; j++) {
        if (j === i || this.species[j] !== si) continue;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        if (dx * dx + dy * dy + dz * dz < R2) cnt++;
      }
      if (cnt + 1 >= threshold) candidateSeeds.push({ idx: i, sp: si, score: cnt });
    }
    candidateSeeds.sort((a, b) => b.score - a.score);

    for (const seed of candidateSeeds) {
      if (claimed[seed.idx]) continue;
      const xi = this.positions[seed.idx * 3 + 0];
      const yi = this.positions[seed.idx * 3 + 1];
      const zi = this.positions[seed.idx * 3 + 2];
      const nearby: { idx: number; d2: number }[] = [];
      for (let j = 0; j < this.count; j++) {
        if (j === seed.idx || claimed[j]) continue;
        if (this.species[j] !== seed.sp) continue;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R2) nearby.push({ idx: j, d2 });
      }
      if (nearby.length + 1 < threshold) continue;
      nearby.sort((a, b) => a.d2 - b.d2);
      const take = Math.min(nearby.length, targetSize - 1);
      const cluster = [seed.idx];
      for (let k = 0; k < take; k++) cluster.push(nearby[k].idx);
      for (const idx of cluster) claimed[idx] = 1;
      this.spawnStarFromCluster(cluster);
      for (const idx of cluster) removed.push(idx);
    }

    if (removed.length === 0) return;
    removed.sort((a, b) => b - a);
    for (const idx of removed) if (idx < this.count) this.removeParticle(idx);
  }

  bbnConvert(fraction: number): { pairs: number; helium: number } {
    const heId = SPECIES.findIndex((s) => s.name === 'He');
    if (heId < 0) return { pairs: 0, helium: 0 };
    const hList: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.species[i] === 0) hList.push(i);
    for (let i = hList.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = hList[i]; hList[i] = hList[j]; hList[j] = tmp;
    }
    const toConvert = Math.floor(hList.length * fraction);
    const pairCount = toConvert - (toConvert % 2);
    const removed: number[] = [];
    for (let k = 0; k < pairCount; k += 2) {
      const a = hList[k];
      const b = hList[k + 1];
      const mx = (this.positions[a * 3 + 0] + this.positions[b * 3 + 0]) * 0.5;
      const my = (this.positions[a * 3 + 1] + this.positions[b * 3 + 1]) * 0.5;
      const mz = (this.positions[a * 3 + 2] + this.positions[b * 3 + 2]) * 0.5;
      const vx = (this.velocities[a * 3 + 0] + this.velocities[b * 3 + 0]) * 0.5;
      const vy = (this.velocities[a * 3 + 1] + this.velocities[b * 3 + 1]) * 0.5;
      const vz = (this.velocities[a * 3 + 2] + this.velocities[b * 3 + 2]) * 0.5;
      this.removeBondsForParticle(a);
      this.species[a] = heId;
      this.positions[a * 3 + 0] = mx;
      this.positions[a * 3 + 1] = my;
      this.positions[a * 3 + 2] = mz;
      this.velocities[a * 3 + 0] = vx;
      this.velocities[a * 3 + 1] = vy;
      this.velocities[a * 3 + 2] = vz;
      removed.push(b);
    }
    removed.sort((x, y) => y - x);
    for (const idx of removed) if (idx < this.count) this.removeParticle(idx);
    return { pairs: pairCount / 2, helium: pairCount / 2 };
  }

  forceFormStars(maxStars: number, radius: number, minClusterSize: number): number {
    let formed = this.scanAndFormStars(maxStars, radius, minClusterSize);
    if (formed > 0) return formed;
    formed = this.scanAndFormStars(maxStars, radius * 1.6, Math.max(3, Math.floor(minClusterSize / 2)));
    if (formed > 0) return formed;
    return this.fallbackFormStars(maxStars);
  }

  private scanAndFormStars(maxStars: number, radius: number, minClusterSize: number): number {
    const r2 = radius * radius;
    const targetSize = Math.max(minClusterSize, Math.min(minClusterSize + 2, 8));
    const hIndices: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.species[i] === 0) hIndices.push(i);
    if (hIndices.length < minClusterSize) return 0;

    const score = new Int32Array(this.count);
    for (const i of hIndices) {
      const xi = this.positions[i * 3 + 0];
      const yi = this.positions[i * 3 + 1];
      const zi = this.positions[i * 3 + 2];
      let s = 0;
      for (const j of hIndices) {
        if (j === i) continue;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        if (dx * dx + dy * dy + dz * dz < r2) s++;
      }
      score[i] = s;
    }
    hIndices.sort((a, b) => score[b] - score[a]);

    const claimed = new Uint8Array(this.count);
    const removed: number[] = [];
    let formed = 0;
    for (const seed of hIndices) {
      if (formed >= maxStars) break;
      if (claimed[seed]) continue;
      const xi = this.positions[seed * 3 + 0];
      const yi = this.positions[seed * 3 + 1];
      const zi = this.positions[seed * 3 + 2];
      const nearby: { idx: number; d2: number }[] = [];
      for (const j of hIndices) {
        if (j === seed || claimed[j]) continue;
        const dx = this.positions[j * 3 + 0] - xi;
        const dy = this.positions[j * 3 + 1] - yi;
        const dz = this.positions[j * 3 + 2] - zi;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r2) nearby.push({ idx: j, d2 });
      }
      if (nearby.length + 1 < minClusterSize) continue;
      nearby.sort((a, b) => a.d2 - b.d2);
      const take = Math.min(nearby.length, targetSize - 1);
      const members = [seed];
      for (let k = 0; k < take; k++) members.push(nearby[k].idx);
      for (const idx of members) claimed[idx] = 1;
      this.spawnStarFromCluster(members);
      for (const idx of members) removed.push(idx);
      formed++;
    }
    removed.sort((a, b) => b - a);
    for (const idx of removed) if (idx < this.count) this.removeParticle(idx);
    return formed;
  }

  private fallbackFormStars(maxStars: number): number {
    const hIndices: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.species[i] === 0) hIndices.push(i);
    if (hIndices.length < 2) return 0;
    for (let i = hIndices.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = hIndices[i]; hIndices[i] = hIndices[j]; hIndices[j] = tmp;
    }
    const wanted = Math.min(maxStars, Math.floor(hIndices.length / 4));
    if (wanted < 1) return 0;
    const groupSize = Math.max(3, Math.floor(hIndices.length / wanted));
    const candidates: { members: number[] }[] = [];
    for (let k = 0; k < wanted; k++) {
      const members = hIndices.slice(k * groupSize, (k + 1) * groupSize);
      if (members.length >= 2) candidates.push({ members });
    }
    return this.consumeClustersIntoStars(candidates, maxStars);
  }

  private consumeClustersIntoStars(candidates: { members: number[] }[], maxStars: number): number {
    candidates.sort((a, b) => b.members.length - a.members.length);
    const claimed = new Uint8Array(this.count);
    const removed: number[] = [];
    let formed = 0;
    for (const cand of candidates) {
      if (formed >= maxStars) break;
      let overlap = false;
      for (const idx of cand.members) if (claimed[idx]) { overlap = true; break; }
      if (overlap) continue;
      for (const idx of cand.members) claimed[idx] = 1;
      this.spawnStarFromCluster(cand.members);
      for (const idx of cand.members) removed.push(idx);
      formed++;
    }
    removed.sort((a, b) => b - a);
    for (const idx of removed) if (idx < this.count) this.removeParticle(idx);
    return formed;
  }

  private spawnStarFromCluster(indices: number[]): Effector | null {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let total = 0;
    for (const i of indices) {
      const m = SPECIES[this.species[i]].mass;
      cx += this.positions[i * 3 + 0] * m;
      cy += this.positions[i * 3 + 1] * m;
      cz += this.positions[i * 3 + 2] * m;
      vx += this.velocities[i * 3 + 0] * m;
      vy += this.velocities[i * 3 + 1] * m;
      vz += this.velocities[i * 3 + 2] * m;
      total += m;
    }
    if (total <= 0) return null;
    cx /= total;
    cy /= total;
    cz /= total;
    vx /= total;
    vy /= total;
    vz /= total;

    const eff = this.addEffector('star', cx, cy, cz);
    eff.vx = vx;
    eff.vy = vy;
    eff.vz = vz;
    eff.strength = Math.min(180, total * 25);
    eff.radius = Math.min(3.0, Math.max(0.8, Math.cbrt(total) * 0.7));
    this.starsFormed++;
    this.onStarFormation?.([cx, cy, cz], indices.length);
    return eff;
  }

  private integrateEffectors(dt: number): void {
    const list = this.effectors;
    if (list.length === 0) return;
    const G = this.effectorPairG;
    const eps2 = 0.25;

    const ax = new Float64Array(list.length);
    const ay = new Float64Array(list.length);
    const az = new Float64Array(list.length);

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!this.isMassive(a)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!this.isMassive(b)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const invR = 1 / Math.sqrt(r2);
        const base = G * invR * invR * invR;
        const fa = base * b.strength;
        const fb = base * a.strength;
        ax[i] += fa * dx;
        ay[i] += fa * dy;
        az[i] += fa * dz;
        ax[j] -= fb * dx;
        ay[j] -= fb * dy;
        az[j] -= fb * dz;
      }
    }

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!this.isMassive(e)) continue;
      e.vx += ax[i] * dt;
      e.vy += ay[i] * dt;
      e.vz += az[i] * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.z += e.vz * dt;
    }

    this.handleEffectorCollisions();
  }

  private handleEffectorCollisions(): void {
    const removed = new Set<Effector>();
    const list = this.effectors;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (removed.has(a) || !this.isMassive(a)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (removed.has(b) || !this.isMassive(b)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (a.type === 'blackhole' && b.type === 'blackhole') {
          if (r < a.radius + b.radius) {
            this.mergeBlackHoles(a, b);
            removed.add(b);
          }
        } else if (a.type === 'blackhole' && b.type === 'star') {
          if (r < a.radius) {
            this.consumeStar(a, b);
            removed.add(b);
          }
        } else if (a.type === 'star' && b.type === 'blackhole') {
          if (r < b.radius) {
            this.consumeStar(b, a);
            removed.add(a);
            break;
          }
        } else if (a.type === 'star' && b.type === 'star') {
          if (r < (a.radius + b.radius) * 0.9) {
            const collapsed = this.mergeStars(a, b);
            removed.add(b);
            if (collapsed) removed.add(a);
          }
        }
      }
    }
    if (removed.size === 0) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (removed.has(list[i])) {
        const e = list[i];
        list.splice(i, 1);
        this.onEffectorRemoved?.(e, e.type === 'star' ? 'consumed' : 'merged');
      }
    }
  }


  private mergeBlackHoles(a: Effector, b: Effector): void {
    const ma = a.strength;
    const mb = b.strength;
    const total = ma + mb;
    a.x = (a.x * ma + b.x * mb) / total;
    a.y = (a.y * ma + b.y * mb) / total;
    a.z = (a.z * ma + b.z * mb) / total;
    a.vx = (a.vx * ma + b.vx * mb) / total;
    a.vy = (a.vy * ma + b.vy * mb) / total;
    a.vz = (a.vz * ma + b.vz * mb) / total;
    a.strength = total;
    a.radius = Math.min(2.0, Math.cbrt(a.radius ** 3 + b.radius ** 3));
    a.consumed += b.consumed;
  }

  private mergeStars(a: Effector, b: Effector): boolean {
    const ma = a.strength;
    const mb = b.strength;
    const total = ma + mb;
    const mx = (a.x * ma + b.x * mb) / total;
    const my = (a.y * ma + b.y * mb) / total;
    const mz = (a.z * ma + b.z * mb) / total;
    const vx = (a.vx * ma + b.vx * mb) / total;
    const vy = (a.vy * ma + b.vy * mb) / total;
    const vz = (a.vz * ma + b.vz * mb) / total;

    if (total > this.supernovaMassThreshold) {
      const bh = this.addEffector('blackhole', mx, my, mz);
      bh.vx = vx;
      bh.vy = vy;
      bh.vz = vz;
      bh.strength = total * 0.55;
      bh.radius = Math.max(0.6, Math.cbrt(bh.strength) * 0.18);
      this.onSupernova?.([mx, my, mz], total);
      return true;
    }

    a.x = mx;
    a.y = my;
    a.z = mz;
    a.vx = vx;
    a.vy = vy;
    a.vz = vz;
    a.strength = total;
    a.radius = Math.cbrt(a.radius ** 3 + b.radius ** 3);
    this.onStellarMerger?.([mx, my, mz], total);
    return false;
  }

  private consumeStar(bh: Effector, star: Effector): void {
    const ma = bh.strength;
    const dm = star.strength * 0.6;
    const total = ma + dm;
    bh.x = (bh.x * ma + star.x * dm) / total;
    bh.y = (bh.y * ma + star.y * dm) / total;
    bh.z = (bh.z * ma + star.z * dm) / total;
    bh.vx = (bh.vx * ma + star.vx * dm) / total;
    bh.vy = (bh.vy * ma + star.vy * dm) / total;
    bh.vz = (bh.vz * ma + star.vz * dm) / total;
    bh.strength = total;
    bh.radius = Math.min(1.0, Math.cbrt(bh.radius ** 3 + star.radius ** 3 * 0.1));
    bh.consumed += 1;
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
        if (p.epsilon === 0) return;
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

    if (this.effectors.length > 0) this.applyEffectors();
  }

  addEffector(type: EffectorType, x: number, y: number, z: number): Effector {
    const presets: Record<EffectorType, { radius: number; strength: number }> = {
      blackhole: { radius: 0.35, strength: 25 },
      star:      { radius: 1.6, strength: 30 },
      repulsor:  { radius: 1.5, strength: 60 },
      freezer:   { radius: 3.0, strength: 0.92 },
    };
    const p = presets[type];
    const e: Effector = {
      type, x, y, z,
      vx: 0, vy: 0, vz: 0,
      radius: p.radius, strength: p.strength, consumed: 0,
      bornAt: this.simTime,
    };
    if (type === 'star') e.name = `★ S-${String(++this.starCounter).padStart(3, '0')}`;
    else if (type === 'blackhole') e.name = `● BH-${String(++this.bhCounter).padStart(3, '0')}`;
    this.effectors.push(e);
    return e;
  }

  clearEffectors(): void {
    for (const e of this.effectors) this.onEffectorRemoved?.(e, 'manual');
    this.effectors.length = 0;
  }

  removeEffector(target: Effector): void {
    const idx = this.effectors.indexOf(target);
    if (idx >= 0) {
      this.effectors.splice(idx, 1);
      this.onEffectorRemoved?.(target, 'manual');
    }
  }

  private isMassive(e: Effector): boolean {
    return e.type === 'blackhole' || e.type === 'star';
  }

  private applyEffectors(): void {
    const consume = new Set<number>();
    for (const e of this.effectors) {
      switch (e.type) {
        case 'blackhole': this.applyBlackHole(e, consume); break;
        case 'star':      this.applyStar(e); break;
        case 'repulsor':  this.applyRepulsor(e); break;
        case 'freezer':   this.applyFreezer(e); break;
      }
    }
    if (consume.size > 0) {
      const sorted = Array.from(consume).sort((a, b) => b - a);
      for (const idx of sorted) if (idx < this.count) this.removeParticle(idx);
    }
  }

  private applyBlackHole(e: Effector, consume: Set<number>): void {
    const G = this.blackHoleG;
    const eps2 = 0.05;
    const r2horizon = e.radius * e.radius;
    const influence = e.radius * 5;
    const r2influence = influence * influence;
    const fadeStart = influence * 0.85;
    const r2fade = fadeStart * fadeStart;
    for (let i = 0; i < this.count; i++) {
      const dx = e.x - this.positions[i * 3 + 0];
      const dy = e.y - this.positions[i * 3 + 1];
      const dz = e.z - this.positions[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 < r2horizon) {
        consume.add(i);
        e.consumed++;
        continue;
      }
      if (r2 > r2influence) continue;
      let scale = 1;
      if (r2 > r2fade) {
        const r = Math.sqrt(r2);
        scale = (influence - r) / (influence - fadeStart);
      }
      const m = SPECIES[this.species[i]].mass;
      const invR = 1 / Math.sqrt(r2 + eps2);
      const f = G * e.strength * m * invR * invR * invR * scale;
      this.forces[i * 3 + 0] += f * dx;
      this.forces[i * 3 + 1] += f * dy;
      this.forces[i * 3 + 2] += f * dz;
    }
  }

  private applyStar(e: Effector): void {
    const G = this.starG;
    const eps2 = 0.5;
    const heatR2 = (e.radius * 3) * (e.radius * 3);
    const heatRate = this.starHeatRate;
    for (let i = 0; i < this.count; i++) {
      const dx = e.x - this.positions[i * 3 + 0];
      const dy = e.y - this.positions[i * 3 + 1];
      const dz = e.z - this.positions[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz;
      const m = SPECIES[this.species[i]].mass;
      const invR = 1 / Math.sqrt(r2 + eps2);
      const f = G * e.strength * m * invR * invR * invR;
      this.forces[i * 3 + 0] += f * dx;
      this.forces[i * 3 + 1] += f * dy;
      this.forces[i * 3 + 2] += f * dz;
      if (r2 < heatR2) {
        const boost = 1 + heatRate * 0.01;
        this.velocities[i * 3 + 0] *= boost;
        this.velocities[i * 3 + 1] *= boost;
        this.velocities[i * 3 + 2] *= boost;
      }
    }
  }

  private applyRepulsor(e: Effector): void {
    const G = this.repulsorG;
    const eps2 = 0.3;
    const cutoff2 = (e.radius * 4) * (e.radius * 4);
    for (let i = 0; i < this.count; i++) {
      const dx = this.positions[i * 3 + 0] - e.x;
      const dy = this.positions[i * 3 + 1] - e.y;
      const dz = this.positions[i * 3 + 2] - e.z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > cutoff2) continue;
      const m = SPECIES[this.species[i]].mass;
      const invR = 1 / Math.sqrt(r2 + eps2);
      const f = G * e.strength * m * invR * invR * invR;
      this.forces[i * 3 + 0] += f * dx;
      this.forces[i * 3 + 1] += f * dy;
      this.forces[i * 3 + 2] += f * dz;
    }
  }

  private applyFreezer(e: Effector): void {
    const r2 = e.radius * e.radius;
    const damp = e.strength;
    for (let i = 0; i < this.count; i++) {
      const dx = e.x - this.positions[i * 3 + 0];
      const dy = e.y - this.positions[i * 3 + 1];
      const dz = e.z - this.positions[i * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      this.velocities[i * 3 + 0] *= damp;
      this.velocities[i * 3 + 1] *= damp;
      this.velocities[i * 3 + 2] *= damp;
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

    for (let i = 0; i < n; i++) this.massCache[i] = SPECIES[this.species[i]].mass;
    this.bh.theta2 = this.bhTheta * this.bhTheta;
    this.bh.softening2 = this.selfGravitySoftening * this.selfGravitySoftening;

    const effectiveHalf = this.boxHalf * this.scaleFactor;
    this.bh.build(this.positions, this.massCache, n, effectiveHalf);

    const out = this.bhAccel;
    for (let i = 0; i < n; i++) {
      const px = this.positions[i * 3 + 0];
      const py = this.positions[i * 3 + 1];
      const pz = this.positions[i * 3 + 2];
      this.bh.computeAcceleration(px, py, pz, i, G, out);
      const m = this.massCache[i];
      this.forces[i * 3 + 0] += m * out[0];
      this.forces[i * 3 + 1] += m * out[1];
      this.forces[i * 3 + 2] += m * out[2];
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

  private applyPeriodicBoundary(): void {
    const half = this.boxHalf * this.scaleFactor;
    if (!Number.isFinite(half) || half <= 0) return;
    const period = 2 * half;
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        const p = this.positions[idx];
        if (p > half || p < -half) {
          this.positions[idx] = p - period * Math.floor((p + half) / period);
        }
      }
    }
    for (const e of this.effectors) {
      if (e.x > half || e.x < -half) e.x = e.x - period * Math.floor((e.x + half) / period);
      if (e.y > half || e.y < -half) e.y = e.y - period * Math.floor((e.y + half) / period);
      if (e.z > half || e.z < -half) e.z = e.z - period * Math.floor((e.z + half) / period);
    }
  }

  private applyThermostat(dt: number): void {
    if (this.count < 2) return;
    const ke = this.kineticEnergy();
    const dof = 3 * this.count;
    const tCurrent = (2 * ke) / (dof * K_BOLTZMANN_REDUCED);
    if (tCurrent < 1e-8) return;
    const tTarget = this.targetTemperatureK / T_REDUCED_TO_KELVIN;
    if (this.thermostatCoolOnly && tCurrent <= tTarget) return;
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
    let darkMass = 0;
    let baryonMass = 0;
    for (let i = 0; i < this.count; i++) {
      const sp = SPECIES[this.species[i]];
      if (sp.name === 'DM') darkMass += sp.mass;
      else baryonMass += sp.mass;
    }

    return {
      count: this.count,
      kineticEnergy: ke,
      potentialEnergy: this.potentialEnergy,
      temperatureReduced: tReduced,
      temperatureK: tReduced * T_REDUCED_TO_KELVIN,
      fusionEvents: this.fusionEvents,
      simTime: this.simTime,
      bondCount: this.bondLen,
      starsFormed: this.starsFormed,
      scaleFactor: this.scaleFactor,
      darkMass,
      baryonMass,
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
