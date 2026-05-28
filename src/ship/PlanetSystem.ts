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
  /** Orbit semi-major axis, in *world units* relative to the host star.
   * For an eccentric orbit, this is the average of perihelion and aphelion. */
  orbitRadius: number;
  /** Orbital period in seconds of ship proper time (visual ornament). */
  periodSec: number;
  /** Phase offset at t = 0, radians — the *mean anomaly* baseline so two
   * planets seeded with the same phase0 start at the same orbital phase
   * regardless of eccentricity. */
  phase0: number;
  /** Orbit plane tilt from host's local up, radians. */
  inclination: number;
  /** Orbital eccentricity. 0 = circle, →1 = very elongated. Capped at ~0.6
   * here so the visual ellipse stays readable and doesn't graze the star. */
  eccentricity: number;
  /** Argument of periapsis, radians. Rotates the ellipse within its own
   * orbital plane so periapsis isn't always on +X — keeps multi-planet
   * systems from looking like everyone shares the same major axis. */
  argPeriapsis: number;
  /** Rendered sphere radius in world units. */
  visualRadius: number;
  /** RGB in [0,1]. */
  color: [number, number, number];
  /** Self-rotation period in ship-time seconds (visual only). Negative
   * values mean retrograde spin. For tidally-locked worlds, equals periodSec. */
  spinPeriodSec: number;
  /** Axial tilt in radians, applied to the planet's local Y axis. */
  axialTilt: number;
  /** Equatorial oblateness — fractional ratio (equatorial - polar) /
   * equatorial. Visualized as a flatten on the Y axis. Real Jupiter is ~0.065;
   * we exaggerate gas giants slightly so it reads at distance. */
  oblateness: number;
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

  // Inner edge sits well outside the star's visual extent. Stars in this
  // build draw at ~4× their physics radius (see Scene.ts scaleBoost), so the
  // innermost planet needs ≥6× to read as orbiting *around* the star instead
  // of clipping into the corona. Outer edge stays within reasonable visit
  // range — far planets at 30-60u are still findable.
  const innerR = eff.type === 'blackhole'
    ? eff.radius * 14
    : eff.type === 'star'
      ? eff.radius * (8 + rng() * 5.0)        // 8-13× eff.radius (~2-3× visual)
      : eff.radius * (4.5 + rng() * 3.0);     // neutron stars: tight
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

    // Eccentricity: most rocky/desert worlds stay nearly circular (Solar
    // System bias — Mercury at e=0.21 is the outlier). Gas giants and ice
    // worlds can be more eccentric, especially in the outer system where
    // secular perturbations stack up over Gyrs. We cap at ~0.55 so the
    // ellipse stays readable and the planet doesn't graze the host.
    let eccentricity: number;
    if (cls === 'lava') eccentricity = 0.0 + rng() * 0.08;            // hot Jupiters / Mercurys
    else if (cls === 'gas' || cls === 'ice') eccentricity = 0.02 + rng() * 0.30;
    else eccentricity = 0.0 + rng() * 0.18;
    // Occasional comet-like outlier (~6% chance) — visually striking.
    if (rng() < 0.06 && t > 0.4) eccentricity = Math.min(0.55, eccentricity + 0.25 + rng() * 0.2);
    const argPeriapsis = rng() * Math.PI * 2;

    // Visual-only rotation and tilt. Gas giants spin fast (10–25s), rocky
    // worlds slow (40–80s) — keeps Jupiter-feel vs Earth-feel. Close-in
    // rocky worlds get tidally locked (spin = orbital period) further down.
    const spinFast = cls === 'gas';
    let spinPeriodSec = spinFast ? 10 + rng() * 15 : 40 + rng() * 40;
    // ~15% of free-spinning planets are retrograde (Venus-like).
    if (rng() < 0.15) spinPeriodSec = -spinPeriodSec;
    const axialTilt = (rng() - 0.5) * 0.7;

    // Oblateness: gas giants visibly squashed, rocky worlds essentially
    // spherical. Ice giants moderate. Real Jupiter ≈ 0.065, Saturn ≈ 0.098;
    // we exaggerate to ~0.10–0.15 so it reads at fly-by distance.
    let oblateness: number;
    if (cls === 'gas') oblateness = 0.08 + rng() * 0.07;
    else if (cls === 'ice') oblateness = 0.02 + rng() * 0.04;
    else oblateness = 0.0;

    const shaderSeed = rng();

    const planet: Planet = {
      index: i,
      name: `${planetName(eff, i)}`,
      planetClass: cls,
      orbitRadius: orbitR,
      periodSec,
      phase0,
      inclination,
      eccentricity,
      argPeriapsis,
      visualRadius,
      color,
      spinPeriodSec,
      axialTilt,
      oblateness,
      shaderSeed,
    };
    // Apply tidal locking AFTER construction so the helper sees the final
    // orbit radius / eccentricity. Locked planets always show the same face
    // to their host — a real, observable phenomenon for close-in rocky worlds.
    if (isTidallyLocked(planet, eff.radius)) {
      planet.spinPeriodSec = planet.periodSec; // synchronous rotation
      // Locked worlds have nearly zero obliquity (Sun keeps them aligned).
      planet.axialTilt *= 0.15;
    }
    planets.push(planet);
  }

  // Orbit-stability pass. After per-planet eccentricities are assigned, two
  // adjacent planets' ellipses can cross if apoapsis(inner) > periapsis(outer).
  // The Solar System never has crossings — Pluto-Neptune look like they do,
  // but the orbits are out of resonance so they never collide. We don't model
  // resonance, so we conservatively require the apoapsis-to-periapsis gap to
  // stay positive with a margin, and squeeze eccentricities (proportionally,
  // so we keep the qualitative "this one is more eccentric than that one"
  // ranking) until the system is non-crossing.
  planets.sort((a, b) => a.orbitRadius - b.orbitRadius);
  const margin = 1.04; // 4% safety so periapsis stays clearly outside apoapsis
  for (let i = 1; i < planets.length; i++) {
    const inner = planets[i - 1];
    const outer = planets[i];
    const apoIn = inner.orbitRadius * (1 + inner.eccentricity);
    const periOut = outer.orbitRadius * (1 - outer.eccentricity);
    if (apoIn * margin < periOut) continue; // already safe

    // Try shrinking both eccentricities by a common factor x ∈ [0, 1] so the
    // crossing just resolves. Algebra: a_in·(1+x·e_in)·margin = a_out·(1−x·e_out)
    //   ⇒ x · (margin·a_in·e_in + a_out·e_out) = a_out − margin·a_in
    const aIn = inner.orbitRadius;
    const aOut = outer.orbitRadius;
    const denom = margin * aIn * inner.eccentricity + aOut * outer.eccentricity;
    const numer = aOut - margin * aIn;
    if (numer > 0 && denom > 0) {
      const x = Math.max(0, Math.min(1, numer / denom));
      inner.eccentricity *= x;
      outer.eccentricity *= x;
    } else {
      // Hard case: even circles cross (the log-spacing jitter put two planets
      // at nearly the same a). Force both to circles and nudge the outer one
      // outward — small price for visual sanity. Subsequent iterations of the
      // outer loop will re-test against the next outer planet.
      inner.eccentricity = 0;
      outer.eccentricity = 0;
      const newR = Math.max(outer.orbitRadius, aIn * margin * 1.08);
      // Kepler's 3rd law: T ∝ a^1.5 — keep period consistent so the velocity
      // along the orbit reads correctly when we move the planet outward.
      outer.periodSec *= Math.pow(newR / outer.orbitRadius, 1.5);
      outer.orbitRadius = newR;
    }
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

/** Solve Kepler's equation E - e·sin(E) = M for the eccentric anomaly using
 *  Newton-Raphson. Five iterations are plenty for e < 0.7; we cap iterations
 *  defensively but break early on convergence so the hot path stays cheap. */
function eccentricAnomaly(M: number, e: number): number {
  // Normalize M to [-π, π] so the iteration starts close to the answer
  // and doesn't accumulate drift across many revolutions.
  M = ((M + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 6; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

/** Advance a planet along its Kepler ellipse to the given proper time, in
 *  world-space coordinates *relative to the host star* (i.e., the host sits
 *  at the origin of these coordinates). Writes into `out` to avoid allocs.
 *
 *  Uses the standard parametric form: with semi-major axis a, eccentricity e,
 *  eccentric anomaly E,
 *      x_plane =  a (cos E − e)
 *      y_plane =  a √(1−e²) sin E
 *  Rotates by argPeriapsis within the orbit plane, then tilts by inclination
 *  around the X axis (matching the existing convention where orbital plane is
 *  X-Z and the inclination tips the Z component into Y).
 */
export function planetPosition(p: Planet, time: number, out: [number, number, number]): void {
  const meanMotion = (Math.PI * 2) / p.periodSec;
  const M = p.phase0 + meanMotion * time;
  const e = p.eccentricity;
  const E = eccentricAnomaly(M, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const a = p.orbitRadius;
  const xPlane = a * (cosE - e);
  const yPlane = a * Math.sqrt(Math.max(0, 1 - e * e)) * sinE;

  const cosW = Math.cos(p.argPeriapsis);
  const sinW = Math.sin(p.argPeriapsis);
  // Rotate the ellipse within its own plane (X-Z plane of the host).
  const xRot = xPlane * cosW - yPlane * sinW;
  const zRot = xPlane * sinW + yPlane * cosW;

  const sinI = Math.sin(p.inclination);
  const cosI = Math.cos(p.inclination);
  out[0] = xRot;
  out[1] = zRot * sinI;
  out[2] = zRot * cosI;
}

/** True/false: does this planet's periapsis sit close enough to the host that
 *  tidal locking is the realistic outcome? Used by the generator to set the
 *  spin period equal to the orbital period for inner rocky worlds. */
export function isTidallyLocked(p: Planet, hostRadius: number): boolean {
  // Locking radius scales with the host's gravitational reach. Real Earth
  // sits outside the Sun's locking radius; Mercury is locked in a 3:2 spin
  // resonance — close but not quite synchronous. We treat ≤ ~12 host-radii
  // for rocky/desert/lava worlds as a hard lock and let everything else
  // spin freely. Gas giants never lock at the visual radii we use here.
  if (p.planetClass === 'gas' || p.planetClass === 'ice') return false;
  const perihelion = p.orbitRadius * (1 - p.eccentricity);
  return perihelion < hostRadius * 12;
}
