// Star-formation lifecycle split out of Simulator.ts: cluster detection,
// IMF-sampled spawn, stellar lifetimes, supernova ejecta, galaxy seeding.
import type { Effector, Simulator } from './Simulator';
import { SPECIES } from './types';

export function countDMNear(sim: Simulator, x: number, y: number, z: number, r2: number): number {
  const dmId = sim.dmSpeciesId;
  if (dmId < 0) return 0;
  let cnt = 0;
  for (let i = 0; i < sim.count; i++) {
    if (sim.species[i] !== dmId) continue;
    const dx = sim.positions[i * 3 + 0] - x;
    const dy = sim.positions[i * 3 + 1] - y;
    const dz = sim.positions[i * 3 + 2] - z;
    if (dx * dx + dy * dy + dz * dz < r2) cnt++;
  }
  return cnt;
}

export function checkStarFormation(sim: Simulator): void {
  const R = sim.starFormationRadius;
  const R2 = R * R;
  const threshold = sim.starFormationCount;
  const targetSize = Math.max(threshold, Math.min(threshold + 2, 8));
  const claimed = new Uint8Array(sim.count);
  const removed: number[] = [];

  const candidateSeeds: { idx: number; sp: number; score: number }[] = [];
  for (let i = 0; i < sim.count; i++) {
    const si = sim.species[i];
    if (si !== 0 && si !== 4) continue;
    const xi = sim.positions[i * 3 + 0];
    const yi = sim.positions[i * 3 + 1];
    const zi = sim.positions[i * 3 + 2];
    let cnt = 0;
    for (let j = 0; j < sim.count; j++) {
      if (j === i || sim.species[j] !== si) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      if (dx * dx + dy * dy + dz * dz < R2) cnt++;
    }
    if (cnt + 1 >= threshold) candidateSeeds.push({ idx: i, sp: si, score: cnt });
  }
  candidateSeeds.sort((a, b) => b.score - a.score);

  const requireDM = sim.starFormationDMMin > 0;
  const dmR2 = sim.starFormationDMRadius * sim.starFormationDMRadius;
  // Immature nebulae shield their gas from continuous SF so they can grow
  // into giant molecular clouds before collapsing into stars.
  const protectedNebulae: Effector[] = [];
  for (const e of sim.effectors) {
    if (e.type === 'nebula' && e.strength < sim.nebulaMaturityMass) {
      protectedNebulae.push(e);
    }
  }
  for (const seed of candidateSeeds) {
    if (claimed[seed.idx]) continue;
    const xi = sim.positions[seed.idx * 3 + 0];
    const yi = sim.positions[seed.idx * 3 + 1];
    const zi = sim.positions[seed.idx * 3 + 2];
    if (requireDM) {
      if (countDMNear(sim, xi, yi, zi, dmR2) < sim.starFormationDMMin) continue;
    }
    let inImmatureNebula = false;
    for (const n of protectedNebulae) {
      const dx = xi - n.x, dy = yi - n.y, dz = zi - n.z;
      if (dx * dx + dy * dy + dz * dz < n.radius * n.radius) {
        inImmatureNebula = true;
        break;
      }
    }
    if (inImmatureNebula) continue;
    const nearby: { idx: number; d2: number }[] = [];
    for (let j = 0; j < sim.count; j++) {
      if (j === seed.idx || claimed[j]) continue;
      if (sim.species[j] !== seed.sp) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R2) nearby.push({ idx: j, d2 });
    }
    if (nearby.length + 1 < threshold) continue;
    nearby.sort((a, b) => a.d2 - b.d2);
    const take = Math.min(nearby.length, targetSize - 1);
    const cluster = [seed.idx];
    for (let k = 0; k < take; k++) cluster.push(nearby[k].idx);
    for (const idx of cluster) claimed[idx] = 1;
    spawnStarFromCluster(sim, cluster);
    for (const idx of cluster) removed.push(idx);
  }

  if (removed.length === 0) return;
  removed.sort((a, b) => b - a);
  for (const idx of removed) if (idx < sim.count) sim.removeParticle(idx);
}

