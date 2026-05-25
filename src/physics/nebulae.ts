// Nebula compact-object logic split out of Simulator.ts. Functions operate on
// a Simulator instance via its public/internal fields. Same-folder
// "modules-as-friends" pattern — these are not intended to be called from
// outside src/physics/.
import type { Effector, Simulator } from './Simulator';
import { SPECIES } from './types';

export function checkNebulaFormation(sim: Simulator): void {
  let count = 0;
  for (const e of sim.effectors) if (e.type === 'nebula') count++;
  if (count >= sim.maxNebulae) return;
  const R = sim.nebulaRadius;
  const R2 = R * R;
  const sepFactor = R * 1.4;
  const sep2 = sepFactor * sepFactor;
  const dmId = sim.dmSpeciesId;
  const existing: Array<[number, number, number]> = [];
  for (const e of sim.effectors) {
    if (e.type === 'nebula') existing.push([e.x, e.y, e.z]);
  }
  // Subsample seeds to keep this O(N · seeds) tractable on N=9000
  const stride = Math.max(1, Math.floor(sim.count / 600));
  let bestSeed = -1;
  let bestMass = 0;
  let bestX = 0, bestY = 0, bestZ = 0;
  for (let i = 0; i < sim.count; i += stride) {
    const si = sim.species[i];
    if (si === dmId) continue;
    const xi = sim.positions[i * 3 + 0];
    const yi = sim.positions[i * 3 + 1];
    const zi = sim.positions[i * 3 + 2];
    let inside = false;
    for (const c of existing) {
      const dx = xi - c[0], dy = yi - c[1], dz = zi - c[2];
      if (dx * dx + dy * dy + dz * dz < sep2) { inside = true; break; }
    }
    if (inside) continue;
    let m = 0;
    for (let j = 0; j < sim.count; j++) {
      const sj = sim.species[j];
      if (sj === dmId) continue;
      const dx = sim.positions[j * 3 + 0] - xi;
      const dy = sim.positions[j * 3 + 1] - yi;
      const dz = sim.positions[j * 3 + 2] - zi;
      if (dx * dx + dy * dy + dz * dz < R2) m += SPECIES[sj].mass;
    }
    if (m > bestMass) {
      bestMass = m;
      bestSeed = i;
      bestX = xi; bestY = yi; bestZ = zi;
    }
  }
  if (bestSeed < 0 || bestMass < sim.nebulaMassMin) return;
  const eff = sim.addEffector('nebula', bestX, bestY, bestZ);
  eff.radius = R;
  eff.strength = bestMass;
  sim.onNebulaFormation?.([bestX, bestY, bestZ], bestMass);
}

export function updateNebulae(sim: Simulator): void {
  if (sim.effectors.length === 0) return;
  const dmId = sim.dmSpeciesId;
  const removed: Effector[] = [];
  for (const e of sim.effectors) {
    if (e.type !== 'nebula') continue;
    const R2 = e.radius * e.radius;
    let cx = 0, cy = 0, cz = 0;
    let vx = 0, vy = 0, vz = 0;
    let totM = 0;
    for (let i = 0; i < sim.count; i++) {
      const si = sim.species[i];
      if (si === dmId) continue;
      const dx = sim.positions[i * 3 + 0] - e.x;
      const dy = sim.positions[i * 3 + 1] - e.y;
      const dz = sim.positions[i * 3 + 2] - e.z;
      if (dx * dx + dy * dy + dz * dz > R2) continue;
      const m = SPECIES[si].mass;
      cx += sim.positions[i * 3 + 0] * m;
      cy += sim.positions[i * 3 + 1] * m;
      cz += sim.positions[i * 3 + 2] * m;
      vx += sim.velocities[i * 3 + 0] * m;
      vy += sim.velocities[i * 3 + 1] * m;
      vz += sim.velocities[i * 3 + 2] * m;
      totM += m;
    }
    if (totM < sim.nebulaDissolveMassMin) {
      removed.push(e);
      continue;
    }
    cx /= totM; cy /= totM; cz /= totM;
    vx /= totM; vy /= totM; vz /= totM;
    const alpha = 0.25;
    e.x = e.x * (1 - alpha) + cx * alpha;
    e.y = e.y * (1 - alpha) + cy * alpha;
    e.z = e.z * (1 - alpha) + cz * alpha;
    e.vx = vx;
    e.vy = vy;
    e.vz = vz;
    e.strength = totM;
    e.radius = Math.max(5.0, Math.min(sim.nebulaRadiusCap, Math.sqrt(totM) * sim.nebulaRadiusCoeff));
  }
  for (const e of removed) {
    const idx = sim.effectors.indexOf(e);
    if (idx >= 0) {
      sim.effectors.splice(idx, 1);
      sim.onEffectorRemoved?.(e, 'consumed');
    }
  }
  mergeOverlappingNebulae(sim);
}

// Adjacent nebulae fuse into one larger cloud (gas clusters collide and become
// a super-massive molecular cloud). Without this, nearby gas concentrations
// stay as several small nebulae instead of a single giant.
function mergeOverlappingNebulae(sim: Simulator): void {
  const list: Effector[] = [];
  for (const e of sim.effectors) if (e.type === 'nebula') list.push(e);
  if (list.length < 2) return;
  const removed = new Set<Effector>();
  for (let i = 0; i < list.length; i++) {
    if (removed.has(list[i])) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (removed.has(list[j])) continue;
      const a = list[i], b = list[j];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > (a.radius + b.radius) * 0.7) continue;
      const ma = a.strength, mb = b.strength;
      const total = ma + mb;
      const keeper = ma >= mb ? a : b;
      const other = ma >= mb ? b : a;
      keeper.x = (a.x * ma + b.x * mb) / total;
      keeper.y = (a.y * ma + b.y * mb) / total;
      keeper.z = (a.z * ma + b.z * mb) / total;
      keeper.vx = (a.vx * ma + b.vx * mb) / total;
      keeper.vy = (a.vy * ma + b.vy * mb) / total;
      keeper.vz = (a.vz * ma + b.vz * mb) / total;
      keeper.strength = total;
      keeper.radius = Math.min(sim.nebulaRadiusCap, Math.sqrt(total) * sim.nebulaRadiusCoeff);
      removed.add(other);
    }
  }
  if (removed.size === 0) return;
  for (let k = sim.effectors.length - 1; k >= 0; k--) {
    if (removed.has(sim.effectors[k])) {
      sim.effectors.splice(k, 1);
    }
  }
}
