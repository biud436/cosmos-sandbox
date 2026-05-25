import * as THREE from 'three';

// Conceptual lightspeed in sim units / second. The simulation has no honest
// scale — but giving the ship a "c" reference makes the HUD's "0.42 c"
// readout meaningful and forces sub-light cruise to feel like you're
// actually moving through interstellar distances (and motivates warp for
// crossing them in a session). Light crosses BOX_HALF (150 units) in 2.5s.
export const LIGHTSPEED_UNITS = 60;

// Propulsion modes. The ship has multiple thruster regimes so the player
// can pick a speed that matches the task — fine maneuvering around a
// planet, casual interplanetary cruise, hard interstellar traversal, or
// FTL "warp" (the fictional one). Each mode caps maxSpeed differently;
// Shift "boost" multiplies the cap ×2 inside whichever mode is active.
//
// Speeds are anchored to LIGHTSPEED_UNITS, displayed only as a c-fraction:
//   approach: 0.5 u/s    ≈ 0.008c   (orbital docking pace)
//   cruise:   12 u/s     = 0.20c    (interplanetary cruise)
//   high:     60 u/s     = 1.00c    (interstellar relativistic)
//   warp:     600 u/s    = 10c      (fictional spacetime-compression drive)
export type PropulsionMode = 'approach' | 'cruise' | 'high' | 'warp';

export interface PropulsionModeSpec {
  id: PropulsionMode;
  label: string;          // short HUD tag (Korean)
  description: string;    // one-line hint shown on mode switch
  maxSpeed: number;       // u/s at boost = 1
}

export const PROPULSION_SPECS: Record<PropulsionMode, PropulsionModeSpec> = {
  approach: { id: 'approach', label: '근접', description: '근접 기동 · 0.008c · 행성 도킹용',                       maxSpeed: 0.5 },
  cruise:   { id: 'cruise',   label: '순항', description: '순항 · 0.2c · 행성 간 이동',                              maxSpeed: 0.2 * LIGHTSPEED_UNITS },
  high:     { id: 'high',     label: '고속', description: '고속 항해 · 1c · 항성 간 이동',                            maxSpeed: LIGHTSPEED_UNITS },
  warp:     { id: 'warp',     label: '워프', description: '워프 · 10c · 시공간 압축 · 은하 횡단용 (가상 추진)',     maxSpeed: 10 * LIGHTSPEED_UNITS },
};

export const PROPULSION_ORDER: PropulsionMode[] = ['approach', 'cruise', 'high', 'warp'];

// 6-DOF spaceship controller. Borrows a Three.js PerspectiveCamera while
// active and drives it directly via quaternion.
//
// Two flight models:
//   - Flight Assist ON  (default): when no thrust key is held the ship
//     gradually bleeds velocity — physically dishonest for hard vacuum
//     but the only way the controls feel responsive without constant
//     counter-thrust micromanagement.
//   - Flight Assist OFF: pure Newtonian — releasing keys does nothing,
//     X (brake) is the only way to stop.
//
// Controls (active only while .enabled):
//   Mouse look (with Pointer Lock)    yaw + pitch
//   Q / E                              roll left / right
//   W / S                              forward / reverse thrust
//   A / D                              strafe left / right
//   R / F                              strafe up / down
//   Shift                              boost (×4 while held)
//   X                                  hard brake (kills velocity)
//   Space                              toggle Flight Assist

export interface ShipControllerOptions {
  /** Camera the controller drives while enabled. */
  camera: THREE.PerspectiveCamera;
  /** Element to attach pointer-lock + key events to. */
  domElement: HTMLElement;
  /** Soft cap on cruise speed in world units / second at throttle = 1. */
  maxSpeed?: number;
  /** Initial position (defaults to camera's current position). */
  initialPosition?: THREE.Vector3;
}

export interface ShipState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Forward unit vector in world space. */
  forward: THREE.Vector3;
  /** 0..1, instantaneous magnitude of forward throttle input (W key). */
  throttleInput: number;
  /** 0..1, normalized |velocity| / maxSpeed (for HUD bars and ModeManager). */
  throttleNormalized: number;
  /** Magnitude of velocity, units/sec. */
  speed: number;
  /** speed / LIGHTSPEED_UNITS — the "x c" readout on the HUD. */
  speedC: number;
  boosting: boolean;
  /** Currently-active propulsion regime. */
  propulsionMode: PropulsionMode;
  /** Whether the player has 실사 (realistic) mode active. */
  realisticMode: boolean;
  /** 0..1 — warp gauge level (only relevant in 실사 mode). */
  warpCharge: number;
  /** True while a warp burst is firing (consuming charge). */
  warpBursting: boolean;
}

