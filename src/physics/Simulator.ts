import { BarnesHut } from './BarnesHut';
import { SpatialGrid } from './SpatialGrid';
import { K_BOLTZMANN_REDUCED, SPECIES, Species, T_REDUCED_TO_KELVIN } from './types';
import { checkNebulaFormation, updateNebulae } from './nebulae';
import {
  checkStarFormation,
  checkStellarLifetimes,
  forceFormStars,
  seedGalaxies,
  SeedGalaxiesOpts,
  spinUpRecentStars,
} from './starFormation';
import { applyEffectors, integrateEffectors } from './effectors';

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

  // Live entity counts (for science-y stat panel)
  starsAlive: number;
  neutronStars: number;
  blackHoles: number;
  nebulae: number;
  totalBHMass: number;
  totalStarMass: number;

  // Chemical / cosmological state
  globalMetallicity: number;
  meanStellarMetallicity: number;
  hubbleRate: number;
  currentEra: string;

  // Cumulative event tallies, categorized
  eventCounts: {
    snTypeII: number;
    snNS: number;
    snPair: number;
    snDirect: number;
    stellarMerger: number;
    bhMerger: number;
    kilonova: number;
    starConsumed: number;
    nebulaMerger: number;
  };
}

export interface FusionEvent {
  position: [number, number, number];
  energy: number;
}

export interface MoleculeEntry {
  label: string;
  count: number;
  color: number;
  mass: number;
}

export interface CosmicEvent {
  time: number;
  name: string;
  description: string;
  action: (sim: Simulator) => void;
}

export type EffectorType = 'blackhole' | 'star' | 'repulsor' | 'freezer' | 'nebula' | 'neutron_star';

export interface Effector {
  /** Monotonic, stable for the effector's lifetime. Used as a seed key for
   * procedural artifacts (planet systems) and as the identity in the
   * spaceship-mode dex. Survives mergers only on the surviving effector. */
  id: number;
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
  // Birth metallicity for stars (0 = Pop III pristine, ~1 = Pop I enriched).
  // Inherited from the global ISM metallicity at the moment of formation.
  metallicity?: number;
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
  initialClumpRotation = 0.6;
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
  bhTheta = 0.9;
  hubbleRate = 0;
  hubbleDecay = 0;
  // When true, Hubble flow also moves effectors outward (at half rate so
  // bound orbits within galaxies survive). Lets dark energy disperse the
  // central concentration of stars/BHs instead of letting BHs eat everything.
  applyEffectorHubbleFlow = false;
  scaleFactor = 1.0;
  // Separate scale factor tracking *just* for effectors, since they expand
  // at half rate. Used by the orbit predictor so post-expansion orbits still
  // read as bound (compensates the GM/r reduction caused by lab-frame scaling).
  effectorScaleFactor = 1.0;

  // Chemical evolution: cumulative metal mass ejected by supernovae. New
  // stars inherit a metallicity proxy = metalMass / (metalMass + scaleRef)
  // so Pop III stars (formed when nothing has died yet) are pristine, and
  // late-generation stars get progressively enriched.
  metalMass = 0;
  metallicityScale = 200;

  // Cumulative event tallies — categorical so the UI can show "how this run
  // played out" at a glance (Type II SN, kilonovae, pair-instability, etc.).
  evSnTypeII = 0;
  evSnNS = 0;
  evSnPair = 0;
  evSnDirect = 0;
  evStellarMerger = 0;
  evBHMerger = 0;
  evKilonova = 0;
  evStarConsumed = 0;
  evNebulaMerger = 0;
  openBoundary = false;
  starFormationEnabled = false;
  starFormationRadius = 1.4;
  starFormationCount = 8;
  starFormationCooldown = 0.2;
  starFormationDMMin = 0;
  starFormationDMRadius = 3.0;
  // Jeans-like gating: continuous SF only fires when the local gas mean KE
  // is below this cap. Hot gas (e.g., fresh SN ejecta) has too much pressure
  // support to collapse → realistic suppression of SF in hot regions.
  sfMaxMeanKE = 1.5;
  // Exposed for sibling modules in this folder (nebulae.ts, starFormation.ts,
  // effectors.ts). Treat as package-internal — not intended for external use.
  readonly dmSpeciesId: number = SPECIES.findIndex((s) => s.name === 'DM');
  starFormationTimer = 0;
  starsFormed = 0;
  bondingEnabled = false;
  bondStiffness = 80;
  bondFormFactor = 1.2;
  bondBreakFactor = 3.0;
  blackHoleG = 0.35;
  starG = 2;
  starHeatRate = 0.4;
  repulsorG = 4;
  freezerDamp = 0.92;
  effectorPairG = 0.15;
  starStarGMul = 0.45;
  starConsumeRadiusMul = 0.35;
  bhInspiralRate = 0.12;
  bhInspiralRange = 3;
  readonly effectors: Effector[] = [];
  onEffectorRemoved: ((eff: Effector, reason: 'merged' | 'consumed' | 'manual') => void) | null = null;