export function forceFormStars(sim: Simulator, maxStars: number, radius: number, minClusterSize: number): number {
  let formed = scanAndFormStars(sim, maxStars, radius, minClusterSize);
  if (formed > 0) return formed;
  formed = scanAndFormStars(sim, maxStars, radius * 1.6, Math.max(3, Math.floor(minClusterSize / 2)));
  if (formed > 0) return formed;
  return fallbackFormStars(sim, maxStars);
}

function scanAndFormStars(sim: Simulator, maxStars: number, radius: number, minClusterSize: number): number {
  const r2 = radius * radius;
  const targetSize = Math.max(minClusterSize, Math.min(minClusterSize + 2, 8));
  const hIndices: number[] = [];
  for (let i = 0; i < sim.count; i++) if (sim.species[i] === 0) hIndices.push(i);
  if (hIndices.length < minClusterSize) return 0;

  const score = new Int32Array(sim.count);
  for (const i of hIndices) {
    const xi = sim.positions[i * 3 + 0];
    const yi = sim.positions[i * 3 + 1];
    const zi = sim.positions[i * 3 + 2];
    let s = 0;
    for (const j of hIndices) {
      if (j === i) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      if (dx * dx + dy * dy + dz * dz < r2) s++;
    }
    score[i] = s;
  }
  hIndices.sort((a, b) => score[b] - score[a]);

  const claimed = new Uint8Array(sim.count);
  const removed: number[] = [];
  let formed = 0;
  const requireDM = sim.starFormationDMMin > 0;
  const dmR2 = sim.starFormationDMRadius * sim.starFormationDMRadius;
  for (const seed of hIndices) {
    if (formed >= maxStars) break;
    if (claimed[seed]) continue;
    const xi = sim.positions[seed * 3 + 0];
    const yi = sim.positions[seed * 3 + 1];
    const zi = sim.positions[seed * 3 + 2];
    if (requireDM) {
      if (countDMNear(sim, xi, yi, zi, dmR2) < sim.starFormationDMMin) continue;
    }
    const nearby: { idx: number; d2: number }[] = [];
    for (const j of hIndices) {
      if (j === seed || claimed[j]) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) nearby.push({ idx: j, d2 });
    }
    if (nearby.length + 1 < minClusterSize) continue;
    nearby.sort((a, b) => a.d2 - b.d2);
    const take = Math.min(nearby.length, targetSize - 1);
    const members = [seed];
    for (let k = 0; k < take; k++) members.push(nearby[k].idx);
    for (const idx of members) claimed[idx] = 1;
    spawnStarFromCluster(sim, members);
    for (const idx of members) removed.push(idx);
    formed++;
  }
  removed.sort((a, b) => b - a);
  for (const idx of removed) if (idx < sim.count) sim.removeParticle(idx);
  return formed;
}

function fallbackFormStars(sim: Simulator, maxStars: number): number {
  const hIndices: number[] = [];
  for (let i = 0; i < sim.count; i++) if (sim.species[i] === 0) hIndices.push(i);
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
  return consumeClustersIntoStars(sim, candidates, maxStars);
}

function consumeClustersIntoStars(sim: Simulator, candidates: { members: number[] }[], maxStars: number): number {
  candidates.sort((a, b) => b.members.length - a.members.length);
  const claimed = new Uint8Array(sim.count);
  const removed: number[] = [];
  let formed = 0;
  for (const cand of candidates) {
    if (formed >= maxStars) break;
    let overlap = false;
    for (const idx of cand.members) if (claimed[idx]) { overlap = true; break; }
    if (overlap) continue;
    for (const idx of cand.members) claimed[idx] = 1;
    spawnStarFromCluster(sim, cand.members);
    for (const idx of cand.members) removed.push(idx);
    formed++;
  }
  removed.sort((a, b) => b - a);
  for (const idx of removed) if (idx < sim.count) sim.removeParticle(idx);
  return formed;
}

