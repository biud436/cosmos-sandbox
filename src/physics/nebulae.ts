// Nebula compact-object logic split out of Simulator.ts. Functions operate on
// a Simulator instance via its public/internal fields. Same-folder
// "modules-as-friends" pattern — these are not intended to be called from
// outside src/physics/.
import type { Effector, Simulator } from './Simulator';
import { spawnStarFromCluster } from './starFormation';
import { SPECIES } from './types';

// R = coeff · M^exp, clamped. Sub-linear power keeps small nebulae compact
// but lets a 200+ mass cloud genuinely puff out to ~40 units.
function nebulaRadiusFor(mass: number, sim: Simulator): number {
  const raw = sim.nebulaRadiusCoeff * Math.pow(Math.max(mass, 0), sim.nebulaRadiusExp);
  return Math.max(5.0, Math.min(sim.nebulaRadiusCap, raw));
}

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

    // Scan slightly beyond the current radius — this lets a nebula accrete
    // gas drifting at its boundary, which is the key to runaway growth into
    // a GMC. Without this, mass plateaus at whatever was in the initial
    // detection ball.
    const scanR = e.radius * sim.nebulaScanExpansion;
    const R2 = scanR * scanR;

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

    // Faster centroid tracking — fast-moving gas streams won't leave the
    // nebula behind. Velocity is recorded for diagnostics but motion is
    // entirely driven by gas COM.
    const alpha = 0.4;
    e.x = e.x * (1 - alpha) + cx * alpha;
    e.y = e.y * (1 - alpha) + cy * alpha;
    e.z = e.z * (1 - alpha) + cz * alpha;
    e.vx = vx;
    e.vy = vy;
    e.vz = vz;
    e.strength = totM;
    e.radius = nebulaRadiusFor(totM, sim);

    // Cradle pass: a mature nebula occasionally births a child star from its
    // internal gas. This runs independently of the global continuous-SF flag
    // so a nebula keeps producing stars even when the player has SF off
    // globally. The star inherits the gas cluster's COM velocity (so it stays
    // mostly co-moving with the cradle) plus a small tangential kick (so it
    // orbits the cradle's center rather than drifting straight through).
    if (totM >= sim.nebulaMaturityMass) {
      tryNebulaNursery(sim, e);
    }
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

// Per-nebula nursery cooldown. Keyed by eff.id so the bookkeeping survives
// individual nebula merges (the keeper inherits the lower of the two times,
// which is fine — it just gets to spawn slightly sooner).
const nurseryNextAt = new Map<number, number>();

// Cradle birth: pick a dense pocket of gas particles inside the nebula,
// promote them to a star, give the star a small tangential kick about the
// nebula's center so it orbits the cradle rather than drifting through.
// Runs at most every `sim.nebulaNurseryCooldown` seconds per nebula and only
// when the nebula has surplus gas to spare (so we don't dissolve it).
function tryNebulaNursery(sim: Simulator, neb: Effector): void {
  const next = nurseryNextAt.get(neb.id) ?? 0;
  if (sim.simTime < next) return;

  // Hold back the cooldown to a per-nebula stochastic interval (1.5-3.5×
  // the base) so neighboring cradles don't fire in lockstep.
  const base = sim.nebulaNurseryCooldown;
  nurseryNextAt.set(neb.id, sim.simTime + base * (1.5 + Math.random() * 2.0));

  // Refuse if removing a cluster's worth of mass would drop the nebula
  // below the dissolve threshold (we want the cradle to keep birthing for
  // a long time, not die after one star).
  const groupSize = Math.max(3, Math.min(8, sim.starFormationCount));
  if (neb.strength < sim.nebulaDissolveMassMin + groupSize * 1.2) return;

  // Find candidate gas particles inside the nebula (excluding DM).
  const dmId = sim.dmSpeciesId;
  const R = neb.radius;
  const R2 = R * R;
  const candidates: number[] = [];
  for (let i = 0; i < sim.count; i++) {
    const si = sim.species[i];
    if (si === dmId) continue;
    const dx = sim.positions[i * 3 + 0] - neb.x;
    const dy = sim.positions[i * 3 + 1] - neb.y;
    const dz = sim.positions[i * 3 + 2] - neb.z;
    if (dx * dx + dy * dy + dz * dz < R2) candidates.push(i);
  }
  if (candidates.length < groupSize) return;

  // Pick the densest pocket: seed at a random candidate, take the closest
  // groupSize-1 peers. Random seed (instead of densest seed) so successive
  // nursery births don't all spawn at the same hot spot.
  const seed = candidates[(Math.random() * candidates.length) | 0];
  const sx = sim.positions[seed * 3 + 0];
  const sy = sim.positions[seed * 3 + 1];
  const sz = sim.positions[seed * 3 + 2];
  const dists: { idx: number; d2: number }[] = [];
  for (const j of candidates) {
    if (j === seed) continue;
    const dx = sim.positions[j * 3 + 0] - sx;
    const dy = sim.positions[j * 3 + 1] - sy;
    const dz = sim.positions[j * 3 + 2] - sz;
    dists.push({ idx: j, d2: dx * dx + dy * dy + dz * dz });
  }
  dists.sort((a, b) => a.d2 - b.d2);
  const members = [seed];
  for (let k = 0; k < groupSize - 1 && k < dists.length; k++) members.push(dists[k].idx);
  if (members.length < groupSize) return;

  const star = spawnStarFromCluster(sim, members);
  if (!star) return;

  // Tangential kick: take the vector from nebula center to the star, pick a
  // perpendicular direction (favoring whatever the cluster's residual
  // velocity already projects onto), give the star a sub-light orbital
  // boost. This makes the child genuinely orbit instead of just being
  // co-moving with the cradle.
  const rx = star.x - neb.x;
  const ry = star.y - neb.y;
  const rz = star.z - neb.z;
  const rMag = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rMag > 1e-3) {
    // Build an orthogonal frame: pick any vector not parallel to r, cross.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ry / rMag) > 0.9) { ux = 1; uy = 0; uz = 0; }
    // tangent = r × u (perpendicular to r), then normalize
    const tx = ry * uz - rz * uy;
    const ty = rz * ux - rx * uz;
    const tz = rx * uy - ry * ux;
    const tMag = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tMag > 1e-3) {
      // Circular-orbit speed scaled to actual gravity at this radius:
      //   v² ≈ G·M_neb / r  →  v = sqrt(G·M/r)
      const vCirc = Math.sqrt(Math.max(0, sim.effectorPairG * neb.strength / rMag));
      const k = vCirc / tMag;
      // Random sign so cradles produce a mix of prograde/retrograde children
      const sign = Math.random() < 0.5 ? -1 : 1;
      star.vx += tx * k * sign;
      star.vy += ty * k * sign;
      star.vz += tz * k * sign;
    }
  }

  // Descending order so indices stay valid as we swap-remove from the back.
  members.sort((a, b) => b - a);
  for (const idx of members) if (idx < sim.count) sim.removeParticle(idx);
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

      // Generous merge: trigger when either nebula's edge reaches the other's
      // center (mergeFactor=1.0). Previously required deep overlap, which
      // meant nebulae floated past each other without coalescing.
      if (d > (a.radius + b.radius) * sim.nebulaMergeFactor) continue;

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
      keeper.radius = nebulaRadiusFor(total, sim);

      removed.add(other);
      sim.evNebulaMerger++;
    }
  }

  if (removed.size === 0) return;
  for (let k = sim.effectors.length - 1; k >= 0; k--) {
    if (removed.has(sim.effectors[k])) {
      sim.effectors.splice(k, 1);
    }
  }
}