  onFusion: ((event: FusionEvent) => void) | null = null;
  onStarFormation: ((position: [number, number, number], atoms: number) => void) | null = null;
  onCosmicEvent: ((event: CosmicEvent) => void) | null = null;
  onSupernova: ((position: [number, number, number], mass: number) => void) | null = null;
  onStellarMerger: ((position: [number, number, number], totalMass: number) => void) | null = null;
  onNebulaFormation: ((position: [number, number, number], mass: number) => void) | null = null;
  supernovaMassThreshold = 60;
  // Direct merger → BH requires much higher mass than natal SN threshold.
  // Two ~60M⊙ stars merging shouldn't instant-collapse; in real astrophysics
  // such a remnant lives as a luminous blue variant before SN. This decouples
  // the merger pathway from the single-star death pathway.
  mergerSupernovaThreshold = 200;
  // Mass window for neutron-star formation. Below the SN threshold a star
  // dies quietly; in [SN, NS_upper) it leaves a NS; above that → BH.
  neutronStarUpperMass = 100;
  // Natal cocoon: newly-born stars don't merge with each other for this many
  // sim sec. Prevents same-frame multi-star spawn → instant BH cascade.
  stellarMergerCooldown = 1.5;
  supernovaFullDisruptionProb = 0.25;
  supernovaEjectaSpeed = 3.5;
  supernovaEjectaCountFactor = 0.18;
  // Stellar lifetime (in sim time units). τ = base · (refMass / mass)^exp.
  // Tuned for the compressed sim scale: a "sun-like" 30 M-unit star lives
  // ~70 sim sec (≈ most of the run); 60 M (SN limit) ~25 sim sec; 150 M
  // (pair-instability) ~6 sim sec; 250 M (direct collapse) ~2 sim sec.
  // Capped to prevent immortal stars or instant disappearance.
  stellarLifetimeBase = 70;
  stellarLifetimeRefMass = 30;
  stellarLifetimeExp = 1.5;
  stellarLifetimeMin = 1.5;
  stellarLifetimeMax = 500;
  maxParticleSpeed = 10;
  maxEffectorSpeed = 18;
  // Nebulae: detect dense gas clusters and promote them to compact objects
  // for distinct rendering. Does NOT consume particles — gas continues to
  // flow; nebula tracks its centroid and dissolves when the gas thins out.
  nebulaFormationEnabled = true;
  nebulaFormationCooldown = 0.3;
  nebulaRadius = 7;
  nebulaMassMin = 5;
  nebulaDissolveMassMin = 2;
  maxNebulae = 24;
  // Below this mass an active nebula's gas is "protected" from continuous
  // star formation so it can grow into a giant molecular cloud first. Once a
  // nebula matures past the threshold, SF proceeds normally inside it.
  nebulaMaturityMass = 120;
  // Radius as a power law of mass (R = coeff · M^exp). A sub-linear power < 1
  // keeps small nebulae compact while letting massive GMCs become genuinely
  // large. sqrt(M) was too slow to reward accretion visually.
  nebulaRadiusCap = 60;
  nebulaRadiusCoeff = 1.6;
  nebulaRadiusExp = 0.6;
  // Scan beyond the current radius so a nebula can accrete gas at its edge
  // and grow over time, instead of being capped at its initial radius.
  nebulaScanExpansion = 1.3;
  // How aggressively two nebulae fuse: 0 = exact touch only, 1+ = generous.
  nebulaMergeFactor = 1.0;
  nebulaFormationTimer = 0;
  nebulaCounter = 0;

