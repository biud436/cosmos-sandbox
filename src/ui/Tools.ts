import { EffectorType } from '../physics/Simulator';

export interface ToolsCallbacks {
  isInsideViewport: (clientX: number, clientY: number) => boolean;
  worldFromScreen: (clientX: number, clientY: number) => [number, number, number] | null;
  onPlace: (type: EffectorType, position: [number, number, number]) => void;
  onClearAll: () => void;
  setViewportDropHighlight: (active: boolean) => void;
}

const TOOLS: { type: EffectorType; label: string }[] = [
  { type: 'blackhole', label: 'Black Hole' },
  { type: 'star',      label: 'Star' },
  { type: 'repulsor',  label: 'Repulsor' },
  { type: 'freezer',   label: 'Freezer' },
];

export class Tools {
  private ghost: HTMLElement | null = null;
  private ghostCanvas: HTMLCanvasElement | null = null;
  private dragging: EffectorType | null = null;
  private animationStart = performance.now();
  private buttons: { type: EffectorType; el: HTMLElement; canvas: HTMLCanvasElement }[] = [];

  constructor(private cb: ToolsCallbacks) {
    this.render();
    this.startCanvasAnimation();
  }

  private render(): void {
    const body = document.getElementById('tools-body')!;
    body.innerHTML = '';
    for (const t of TOOLS) {
      const el = document.createElement('div');
      el.className = 'tool-btn';
      el.dataset.type = t.type;
      el.title = `드래그하여 ${t.label} 배치 · 뷰포트에서 클릭으로 선택`;
      const canvas = document.createElement('canvas');
      canvas.className = 'tool-canvas';
      canvas.width = 56;
      canvas.height = 56;
      const label = document.createElement('span');
      label.className = 'tool-label';
      label.textContent = t.label;
      el.append(canvas, label);
      body.appendChild(el);
      this.bindDrag(el, t.type);
      this.buttons.push({ type: t.type, el, canvas });
    }
    const clearBtn = document.createElement('button');
    clearBtn.className = 'tool-action';
    clearBtn.id = 'tool-clear-all';
    clearBtn.title = '모든 효과기 제거';
    clearBtn.textContent = 'Clear All';
    clearBtn.addEventListener('click', () => this.cb.onClearAll());
    body.appendChild(clearBtn);
  }

  private startCanvasAnimation(): void {
    const draw = () => {
      const t = (performance.now() - this.animationStart) / 1000;
      for (const b of this.buttons) drawEffector(b.canvas, t, b.type);
      if (this.ghostCanvas && this.dragging) drawEffector(this.ghostCanvas, t, this.dragging);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  private bindDrag(el: HTMLElement, type: EffectorType): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.beginDrag(type, e.clientX, e.clientY);
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.updateGhost(e.clientX, e.clientY);
      this.cb.setViewportDropHighlight(this.cb.isInsideViewport(e.clientX, e.clientY));
    });
    el.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      this.endDrag(e.clientX, e.clientY);
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener('pointercancel', () => this.cancelDrag());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dragging) this.cancelDrag();
    });
  }

  private beginDrag(type: EffectorType, x: number, y: number): void {
    this.dragging = type;
    for (const b of this.buttons) if (b.type === type) b.el.classList.add('dragging');
    const ghost = document.createElement('div');
    ghost.className = 'tool-ghost';
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    ghost.appendChild(c);
    document.body.appendChild(ghost);
    this.ghost = ghost;
    this.ghostCanvas = c;
    this.updateGhost(x, y);
  }

  private updateGhost(x: number, y: number): void {
    if (!this.ghost) return;
    this.ghost.style.left = `${x}px`;
    this.ghost.style.top = `${y}px`;
  }

  private endDrag(x: number, y: number): void {
    const type = this.dragging;
    this.dragging = null;
    for (const b of this.buttons) b.el.classList.remove('dragging');
    this.cb.setViewportDropHighlight(false);
    if (type && this.cb.isInsideViewport(x, y)) {
      const pos = this.cb.worldFromScreen(x, y);
      if (pos) this.cb.onPlace(type, pos);
    }
    this.removeGhost();
  }

  private cancelDrag(): void {
    this.dragging = null;
    for (const b of this.buttons) b.el.classList.remove('dragging');
    this.cb.setViewportDropHighlight(false);
    this.removeGhost();
  }

  private removeGhost(): void {
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
      this.ghostCanvas = null;
    }
  }
}

