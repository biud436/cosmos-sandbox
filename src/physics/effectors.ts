// Effector physics (gravity, collisions, mergers, type-dispatched application
// of forces on particles) split out of Simulator.ts.
import type { Effector, Simulator } from './Simulator';
import { effectiveTemperature, luminosity } from './stellarPhysics';
import { SPECIES } from './types';
import { ejectSupernovaParticles } from './starFormation';

export function isMassive(e: Effector): boolean {
  return e.type === 'blackhole' || e.type === 'star' || e.type === 'neutron_star';
}

// Nebulae are *gravity sources* (their tracked gas mass pulls on stars/BHs/NS)
// but NOT receivers — their own motion is driven by gas-COM tracking in
// updateNebulae, so applying acceleration to them here would fight that. This
// is what gravitationally binds child stars to their birth cradle: a star
// born inside a nebula inherits gas-cluster velocity, then keeps orbiting
// because the surrounding cloud still pulls on it.
export function isGravitySource(e: Effector): boolean {
  return e.type === 'blackhole' || e.type === 'star' || e.type === 'neutron_star' || e.type === 'nebula';
}

export function integrateEffectors(sim: Simulator, dt: number): void {
  const list = sim.effectors;
  if (list.length === 0) return;
  const G = sim.effectorPairG;
  const eps2 = 1.5;

  const ax = new Float64Array(list.length);
  const ay = new Float64Array(list.length);
  const az = new Float64Array(list.length);

  const starStarMul = sim.starStarGMul;
  // Asymmetric pair loop: receiver (massive) ← source (any gravity source).
  // For massive-massive pairs Newton's third law is preserved by the j<i
  // half — we only emit the i←j contribution per (i, j) pair and rely on
  // the symmetric loop iteration to produce j←i separately, except for
  // nebula sources which only push, never get pushed.
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!isMassive(a)) continue;
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const b = list[j];
      if (!isGravitySource(b)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const r2 = dx * dx + dy * dy + dz * dz + eps2;
      const invR = 1 / Math.sqrt(r2);
      let mul = 1;
      if (a.type === 'star' && b.type === 'star') mul = starStarMul;
      const fa = G * invR * invR * invR * mul * b.strength;
      ax[i] += fa * dx;
      ay[i] += fa * dy;
      az[i] += fa * dz;
    }
  }

  // Effectors also feel the smooth gravitational field of particles (DM/gas)
  // via the BarnesHut tree built in applySelfGravity. Without this stars
  // don't feel DM halos and never settle into stable galactic orbits.
  if (sim.selfGravity !== 0 && sim.count > 0) {
    const Gself = sim.selfGravity;
    const accel: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isMassive(e)) continue;
      sim.bh.computeAcceleration(e.x, e.y, e.z, -1, Gself, accel);
      ax[i] += accel[0];
      ay[i] += accel[1];
      az[i] += accel[2];
    }
  }

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isMassive(e)) continue;
    e.vx += ax[i] * dt;
    e.vy += ay[i] * dt;
    e.vz += az[i] * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.z += e.vz * dt;
  }

  if (sim.bhInspiralRate > 0) applyBHInspiral(sim, dt);
  handleEffectorCollisions(sim);
}

function applyBHInspiral(sim: Simulator, dt: number): void {
  const list = sim.effectors;
  const range2 = sim.bhInspiralRange * sim.bhInspiralRange;
  const rate = sim.bhInspiralRate;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.type !== 'blackhole') continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b.type !== 'blackhole') continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > range2 || r2 < 1e-3) continue;
      // GW-like drag: damp relative motion, stronger when close
      const dvx = b.vx - a.vx;
      const dvy = b.vy - a.vy;
      const dvz = b.vz - a.vz;
      const drag = rate * dt / (r2 + 1);
      a.vx += dvx * drag;
      a.vy += dvy * drag;
      a.vz += dvz * drag;
      b.vx -= dvx * drag;
      b.vy -= dvy * drag;
      b.vz -= dvz * drag;
    }
  }
}

