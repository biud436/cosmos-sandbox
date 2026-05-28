import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { PROPULSION_SPECS, ShipState } from './ShipController';

// Cosmic-unit display for spaceship mode. The sim uses one coordinate system
// for both planet orbits AND star-to-star distances, but in reality those
// scales differ by ~5-6 orders of magnitude (a planet sits ~1 AU from its
// host star, whereas neighboring stars sit several light-years apart). A
// single u→real conversion can only be right for one of these contexts, so
// we use TWO independent display scales — picked per context by what's
// being measured:
//
//   PLANETARY scale (1u = 0.5 AU)
//     For distances inside a star system: planet orbit radius, planet body
//     radius, ship-to-planet DIST. A 5-60u orbit reads as 2.5-30 AU,
//     matching the Mars-to-Neptune range.
//
//   INTERSTELLAR scale (1u = 1.0 ly)
//     For distances between star systems: ship-to-star DIST, nearest-star
//     readout. A 30u traversal reads as 30 ly (galactic neighborhood). The
//     simulation's coordinate values grow naturally with sim.scaleFactor as
//     Hubble expansion runs, so distances in this readout get bigger over
//     long sessions — no extra Hubble correction needed.
//
// This is dishonest only in the sense that "5 u" means 2.5 AU in one
// context and 5 ly in another. But it matches what cosmic visualizations
// always do — orreries and galactic maps use entirely different scales —
// and it's what makes the readouts feel like "space."
const KM_PER_AU = 149_597_870.7;
const KM_PER_LY = 9.4607304725808e12;
const AU_PER_LY = KM_PER_LY / KM_PER_AU; // ≈ 63,241.077

const PLANETARY_AU_PER_U = 0.5;   // 1u = 0.5 AU
const INTERSTELLAR_LY_PER_U = 1.0; // 1u = 1.0 ly

/** Planetary-context distance: AU for typical reads, km for sub-AU close-in. */
export function formatPlanetaryDistance(u: number): string {
  const au = u * PLANETARY_AU_PER_U;
  if (au >= 1000) return `${au.toFixed(0)} AU`;
  if (au >= 10)   return `${au.toFixed(1)} AU`;
  if (au >= 0.01) return `${au.toFixed(2)} AU`;
  const km = au * KM_PER_AU;
  if (km >= 1e6) return `${(km / 1e6).toFixed(2)} Mkm`;
  if (km >= 1)   return `${km.toFixed(0)} km`;
  return `${(km * 1000).toFixed(0)} m`;
}

/** Interstellar-context distance: ly for typical reads, AU for sub-ly. */
export function formatInterstellarDistance(u: number): string {
  const ly = u * INTERSTELLAR_LY_PER_U;
  if (ly >= 1000) return `${ly.toFixed(0)} ly`;
  if (ly >= 10)   return `${ly.toFixed(1)} ly`;
  if (ly >= 0.01) return `${ly.toFixed(2)} ly`;
  // Below 0.01 ly fall back to AU — typically only happens when the ship
  // sits inside a star system and the "nearest star" is its current host.
  const au = ly * AU_PER_LY;
  if (au >= 1)    return `${au.toFixed(1)} AU`;
  return `${au.toFixed(3)} AU`;
}

// Threshold (in u) between "inside a star system" and "interstellar void."
// Picked at the outer-planet orbit limit set by PlanetSystem (innerR up to
// 13× eff.radius × outerR multiplier up to 6 ≈ 78u worst case). 60u is a
// comfortable break: a star within 60u is one the ship can plausibly be
// orbiting / fly-by-ing in-system, anything beyond is "interstellar."
const INTERSTELLAR_U_THRESHOLD = 60;

/**
 * Pick the right scale for a HUDTarget:
 *   - Planet targets always use planetary AU (you're inside a system).
 *   - Star targets are magnitude-aware: AU when close (the ship is currently
 *     inside that star's planetary system), ly only when truly interstellar.
 *     Fixes the "approaching the sun still shows ly" complaint — the AU read
 *     reflects in-system distance the way real spacecraft instruments would.
 */
function formatTargetDistance(u: number, kind: 'planet' | 'star'): string {
  if (kind === 'planet') return formatPlanetaryDistance(u);
  return u > INTERSTELLAR_U_THRESHOLD ? formatInterstellarDistance(u) : formatPlanetaryDistance(u);
}