  cosmicEvents: CosmicEvent[] = [];
  firedEvents: { event: CosmicEvent; firedAt: number }[] = [];
  private firedEventCount = 0;
  starCounter = 0;
  bhCounter = 0;
  nsCounter = 0;
  private nextEffectorId = 1;

  private grid: SpatialGrid;
  bh: BarnesHut;
  private massCache: Float64Array;
  private bhAccel: [number, number, number] = [0, 0, 0];
  private potentialEnergy = 0;
  private pair: PairParams[];
  private readonly numSpecies: number;
  private fusionEvents = 0;
  private readonly fusionQueue: number[] = [];
  private readonly fusedMark: Uint8Array;
  simTime = 0;

  private readonly bondI: Int32Array;
  private readonly bondJ: Int32Array;
  private readonly bondRest: Float32Array;
  private bondLen = 0;
  private readonly bondCount: Uint8Array;
  private readonly maxBonds: number;

  // Normalized 0..1 metallicity from cumulative SN ejecta. Saturates so even
  // a runaway-SN universe doesn't push past 1.
  get globalMetallicity(): number {
    return this.metalMass / (this.metalMass + this.metallicityScale);
  }

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
    this.nebulaFormationTimer = 0;
    this.nebulaCounter = 0;
    this.metalMass = 0;
    this.effectorScaleFactor = 1.0;
    this.evSnTypeII = 0;
    this.evSnNS = 0;
    this.evSnPair = 0;
    this.evSnDirect = 0;
    this.evStellarMerger = 0;
    this.evBHMerger = 0;
    this.evKilonova = 0;
    this.evStarConsumed = 0;
    this.evNebulaMerger = 0;
    this.scaleFactor = 1.0;
    this.firedEventCount = 0;
    this.firedEvents = [];
    this.starCounter = 0;
    this.bhCounter = 0;
    this.nsCounter = 0;
    const half = this.boxHalf * this.initialBoundingRadius;
    const targetT = this.targetTemperatureK / T_REDUCED_TO_KELVIN;