export function spawnStarFromCluster(sim: Simulator, indices: number[]): Effector | null {
  let cx = 0, cy = 0, cz = 0;
  let vx = 0, vy = 0, vz = 0;
  let total = 0;
  for (const i of indices) {
    const m = SPECIES[sim.species[i]].mass;
    cx += sim.positions[i * 3 + 0] * m;
    cy += sim.positions[i * 3 + 1] * m;
    cz += sim.positions[i * 3 + 2] * m;
    vx += sim.velocities[i * 3 + 0] * m;
    vy += sim.velocities[i * 3 + 1] * m;
    vz += sim.velocities[i * 3 + 2] * m;
    total += m;
  }
  if (total <= 0) return null;
  cx /= total; cy /= total; cz /= total;
  vx /= total; vy /= total; vz /= total;

  const eff = sim.addEffector('star', cx, cy, cz);
  // Inherit the full bulk velocity of the gas cluster (preserves angular
  // momentum of the collapsing gas → star naturally orbits whatever the
  // gas was orbiting, no manual setup needed).
  eff.vx = vx;
  eff.vy = vy;
  eff.vz = vz;
  // Chabrier-like IMF: most stars are LOW mass (think red dwarfs / sun-like)
  // that live long; only a small fraction reach supernova mass; even fewer
  // are pair-instability/direct-collapse hypermassives. Previously a flat
  // Salpeter tail was producing too many BHs because mid-mass stars all hit
  // the SN threshold.
  const baseMass = total * 150;
  const r = Math.random();
  let imfBoost: number;
  if (r < 0.70) {
    // Low-mass stars (red dwarf → sun-like): 0.3–1.0× base
    imfBoost = 0.3 + Math.random() * 0.7;
  } else if (r < 0.92) {
    // Mid-mass (A/F): 1.0–2.5× base
    imfBoost = 1.0 + Math.random() * 1.5;
  } else if (r < 0.99) {
    // Massive (O/B, supernova-eligible): 2.5–6× base
    imfBoost = 2.5 + Math.random() * 3.5;
  } else {
    // Hypermassive (pair-instability or direct collapse): 6–12× base
    imfBoost = 6.0 + Math.random() * 6.0;
  }
  eff.strength = Math.min(320, Math.max(6, baseMass * imfBoost));
  eff.radius = Math.min(3.2, Math.max(0.7, Math.cbrt(eff.strength / 30) * 0.95));

  // Inherit the ISM metallicity at the moment of birth. Stars born from
  // pristine gas (early universe) get Z≈0; stars born after many SNe get Z↑.
  eff.metallicity = sim.globalMetallicity;

  sim.starsFormed++;
  sim.onStarFormation?.([cx, cy, cz], indices.length);
  return eff;
}

