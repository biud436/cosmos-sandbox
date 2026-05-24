export interface ToolsCallbacks {
  isInsideViewport: (clientX: number, clientY: number) => boolean;
  worldFromScreen: (clientX: number, clientY: number) => [number, number, number] | null;
  onPlaceBlackHole: (position: [number, number, number]) => void;
  onClearBlackHoles: () => void;
  setViewportDropHighlight: (active: boolean) => void;
}

export class Tools {
  private readonly button = document.getElementById('tool-blackhole') as HTMLElement;
  private readonly canvas = this.button.querySelector('canvas') as HTMLCanvasElement;
  private readonly clearBtn = document.getElementById('tool-clear-bh') as HTMLButtonElement;
  private ghost: HTMLElement | null = null;
  private ghostCanvas: HTMLCanvasElement | null = null;
  private dragging = false;
  private animationStart = performance.now();

  constructor(private cb: ToolsCallbacks) {
    this.startCanvasAnimation();
    this.bindDrag();
    this.clearBtn.addEventListener('click', () => this.cb.onClearBlackHoles());
  }

  private startCanvasAnimation(): void {
    const draw = () => {
      const t = (performance.now() - this.animationStart) / 1000;
      this.drawBlackHole(this.canvas, t);
      if (this.ghostCanvas) this.drawBlackHole(this.ghostCanvas, t);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  private drawBlackHole(canvas: HTMLCanvasElement, t: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(cx, cy);
    ctx.clearRect(0, 0, w, h);

    const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R);
    halo.addColorStop(0, 'rgba(255, 200, 110, 0.0)');
    halo.addColorStop(0.55, 'rgba(255, 150, 70, 0.25)');
    halo.addColorStop(0.9, 'rgba(255, 90, 40, 0.0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    const ringInner = R * 0.55;
    const ringOuter = R * 0.95;
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const swirl = Math.sin(a * 5 - t * 4 + Math.cos(a * 2 + t) * 2);
      const r = ringInner + (ringOuter - ringInner) * (0.5 + 0.5 * swirl);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.45;
      const alpha = 0.45 + 0.5 * Math.max(0, swirl);
      const r255 = 255;
      const g255 = 120 + Math.floor(110 * (swirl * 0.5 + 0.5));
      const b255 = 40 + Math.floor(60 * Math.max(0, swirl));
      ctx.fillStyle = `rgba(${r255}, ${g255}, ${b255}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const coreR = R * 0.38;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.1);
    core.addColorStop(0, '#000');
    core.addColorStop(0.8, '#000');
    core.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  private bindDrag(): void {
    this.button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.beginDrag(e.clientX, e.clientY);
      this.button.setPointerCapture(e.pointerId);
    });
    this.button.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.updateGhost(e.clientX, e.clientY);
      this.cb.setViewportDropHighlight(this.cb.isInsideViewport(e.clientX, e.clientY));
    });
    this.button.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      this.endDrag(e.clientX, e.clientY);
      this.button.releasePointerCapture(e.pointerId);
    });
    this.button.addEventListener('pointercancel', () => this.cancelDrag());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dragging) this.cancelDrag();
    });
  }

  private beginDrag(x: number, y: number): void {
    this.dragging = true;
    this.button.classList.add('dragging');
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
    this.dragging = false;
    this.button.classList.remove('dragging');
    this.cb.setViewportDropHighlight(false);
    if (this.cb.isInsideViewport(x, y)) {
      const pos = this.cb.worldFromScreen(x, y);
      if (pos) this.cb.onPlaceBlackHole(pos);
    }
    this.removeGhost();
  }

  private cancelDrag(): void {
    this.dragging = false;
    this.button.classList.remove('dragging');
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