// 실사 (realistic) mode. A toggle layered ON TOP of the propulsion-mode
// cycle: when ON the ship always cruises at approach speed (no infinite
// thrust), but holding Shift fires a brief warp burst — gated by a finite
// charge gauge that refills slowly. Models the "spaceship with an actual
// energy budget" feel the user asked for: no perpetual c-fraction cruise,
// no instant-glide to far targets via G.
export const REALISTIC_BASE_SPEED = 0.5;        // u/s, same as approach mode
export const REALISTIC_BURST_SPEED = 600;       // u/s, same as warp mode
export const REALISTIC_CHARGE_FULL_SECONDS = 10; // how long to fully recharge
export const REALISTIC_BURST_BUDGET_SECONDS = 1; // how long full charge lasts
// → recharge rate = 1 / 10 (charge per second), drain rate = 1 / 1 = 1/s.

export class ShipController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  /** Caller-provided override; `null` means use the current propulsion mode. */
  private readonly maxSpeedOverride: number | null;
  /** Active propulsion mode. Defaults to cruise (the historic single regime). */
  private propulsionMode: PropulsionMode = 'cruise';

  private _enabled = false;
  private pointerLocked = false;
  flightAssist = true;
  /** Time constant for FA decay: smaller = snappier stop. */
  private faDecayK = 1.8;
  /** Per-toggle callback so the HUD can flash a hint. */
  onFlightAssistToggle: ((on: boolean) => void) | null = null;
  /** Fired when the propulsion mode changes — HUD flashes a label. */
  onPropulsionChange: ((spec: PropulsionModeSpec) => void) | null = null;
  /** Fired when 실사 mode toggles — HUD flashes "전환/해제" hint. */
  onRealisticToggle: ((on: boolean) => void) | null = null;

  // 실사 mode state. `realistic` is the toggle; `warpCharge` is the gauge
  // (0..1); `warpBursting` is true while the burst is actively firing.
  private realistic = false;
  private warpCharge = 1.0;
  private warpBursting = false;

  // Ship state. The camera position/orientation mirrors these every frame.
  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();

  // Per-tick input accumulators
  private readonly keys = new Set<string>();
  private yawDelta = 0;   // radians to apply this frame
  private pitchDelta = 0;

  // Scratch
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();

  // Optional auto-pilot target (set by glideTo). When non-null, the controller
  // steers/translates toward it each tick and clears it on arrival or on any
  // manual input. This is how dex-entry "→ 이동" buttons work.
  private autoTarget: THREE.Vector3 | null = null;
  private autoStandoff = 0;
  private autoLabel = '';

  // Circular orbit around a moving target. `target` is a getter so the ship
  // can track planets that are themselves orbiting their host star. The orbit
  // plane (basisU, basisV) is locked at engagement and stays absolute, so
  // the ship orbits the planet as the planet orbits the star — composed motion.
  private orbit: {
    target: () => THREE.Vector3;
    radius: number;
    basisU: THREE.Vector3;
    basisV: THREE.Vector3;
    angle: number;
    angularSpeed: number;
    label: string;
    /** Cumulative free-look offsets relative to the look-at orientation. */
    lookYaw: number;
    lookPitch: number;
  } | null = null;

  /** True while the ship is in a forced circular orbit (set via enterOrbit). */
  get orbiting(): { label: string; radius: number } | null {
    return this.orbit ? { label: this.orbit.label, radius: this.orbit.radius } : null;
  }

  /** The current navigation focus (orbit center or autopilot target) and
   *  a human label for it. Returns null when the player has no active
   *  destination — the HUD uses this to decide whether to draw an
   *  off-screen direction arrow. */
  getNavTarget(): { position: THREE.Vector3; label: string } | null {
    if (this.orbit) return { position: this.orbit.target().clone(), label: this.orbit.label };
    if (this.autoTarget) return { position: this.autoTarget.clone(), label: this.autoLabel };
    return null;
  }

  // Listener refs (so we can detach)
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
  private readonly onPointerLockChange = () => this.handlePointerLockChange();
  private readonly onCanvasClick = () => this.requestPointerLock();

  constructor(opts: ShipControllerOptions) {
    this.camera = opts.camera;
    this.dom = opts.domElement;
    // If a caller pins maxSpeed via opts we honor it and disable mode-switching's
    // effect on the cap. Otherwise the cap comes from the active mode.
    this.maxSpeedOverride = opts.maxSpeed ?? null;
    const start = opts.initialPosition ?? this.camera.position;
    this.position.copy(start);
    this.orientation.copy(this.camera.quaternion);
  }

  /** Effective max speed for the active mode (boost not applied). */
  private get currentMaxSpeed(): number {
    return this.maxSpeedOverride ?? PROPULSION_SPECS[this.propulsionMode].maxSpeed;
  }

  /** Cycle to the next propulsion mode (Z key). Wraps around at the end. */
  cyclePropulsionMode(delta = 1): void {
    const i = PROPULSION_ORDER.indexOf(this.propulsionMode);
    const next = PROPULSION_ORDER[(i + delta + PROPULSION_ORDER.length) % PROPULSION_ORDER.length];
    this.setPropulsionMode(next);
  }

  setPropulsionMode(mode: PropulsionMode): void {
    if (this.propulsionMode === mode) return;
    this.propulsionMode = mode;
    // If the new cap is below current speed, ease velocity down instead of
    // a hard clamp — the cap loop in update() will keep tightening it.
    this.onPropulsionChange?.(PROPULSION_SPECS[mode]);
  }

  getPropulsionMode(): PropulsionMode {
    return this.propulsionMode;
  }

  getPropulsionSpec(): PropulsionModeSpec {
    return PROPULSION_SPECS[this.propulsionMode];
  }

  /** Toggle 실사 (realistic) mode. While active, the ship is capped at
   *  approach speed and Shift fires a gated warp burst from the charge
   *  gauge. The 4-step propulsion cycle (Z) is still available but its
   *  speed cap is overridden while realistic is on. */
  toggleRealisticMode(): void {
    this.setRealisticMode(!this.realistic);
  }

  setRealisticMode(on: boolean): void {
    if (this.realistic === on) return;
    this.realistic = on;
    if (on) {
      // Reset gauge to full so the first burst is immediately available
      // (otherwise enabling the mode mid-flight would feel slow).
      this.warpCharge = 1.0;
      this.warpBursting = false;
    }
    this.onRealisticToggle?.(on);
  }

  isRealistic(): boolean { return this.realistic; }
  getWarpCharge(): number { return this.warpCharge; }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Borrow the camera. Snaps camera pose to current ship pose. */
  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this.position.copy(this.camera.position);
    this.orientation.copy(this.camera.quaternion);
    this.velocity.set(0, 0, 0);
    this.keys.clear();
    this.yawDelta = 0;
    this.pitchDelta = 0;

    // Capture phase so we can stopImmediatePropagation on hijacked keys
    // (Space etc.) before Layout's window-level shortcut handler sees them.
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.dom.addEventListener('click', this.onCanvasClick);
    this.requestPointerLock();
  }

  /** Release the camera; sim mode (OrbitControls) takes over. */
  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.dom.removeEventListener('click', this.onCanvasClick);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
    this.pointerLocked = false;
    this.keys.clear();
  }

  /**
   * Engage auto-pilot toward `target`, stopping `standoff` units away
   * (so the player ends up facing the target from outside, not buried in it).
   * Any manual input cancels it.
   */
  glideTo(target: THREE.Vector3, standoff: number, label = '항법 목적지'): void {
    this.autoTarget = target.clone();
    this.autoStandoff = Math.max(0.01, standoff);
    this.autoLabel = label;
    this.orbit = null;
  }

  cancelGlide(): void {
    this.autoTarget = null;
  }

  /**
   * Lock the ship into a circular orbit around a target that may itself be
   * moving (planets revolve around stars). `getTarget` is invoked each
   * frame so the orbit follows.
   *
   * `minRadius` is the closest the orbit may sit (typically a small multiple
   * of the target's body radius). The actual orbit radius is the ship's
   * *current* distance from the target, clamped to [minRadius, minRadius*8].
   * This avoids the previous "teleport snap to fixed radius" behavior.
   *
   * The orbital tangent is taken from the ship's current velocity (projected
   * onto the orbit plane); if velocity is too small or radial, a default
   * world-up-aligned tangent is used. Manual thrust or X breaks the orbit.
   */
  enterOrbit(getTarget: () => THREE.Vector3, minRadius: number, label: string): void {
    this.autoTarget = null;
    const tgt = getTarget();
    let radial = this.position.clone().sub(tgt);
    const currentDist = radial.length();
    if (currentDist < 1e-3) {
      // Ship is essentially on top of the target — use a small offset along
      // its current forward axis so we don't divide by zero.
      radial = this.tmpForward.set(0, 0, -1).applyQuaternion(this.orientation).clone().multiplyScalar(-minRadius);
    }
    const orbitR = Math.min(Math.max(currentDist, minRadius), minRadius * 8);
    radial.normalize();

    // Tangent direction. The ship usually approaches *radially* (W toward
    // planet), so its velocity has almost no tangential component — using
    // the velocity-projection as the starting tangent then leaves an
    // arbitrary residual whose sign feels random. Use the ship's local
    // right axis instead: orbit always begins by curving across the
    // viewport, which reads consistently no matter how the player came in.
    // Fall back to local up (then world axes) if right ≈ radial.
    let tangential = new THREE.Vector3();
    const localRight = this.tmpRight.set(1, 0, 0).applyQuaternion(this.orientation).clone();
    tangential.copy(localRight).addScaledVector(radial, -localRight.dot(radial));
    if (tangential.lengthSq() < 0.01) {
      const localUp = this.tmpUp.set(0, 1, 0).applyQuaternion(this.orientation).clone();
      tangential.copy(localUp).addScaledVector(radial, -localUp.dot(radial));
    }
    if (tangential.lengthSq() < 0.01) {
      // Pathological — radial happens to align with both ship axes. Use a
      // world-up cross as a last resort.
      let normal = new THREE.Vector3(0, 1, 0).cross(radial);
      if (normal.lengthSq() < 0.05) normal = new THREE.Vector3(0, 0, 1).cross(radial);
      normal.normalize();
      tangential.crossVectors(normal, radial);
    }
    tangential.normalize();

    // Angular speed: scenic. Kepler-ish T ∝ r^0.7 with [45, 120]-second
    // bounds so a tight orbit completes in under a minute and a wide one
    // doesn't drag past two minutes. Previously the orbit ran at a fixed
    // 8 u/s tangential, which at small radii spun the ship around in 3-4
    // seconds — comically fast.
    const orbitPeriod = Math.min(120, Math.max(45, 30 * Math.pow(orbitR, 0.7)));
    const angularSpeed = (Math.PI * 2) / orbitPeriod;

    this.orbit = {
      target: getTarget,
      radius: orbitR,
      basisU: radial,
      basisV: tangential,
      angle: 0,
      angularSpeed,
      label,
      lookYaw: 0,
      lookPitch: 0,
    };
    this.velocity.set(0, 0, 0);
  }

  exitOrbit(): void {
    this.orbit = null;
  }

  /** Advance the ship one frame. Caller passes wall-clock dt. */
  update(dt: number): void {
    if (!this._enabled || dt <= 0) return;

    // Orbit mode bypasses normal translation/auto-pilot: the position is
    // analytically set every frame from the parametric circle. Any thrust
    // input or hard-brake exits orbit and hands control back to the player.
    if (this.orbit) {
      const userInput = this.keys.has('w') || this.keys.has('s') || this.keys.has('a') || this.keys.has('d')
        || this.keys.has('r') || this.keys.has('f') || this.keys.has('x');
      if (userInput) {
        this.orbit = null;
      } else {
        this.orbit.angle += this.orbit.angularSpeed * dt;
        const tgt = this.orbit.target();
        const cosA = Math.cos(this.orbit.angle);
        const sinA = Math.sin(this.orbit.angle);
        this.position.set(
          tgt.x + (this.orbit.basisU.x * cosA + this.orbit.basisV.x * sinA) * this.orbit.radius,
          tgt.y + (this.orbit.basisU.y * cosA + this.orbit.basisV.y * sinA) * this.orbit.radius,
          tgt.z + (this.orbit.basisU.z * cosA + this.orbit.basisV.z * sinA) * this.orbit.radius,
        );
        // Free-look offsets accumulate so the player can pan around while
        // the autopilot maintains the inward-facing look-at as a baseline.
        // Pitch is clamped to avoid the camera going past the poles.
        this.orbit.lookYaw   += this.yawDelta;
        this.orbit.lookPitch = Math.max(-1.3, Math.min(1.3, this.orbit.lookPitch + this.pitchDelta));
        this.yawDelta = 0;
        this.pitchDelta = 0;

        // Base: look toward target with world-up; offset: persistent yaw/pitch.
        const lookM = new THREE.Matrix4().lookAt(this.position, tgt, new THREE.Vector3(0, 1, 0));
        this.orientation.setFromRotationMatrix(lookM);
        if (this.orbit.lookYaw !== 0) {
          this.tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.orbit.lookYaw);
          this.orientation.multiply(this.tmpQuat);
        }
        if (this.orbit.lookPitch !== 0) {
          this.tmpQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.orbit.lookPitch);
          this.orientation.multiply(this.tmpQuat);
        }
        this.orientation.normalize();
        this.velocity.set(0, 0, 0);
        this.camera.position.copy(this.position);
        this.camera.quaternion.copy(this.orientation);
        return;
      }
    }

    // 0. Auto-pilot: if active and the player hasn't given input, orient and
    //    accelerate toward the target with a distance-aware speed plan.
    if (this.autoTarget) {
      const userInput = this.keys.has('w') || this.keys.has('s') || this.keys.has('a') || this.keys.has('d')
        || this.keys.has('r') || this.keys.has('f')
        || this.keys.has('q') || this.keys.has('e')
        || this.keys.has('x');
      if (userInput) {
        this.autoTarget = null;
      } else {
        const toTarget = this.tmpForward.copy(this.autoTarget).sub(this.position);
        const dist = toTarget.length();
        if (dist <= this.autoStandoff * 1.05) {
          // Arrived — hard brake and disengage so the ship stops cleanly
          // rather than coasting through the standoff with residual velocity.
          this.velocity.set(0, 0, 0);
          this.autoTarget = null;
        } else {
          // Aim first: slerp orientation toward look-at. Faster slerp than
          // before so the ship's forward axis catches up with the
          // already-pointed velocity quickly.
          const lookM = new THREE.Matrix4().lookAt(this.position, this.autoTarget, new THREE.Vector3(0, 1, 0));
          const lookQ = new THREE.Quaternion().setFromRotationMatrix(lookM);
          this.orientation.slerp(lookQ, Math.min(1, dt * 5));

          // Speed plan: top speed scales with travel distance — short hops
          // shouldn't blow past at near-c. Brake zone is generous so we never
          // overshoot the standoff.
          //
          // travelRange spans from the moment we engaged autopilot to arrival;
          // we don't have that handy without storing initial dist, so use the
          // current dist as the scale instead — it's a conservative proxy
          // that gives close targets a sub-c cap.
          const travel = Math.max(0, dist - this.autoStandoff);
          // 실사 mode autopilot: drain the warp gauge to make a burst toward
          // the target, then coast at approach speed (≈ stand still) while
          // the gauge recharges, then burst again. The ship visibly "warps"
          // in short hops — far targets take many bursts, not an instant
          // glide. Outside 실사 we use the historic continuous cruise plan.
          let desiredSpeed: number;
          if (this.realistic) {
            if (this.warpCharge > 0.05) {
              // Burst: ride the gauge down. Mark warpBursting so HUD shows it.
              this.warpCharge = Math.max(0, this.warpCharge - dt / REALISTIC_BURST_BUDGET_SECONDS);
              this.warpBursting = true;
              desiredSpeed = REALISTIC_BURST_SPEED;
            } else {
              // Gauge empty: creep at approach speed while it recharges.
              this.warpCharge = Math.min(1, this.warpCharge + dt / REALISTIC_CHARGE_FULL_SECONDS);
              this.warpBursting = false;
              desiredSpeed = REALISTIC_BASE_SPEED;
            }
            // Brake well before the standoff so we don't overshoot at warp speed.
            const brakeZone = Math.max(this.autoStandoff * 8, 12);
            const ease = Math.min(1, travel / brakeZone);
            desiredSpeed *= ease;
          } else {
            const maxCruise = Math.min(0.6 * LIGHTSPEED_UNITS, 6 + travel * 1.2);
            const brakeZone = Math.max(this.autoStandoff * 6, maxCruise * 0.6);
            const ease = Math.min(1, travel / brakeZone);
            desiredSpeed = Math.max(1.5, maxCruise * ease);
          }
          const dir = toTarget.normalize();
          // Blend velocity toward the desired vector instead of hard-setting,
          // so the ship's apparent inertia stays believable.
          const blend = Math.min(1, dt * 4);
          this.velocity.x += (dir.x * desiredSpeed - this.velocity.x) * blend;
          this.velocity.y += (dir.y * desiredSpeed - this.velocity.y) * blend;
          this.velocity.z += (dir.z * desiredSpeed - this.velocity.z) * blend;
        }
      }
    }

    // 1. Rotation: apply accumulated mouse yaw/pitch + key-driven roll.
    //    Quaternion order: yaw (world up after roll) → pitch (local right)
    //    → roll (local forward). To avoid gimbal weirdness we apply each in
    //    the ship's local frame, then re-orthonormalize the quaternion.
    const rollSpeed = 1.4; // rad/s
    let roll = 0;
    if (this.keys.has('q')) roll += rollSpeed * dt;
    if (this.keys.has('e')) roll -= rollSpeed * dt;

    if (this.yawDelta !== 0) {
      // yaw around local up
      this.tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.yawDelta);
      this.orientation.multiply(this.tmpQuat);
    }
    if (this.pitchDelta !== 0) {
      this.tmpQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.pitchDelta);
      this.orientation.multiply(this.tmpQuat);
    }
    if (roll !== 0) {
      this.tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
      this.orientation.multiply(this.tmpQuat);
    }
    this.orientation.normalize();
    this.yawDelta = 0;
    this.pitchDelta = 0;

    // 2. Translation. Apply thrust in local space, gated by throttle keys.
    this.tmpForward.set(0, 0, -1).applyQuaternion(this.orientation);
    this.tmpRight.set(1, 0, 0).applyQuaternion(this.orientation);
    this.tmpUp.set(0, 1, 0).applyQuaternion(this.orientation);

    // Boost is now ×2 (was ×4 when there was only one regime) — modes carry
    // most of the speed-scale variation, and ×4 on warp mode would push the
    // ship past 20c which feels arbitrary.
    //
    // 실사 mode overrides the cap entirely: ship cruises at REALISTIC_BASE_SPEED
    // by default. Shift consumes the warp gauge for a brief REALISTIC_BURST_SPEED
    // burst. Charge regenerates whenever the burst isn't firing.
    let baseMax: number;
    let boost: number;
    if (this.realistic) {
      const wantBurst = this.keys.has('shift') && this.warpCharge > 0;
      this.warpBursting = wantBurst;
      if (wantBurst) {
        // Drain at 1/REALISTIC_BURST_BUDGET_SECONDS per second; full charge
        // sustains REALISTIC_BURST_BUDGET_SECONDS of warp before depletion.
        this.warpCharge = Math.max(0, this.warpCharge - dt / REALISTIC_BURST_BUDGET_SECONDS);
        baseMax = REALISTIC_BURST_SPEED;
      } else {
        // Regen at 1/REALISTIC_CHARGE_FULL_SECONDS per second.
        this.warpCharge = Math.min(1, this.warpCharge + dt / REALISTIC_CHARGE_FULL_SECONDS);
        baseMax = REALISTIC_BASE_SPEED;
      }
      boost = 1;
    } else {
      boost = this.keys.has('shift') ? 2 : 1;
      baseMax = this.currentMaxSpeed;
      this.warpBursting = false;
    }
    const accel = baseMax * 1.5 * boost; // saturates to baseMax·boost in ~0.67s

    const thrustW = this.keys.has('w');
    const thrustS = this.keys.has('s');
    const thrustA = this.keys.has('a');
    const thrustD = this.keys.has('d');
    const thrustR = this.keys.has('r');
    const thrustF = this.keys.has('f');
    const anyThrust = thrustW || thrustS || thrustA || thrustD || thrustR || thrustF;

    if (thrustW) this.velocity.addScaledVector(this.tmpForward,  accel * dt);
    if (thrustS) this.velocity.addScaledVector(this.tmpForward, -accel * dt);
    if (thrustD) this.velocity.addScaledVector(this.tmpRight,    accel * dt);
    if (thrustA) this.velocity.addScaledVector(this.tmpRight,   -accel * dt);
    if (thrustR) this.velocity.addScaledVector(this.tmpUp,       accel * dt);
    if (thrustF) this.velocity.addScaledVector(this.tmpUp,      -accel * dt);

    // Hard brake — instantly null velocity. Player convenience, not physical.
    if (this.keys.has('x')) this.velocity.set(0, 0, 0);

    // Flight Assist: bleed off residual velocity when no thrust is applied,
    // so the ship comes to a comfortable stop without manual countering.
    // Disable for "real space" feel.
    if (this.flightAssist && !anyThrust && !this.autoTarget) {
      const decay = Math.exp(-this.faDecayK * dt);
      this.velocity.multiplyScalar(decay);
      if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
    }

    // Soft speed cap. Beyond baseMax*boost, exponentially damp excess so
    // the ship can't accelerate forever. The same loop also pulls speed
    // down toward a new (lower) cap when the player downshifts modes.
    const cap = baseMax * boost;
    const speed = this.velocity.length();
    if (speed > cap) {
      const k = Math.exp(-2.0 * dt); // approach cap quickly but smoothly
      const target = cap + (speed - cap) * k;
      this.velocity.multiplyScalar(target / speed);
    }

    this.position.addScaledVector(this.velocity, dt);

    // 3. Sync camera.
    this.camera.position.copy(this.position);
    this.camera.quaternion.copy(this.orientation);
  }

  /** Snapshot for HUD / ModeManager. Cheap — no allocations on the hot path. */
  getState(): ShipState {
    const forward = this.tmpForward.set(0, 0, -1).applyQuaternion(this.orientation).clone();
    const speed = this.velocity.length();
    const boosting = this.keys.has('shift');
    const cap = this.currentMaxSpeed * (boosting ? 2 : 1);
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      forward,
      throttleInput: (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0),
      throttleNormalized: Math.min(1, speed / cap),
      speed,
      speedC: speed / LIGHTSPEED_UNITS,
      boosting,
      propulsionMode: this.propulsionMode,
      realisticMode: this.realistic,
      warpCharge: this.warpCharge,
      warpBursting: this.warpBursting,
    };
  }

  // ---- input handlers ----

  private isHijackedKey(key: string): boolean {
    // Note: 'g' is intentionally NOT hijacked — main.ts owns the orbit-toggle
    // shortcut, and stealing it here (with stopImmediatePropagation in capture
    // phase) would silently prevent orbit entry from ever firing.
    return (
      key === 'w' || key === 'a' || key === 's' || key === 'd' ||
      key === 'q' || key === 'e' || key === 'r' || key === 'f' ||
      key === 'x' || key === 'z' || key === 'v' ||
      key === ' ' || key === 'spacebar' || key === 'shift'
    );
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const key = e.key.toLowerCase();
    if (!this.isHijackedKey(key)) return;

    // Stop other window-level shortcut handlers (e.g., Space → pause) from
    // firing while ship mode owns these keys.
    e.preventDefault();
    e.stopImmediatePropagation();

    if (key === 'shift') { this.keys.add('shift'); return; }
    if (key === ' ' || key === 'spacebar') {
      // Edge-triggered (toggle on press, ignore auto-repeat).
      if (!e.repeat) {
        this.flightAssist = !this.flightAssist;
        this.onFlightAssistToggle?.(this.flightAssist);
      }
      return;
    }
    if (key === 'z') {
      // Edge-triggered propulsion-mode cycle. Shift+Z steps backward.
      if (!e.repeat) {
        this.cyclePropulsionMode(e.shiftKey ? -1 : +1);
      }
      return;
    }
    if (key === 'v') {
      // Edge-triggered 실사 mode toggle.
      if (!e.repeat) this.toggleRealisticMode();
      return;
    }
    this.keys.add(key);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    if (!this.isHijackedKey(key)) return;
    e.stopImmediatePropagation();
    if (key === 'shift') { this.keys.delete('shift'); return; }
    if (key === ' ' || key === 'spacebar') return; // edge-triggered, no held state
    if (key === 'z' || key === 'v') return; // edge-triggered too
    this.keys.delete(key);
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.pointerLocked) return;
    // Pointer Lock gives us movementX/Y in CSS pixels; scale to ~half-radian
    // per full screen width for natural sensitivity.
    const sens = 0.0022;
    this.yawDelta += e.movementX * sens;
    this.pitchDelta += e.movementY * sens;
  }

  private handlePointerLockChange(): void {
    this.pointerLocked = document.pointerLockElement === this.dom;
  }

  private requestPointerLock(): void {
    if (!this._enabled) return;
    if (document.pointerLockElement !== this.dom) {
      this.dom.requestPointerLock?.();
    }
  }
}