export function findDensestHSeed(sim: Simulator, radius: number, excludeCenters: [number, number, number][], minSep2: number): number {
  const R2 = radius * radius;
  let bestIdx = -1;
  let bestCount = -1;
  for (let i = 0; i < sim.count; i++) {
    if (sim.species[i] !== 0) continue;
    const xi = sim.positions[i * 3 + 0];
    const yi = sim.positions[i * 3 + 1];
    const zi = sim.positions[i * 3 + 2];
    let tooClose = false;
    for (const c of excludeCenters) {
      const dx = xi - c[0];
      const dy = yi - c[1];
      const dz = zi - c[2];
      if (dx * dx + dy * dy + dz * dz < minSep2) { tooClose = true; break; }
    }
    if (tooClose) continue;
    let cnt = 0;
    for (let j = 0; j < sim.count; j++) {
      if (j === i || sim.species[j] !== 0) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      if (dx * dx + dy * dy + dz * dz < R2) cnt++;
    }
    if (cnt > bestCount) {
      bestCount = cnt;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function spinUpRecentStars(sim: Simulator, orbitalSpeed: number, withinSimTime: number): number {
  const cutoff = sim.simTime - withinSimTime;
  const recent: Effector[] = [];
  for (const e of sim.effectors) if (e.type === 'star' && e.bornAt >= cutoff) recent.push(e);
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

export interface SeedGalaxiesOpts {
  galaxyCount: number;
  starsPerGalaxy: number;
  radius: number;
  starClusterSize: number;
  orbitalSpeed: number;
  centralBHMass?: number;
  centralBHRadius?: number;
}

export function seedGalaxies(sim: Simulator, opts: SeedGalaxiesOpts): { galaxies: number; stars: number; blackHoles: number } {
  let galaxiesFormed = 0;
  let totalStars = 0;
  let totalBHs = 0;
  const usedCenters: [number, number, number][] = [];
  const minSeparation2 = (opts.radius * 3.5) * (opts.radius * 3.5);
  const R2 = opts.radius * opts.radius;
  const groupSize = Math.max(2, opts.starClusterSize);
  const maxAttempts = opts.galaxyCount * 4;
  const wantBH = !!opts.centralBHMass && opts.centralBHMass > 0;
  const bhRadius = opts.centralBHRadius ?? 0.35;
  const minStarR = bhRadius * 4;
  const minStarR2 = minStarR * minStarR;
  let attempts = 0;
  while (galaxiesFormed < opts.galaxyCount && attempts < maxAttempts) {
    attempts++;
    const seed = findDensestHSeed(sim, opts.radius, usedCenters, minSeparation2);
    if (seed === -1) break;
    const sx = sim.positions[seed * 3 + 0];
    const sy = sim.positions[seed * 3 + 1];
    const sz = sim.positions[seed * 3 + 2];

    const pool: number[] = [];
    for (let j = 0; j < sim.count; j++) {
      if (sim.species[j] !== 0) continue;
      const dx = sim.positions[j * 3 + 0] - sx;
      const dy = sim.positions[j * 3 + 1] - sy;
      const dz = sim.positions[j * 3 + 2] - sz;
      if (dx * dx + dy * dy + dz * dz < R2) pool.push(j);
    }
    if (pool.length < groupSize) {
      usedCenters.push([sx, sy, sz]);
      continue;
    }

    let cx = 0, cy = 0, cz = 0, cvx = 0, cvy = 0, cvz = 0, comM = 0;
    for (const idx of pool) {
      const m = SPECIES[sim.species[idx]].mass;
      cx += sim.positions[idx * 3 + 0] * m;
      cy += sim.positions[idx * 3 + 1] * m;
      cz += sim.positions[idx * 3 + 2] * m;
      cvx += sim.velocities[idx * 3 + 0] * m;
      cvy += sim.velocities[idx * 3 + 1] * m;
      cvz += sim.velocities[idx * 3 + 2] * m;
      comM += m;
    }
    if (comM <= 0) { usedCenters.push([sx, sy, sz]); continue; }
    cx /= comM; cy /= comM; cz /= comM;
    cvx /= comM; cvy /= comM; cvz /= comM;

    const coreIndices: number[] = [];
    const haloIndices: number[] = [];
    if (wantBH) {
      for (const idx of pool) {
        const dx = sim.positions[idx * 3 + 0] - cx;
        const dy = sim.positions[idx * 3 + 1] - cy;
        const dz = sim.positions[idx * 3 + 2] - cz;
        if (dx * dx + dy * dy + dz * dz < minStarR2) coreIndices.push(idx);
        else haloIndices.push(idx);
      }
    } else {
      for (const idx of pool) haloIndices.push(idx);
    }

    haloIndices.sort((a, b) => {
      const ax = sim.positions[a * 3 + 0] - cx;
      const ay = sim.positions[a * 3 + 1] - cy;
      const az = sim.positions[a * 3 + 2] - cz;
      const bx = sim.positions[b * 3 + 0] - cx;
      const by = sim.positions[b * 3 + 1] - cy;
      const bz = sim.positions[b * 3 + 2] - cz;
      return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz);
    });

    const toRemove: number[] = [];
    if (wantBH) {
      let absorbedMass = 0;
      for (const idx of coreIndices) {
        absorbedMass += SPECIES[sim.species[idx]].mass;
        toRemove.push(idx);
      }
      const bh = sim.addEffector('blackhole', cx, cy, cz);
      bh.strength = (opts.centralBHMass ?? 0) + absorbedMass * 5;
      bh.radius = bhRadius;
      bh.vx = cvx;
      bh.vy = cvy;
      bh.vz = cvz;
      totalBHs++;
    }

    const haloMaxStars = Math.min(opts.starsPerGalaxy, Math.floor(haloIndices.length / groupSize));
    let stars = 0;
    for (let k = 0; k < haloMaxStars; k++) {
      const slice = haloIndices.slice(k * groupSize, (k + 1) * groupSize);
      const star = spawnStarFromCluster(sim, slice);
      if (star) {
        stars++;
        for (const idx of slice) toRemove.push(idx);
      }
    }

    toRemove.sort((a, b) => b - a);
    for (const idx of toRemove) if (idx < sim.count) sim.removeParticle(idx);

    galaxiesFormed++;
    totalStars += stars;
    usedCenters.push([cx, cy, cz]);
  }
  return { galaxies: galaxiesFormed, stars: totalStars, blackHoles: totalBHs };
}

export function checkStellarLifetimes(sim: Simulator): void {
  if (sim.stellarLifetimeBase <= 0) return;
  const refM = sim.stellarLifetimeRefMass;
  const exp = sim.stellarLifetimeExp;
  const base = sim.stellarLifetimeBase;
  const lifeMin = sim.stellarLifetimeMin;
  const lifeMax = sim.stellarLifetimeMax;
  const dying: Effector[] = [];
  for (const e of sim.effectors) {
    if (e.type !== 'star') continue;
    const age = sim.simTime - e.bornAt;
    const lifetime = Math.max(lifeMin, Math.min(lifeMax,
      base * Math.pow(refM / Math.max(e.strength, 1e-3), exp)));
    if (age > lifetime) dying.push(e);
  }
  if (dying.length === 0) return;
  for (const star of dying) endOfStarLife(sim, star);
}

// Three death pathways inspired by real stellar evolution, adapted to the
// compressed sim scale (M in our units, not solar masses):
//   M <  60:   quiet death — envelope ejected, no compact remnant (proxy
//              for low-mass stars + white dwarfs that we don't track).
//   60–150:    core-collapse SN — leaves a stellar-mass BH.
//   150–250:   pair-instability SN — FULL disruption, no remnant.
//              Real M_PI window is ~140–260 M⊙; the gap is what produces
//              the observed "BH mass gap" between ~50 and 130 M⊙.
//   M ≥ 250:   direct collapse to a more massive BH — minimal ejecta,
//              most mass enters the BH (mirrors how Pop III hypermassives
//              are thought to seed early supermassive BHs).
function endOfStarLife(sim: Simulator, star: Effector): void {
  const idx = sim.effectors.indexOf(star);
  if (idx < 0) return;
  const M = star.strength;
  const snThreshold = sim.supernovaMassThreshold;
  const pairInstabilityLo = 150;
  const directCollapseLo = 250;

  if (M < snThreshold) {
    // Quiet death: shed envelope as gas, no remnant
    ejectSupernovaParticles(sim, star.x, star.y, star.z, star.vx, star.vy, star.vz, M * 0.55);
  } else if (M < pairInstabilityLo) {
    // Type II SN → stellar-mass BH
    const ejectaFraction = 0.55;
    ejectSupernovaParticles(sim, star.x, star.y, star.z, star.vx, star.vy, star.vz, M * ejectaFraction);
    const bh = sim.addEffector('blackhole', star.x, star.y, star.z);
    bh.vx = star.vx; bh.vy = star.vy; bh.vz = star.vz;
    bh.strength = M * (1 - ejectaFraction);
    bh.radius = Math.max(0.5, Math.cbrt(bh.strength) * 0.18);
    sim.onSupernova?.([star.x, star.y, star.z], M);
  } else if (M < directCollapseLo) {
    // Pair-instability SN: total disruption — NO remnant. Generates a lot
    // of ejecta and removes the star entirely from the BH-formation budget.
    ejectSupernovaParticles(sim, star.x, star.y, star.z, star.vx, star.vy, star.vz, M * 0.95);
    sim.onSupernova?.([star.x, star.y, star.z], M);
  } else {
    // Direct collapse: most mass goes into BH, minimal ejecta. This is the
    // primary channel for seeding heavy BHs in the early universe.
    const ejectaFraction = 0.15;
    ejectSupernovaParticles(sim, star.x, star.y, star.z, star.vx, star.vy, star.vz, M * ejectaFraction);
    const bh = sim.addEffector('blackhole', star.x, star.y, star.z);
    bh.vx = star.vx; bh.vy = star.vy; bh.vz = star.vz;
    bh.strength = M * (1 - ejectaFraction);
    bh.radius = Math.max(0.7, Math.cbrt(bh.strength) * 0.20);
    sim.onSupernova?.([star.x, star.y, star.z], M);
  }
  sim.effectors.splice(idx, 1);
  sim.onEffectorRemoved?.(star, 'consumed');
}

export function ejectSupernovaParticles(sim: Simulator, x: number, y: number, z: number, vx: number, vy: number, vz: number, ejectaMass: number): void {
  const find = (name: string) => SPECIES.findIndex((s) => s.name === name);
  const heId = find('He');
  const n2Id = find('N₂');
  const o2Id = find('O₂');
  const dustId = find('Dust');
  const cId = find('C');
  const siId = find('Si');
  const feId = find('Fe');
  const auId = find('Au');
  // Stellar nucleosynthesis abundances (alpha-process favored).
  // He · C · O₂ most common, Si/N₂ moderate, Fe rarer, Au very rare (r-process).
  const speciesPool: number[] = [];
  if (heId >= 0) { for (let k = 0; k < 6; k++) speciesPool.push(heId); }
  if (cId >= 0) { for (let k = 0; k < 4; k++) speciesPool.push(cId); }
  if (o2Id >= 0) { for (let k = 0; k < 4; k++) speciesPool.push(o2Id); }
  if (siId >= 0) { for (let k = 0; k < 2; k++) speciesPool.push(siId); }
  if (n2Id >= 0) { for (let k = 0; k < 2; k++) speciesPool.push(n2Id); }
  if (feId >= 0) { speciesPool.push(feId); }
  if (dustId >= 0) { speciesPool.push(dustId); }
  const sprinkleGold = auId >= 0 && Math.random() < 0.18;
  if (speciesPool.length === 0) return;

  // Track cumulative metal output for chemical evolution. Everything ejected
  // by a SN counts as enrichment (in our species mix even He acts as a
  // visual stand-in for "stuff heavier than primordial H").
  sim.metalMass += ejectaMass;

  const count = Math.max(4, Math.min(40, Math.floor(ejectaMass * sim.supernovaEjectaCountFactor)));
  const baseSpeed = sim.supernovaEjectaSpeed;
  for (let k = 0; k < count; k++) {
    if (sim.count >= sim.maxParticles) return;
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = s * Math.cos(t);
    const dy = u;
    const dz = s * Math.sin(t);
    let sp = speciesPool[(Math.random() * speciesPool.length) | 0];
    if (sprinkleGold && auId >= 0 && k === 0) sp = auId;
    const r0 = 0.6 + Math.random() * 0.3;
    const speed = baseSpeed * (0.7 + Math.random() * 0.6);
    const i = sim.count++;
    sim.species[i] = sp;
    sim.positions[i * 3 + 0] = x + dx * r0;
    sim.positions[i * 3 + 1] = y + dy * r0;
    sim.positions[i * 3 + 2] = z + dz * r0;
    sim.velocities[i * 3 + 0] = vx + dx * speed;
    sim.velocities[i * 3 + 1] = vy + dy * speed;
    sim.velocities[i * 3 + 2] = vz + dz * speed;
  }
}
