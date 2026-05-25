import { PlanetClass, PlanetSystem } from './PlanetSystem';

// Visitor log ("도감") for stars and their procedurally-generated planets.
//
// Memory: every star ever visited and every planet ever generated for that
// star stays in memory permanently — the metadata is small (handful of
// numbers per planet) and the player likely cares about *all* their
// discoveries, not just the recent N. The LRU is a separate concern that
// caps GPU memory for orbits/planet meshes; the dex stays exhaustive.
//
// Disk: snapshotted to localStorage with a debounced writer so the player's
// log survives a refresh. Schema is versioned so we can migrate.

const STORAGE_KEY = 'cosmos:ship-dex:v1';
const SAVE_DEBOUNCE_MS = 600;

export interface DexStarEntry {
  starId: number;
  starName: string;
  starType: string;
  firstSeenCosmic: number;   // sim.simTime when first visited
  lastSeenCosmic: number;
  firstSeenWall: number;     // Date.now() of first visit
  visits: number;
  /** False once the host effector is removed from the sim (consumed / SN). */
  alive: boolean;
}

export interface DexPlanetEntry {
  starId: number;
  planetIndex: number;
  planetName: string;
  planetClass: PlanetClass;
  orbitRadius: number;
  visualRadius: number;
  color: [number, number, number];
  firstSeenCosmic: number;
  firstSeenWall: number;
}

interface DexSnapshot {
  v: 1;
  stars: DexStarEntry[];
  planets: DexPlanetEntry[];
}

export class Dex {
  private readonly stars = new Map<number, DexStarEntry>();
  /** Keyed by `${starId}:${planetIndex}` */
  private readonly planets = new Map<string, DexPlanetEntry>();
  private saveTimer: number | null = null;

  constructor() {
    this.load();
  }

  /** Idempotent: first call records first-seen, subsequent calls bump visits. */
  recordVisit(starId: number, starName: string, starType: string, cosmicTime: number): void {
    const existing = this.stars.get(starId);
    if (existing) {
      existing.lastSeenCosmic = cosmicTime;
      existing.visits += 1;
      existing.starName = starName; // refresh in case the sim renamed it
    } else {
      this.stars.set(starId, {
        starId, starName, starType,
        firstSeenCosmic: cosmicTime,
        lastSeenCosmic: cosmicTime,
        firstSeenWall: Date.now(),
        visits: 1,
        alive: true,
      });
    }
    this.scheduleSave();
  }

  /** Record (or refresh) every planet in a freshly-generated system. */
  recordPlanets(system: PlanetSystem, cosmicTime: number): void {
    for (const p of system.planets) {
      const key = `${system.starId}:${p.index}`;
      if (this.planets.has(key)) continue;
      this.planets.set(key, {
        starId: system.starId,
        planetIndex: p.index,
        planetName: p.name,
        planetClass: p.planetClass,
        orbitRadius: p.orbitRadius,
        visualRadius: p.visualRadius,
        color: p.color,
        firstSeenCosmic: cosmicTime,
        firstSeenWall: Date.now(),
      });
    }
    this.scheduleSave();
  }

  /** Marks a star as no longer present in the sim (SN, BH consumption, …). */
  markDead(starId: number): void {
    const e = this.stars.get(starId);
    if (!e || !e.alive) return;
    e.alive = false;
    this.scheduleSave();
  }

  starsArray(): DexStarEntry[] {
    return Array.from(this.stars.values());
  }

  planetsArray(): DexPlanetEntry[] {
    return Array.from(this.planets.values());
  }

  starCount(): number { return this.stars.size; }
  planetCount(): number { return this.planets.size; }

  clear(): void {
    this.stars.clear();
    this.planets.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  // ---- persistence ----

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    const snap: DexSnapshot = {
      v: 1,
      stars: Array.from(this.stars.values()),
      planets: Array.from(this.planets.values()),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // Quota exceeded or storage disabled — silently skip. The in-memory
      // dex stays intact for the session.
    }
  }

  private load(): void {
    let raw: string | null = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return; }
    if (!raw) return;
    let snap: DexSnapshot;
    try { snap = JSON.parse(raw); } catch { return; }
    if (!snap || snap.v !== 1) return;
    for (const s of snap.stars ?? []) this.stars.set(s.starId, s);
    for (const p of snap.planets ?? []) {
      this.planets.set(`${p.starId}:${p.planetIndex}`, p);
    }
  }
}