function handleEffectorCollisions(sim: Simulator): void {
  const removed = new Set<Effector>();
  const list = sim.effectors;
  const cocoon = sim.stellarMergerCooldown;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (removed.has(a) || !isMassive(a)) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (removed.has(b) || !isMassive(b)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (a.type === 'blackhole' && b.type === 'blackhole') {
        if (r < (a.radius + b.radius) * 0.7) {
          mergeBlackHoles(sim, a, b);
          removed.add(b);
        }
      } else if (a.type === 'blackhole' && b.type === 'star') {
        if (r < a.radius * sim.starConsumeRadiusMul) {
          consumeStar(sim, a, b);
          removed.add(b);
        }
      } else if (a.type === 'star' && b.type === 'blackhole') {
        if (r < b.radius * sim.starConsumeRadiusMul) {
          consumeStar(sim, b, a);
          removed.add(a);
          break;
        }
      } else if (a.type === 'star' && b.type === 'star') {
        // Skip merger if either star is still in its natal cocoon — prevents
        // same-frame multi-spawn cascading into instant BHs.
        const ageA = sim.simTime - a.bornAt;
        const ageB = sim.simTime - b.bornAt;
        if (ageA < cocoon || ageB < cocoon) continue;
        if (r < (a.radius + b.radius) * 0.9) {
          const collapsed = mergeStars(sim, a, b);
          removed.add(b);
          if (collapsed) removed.add(a);
        }

      } else if (
        (a.type === 'blackhole' && b.type === 'neutron_star') ||
        (a.type === 'neutron_star' && b.type === 'blackhole')
      ) {
        // BH tidally disrupts and swallows NS
        const bh = a.type === 'blackhole' ? a : b;
        const ns = a.type === 'blackhole' ? b : a;
        if (r < bh.radius * sim.starConsumeRadiusMul) {
          consumeStar(sim, bh, ns);
          removed.add(ns);
          if (ns === a) break;
        }

      } else if (a.type === 'neutron_star' && b.type === 'neutron_star') {
        // NS-NS merger → kilonova → new BH (every successful merger collapses
        // since the combined mass exceeds the Tolman-Oppenheimer-Volkoff limit).
        if (r < (a.radius + b.radius) * 1.5) {
          mergeNeutronStars(sim, a, b);
          removed.add(a);
          removed.add(b);
          break;
        }
      }
    }
  }
  if (removed.size === 0) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (removed.has(list[i])) {
      const e = list[i];
      list.splice(i, 1);
      sim.onEffectorRemoved?.(e, e.type === 'star' ? 'consumed' : 'merged');
    }
  }
}

function mergeBlackHoles(sim: Simulator, a: Effector, b: Effector): void {
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
  sim.evBHMerger++;
}

