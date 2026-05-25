import { Effector } from '../physics/Simulator';

// Deterministic procedural planet generation. The same star always yields
// the same planets — the dex relies on this for re-visits, and the LRU can
// safely evict & regenerate without surprising the player.
//
// All values are derived from the seed: orbit radius, period, color, size,
// composition class. There is no Kepler dynamics in the simulator — these
// orbits are purely visual ornament, advanced from `shipProperTime` so they
// stay smooth at any cosmic time scale.

export type PlanetClass = 'rock' | 'desert' | 'ocean' | 'ice' | 'gas' | 'lava';

export interface Planet {
  /** Stable within a star system. Forms part of dex key (starId, index). */
  index: number;
  name: string;
  planetClass: PlanetClass;
  /** Orbit semi-major axis, in *world units* relative to the host star. */
  orbitRadius: number;
  /** Orbital period in seconds of ship proper time (visual ornament). */
  periodSec: number;
  /** Phase offset at t = 0, radians. */
  phase0: number;
  /** Orbit plane tilt from host's local up, radians. */
  inclination: number;
  /** Rendered sphere radius in world units. */
  visualRadius: number;
  /** RGB in [0,1]. */
  color: [number, number, number];
  /** Self-rotation period in ship-time seconds (visual only). */
  spinPeriodSec: number;
  /** Axial tilt in radians, applied to the planet's local Y axis. */
  axialTilt: number;
  /** Per-planet seed (decimal noise of mulberry32 output) used by the
   * fragment shader to decorrelate surface patterns between planets of
   * the same class. Stable for the planet's lifetime. */
  shaderSeed: number;
}

export interface PlanetSystem {
  starId: number;
  starName: string;
  planets: Planet[];
}

