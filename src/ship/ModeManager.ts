// Decides how wall-clock time is split between the physics simulator and
// the spaceship controller each frame. Two clocks are conceptually distinct:
//
//   cosmicTime    — advanced by sim.step(); the age of the simulated universe
//   shipProperTime — wall-clock, used to integrate the ship's motion
//
// In 'sim' mode they're essentially the same (cosmic time scaled by the user's
// time slider). In 'ship' mode the cosmic clock slows down as the pilot
// throttles up, so flying fast doesn't make you watch the universe race
// past — handwave for what would otherwise be impossibly long journeys.
//
// 'warp' mode (Phase 4) freezes cosmic time entirely.
//
// 'planet' mode is the photoreal close-up: a single real body (Earth/Mars)
// rendered from texture maps in an isolated lab scene. Cosmic time is frozen
// just like ship/warp — the particle universe pauses while you observe.

export type SimMode = 'sim' | 'ship' | 'warp' | 'planet';

export interface ModeTick {
  /** How many sim.step() calls to make this frame. */
  simSteps: number;
  /** dt to pass to each sim.step() call. */
  simDt: number;
  /** dt to use when integrating ship motion / HUD animations. */
  shipDt: number;
}

export interface ModeManagerConfig {
  internalDt: number;
  baseSubstepsPerFrame: number;
}

export class ModeManager {
  mode: SimMode = 'sim';
  paused = false;
  timeScale = 1;
  /** 0..1, read by tick() to slow cosmic time while the ship is moving. */
  shipThrottle = 0;

  private readonly internalDt: number;
  private readonly baseSubstepsPerFrame: number;

  constructor(cfg: ModeManagerConfig) {
    this.internalDt = cfg.internalDt;
    this.baseSubstepsPerFrame = cfg.baseSubstepsPerFrame;
  }

  tick(wallDt: number): ModeTick {
    const shipDt = wallDt;
    // Ship mode anchors *ship time* as the master clock. Cosmic time is
    // frozen so the player doesn't watch the universe age past millions of
    // years (and trigger runaway Hubble expansion) during what is, from
    // the cockpit, a few real seconds of flight. Switch back to sim mode
    // to advance the universe. Warp also freezes cosmic time.
    if (this.mode === 'ship' || this.mode === 'warp' || this.mode === 'planet') {
      return { simSteps: 0, simDt: this.internalDt, shipDt };
    }
    if (this.paused || this.timeScale <= 0) {
      return { simSteps: 0, simDt: this.internalDt, shipDt };
    }

    const desired = this.baseSubstepsPerFrame * this.timeScale;
    const simSteps = Math.max(0, Math.round(desired));
    return { simSteps, simDt: this.internalDt, shipDt };
  }
}