    interface Clump {
      cx: number; cy: number; cz: number;
      ax: number; ay: number; az: number; // unit rotation axis
      omega: number; // angular speed
    }
    let clumps: Clump[] = [];
    if (this.initialPattern === 'clumpy') {
      const n = Math.max(2, this.initialClumpCount);
      const inner = half * 0.7;
      for (let k = 0; k < n; k++) {
        let ax = Math.random() * 2 - 1;
        let ay = Math.random() * 2 - 1;
        let az = Math.random() * 2 - 1;
        const al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;
        clumps.push({
          cx: (Math.random() * 2 - 1) * inner,
          cy: (Math.random() * 2 - 1) * inner,
          cz: (Math.random() * 2 - 1) * inner,
          ax, ay, az,
          omega: this.initialClumpRotation * (0.7 + Math.random() * 0.6),
        });
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

  private addParticle(species: Species, half: number, targetTReduced: number, clumps: { cx: number; cy: number; cz: number; ax: number; ay: number; az: number; omega: number }[]): void {
    const i = this.count++;
    this.species[i] = species.id;
    let offX = 0, offY = 0, offZ = 0;
    let clump: { cx: number; cy: number; cz: number; ax: number; ay: number; az: number; omega: number } | null = null;
    if (clumps.length > 0) {
      clump = clumps[(Math.random() * clumps.length) | 0];
      const spread = half * this.initialClumpSpread;
      offX = gaussian() * spread;
      offY = gaussian() * spread;
      offZ = gaussian() * spread;
      let x = clump.cx + offX;
      let y = clump.cy + offY;
      let z = clump.cz + offZ;
      x = Math.max(-half, Math.min(half, x));
      y = Math.max(-half, Math.min(half, y));
      z = Math.max(-half, Math.min(half, z));
      this.positions[i * 3 + 0] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
      offX = x - clump.cx;
      offY = y - clump.cy;
      offZ = z - clump.cz;
    } else {
      this.positions[i * 3 + 0] = (Math.random() * 2 - 1) * half;
      this.positions[i * 3 + 1] = (Math.random() * 2 - 1) * half;
      this.positions[i * 3 + 2] = (Math.random() * 2 - 1) * half;
    }

    const sigma = Math.sqrt((K_BOLTZMANN_REDUCED * targetTReduced) / Math.max(species.mass, 1e-6)) * this.initialVelocityScale;
    let vx = gaussian() * sigma;
    let vy = gaussian() * sigma;
    let vz = gaussian() * sigma;
    if (clump && clump.omega !== 0) {
      // Tangential rotation about clump axis: v_tangent = omega * (axis × offset)
      const tx = clump.ay * offZ - clump.az * offY;
      const ty = clump.az * offX - clump.ax * offZ;
      const tz = clump.ax * offY - clump.ay * offX;
      vx += tx * clump.omega;
      vy += ty * clump.omega;
      vz += tz * clump.omega;
    }
    this.velocities[i * 3 + 0] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
  }

  coolAllParticles(factor: number): void {
    for (let i = 0; i < this.count * 3; i++) this.velocities[i] *= factor;
  }

  seedGalaxies(opts: SeedGalaxiesOpts): { galaxies: number; stars: number; blackHoles: number } {
    return seedGalaxies(this, opts);
  }

  spinUpRecentStars(orbitalSpeed: number, withinSimTime: number): number {
    return spinUpRecentStars(this, orbitalSpeed, withinSimTime);
  }

  forceFormStars(maxStars: number, radius: number, minClusterSize: number): number {
    return forceFormStars(this, maxStars, radius, minClusterSize);
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
    this.clampParticleSpeeds();
    this.applyThermostat(dt);
    integrateEffectors(this, dt);
    this.clampEffectorSpeeds();

    if (this.hubbleRate > 0) this.applyHubble(dt);
    if (this.openBoundary) this.applyPeriodicBoundary();

    if (this.starFormationEnabled) {
      this.starFormationTimer += dt;
      if (this.starFormationTimer >= this.starFormationCooldown) {
        this.starFormationTimer = 0;
        checkStarFormation(this);
      }
    }

    if (this.nebulaFormationEnabled) {
      this.nebulaFormationTimer += dt;
      if (this.nebulaFormationTimer >= this.nebulaFormationCooldown) {
        this.nebulaFormationTimer = 0;
        checkNebulaFormation(this);
      }
      updateNebulae(this);
    }

    checkStellarLifetimes(this);

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
    // Effectors are normally decoupled from Hubble flow (gravitationally bound
    // systems shouldn't expand internally). But when applyEffectorHubbleFlow
    // is on (e.g., during the dark-energy era), apply a *half-rate* scaling so
    // intergalactic distances grow while tight orbits mostly survive.
    if (this.applyEffectorHubbleFlow && this.effectors.length > 0) {
      const efactor = 1 + (H * 0.5) * dt;
      this.effectorScaleFactor *= efactor;
      for (const e of this.effectors) {
        e.x *= efactor;
        e.y *= efactor;
        e.z *= efactor;
      }
    }
  }

  currentHubble(): number {
    if (this.hubbleRate <= 0) return 0;
    if (this.hubbleDecay <= 0) return this.hubbleRate;
    return this.hubbleRate / (1 + this.hubbleDecay * this.simTime);
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

    if (this.effectors.length > 0) applyEffectors(this);
  }

  addEffector(type: EffectorType, x: number, y: number, z: number): Effector {
    const presets: Record<EffectorType, { radius: number; strength: number }> = {
      blackhole:    { radius: 0.35, strength: 25 },
      star:         { radius: 1.6,  strength: 30 },
      repulsor:     { radius: 1.5,  strength: 60 },
      freezer:      { radius: 3.0,  strength: 0.92 },
      nebula:       { radius: 8.0,  strength: 0 },
      neutron_star: { radius: 0.45, strength: 20 },
    };
    const p = presets[type];
    const e: Effector = {
      id: this.nextEffectorId++,
      type, x, y, z,
      vx: 0, vy: 0, vz: 0,
      radius: p.radius, strength: p.strength, consumed: 0,
      bornAt: this.simTime,
    };
    if (type === 'star') e.name = `★ S-${String(++this.starCounter).padStart(3, '0')}`;
    else if (type === 'blackhole') e.name = `● BH-${String(++this.bhCounter).padStart(3, '0')}`;
    else if (type === 'nebula') e.name = `☁ N-${String(++this.nebulaCounter).padStart(3, '0')}`;
    else if (type === 'neutron_star') e.name = `⚪ NS-${String(++this.nsCounter).padStart(3, '0')}`;
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

  removeBondsForParticle(p: number): void {
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
    const componentMass = new Float64Array(n);
    for (let i = 0; i < n; i++) componentFirstMember[i] = -1;
    for (let i = 0; i < n; i++) {
      const r = find(i);
      componentSize[r]++;
      componentSpeciesMask[r] |= 1 << this.species[i];
      componentMass[r] += SPECIES[this.species[i]].mass;
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
        existing.mass += componentMass[r];
      } else {
        tally.set(label, { label, count: 1, color: repSpeciesObj.color, mass: componentMass[r] });
      }
    }

    const out = Array.from(tally.values());
    out.sort((a, b) => b.mass - a.mass);
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

  removeParticle(idx: number): void {
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

  private clampParticleSpeeds(): void {
    const vmax = this.maxParticleSpeed;
    if (!Number.isFinite(vmax) || vmax <= 0) return;
    const vmax2 = vmax * vmax;
    for (let i = 0; i < this.count; i++) {
      const vx = this.velocities[i * 3 + 0];
      const vy = this.velocities[i * 3 + 1];
      const vz = this.velocities[i * 3 + 2];
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 <= vmax2) continue;
      const scale = vmax / Math.sqrt(v2);
      this.velocities[i * 3 + 0] = vx * scale;
      this.velocities[i * 3 + 1] = vy * scale;
      this.velocities[i * 3 + 2] = vz * scale;
    }
  }

  private clampEffectorSpeeds(): void {
    const vmax = this.maxEffectorSpeed;
    if (!Number.isFinite(vmax) || vmax <= 0) return;
    const vmax2 = vmax * vmax;
    for (const e of this.effectors) {
      const v2 = e.vx * e.vx + e.vy * e.vy + e.vz * e.vz;
      if (v2 <= vmax2) continue;
      const scale = vmax / Math.sqrt(v2);
      e.vx *= scale;
      e.vy *= scale;
      e.vz *= scale;
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

    let starsAlive = 0;
    let neutronStars = 0;
    let blackHoles = 0;
    let nebulae = 0;
    let totalBHMass = 0;
    let totalStarMass = 0;
    let zSum = 0;
    let zCount = 0;
    for (const e of this.effectors) {
      switch (e.type) {
        case 'star':
          starsAlive++;
          totalStarMass += e.strength;
          if (e.metallicity !== undefined) { zSum += e.metallicity; zCount++; }
          break;
        case 'neutron_star':
          neutronStars++;
          break;
        case 'blackhole':
          blackHoles++;
          totalBHMass += e.strength;
          break;
        case 'nebula':
          nebulae++;
          break;
      }
    }

    const currentEra = this.firedEvents.length > 0
      ? this.firedEvents[this.firedEvents.length - 1].event.name
      : '인플레이션 이전';

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

      starsAlive,
      neutronStars,
      blackHoles,
      nebulae,
      totalBHMass,
      totalStarMass,

      globalMetallicity: this.globalMetallicity,
      meanStellarMetallicity: zCount > 0 ? zSum / zCount : 0,
      hubbleRate: this.currentHubble(),
      currentEra,

      eventCounts: {
        snTypeII: this.evSnTypeII,
        snNS: this.evSnNS,
        snPair: this.evSnPair,
        snDirect: this.evSnDirect,
        stellarMerger: this.evStellarMerger,
        bhMerger: this.evBHMerger,
        kilonova: this.evKilonova,
        starConsumed: this.evStarConsumed,
        nebulaMerger: this.evNebulaMerger,
      },
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