// ---- PRNG (mulberry32) ----
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(a: number, b: number): number {
  // Cheap deterministic 32-bit mix of two ints. Good enough — we're not
  // doing crypto, just want decorrelation between (id, mass) pairs.
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---- planet class → color/size hints ----
// Radii are in world units; we deliberately keep them under the typical star
// radius (~1.6 u) so stars still look stellar, but large enough that a close
// fly-by fills a meaningful chunk of FOV. Rocky ≈ 0.4–1.0, gas ≈ 0.9–1.6.
function classProperties(cls: PlanetClass, rng: () => number): { color: [number, number, number]; visualRadius: number } {
  switch (cls) {
    case 'lava':   return { color: [0.95 + rng() * 0.05, 0.30 + rng() * 0.15, 0.15 + rng() * 0.10], visualRadius: 0.45 + rng() * 0.40 };
    case 'rock':   return { color: [0.55 + rng() * 0.20, 0.45 + rng() * 0.15, 0.35 + rng() * 0.10], visualRadius: 0.40 + rng() * 0.45 };
    case 'desert': return { color: [0.85 + rng() * 0.10, 0.65 + rng() * 0.15, 0.35 + rng() * 0.15], visualRadius: 0.50 + rng() * 0.50 };
    case 'ocean':  return { color: [0.30 + rng() * 0.20, 0.55 + rng() * 0.20, 0.85 + rng() * 0.10], visualRadius: 0.55 + rng() * 0.50 };
    case 'ice':    return { color: [0.78 + rng() * 0.10, 0.88 + rng() * 0.08, 0.98],                visualRadius: 0.50 + rng() * 0.50 };
    case 'gas':    return { color: [0.70 + rng() * 0.20, 0.60 + rng() * 0.20, 0.45 + rng() * 0.20], visualRadius: 0.90 + rng() * 0.70 };
  }
}

/**
 * Generate the planet system for an effector. Deterministic on
 * `effector.id` alone — the mass/metallicity hints are derived from the
 * effector but only influence count and class distribution, not the seed.
 *
 * Only stars (and, as a bit of fun, neutron stars / BHs with sparse "graveyard"
 * systems) are eligible. Returns null for non-eligible types.
 */
export function generatePlanetSystem(eff: Effector): PlanetSystem | null {
  if (eff.type !== 'star' && eff.type !== 'neutron_star' && eff.type !== 'blackhole') return null;

  // Mass-tier influences count + class probabilities. Lower mass = fewer,
  // smaller orbits; higher mass = more, with more gas giants on the outside.
  const mass = eff.strength;
  const seed = hashSeed(eff.id, Math.round(mass * 100));
  const rng = mulberry32(seed);

  let count: number;
  if (eff.type === 'blackhole') count = 1 + Math.floor(rng() * 3); // ruins
  else if (eff.type === 'neutron_star') count = 2 + Math.floor(rng() * 3);
  else if (mass < 15) count = 2 + Math.floor(rng() * 3);
  else if (mass < 40) count = 4 + Math.floor(rng() * 4);
  else                count = 5 + Math.floor(rng() * 5);

  // Inner edge sits well outside the star (the largest gas giants are ~1.5u
  // so we need ~2× that clearance from the star's surface). Outer edge stays
  // within reasonable visit range — far planets at 30-60u are still findable.
  const innerR = eff.type === 'blackhole'
    ? eff.radius * 14
    : eff.radius * (4.5 + rng() * 3.0);
  const outerR = innerR * (3 + rng() * 3);

  const planets: Planet[] = [];
  // Use log-uniform spacing so inner-system planets aren't all clumped.
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const jitter = (rng() - 0.5) * 0.18;
    const logR = Math.log(innerR) + (Math.log(outerR) - Math.log(innerR)) * (t + jitter);
    const orbitR = Math.exp(logR);

    // Class probabilities by orbit position (inner = rocky/desert/lava, outer = gas/ice).
    let cls: PlanetClass;
    const r = rng();
    if (eff.type === 'blackhole') {
      cls = r < 0.7 ? 'rock' : 'ice'; // burnt rubble + frozen captures
    } else if (t < 0.2) {
      cls = r < 0.5 ? 'lava' : r < 0.85 ? 'rock' : 'desert';
    } else if (t < 0.5) {
      cls = r < 0.35 ? 'desert' : r < 0.65 ? 'rock' : r < 0.85 ? 'ocean' : 'gas';
    } else {
      cls = r < 0.5 ? 'gas' : r < 0.85 ? 'ice' : 'rock';
    }

    const { color, visualRadius } = classProperties(cls, rng);

    // Kepler-ish period for visual flavor: T ∝ a^1.5. Anchor inner planet
    // to ~30s (real-time) so even closest planet doesn't blur into a streak.
    const innerPeriod = 24 + rng() * 16;
    const periodSec = innerPeriod * Math.pow(orbitR / innerR, 1.5);

    const phase0 = rng() * Math.PI * 2;
    const inclination = (rng() - 0.5) * 0.12;

    // Visual-only rotation and tilt. Gas giants spin fast (10–25s), rocky
    // worlds slow (40–80s) — keeps Jupiter-feel vs Earth-feel.
    const spinFast = cls === 'gas';
    const spinPeriodSec = spinFast ? 10 + rng() * 15 : 40 + rng() * 40;
    const axialTilt = (rng() - 0.5) * 0.7;
    const shaderSeed = rng();

    planets.push({
      index: i,
      name: `${planetName(eff, i)}`,
      planetClass: cls,
      orbitRadius: orbitR,
      periodSec,
      phase0,
      inclination,
      visualRadius,
      color,
      spinPeriodSec,
      axialTilt,
      shaderSeed,
    });
  }

  return {
    starId: eff.id,
    starName: eff.name ?? `${eff.type}-${eff.id}`,
    planets,
  };
}

function planetName(eff: Effector, idx: number): string {
  // Greek letter suffix per planet — feels Kepler-ish without colliding
  // with the star's own name.
  const greek = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ'];
  const stem = (eff.name ?? `K-${eff.id}`).replace(/^[★●⚪☁]\s*/, '');
  return `${stem} ${greek[idx % greek.length]}`;
}

export function planetClassLabel(cls: PlanetClass): string {
  switch (cls) {
    case 'lava':   return '용암형';
    case 'rock':   return '암석형';
    case 'desert': return '사막형';
    case 'ocean':  return '해양형';
    case 'ice':    return '얼음형';
    case 'gas':    return '가스 거대';
  }
}
