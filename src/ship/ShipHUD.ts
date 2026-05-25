import * as THREE from 'three';
import { Effector } from '../physics/Simulator';
import { ShipState } from './ShipController';

export interface HUDTarget {
  kind: 'planet' | 'star';
  label: string;
  getPosition: () => THREE.Vector3;
  radius: number;
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
  private readonly gizmoCanvas: HTMLCanvasElement;
  private readonly gizmoCtx: CanvasRenderingContext2D;
  private readonly hintEl: HTMLElement;
  private readonly faBadge: HTMLElement;
  private readonly orbitBadge: HTMLElement;
  private readonly targetBracket: HTMLElement;

  private visible_ = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ship-hud';
    this.root.innerHTML = `
      <div class="ship-hud-tl">
        <div class="ship-hud-row"><span class="ship-hud-k">POS</span><span class="ship-hud-v" id="ship-pos">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">VEL</span><span class="ship-hud-v" id="ship-vel">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">|v|</span><span class="ship-hud-v" id="ship-spd">—</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">NEAR</span><span class="ship-hud-v" id="ship-near">탐색 중…</span></div>
        <div class="ship-hud-row"><span class="ship-hud-k">TGT</span><span class="ship-hud-v" id="ship-tgt">—</span></div>
      </div>
      <div class="ship-hud-tr">
        <canvas id="ship-gizmo" width="96" height="96"></canvas>
        <div class="ship-hud-badges">
          <span class="ship-badge" id="ship-badge-fa">FA</span>
          <span class="ship-badge orbit" id="ship-badge-orbit" style="display:none">ORBIT</span>
        </div>
      </div>
      <div class="ship-hud-bc">
        <div class="ship-thr-label">THROTTLE</div>
        <div class="ship-thr-bar"><div class="ship-thr-fill" id="ship-thr-fill"></div></div>
      </div>
      <div class="ship-hud-hint" id="ship-hud-hint">
        클릭하여 마우스 잠금 · WASD 이동 · Q/E 롤 · R/F 상하 · Shift 부스트 · X 정지 · Space 비행보조 · G 궤도 · ESC 메뉴
      </div>
      <div class="ship-reticle"></div>
      <div class="ship-target-bracket" id="ship-target-bracket" style="display:none"></div>
    `;
    container.appendChild(this.root);
    this.posEl = this.root.querySelector('#ship-pos') as HTMLElement;
    this.velEl = this.root.querySelector('#ship-vel') as HTMLElement;
    this.spdEl = this.root.querySelector('#ship-spd') as HTMLElement;
    this.thrFill = this.root.querySelector('#ship-thr-fill') as HTMLElement;
    this.nearestEl = this.root.querySelector('#ship-near') as HTMLElement;
    this.tgtEl = this.root.querySelector('#ship-tgt') as HTMLElement;
    this.gizmoCanvas = this.root.querySelector('#ship-gizmo') as HTMLCanvasElement;
    this.gizmoCtx = this.gizmoCanvas.getContext('2d')!;
    this.hintEl = this.root.querySelector('#ship-hud-hint') as HTMLElement;
    this.faBadge = this.root.querySelector('#ship-badge-fa') as HTMLElement;
    this.orbitBadge = this.root.querySelector('#ship-badge-orbit') as HTMLElement;
    this.targetBracket = this.root.querySelector('#ship-target-bracket') as HTMLElement;

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

  /** Called every frame while ship mode is active. */
  update(
    state: ShipState,
    camera: THREE.PerspectiveCamera,
    nearestStar: { eff: Effector; distance: number } | null,
    target: HUDTarget | null,
    flightAssist: boolean,
    orbiting: { label: string; radius: number } | null,
  ): void {
    if (!this.visible_) return;
    const p = state.position;
    this.posEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    const v = state.velocity;
    this.velEl.textContent = `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
    this.spdEl.textContent = `${state.speed.toFixed(2)} u/s${state.boosting ? ' · BOOST' : ''}`;
    this.thrFill.style.width = `${(state.throttleNormalized * 100).toFixed(1)}%`;
    if (state.boosting) this.thrFill.classList.add('boost');
    else this.thrFill.classList.remove('boost');

    if (nearestStar) {
      const name = nearestStar.eff.name ?? `${nearestStar.eff.type}`;
      this.nearestEl.textContent = `${name} · ${nearestStar.distance.toFixed(1)} u`;
    } else {
      this.nearestEl.textContent = '—';
    }

    if (target) {
      const tp = target.getPosition();
      const dist = tp.distanceTo(state.position);
      this.tgtEl.innerHTML = `<b>${escapeText(target.label)}</b> · ${dist.toFixed(1)} u · <span class="ship-key">G</span> 궤도`;
      this.updateTargetBracket(target, camera);
    } else {
      this.tgtEl.textContent = '레티클을 별/행성에 맞추세요';
      this.targetBracket.style.display = 'none';
    }

    // FA / ORBIT badges
    this.faBadge.classList.toggle('off', !flightAssist);
    this.faBadge.textContent = flightAssist ? 'FA' : 'FA OFF';
    if (orbiting) {
      this.orbitBadge.style.display = '';
      this.orbitBadge.textContent = `ORBIT · ${orbiting.label}`;
    } else {
      this.orbitBadge.style.display = 'none';
    }

    this.drawGizmo(camera);
  }

  private updateTargetBracket(target: HUDTarget, camera: THREE.PerspectiveCamera): void {
    // Project the target into NDC and place a bracket overlay. If behind the
    // camera, hide it instead of drawing on the wrong side.
    const p = target.getPosition().project(camera);
    if (p.z > 1 || p.z < -1) { this.targetBracket.style.display = 'none'; return; }
    const cx = (p.x * 0.5 + 0.5) * this.root.clientWidth;
    const cy = (-p.y * 0.5 + 0.5) * this.root.clientHeight;
    this.targetBracket.style.display = '';
    this.targetBracket.style.left = `${cx}px`;
    this.targetBracket.style.top  = `${cy}px`;
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
      .ship-hud-tr {
        position: relative;
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
    `;
    document.head.appendChild(style);
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  } as Record<string, string>)[c]);
}
