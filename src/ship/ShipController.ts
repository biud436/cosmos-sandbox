import * as THREE from 'three';

// Conceptual lightspeed in sim units / second. The simulation has no honest
// scale — but giving the ship a "c" reference makes the HUD's "0.42 c"
// readout meaningful and forces sub-light cruise to feel like you're
// actually moving through interstellar distances (and motivates warp for
// crossing them in a session). Light crosses BOX_HALF (150 units) in 2.5s.
export const LIGHTSPEED_UNITS = 60;

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
}

export class ShipController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly maxSpeed: number;

  private _enabled = false;
  private pointerLocked = false;
  flightAssist = true;
  /** Time constant for FA decay: smaller = snappier stop. */
  private faDecayK = 1.8;
  /** Per-toggle callback so the HUD can flash a hint. */
  onFlightAssistToggle: ((on: boolean) => void) | null = null;

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
  } | null = null;

  /** True while the ship is in a forced circular orbit (set via enterOrbit). */
  get orbiting(): { label: string; radius: number } | null {
    return this.orbit ? { label: this.orbit.label, radius: this.orbit.radius } : null;
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
    // Default cruise: 20% of lightspeed. Shift boost (×4) saturates at 0.8c.
    this.maxSpeed = opts.maxSpeed ?? 0.2 * LIGHTSPEED_UNITS;
    const start = opts.initialPosition ?? this.camera.position;
    this.position.copy(start);
    this.orientation.copy(this.camera.quaternion);
  }

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
  glideTo(target: THREE.Vector3, standoff: number): void {
    this.autoTarget = target.clone();
    this.autoStandoff = Math.max(0.01, standoff);
    this.orbit = null;
  }

  cancelGlide(): void {
    this.autoTarget = null;
  }

  /**
   * Lock the ship into a circular orbit around a target that may itself be
   * moving (planets revolve around stars). `getTarget` is invoked each
   * frame so the orbit follows. The plane is chosen at engagement from the
   * ship's current radial direction and is then held in absolute world
   * orientation. Manual thrust or X breaks the orbit.
   */
  enterOrbit(getTarget: () => THREE.Vector3, radius: number, label: string): void {
    this.autoTarget = null;
    const tgt = getTarget();
    let radial = this.position.clone().sub(tgt);
    if (radial.lengthSq() < 1e-3) radial.set(1, 0, 0);
    radial.normalize();

    // Build an orbit plane: normal preferentially aligned with world up,
    // but if the radial is nearly vertical pick a side axis to avoid a
    // degenerate cross-product.
    let normal = new THREE.Vector3(0, 1, 0).cross(radial);
    if (normal.lengthSq() < 0.05) {
      normal = new THREE.Vector3(0, 0, 1).cross(radial);
    }
    normal.normalize();
    const tangential = new THREE.Vector3().crossVectors(normal, radial).normalize();

    this.orbit = {
      target: getTarget,
      radius,
      basisU: radial,
      basisV: tangential,
      angle: 0,
      angularSpeed: 0.45, // rad/sec → period ~14s
      label,
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
        // Look at target (gives the player a steady inward view)
        const lookM = new THREE.Matrix4().lookAt(this.position, tgt, new THREE.Vector3(0, 1, 0));
        this.orientation.setFromRotationMatrix(lookM);
        // Mouse-look still applies on top (yaw/pitch deltas), so the player
        // can rotate their head while the autopilot maintains the orbit.
        if (this.yawDelta !== 0) {
          this.tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.yawDelta);
          this.orientation.multiply(this.tmpQuat);
        }
        if (this.pitchDelta !== 0) {
          this.tmpQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.pitchDelta);
          this.orientation.multiply(this.tmpQuat);
        }
        this.orientation.normalize();
        this.yawDelta = 0;
        this.pitchDelta = 0;
        this.velocity.set(0, 0, 0);
        this.camera.position.copy(this.position);
        this.camera.quaternion.copy(this.orientation);
        return;
      }
    }

    // 0. Auto-pilot: if active and the player hasn't given input, accelerate
    //    toward the target and orient the ship's forward axis at it.
    if (this.autoTarget) {
      const userInput = this.keys.has('w') || this.keys.has('s') || this.keys.has('a') || this.keys.has('d')
        || this.keys.has(' ') || this.keys.has('c') || this.keys.has('q') || this.keys.has('e')
        || this.keys.has('x');
      if (userInput) {
        this.autoTarget = null;
      } else {
        const toTarget = this.tmpForward.copy(this.autoTarget).sub(this.position);
        const dist = toTarget.length();
        if (dist <= this.autoStandoff * 1.05) {
          // Arrived — brake and disengage.
          this.velocity.multiplyScalar(Math.exp(-6 * dt));
          if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
          this.autoTarget = null;
        } else {
          // Aim: slerp orientation toward look-at quaternion (smooth turn).
          const lookM = new THREE.Matrix4().lookAt(this.position, this.autoTarget, new THREE.Vector3(0, 1, 0));
          const lookQ = new THREE.Quaternion().setFromRotationMatrix(lookM);
          this.orientation.slerp(lookQ, Math.min(1, dt * 3.5));

          // Speed plan: cruise close to lightspeed for autopilot, then ease
          // into the standoff radius. We allow autopilot to brush against c
          // since it's a deliberate "travel to entry" action.
          const cruise = 0.8 * LIGHTSPEED_UNITS;
          const ease = Math.min(1, (dist - this.autoStandoff) / (this.autoStandoff * 4));
          const desiredSpeed = cruise * ease + 2 * (1 - ease); // floor of 2 u/s near arrival
          const dir = toTarget.normalize();
          this.velocity.copy(dir).multiplyScalar(desiredSpeed);
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

    const boost = this.keys.has('shift') ? 4 : 1;
    const accel = this.maxSpeed * 1.5 * boost; // can saturate to maxSpeed*boost in ~0.67s

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

    // Soft speed cap. Beyond maxSpeed*boost, exponentially damp excess so
    // the ship can't accelerate forever.
    const cap = this.maxSpeed * boost;
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
    const cap = this.maxSpeed * (boosting ? 4 : 1);
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      forward,
      throttleInput: (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0),
      throttleNormalized: Math.min(1, speed / cap),
      speed,
      speedC: speed / LIGHTSPEED_UNITS,
      boosting,
    };
  }

  // ---- input handlers ----

  private isHijackedKey(key: string): boolean {
    return (
      key === 'w' || key === 'a' || key === 's' || key === 'd' ||
      key === 'q' || key === 'e' || key === 'r' || key === 'f' ||
      key === 'g' || key === 'x' ||
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
    this.keys.add(key);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    if (!this.isHijackedKey(key)) return;
    e.stopImmediatePropagation();
    if (key === 'shift') { this.keys.delete('shift'); return; }
    if (key === ' ' || key === 'spacebar') return; // edge-triggered, no held state
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