function mergeStars(sim: Simulator, a: Effector, b: Effector): boolean {
  const ma = a.strength;
  const mb = b.strength;
  const total = ma + mb;
  const mx = (a.x * ma + b.x * mb) / total;
  const my = (a.y * ma + b.y * mb) / total;
  const mz = (a.z * ma + b.z * mb) / total;
  const vx = (a.vx * ma + b.vx * mb) / total;
  const vy = (a.vy * ma + b.vy * mb) / total;
  const vz = (a.vz * ma + b.vz * mb) / total;

  // Direct collapse only for very massive merger products — typical
  // stellar-mass mergers should produce a more massive (giant) star that
  // lives out its own lifetime, not an instant BH.
  if (total > sim.mergerSupernovaThreshold) {
    const fullDisruption = Math.random() < sim.supernovaFullDisruptionProb;
    const ejectaFraction = fullDisruption ? 0.95 : 0.45;
    ejectSupernovaParticles(sim, mx, my, mz, vx, vy, vz, total * ejectaFraction);
    if (!fullDisruption) {
      const bh = sim.addEffector('blackhole', mx, my, mz);
      bh.vx = vx;
      bh.vy = vy;
      bh.vz = vz;
      bh.strength = total * (1 - ejectaFraction);
      bh.radius = Math.max(0.6, Math.cbrt(bh.strength) * 0.18);
    }
    sim.evSnDirect++;
    sim.onSupernova?.([mx, my, mz], total);
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
  // Refresh born-at so the merged giant gets a fresh lifetime budget
  a.bornAt = sim.simTime;
  // Recompute the spectrum — a 60 M-unit merger is no longer a G-type sun.
  a.temperatureK = effectiveTemperature(a.strength);
  a.luminositySolar = luminosity(a.strength);
  sim.evStellarMerger++;
  sim.onStellarMerger?.([mx, my, mz], total);
  return false;
}

// Kilonova: two NSes inspiral via GW emission, merge, exceed TOV limit and
// collapse to a BH. Small fraction of mass ejected as r-process material
// (in our sim this gas just adds to ISM metal enrichment).
function mergeNeutronStars(sim: Simulator, a: Effector, b: Effector): void {
  const ma = a.strength;
  const mb = b.strength;
  const total = ma + mb;
  const mx = (a.x * ma + b.x * mb) / total;
  const my = (a.y * ma + b.y * mb) / total;
  const mz = (a.z * ma + b.z * mb) / total;
  const vx = (a.vx * ma + b.vx * mb) / total;
  const vy = (a.vy * ma + b.vy * mb) / total;
  const vz = (a.vz * ma + b.vz * mb) / total;

  // Small ejecta (heavy-element r-process material)
  ejectSupernovaParticles(sim, mx, my, mz, vx, vy, vz, total * 0.05);

  const bh = sim.addEffector('blackhole', mx, my, mz);
  bh.vx = vx;
  bh.vy = vy;
  bh.vz = vz;
  bh.strength = total * 0.95;
  bh.radius = Math.max(0.45, Math.cbrt(bh.strength) * 0.18);

  sim.evKilonova++;
  sim.onSupernova?.([mx, my, mz], total);
}

function consumeStar(sim: Simulator, bh: Effector, star: Effector): void {
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
  sim.evStarConsumed++;
}

export function applyEffectors(sim: Simulator): void {
  const consume = new Set<number>();
  for (const e of sim.effectors) {
    switch (e.type) {
      case 'blackhole': applyBlackHole(sim, e, consume); break;
      case 'star':      applyStar(sim, e); break;
      case 'repulsor':  applyRepulsor(sim, e); break;
      case 'freezer':   applyFreezer(sim, e); break;
    }
  }
  if (consume.size > 0) {
    const sorted = Array.from(consume).sort((a, b) => b - a);
    for (const idx of sorted) if (idx < sim.count) sim.removeParticle(idx);
  }
}

function applyBlackHole(sim: Simulator, e: Effector, consume: Set<number>): void {
  const G = sim.blackHoleG;
  const eps2 = 0.6;
  const r2horizon = e.radius * e.radius;
  const influence = e.radius * 2;
  const r2influence = influence * influence;
  const fadeStart = influence * 0.85;
  const r2fade = fadeStart * fadeStart;
  for (let i = 0; i < sim.count; i++) {
    const dx = e.x - sim.positions[i * 3 + 0];
    const dy = e.y - sim.positions[i * 3 + 1];
    const dz = e.z - sim.positions[i * 3 + 2];
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
    const m = SPECIES[sim.species[i]].mass;
    const invR = 1 / Math.sqrt(r2 + eps2);
    const f = G * e.strength * m * invR * invR * invR * scale;
    sim.forces[i * 3 + 0] += f * dx;
    sim.forces[i * 3 + 1] += f * dy;
    sim.forces[i * 3 + 2] += f * dz;
  }
}

function applyStar(sim: Simulator, e: Effector): void {
  const G = sim.starG;
  const eps2 = 0.5;
  const heatR2 = (e.radius * 3) * (e.radius * 3);
  const heatRate = sim.starHeatRate;
  for (let i = 0; i < sim.count; i++) {
    const dx = e.x - sim.positions[i * 3 + 0];
    const dy = e.y - sim.positions[i * 3 + 1];
    const dz = e.z - sim.positions[i * 3 + 2];
    const r2 = dx * dx + dy * dy + dz * dz;
    const m = SPECIES[sim.species[i]].mass;
    const invR = 1 / Math.sqrt(r2 + eps2);
    const f = G * e.strength * m * invR * invR * invR;
    sim.forces[i * 3 + 0] += f * dx;
    sim.forces[i * 3 + 1] += f * dy;
    sim.forces[i * 3 + 2] += f * dz;
    if (r2 < heatR2) {
      const boost = 1 + heatRate * 0.01;
      sim.velocities[i * 3 + 0] *= boost;
      sim.velocities[i * 3 + 1] *= boost;
      sim.velocities[i * 3 + 2] *= boost;
    }
  }
}

function applyRepulsor(sim: Simulator, e: Effector): void {
  const G = sim.repulsorG;
  const eps2 = 0.3;
  const cutoff2 = (e.radius * 4) * (e.radius * 4);
  for (let i = 0; i < sim.count; i++) {
    const dx = sim.positions[i * 3 + 0] - e.x;
    const dy = sim.positions[i * 3 + 1] - e.y;
    const dz = sim.positions[i * 3 + 2] - e.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 > cutoff2) continue;
    const m = SPECIES[sim.species[i]].mass;
    const invR = 1 / Math.sqrt(r2 + eps2);
    const f = G * e.strength * m * invR * invR * invR;
    sim.forces[i * 3 + 0] += f * dx;
    sim.forces[i * 3 + 1] += f * dy;
    sim.forces[i * 3 + 2] += f * dz;
  }
}

function applyFreezer(sim: Simulator, e: Effector): void {
  const r2 = e.radius * e.radius;
  const damp = e.strength;
  for (let i = 0; i < sim.count; i++) {
    const dx = e.x - sim.positions[i * 3 + 0];
    const dy = e.y - sim.positions[i * 3 + 1];
    const dz = e.z - sim.positions[i * 3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    sim.velocities[i * 3 + 0] *= damp;
    sim.velocities[i * 3 + 1] *= damp;
    sim.velocities[i * 3 + 2] *= damp;
  }
}