/** NEAR readout — nearest stellar object. Same magnitude-aware pick. */
function formatStellarDistance(u: number): string {
  return u > INTERSTELLAR_U_THRESHOLD ? formatInterstellarDistance(u) : formatPlanetaryDistance(u);
}

/** Back-compat alias — defaults to planetary scale; existing callers in
 *  main.ts pass planet orbit/radius, which is the planetary context. */
export const formatRealDistance = formatPlanetaryDistance;

/** Light-travel time for a distance, displayed in the appropriate unit.
 *  Interstellar distances → years (since 1 ly = light-travel of 1 year by
 *  definition); planetary → minutes/seconds. The unit pick mirrors the
 *  distance formatters so the two readouts agree on what scale we're in. */
function formatLightDelay(u: number): string {
  if (u > INTERSTELLAR_U_THRESHOLD) {
    const years = u * INTERSTELLAR_LY_PER_U; // 1 ly takes 1 year for light
    if (years >= 1000) return `${years.toFixed(0)} 년`;
    if (years >= 10)   return `${years.toFixed(1)} 년`;
    return `${years.toFixed(2)} 년`;
  }
  // Planetary scale: AU → minutes (1 AU = 8.32 light-minutes).
  const au = u * PLANETARY_AU_PER_U;
  const minutes = au * 8.317;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} 시간`;
  if (minutes >= 1)  return `${minutes.toFixed(1)} 분`;
  return `${(minutes * 60).toFixed(0)} 초`;
}

export interface HUDTarget {
  kind: 'planet' | 'star';
  label: string;
  getPosition: () => THREE.Vector3;
  radius: number;
  /** Optional swatch color for the info card. */
  color?: [number, number, number];
  /** Compact key/value lines shown in the floating info card. */
  details: { k: string; v: string }[];
}

// HTML overlay shown only while the spaceship mode is active. Renders
// position/velocity/throttle plus a small axes gizmo in the top-right that
// reads the ship's basis vectors, like Unity's scene gizmo.

export class ShipHUD {
  private readonly root: HTMLElement;
  private readonly posEl: HTMLElement;
  private readonly velEl: HTMLElement;
  private readonly spdEl: HTMLElement;
  private readonly thrFill: HTMLElement;
  private readonly nearestEl: HTMLElement;
  private readonly tgtEl: HTMLElement;
  private readonly relRow: HTMLElement;
  private readonly relEl: HTMLElement;
  private readonly gizmoCanvas: HTMLCanvasElement;
  private readonly gizmoCtx: CanvasRenderingContext2D;
  private readonly hintEl: HTMLElement;
  private readonly faBadge: HTMLElement;
  private readonly orbitBadge: HTMLElement;
  private readonly modeBadge: HTMLElement;
  private readonly warpRow: HTMLElement;
  private readonly warpFill: HTMLElement;
  private readonly targetBracket: HTMLElement;
  private readonly targetInfo: HTMLElement;
  private readonly navArrow: HTMLElement;
  private readonly navLabel: HTMLElement;

  private visible_ = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ship-hud';
    this.root.innerHTML = `
      <div class="ship-hud-tl">
        <div class="ship-hud-row"><span class="ship-hud-k">POS</span><span class="ship-hud-v" id="ship-pos">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">VEL</span><span class="ship-hud-v" id="ship-vel">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">|v|</span><span class="ship-hud-v" id="ship-spd">—</span></div>
        <div class="ship-hud-row ship-hud-rel" id="ship-hud-rel" style="display:none"><span class="ship-hud-k">REL</span><span class="ship-hud-v" id="ship-rel">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">NEAR</span><span class="ship-hud-v" id="ship-near">탐색 중…</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">TGT</span><span class="ship-hud-v" id="ship-tgt">—</span></div>
      </div>
      <div class="ship-hud-tr">
        <canvas id="ship-gizmo" width="96" height="96"></canvas>
        <div class="ship-hud-badges">
          <span class="ship-badge mode" id="ship-badge-mode">순항</span>
          <span class="ship-badge" id="ship-badge-fa">FA</span>
          <span class="ship-badge orbit" id="ship-badge-orbit" style="display:none">ORBIT</span>
        </div>
      </div>
      <div class="ship-hud-help" id="ship-hud-help">
        <div class="ship-help-title">조작</div>
        <div class="ship-help-row"><span class="ship-help-k">WASD</span><span>이동</span></div>
        <div class="ship-help-row"><span class="ship-help-k">R / F</span><span>상승 / 하강</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Q / E</span><span>롤</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Mouse</span><span>요·피치</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Shift</span><span>부스트 ×2</span></div>
        <div class="ship-help-row"><span class="ship-help-k">X</span><span>비상 정지</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Space</span><span>비행보조 토글</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Z</span><span>추진 모드 (Shift+Z 역방향)</span></div>
        <div class="ship-help-row"><span class="ship-help-k">V</span><span>실사 모드 토글 (게이지 워프)</span></div>
        <div class="ship-help-row"><span class="ship-help-k">G</span><span>레티클 대상 궤도</span></div>
        <div class="ship-help-row"><span class="ship-help-k">Tab</span><span>메뉴 / 도감</span></div>
      </div>
      <div class="ship-hud-bc">
        <div class="ship-thr-label">THROTTLE</div>
        <div class="ship-thr-bar"><div class="ship-thr-fill" id="ship-thr-fill"></div></div>
        <div class="ship-warp-row" id="ship-warp-row" style="display:none">
          <div class="ship-warp-label">WARP CHG</div>
          <div class="ship-warp-bar"><div class="ship-warp-fill" id="ship-warp-fill"></div></div>
        </div>
      </div>
      <div class="ship-hud-hint" id="ship-hud-hint">
        클릭하여 마우스 잠금 · 오른쪽 패널 참조 · Z 추진모드 · G 궤도 · Tab 메뉴
      </div>
      <div class="ship-reticle"></div>
      <div class="ship-target-bracket" id="ship-target-bracket" style="display:none"></div>
      <div class="ship-target-info" id="ship-target-info" style="display:none"></div>
      <div class="ship-nav-arrow" id="ship-nav-arrow" style="display:none">
        <div class="ship-nav-tri"></div>
        <div class="ship-nav-label" id="ship-nav-label">—</div>
      </div>
    `;
    container.appendChild(this.root);
    this.posEl = this.root.querySelector('#ship-pos') as HTMLElement;
    this.velEl = this.root.querySelector('#ship-vel') as HTMLElement;
    this.spdEl = this.root.querySelector('#ship-spd') as HTMLElement;
    this.thrFill = this.root.querySelector('#ship-thr-fill') as HTMLElement;
    this.nearestEl = this.root.querySelector('#ship-near') as HTMLElement;
    this.tgtEl = this.root.querySelector('#ship-tgt') as HTMLElement;
    this.relRow = this.root.querySelector('#ship-hud-rel') as HTMLElement;
    this.relEl = this.root.querySelector('#ship-rel') as HTMLElement;
    this.gizmoCanvas = this.root.querySelector('#ship-gizmo') as HTMLCanvasElement;
    this.gizmoCtx = this.gizmoCanvas.getContext('2d')!;
    this.hintEl = this.root.querySelector('#ship-hud-hint') as HTMLElement;
    this.faBadge = this.root.querySelector('#ship-badge-fa') as HTMLElement;
    this.orbitBadge = this.root.querySelector('#ship-badge-orbit') as HTMLElement;
    this.modeBadge = this.root.querySelector('#ship-badge-mode') as HTMLElement;
    this.warpRow = this.root.querySelector('#ship-warp-row') as HTMLElement;
    this.warpFill = this.root.querySelector('#ship-warp-fill') as HTMLElement;
    this.targetBracket = this.root.querySelector('#ship-target-bracket') as HTMLElement;
    this.targetInfo = this.root.querySelector('#ship-target-info') as HTMLElement;
    this.navArrow = this.root.querySelector('#ship-nav-arrow') as HTMLElement;
    this.navLabel = this.root.querySelector('#ship-nav-label') as HTMLElement;

    this.injectStyles();
    this.setVisible(false);
  }

  setVisible(v: boolean): void {
    this.visible_ = v;
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.visible_;
  }

  /** Called every frame while ship mode is active.
   *  `nav` is the persistent navigation focus (autopilot target / orbit
   *  center / etc.) — if set and off-screen we draw an edge arrow toward
   *  it so the player can re-acquire it. */
  update(
    state: ShipState,
    camera: THREE.PerspectiveCamera,
    nearestStar: { eff: Effector; distance: number } | null,
    target: HUDTarget | null,
    flightAssist: boolean,
    orbiting: { label: string; radius: number } | null,
    nav: { position: THREE.Vector3; label: string } | null = null,
  ): void {
    if (!this.visible_) return;
    const p = state.position;
    this.posEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    const v = state.velocity;
    this.velEl.textContent = `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
    // Space speed: only the c-fraction. km/s would conflict with the AU-anchored
    // distance scale (the two would imply different KM_PER_U), so we drop it.
    this.spdEl.innerHTML = `<b>${state.speedC.toFixed(3)} c</b>${state.boosting ? ' · BOOST' : ''}`;
    this.thrFill.style.width = `${(state.throttleNormalized * 100).toFixed(1)}%`;
    if (state.boosting) this.thrFill.classList.add('boost');
    else this.thrFill.classList.remove('boost');

    if (nearestStar) {
      const name = nearestStar.eff.name ?? `${nearestStar.eff.type}`;
      // Nearest stellar object — magnitude-aware: AU when in-system, ly when
      // traversing between systems.
      this.nearestEl.textContent = `${name} · ${formatStellarDistance(nearestStar.distance)}`;
    } else {
      this.nearestEl.textContent = '—';
    }

    // Relativistic readout. Hide unless v is meaningfully fast — sub-5%c
    // means γ-1 < 0.13%, which would just be HUD noise. At higher β we show:
    //   γ  (time dilation factor — 0.5c→1.15×, 0.9c→2.29×, 0.99c→7.09×)
    //   D  (relativistic Doppler factor toward the velocity vector, ≥1
    //       means blueshift forward — visible Doppler color shift kicks in
    //       around ~1.05 for the player's intuition)
    //   lt (light-travel time to the nearest star, in the matching scale)
    const beta = Math.min(0.9999, state.speedC);
    if (beta > 0.05) {
      const gamma = 1 / Math.sqrt(Math.max(1e-6, 1 - beta * beta));
      const doppler = Math.sqrt((1 + beta) / Math.max(1e-6, 1 - beta));
      const ltStr = nearestStar ? formatLightDelay(nearestStar.distance) : '—';
      // β shown as percentage of c for quick reading; γ to 2 decimals at
      // moderate speed and 1 decimal once it gets dramatic.
      const gStr = gamma >= 10 ? gamma.toFixed(1) : gamma.toFixed(2);
      this.relRow.style.display = '';
      this.relEl.innerHTML = `γ=<b>${gStr}</b> · D=${doppler.toFixed(2)} · lt(별)=${ltStr}`;
    } else {
      this.relRow.style.display = 'none';
    }

    if (target) {
      const tp = target.getPosition();
      const dist = tp.distanceTo(state.position);
      // Planet target → AU (we're inside the system); star target → ly.
      this.tgtEl.innerHTML = `<b>${escapeText(target.label)}</b> · ${formatTargetDistance(dist, target.kind)} · <span class="ship-key">G</span> 궤도`;
      this.updateTargetBracket(target, camera, dist);
    } else {
      this.tgtEl.textContent = '레티클을 별/행성에 맞추세요';
      this.targetBracket.style.display = 'none';
      this.targetInfo.style.display = 'none';
    }

    // FA / ORBIT / MODE badges
    this.faBadge.classList.toggle('off', !flightAssist);
    this.faBadge.textContent = flightAssist ? 'FA' : 'FA OFF';
    if (orbiting) {
      this.orbitBadge.style.display = '';
      this.orbitBadge.textContent = `ORBIT · ${orbiting.label}`;
    } else {
      this.orbitBadge.style.display = 'none';
    }
    const modeSpec = PROPULSION_SPECS[state.propulsionMode];
    if (state.realisticMode) {
      this.modeBadge.textContent = 'MODE · 실사';
      this.modeBadge.dataset.mode = 'realistic';
    } else {
      this.modeBadge.textContent = `MODE · ${modeSpec.label}`;
      this.modeBadge.dataset.mode = state.propulsionMode;
    }

    // Warp gauge — visible only in 실사 mode; fill = current charge level.
    // Background tints red as the charge depletes so the burst limit is
    // legible even at a glance, and pulses when actively bursting.
    if (state.realisticMode) {
      this.warpRow.style.display = '';
      this.warpFill.style.width = `${(state.warpCharge * 100).toFixed(1)}%`;
      this.warpFill.classList.toggle('bursting', state.warpBursting);
    } else {
      this.warpRow.style.display = 'none';
    }

    this.drawGizmo(camera);
    this.updateNavArrow(nav, state, camera);
  }

  private updateNavArrow(
    nav: { position: THREE.Vector3; label: string } | null,
    state: ShipState,
    camera: THREE.PerspectiveCamera,
  ): void {
    if (!nav) { this.navArrow.style.display = 'none'; return; }
    const ndc = nav.position.clone().project(camera);
    const onScreen = ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 0.97 && Math.abs(ndc.y) <= 0.97;
    if (onScreen) { this.navArrow.style.display = 'none'; return; }

    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const cx = w / 2;
    const cy = h / 2;

    // Build a direction in screen space toward the target. If z > 1 (behind
    // camera), invert XY so the arrow still points away from the target's
    // "behind us" projection.
    let dx = ndc.x;
    let dy = -ndc.y;
    if (ndc.z > 1) { dx = -dx; dy = -dy; }
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) { this.navArrow.style.display = 'none'; return; }
    dx /= len; dy /= len;

    // Clamp the arrow to a 40px-inset ring along the viewport edge so it
    // hugs the border on whichever side the target lies.
    const margin = 48;
    const halfW = cx - margin;
    const halfH = cy - margin;
    const tEdge = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
    const ax = cx + dx * tEdge;
    const ay = cy + dy * tEdge;

    const dist = nav.position.distanceTo(state.position);
    this.navArrow.style.display = '';
    this.navArrow.style.left = `${ax}px`;
    this.navArrow.style.top = `${ay}px`;
    // The container itself is translated to the edge but NOT rotated, so the
    // label stays upright. Only the inner triangle rotates to point outward.
    // CSS rotation is clockwise-positive; the triangle's rest orientation
    // points "up" (screen -Y). The angle that takes (0,-1) → (dx,dy) is
    // atan2(dx, -dy).
    const tri = this.navArrow.querySelector('.ship-nav-tri') as HTMLElement | null;
    if (tri) {
      const angle = Math.atan2(dx, -dy);
      tri.style.transform = `rotate(${angle}rad)`;
    }
    // Nav-arrow targets don't carry kind, but the ship's typical navigation
    // is to nearby objects (selected via reticle). Use planetary scale as
    // the default — it's the safer "smaller numbers" choice that won't
    // mislead about distances inside a star system. Interstellar reads
    // will appear in the NEAR / TGT slots anyway.
    this.navLabel.textContent = `${nav.label} · ${formatPlanetaryDistance(dist)}`;
  }

  private updateTargetBracket(target: HUDTarget, camera: THREE.PerspectiveCamera, distance: number): void {
    // Project the target into NDC and place a bracket overlay. If behind the
    // camera, hide it instead of drawing on the wrong side.
    const p = target.getPosition().project(camera);
    if (p.z > 1 || p.z < -1) {
      this.targetBracket.style.display = 'none';
      this.targetInfo.style.display = 'none';
      return;
    }
    const cx = (p.x * 0.5 + 0.5) * this.root.clientWidth;
    const cy = (-p.y * 0.5 + 0.5) * this.root.clientHeight;
    this.targetBracket.style.display = '';
    this.targetBracket.style.left = `${cx}px`;
    this.targetBracket.style.top  = `${cy}px`;

    // Info card: anchored to the same point. Place to the right of the bracket
    // if there's room, otherwise flip left so it doesn't run off-screen.
    const card = this.targetInfo;
    const swatch = target.color
      ? `<div class="tinfo-swatch" style="background:rgb(${(target.color[0]*255)|0},${(target.color[1]*255)|0},${(target.color[2]*255)|0})"></div>`
      : '';
    const rows = target.details.map((d) =>
      `<div class="tinfo-row"><span class="tinfo-k">${escapeText(d.k)}</span><span class="tinfo-v">${escapeText(d.v)}</span></div>`
    ).join('');
    card.innerHTML = `
      <div class="tinfo-head">${swatch}<div class="tinfo-name">${escapeText(target.label)}</div></div>
      <div class="tinfo-body">${rows}
        <div class="tinfo-row"><span class="tinfo-k">DIST</span><span class="tinfo-v">${formatTargetDistance(distance, target.kind)}</span></div>
      </div>
    `;
    card.style.display = '';
    // Place card 24px right + 0px down from the bracket; flip if off-edge.
    const margin = 24;
    let left = cx + margin;
    let top = cy - 8;
    // Estimate card width 200, height 110 — generous, we just want to flip when near edge
    const w = 200; const h = 110;
    if (left + w > this.root.clientWidth - 8) left = cx - margin - w;
    if (top + h > this.root.clientHeight - 8) top = this.root.clientHeight - h - 8;
    if (top < 8) top = 8;
    card.style.left = `${left}px`;
    card.style.top  = `${top}px`;
  }

  /** Show a one-shot hint message at the bottom for a few seconds. */
  flashHint(text: string, ms = 2400): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('flash');
    window.setTimeout(() => this.hintEl.classList.remove('flash'), ms);
  }

  private drawGizmo(camera: THREE.PerspectiveCamera): void {
    const ctx = this.gizmoCtx;
    const w = this.gizmoCanvas.width;
    const h = this.gizmoCanvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.36;

    // World axes projected into camera space; +X red, +Y green, +Z blue.
    // We render relative to camera so they show how the ship is oriented
    // in world space. Z (forward) negative goes into the screen — small dot.
    const inv = new THREE.Matrix4().copy(camera.matrixWorldInverse);
    const axes: { name: string; v: THREE.Vector3; color: string }[] = [
      { name: 'X', v: new THREE.Vector3(1, 0, 0), color: '#ff5566' },
      { name: 'Y', v: new THREE.Vector3(0, 1, 0), color: '#66dd66' },
      { name: 'Z', v: new THREE.Vector3(0, 0, 1), color: '#5599ff' },
    ];

    // Background ring
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
    ctx.stroke();

    // Sort by Z so far axes draw behind
    const projected = axes.map((a) => {
      const v = a.v.clone().applyMatrix4(inv);
      // Project: -Z is into screen; flip Y for canvas-down
      return { name: a.name, color: a.color, x: cx + v.x * R, y: cy - v.y * R, z: v.z };
    });
    projected.sort((a, b) => b.z - a.z); // far first

    for (const p of projected) {
      ctx.strokeStyle = p.color;
      ctx.fillStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b0b14';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name, p.x, p.y);
    }
  }

  private injectStyles(): void {
    if (document.getElementById('ship-hud-styles')) return;
    const style = document.createElement('style');
    style.id = 'ship-hud-styles';
    style.textContent = `
      .ship-hud {
        position: absolute; inset: 0; pointer-events: none;
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        color: #c5e1ff; z-index: 50;
      }
      .ship-hud-tl {
        position: absolute; top: 12px; left: 12px;
        background: rgba(8, 12, 22, 0.78);
        border: 1px solid rgba(110, 170, 240, 0.35);
        border-radius: 6px; padding: 8px 12px; min-width: 220px;
        backdrop-filter: blur(4px);
      }
      .ship-hud-row {
        display: grid; grid-template-columns: 44px 1fr;
        gap: 10px; font-size: 11px; line-height: 1.5;
      }
      .ship-hud-k {
        color: #6a8cba; letter-spacing: 1px;
      }
      .ship-hud-v {
        color: #e8f3ff; font-variant-numeric: tabular-nums;
      }
      .ship-hud-rel .ship-hud-k {
        color: #c08fff;
      }
      .ship-hud-rel .ship-hud-v {
        color: #e9d2ff;
        text-shadow: 0 0 4px rgba(170, 110, 240, 0.35);
      }
      .ship-hud-tr {
        position: absolute; top: 12px; right: 12px;
        background: rgba(8, 12, 22, 0.78);
        border: 1px solid rgba(110, 170, 240, 0.35);
        border-radius: 50%;
        padding: 4px;
        backdrop-filter: blur(4px);
      }
      .ship-hud-tr canvas { display: block; }
      .ship-hud-bc {
        position: absolute; bottom: 28px; left: 50%;
        transform: translateX(-50%); width: 360px; max-width: 60%;
        background: rgba(8, 12, 22, 0.78);
        border: 1px solid rgba(110, 170, 240, 0.35);
        border-radius: 6px; padding: 6px 10px;
        backdrop-filter: blur(4px);
      }
      .ship-thr-label {
        font-size: 9px; letter-spacing: 2px; color: #6a8cba; margin-bottom: 3px;
      }
      .ship-thr-bar {
        height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;
      }
      .ship-thr-fill {
        height: 100%; width: 0%; background: linear-gradient(90deg, #4a8df6, #6ad6ff);
        transition: width 0.08s ease-out;
      }
      .ship-thr-fill.boost {
        background: linear-gradient(90deg, #ff9e3b, #ffd66b);
        box-shadow: 0 0 8px rgba(255,180,80,0.6);
      }
      .ship-warp-row {
        margin-top: 4px;
      }
      .ship-warp-label {
        font-size: 9px; letter-spacing: 2px; color: #c08fff; margin-bottom: 3px;
      }
      .ship-warp-bar {
        height: 6px; background: rgba(140, 60, 200, 0.18);
        border: 1px solid rgba(180, 110, 240, 0.30);
        border-radius: 3px; overflow: hidden;
      }
      .ship-warp-fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, #8a55d8, #d68bff);
        transition: width 0.05s linear;
      }
      .ship-warp-fill.bursting {
        background: linear-gradient(90deg, #ff6ad2, #ffd1ff);
        box-shadow: 0 0 10px rgba(255, 130, 230, 0.7);
      }
      .ship-badge.mode[data-mode="realistic"] {
        background: rgba(180, 110, 240, 0.22);
        border-color: rgba(220, 140, 255, 0.55);
        color: #e0baff;
        text-shadow: 0 0 6px rgba(220, 140, 255, 0.5);
      }
      .ship-hud-hint {
        position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
        font-size: 10px; color: rgba(180, 210, 250, 0.55);
        letter-spacing: 0.5px; white-space: nowrap; pointer-events: none;
      }
      .ship-hud-hint.flash {
        color: #ffd66b; text-shadow: 0 0 6px rgba(255,180,80,0.6);
      }
      .ship-reticle {
        position: absolute; left: 50%; top: 50%;
        width: 12px; height: 12px; transform: translate(-50%, -50%);
        border: 1px solid rgba(120, 200, 255, 0.55);
        border-radius: 50%;
        box-shadow: 0 0 8px rgba(120, 200, 255, 0.25);
      }
      .ship-reticle::before, .ship-reticle::after {
        content: ''; position: absolute; background: rgba(120, 200, 255, 0.55);
      }
      .ship-reticle::before {
        left: 50%; top: -6px; width: 1px; height: 4px; transform: translateX(-50%);
      }
      .ship-reticle::after {
        top: 50%; left: -6px; height: 1px; width: 4px; transform: translateY(-50%);
      }
      .ship-hud-badges {
        position: absolute; top: 100%; right: 0; margin-top: 6px;
        display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
      }
      .ship-badge {
        display: inline-block;
        padding: 2px 8px; border-radius: 3px;
        font-size: 10px; letter-spacing: 1.5px; font-weight: 700;
        background: rgba(74, 141, 246, 0.22);
        border: 1px solid rgba(120, 170, 240, 0.4);
        color: #c5e1ff;
        white-space: nowrap;
      }
      .ship-badge.off {
        background: rgba(255, 90, 90, 0.18);
        border-color: rgba(255, 140, 140, 0.45);
        color: #ffb6b6;
      }
      .ship-badge.orbit {
        background: rgba(255, 200, 110, 0.18);
        border-color: rgba(255, 200, 110, 0.45);
        color: #ffd28a;
      }
      .ship-badge.mode {
        background: rgba(140, 200, 130, 0.18);
        border-color: rgba(140, 200, 130, 0.45);
        color: #a8e6a0;
      }
      .ship-badge.mode[data-mode="approach"] {
        background: rgba(110, 180, 240, 0.18);
        border-color: rgba(110, 180, 240, 0.45);
        color: #a4cdf8;
      }
      .ship-badge.mode[data-mode="high"] {
        background: rgba(255, 180, 90, 0.18);
        border-color: rgba(255, 180, 90, 0.45);
        color: #ffce8a;
      }
      .ship-badge.mode[data-mode="warp"] {
        background: rgba(220, 130, 255, 0.22);
        border-color: rgba(220, 130, 255, 0.55);
        color: #e6b5ff;
        text-shadow: 0 0 6px rgba(220, 130, 255, 0.5);
      }
      .ship-hud-help {
        position: absolute; top: 180px; right: 12px;
        max-width: 220px;
        background: rgba(8, 12, 22, 0.78);
        border: 1px solid rgba(110, 170, 240, 0.28);
        border-radius: 6px;
        padding: 8px 10px;
        backdrop-filter: blur(4px);
        font-size: 10.5px;
        color: #9eb6d5;
        line-height: 1.45;
      }
      .ship-help-title {
        font-size: 9.5px; letter-spacing: 2px;
        color: #6a8cba; margin-bottom: 5px;
        border-bottom: 1px solid rgba(110, 170, 240, 0.18);
        padding-bottom: 4px;
      }
      .ship-help-row {
        display: grid; grid-template-columns: 56px 1fr;
        gap: 8px; align-items: center;
      }
      .ship-help-k {
        font-family: ui-monospace, monospace;
        font-size: 10px; color: #c5e1ff;
        background: rgba(74, 141, 246, 0.14);
        border: 1px solid rgba(120, 170, 240, 0.28);
        border-radius: 3px;
        padding: 0 4px; text-align: center;
        white-space: nowrap;
      }
      .ship-target-bracket {
        position: absolute;
        width: 28px; height: 28px;
        transform: translate(-50%, -50%);
        border: 1px solid rgba(255, 220, 130, 0.85);
        border-radius: 50%;
        box-shadow: 0 0 12px rgba(255, 200, 80, 0.4), inset 0 0 6px rgba(255, 200, 80, 0.25);
        pointer-events: none;
      }
      .ship-target-bracket::before, .ship-target-bracket::after {
        content: ''; position: absolute; background: rgba(255, 220, 130, 0.85);
      }
      .ship-target-bracket::before {
        left: 50%; top: -8px; width: 1px; height: 5px; transform: translateX(-50%);
      }
      .ship-target-bracket::after {
        left: 50%; bottom: -8px; width: 1px; height: 5px; transform: translateX(-50%);
      }
      .ship-key {
        display: inline-block; padding: 0 5px; margin: 0 2px;
        background: rgba(255, 220, 130, 0.18); color: #ffd28a;
        border: 1px solid rgba(255, 220, 130, 0.35); border-radius: 3px;
        font-family: ui-monospace, monospace; font-size: 10px;
      }
      .ship-target-info {
        position: absolute; width: 200px;
        background: rgba(8, 12, 22, 0.85);
        border: 1px solid rgba(255, 220, 130, 0.45);
        border-radius: 6px;
        padding: 8px 10px;
        backdrop-filter: blur(4px);
        box-shadow: 0 0 16px rgba(255, 200, 80, 0.18);
        pointer-events: none;
      }
      .tinfo-head {
        display: flex; align-items: center; gap: 8px;
        padding-bottom: 6px; margin-bottom: 6px;
        border-bottom: 1px solid rgba(255, 220, 130, 0.18);
      }
      .tinfo-swatch {
        width: 12px; height: 12px; border-radius: 50%;
        box-shadow: 0 0 6px currentColor;
      }
      .tinfo-name {
        color: #ffd28a; font-size: 12px; font-weight: 700;
        letter-spacing: 0.3px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .tinfo-body { display: flex; flex-direction: column; gap: 3px; }
      .tinfo-row {
        display: grid; grid-template-columns: 48px 1fr;
        gap: 8px; font-size: 11px;
      }
      .tinfo-k {
        color: #6a8cba; letter-spacing: 1px; font-size: 9.5px; line-height: 1.5;
      }
      .tinfo-v {
        color: #e8f3ff; font-variant-numeric: tabular-nums;
      }
      .ship-nav-arrow {
        position: absolute;
        transform: translate(-50%, -50%);
        display: flex; flex-direction: column; align-items: center;
        gap: 4px;
        pointer-events: none;
        text-shadow: 0 0 6px rgba(255, 200, 80, 0.6);
      }
      .ship-nav-tri {
        width: 0; height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-bottom: 14px solid rgba(255, 220, 130, 0.92);
        filter: drop-shadow(0 0 6px rgba(255, 200, 80, 0.6));
        transform-origin: 50% 67%;
        /* Default points up (0deg); we rotate -90° in JS to point along +X. */
      }
      .ship-nav-label {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 10.5px; letter-spacing: 0.5px;
        color: #ffd28a;
        background: rgba(8, 12, 22, 0.7);
        border: 1px solid rgba(255, 220, 130, 0.35);
        border-radius: 3px;
        padding: 1px 6px; white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  } as Record<string, string>)[c]);
}