function drawEffector(canvas: HTMLCanvasElement, t: number, type: EffectorType): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(cx, cy);
  ctx.clearRect(0, 0, w, h);

  switch (type) {
    case 'blackhole': drawBlackHole(ctx, cx, cy, R, t); break;
    case 'star':      drawStar(ctx, cx, cy, R, t); break;
    case 'repulsor':  drawRepulsor(ctx, cx, cy, R, t); break;
    case 'freezer':   drawFreezer(ctx, cx, cy, R, t); break;
  }
}

function drawBlackHole(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number): void {
  const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R);
  halo.addColorStop(0, 'rgba(255, 200, 110, 0.0)');
  halo.addColorStop(0.55, 'rgba(255, 150, 70, 0.25)');
  halo.addColorStop(0.9, 'rgba(255, 90, 40, 0.0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, cx * 2, cy * 2);
  const ringInner = R * 0.55;
  const ringOuter = R * 0.95;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const swirl = Math.sin(a * 5 - t * 4 + Math.cos(a * 2 + t) * 2);
    const r = ringInner + (ringOuter - ringInner) * (0.5 + 0.5 * swirl);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.45;
    const alpha = 0.45 + 0.5 * Math.max(0, swirl);
    ctx.fillStyle = `rgba(255, ${120 + Math.floor(110 * (swirl * 0.5 + 0.5))}, ${40 + Math.floor(60 * Math.max(0, swirl))}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42);
  core.addColorStop(0, '#000');
  core.addColorStop(0.8, '#000');
  core.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number): void {
  const pulse = 0.85 + 0.15 * Math.sin(t * 3);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * pulse);
  halo.addColorStop(0, 'rgba(255, 245, 200, 0.95)');
  halo.addColorStop(0.35, 'rgba(255, 200, 120, 0.6)');
  halo.addColorStop(0.7, 'rgba(255, 130, 60, 0.25)');
  halo.addColorStop(1, 'rgba(255, 80, 30, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, cx * 2, cy * 2);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.3);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const len = R * (0.7 + 0.3 * Math.sin(t * 2 + i));
    ctx.strokeStyle = `rgba(255, 230, 150, ${0.4 + 0.3 * Math.sin(t * 4 + i)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.4);
  core.addColorStop(0, 'rgba(255, 255, 230, 1)');
  core.addColorStop(0.7, 'rgba(255, 200, 100, 0.9)');
  core.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawRepulsor(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number): void {
  for (let i = 0; i < 3; i++) {
    const phase = (t * 0.8 + i / 3) % 1;
    const r = R * phase;
    const alpha = (1 - phase) * 0.7;
    ctx.strokeStyle = `rgba(255, 110, 70, ${alpha})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.35);
  core.addColorStop(0, 'rgba(255, 200, 150, 1)');
  core.addColorStop(0.6, 'rgba(255, 100, 60, 0.85)');
  core.addColorStop(1, 'rgba(255, 60, 30, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 1.5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.fillStyle = `rgba(255, 180, 120, 0.8)`;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * R * 0.2, Math.sin(a) * R * 0.2);
    ctx.lineTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
    ctx.lineTo(Math.cos(a + 0.3) * R * 0.25, Math.sin(a + 0.3) * R * 0.25);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawFreezer(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.4);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.strokeStyle = `rgba(160, 220, 255, 0.85)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * R * 0.85, Math.sin(a) * R * 0.85);
    ctx.stroke();
    for (let s = 0; s < 2; s++) {
      const o = R * (0.4 + s * 0.25);
      const px = Math.cos(a) * o;
      const py = Math.sin(a) * o;
      const len = R * 0.18;
      const a1 = a + 0.7;
      const a2 = a - 0.7;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a1) * len, py + Math.sin(a1) * len);
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a2) * len, py + Math.sin(a2) * len);
      ctx.stroke();
    }
  }
  ctx.restore();
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.45);
  core.addColorStop(0, 'rgba(220, 240, 255, 0.95)');
  core.addColorStop(0.6, 'rgba(140, 200, 255, 0.4)');
  core.addColorStop(1, 'rgba(80, 150, 220, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.45, 0, Math.PI * 2);
  ctx.fill();
}
