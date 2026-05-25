import { SPECIES } from '../physics/types';
import { CosmicEvent, Effector, MoleculeEntry, Simulator } from '../physics/Simulator';
import { formatCosmicTime } from './timeFormat';

// Compact effector swatch colors for the catalog UI. Stars use a coarse
// spectral palette by mass so the list reads at a glance — bluest at top of
// rank, red/orange near the bottom.
function effectorSwatchColor(eff: Effector): string {
  if (eff.type === 'neutron_star') return '#a5d2ff';
  if (eff.type === 'blackhole') return '#ff9966';
  if (eff.type === 'nebula') return '#ff7ab2';
  if (eff.type === 'repulsor') return '#ff6644';
  if (eff.type === 'freezer') return '#aaddff';
  // star: rough mass→spectral mapping (matches Scene.ts shader palette)
  const m = eff.strength;
  if (m < 12)  return '#ff8c6b';
  if (m < 22)  return '#ffb780';
  if (m < 40)  return '#ffe5b5';
  if (m < 70)  return '#fafaf0';
  if (m < 130) return '#d2e0ff';
  return            '#a6c5ff';
}

export class Layout {
  private readonly hierBody = document.getElementById('hier-body')!;
  private readonly presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
  private readonly btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
  private readonly btnStep = document.getElementById('btn-step') as HTMLButtonElement;
  private readonly btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  private readonly btnShip = document.getElementById('btn-ship') as HTMLButtonElement;
  private readonly timeScaleSelect = document.getElementById('time-scale') as HTMLSelectElement;
  private readonly eventLog = document.getElementById('event-log')!;

  private readonly hudFps = document.getElementById('hud-fps')!;
  private readonly hudN = document.getElementById('hud-n')!;
  private readonly hudT = document.getElementById('hud-t')!;
  private readonly hudTime = document.getElementById('hud-time')!;
  private readonly sTime = document.getElementById('s-time')!;
  private readonly sScale = document.getElementById('s-scale')!;
  private readonly sTtarget = document.getElementById('s-ttarget')!;
  private readonly sTmeas = document.getElementById('s-tmeas')!;
  private readonly sN = document.getElementById('s-n')!;
  private readonly sKE = document.getElementById('s-ke')!;
  private readonly sPE = document.getElementById('s-pe')!;
  private readonly sFus = document.getElementById('s-fus')!;
  private readonly sBonds = document.getElementById('s-bonds')!;
  private readonly sBH = document.getElementById('s-bh')!;
  private readonly sStars = document.getElementById('s-stars')!;
  private readonly sA = document.getElementById('s-a')!;
  private readonly sDM = document.getElementById('s-dm')!;
  private readonly sBary = document.getElementById('s-bary')!;
  private readonly sNS = document.getElementById('s-ns')!;
  private readonly sNeb = document.getElementById('s-neb')!;
  private readonly sEra = document.getElementById('s-era')!;
  private readonly sHubble = document.getElementById('s-hubble')!;
  private readonly sMStar = document.getElementById('s-mstar')!;
  private readonly sMBH = document.getElementById('s-mbh')!;
  private readonly sZStars = document.getElementById('s-zstars')!;
  private readonly sZ = document.getElementById('s-z')!;
  private readonly sSfTotal = document.getElementById('s-sf-total')!;

  private readonly evIds: { id: string; key: keyof ReturnType<Simulator['stats']>['eventCounts']; el: HTMLElement }[] = [
    { id: 'ev-sn-typeII',       key: 'snTypeII',       el: null as unknown as HTMLElement },
    { id: 'ev-sn-ns',           key: 'snNS',           el: null as unknown as HTMLElement },
    { id: 'ev-sn-pair',         key: 'snPair',         el: null as unknown as HTMLElement },
    { id: 'ev-sn-direct',       key: 'snDirect',       el: null as unknown as HTMLElement },
    { id: 'ev-stellar-merger',  key: 'stellarMerger',  el: null as unknown as HTMLElement },
    { id: 'ev-bh-merger',       key: 'bhMerger',       el: null as unknown as HTMLElement },
    { id: 'ev-kilonova',        key: 'kilonova',       el: null as unknown as HTMLElement },
    { id: 'ev-star-consumed',   key: 'starConsumed',   el: null as unknown as HTMLElement },
    { id: 'ev-nebula-merger',   key: 'nebulaMerger',   el: null as unknown as HTMLElement },
  ];
  private readonly viewport = document.getElementById('viewport')!;

  private hierRows = new Map<string, { dot: HTMLElement; name: HTMLElement; count: HTMLElement; row: HTMLElement }>();
  private starBody = document.getElementById('star-body')!;
  private starRows = new Map<Effector, HTMLElement>();
  private historyBody = document.getElementById('history-body')!;
  private renderedHistoryCount = 0;
  private banner = document.getElementById('event-banner')!;
  private bannerTimer: number | null = null;
  private yearsPerUnit = 10;
  private onSelectEffector: ((eff: Effector) => void) | null = null;

  // Time-series buffer for the population mini-chart. Each updateStats tick
  // pushes one sample; we keep a small rolling window so the chart stays
  // legible without unbounded memory growth.
  private readonly tsCanvas = document.getElementById('ts-chart') as HTMLCanvasElement;
  private readonly tsLegend = document.getElementById('ts-legend')!;
  private readonly tsSeries = [
    { key: 'stars',   label: '★ 별',     color: '#ffe5b5', data: [] as number[] },
    { key: 'bh',      label: '● BH',     color: '#ff9966', data: [] as number[] },
    { key: 'ns',      label: '⚪ NS',    color: '#a5d2ff', data: [] as number[] },
    { key: 'nebulae', label: '☁ 성운',   color: '#ff7ab2', data: [] as number[] },
  ];
  private readonly tsCapacity = 240;
  private tsLegendBuilt = false;

  // Spectral-class histogram of currently-alive stars. Bins match the color
  // table in Scene.ts / effectorSwatchColor (this file).
  private readonly massBins = [
    { label: 'M', upper: 12,       color: '#ff8c6b' },
    { label: 'K', upper: 22,       color: '#ffb780' },
    { label: 'G', upper: 40,       color: '#ffe5b5' },
    { label: 'F/A', upper: 70,     color: '#fafaf0' },
    { label: 'B', upper: 130,      color: '#d2e0ff' },
    { label: 'O', upper: Infinity, color: '#a6c5ff' },
  ];
  private readonly massCanvas = document.getElementById('mass-hist') as HTMLCanvasElement;
  private readonly massLegend = document.getElementById('mass-hist-legend')!;
  private massLegendBuilt = false;

  constructor() {
    SPECIES;
    for (const e of this.evIds) {
      e.el = document.getElementById(e.id)!;
    }
  }

  private updateHierarchy(entries: MoleculeEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.label);
      let row = this.hierRows.get(entry.label);
      if (!row) {
        const rowEl = document.createElement('div');
        rowEl.className = 'hier-row';
        const dot = document.createElement('span');
        dot.className = 'hier-dot';
        const name = document.createElement('span');
        name.className = 'hier-name';
        const count = document.createElement('span');
        count.className = 'hier-count';
        rowEl.append(dot, name, count);
        this.hierBody.appendChild(rowEl);
        row = { dot, name, count, row: rowEl };
        this.hierRows.set(entry.label, row);
      }
      const hex = '#' + entry.color.toString(16).padStart(6, '0');
      row.dot.style.background = hex;
      row.dot.style.boxShadow = `0 0 6px ${hex}`;
      row.name.textContent = entry.label;
      row.count.textContent = `${entry.count} · M ${entry.mass.toFixed(0)}`;
      this.hierBody.appendChild(row.row);
    }
    for (const [label, row] of this.hierRows) {
      if (!seen.has(label)) {
        row.row.remove();
        this.hierRows.delete(label);
      }
    }
  }

  bindToolbar(opts: {
    presets: string[];
    initialPreset: string;
    initialTimeScale: number;
    onPreset: (name: string) => void;
    onPauseToggle: () => boolean;
    onStep: () => void;
    onReset: () => void;
    onTimeScale: (scale: number) => void;
    onToggleOrbits?: () => void;
    onToggleShip?: () => boolean;
  }): void {
    this.presetSelect.innerHTML = '';
    for (const name of opts.presets) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      if (name === opts.initialPreset) o.selected = true;
      this.presetSelect.appendChild(o);
    }
    this.presetSelect.addEventListener('change', () => opts.onPreset(this.presetSelect.value));

    this.timeScaleSelect.value = String(opts.initialTimeScale);
    this.timeScaleSelect.addEventListener('change', () => {
      const v = parseFloat(this.timeScaleSelect.value);
      opts.onTimeScale(v);
      this.sScale.textContent = `×${v}`;
    });

    this.btnPause.addEventListener('click', () => {
      const paused = opts.onPauseToggle();
      this.setPausedUI(paused);
    });
    this.btnStep.addEventListener('click', () => opts.onStep());
    this.btnReset.addEventListener('click', () => opts.onReset());
    if (opts.onToggleShip && this.btnShip) {
      this.btnShip.addEventListener('click', () => {
        const isShip = opts.onToggleShip!();
        this.setShipUI(isShip);
      });
    }

    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        const paused = opts.onPauseToggle();
        this.setPausedUI(paused);
      } else if (e.code === 'Period') {
        opts.onStep();
      } else if (e.code === 'KeyT' && opts.onToggleOrbits) {
        opts.onToggleOrbits();
      }
    });

    this.sScale.textContent = `×${opts.initialTimeScale}`;
  }

  private setPausedUI(paused: boolean): void {
    this.btnPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    this.btnStep.disabled = !paused;
  }

  setShipUI(isShipMode: boolean): void {
    if (!this.btnShip) return;
    this.btnShip.textContent = isShipMode ? '시뮬 복귀' : '우주선 조종';
    this.btnShip.title = isShipMode ? '시뮬레이션 시점으로 복귀' : '우주선 조종 모드로 전환';
  }

  setPreset(name: string): void {
    if (this.presetSelect.value !== name) this.presetSelect.value = name;
  }

  setTimeScale(scale: number): void {
    const v = String(scale);
    if (this.timeScaleSelect.value !== v) this.timeScaleSelect.value = v;
    this.sScale.textContent = `×${scale}`;
  }

  setYearsPerUnit(yearsPerUnit: number): void {
    this.yearsPerUnit = yearsPerUnit;
  }

  updateStats(sim: Simulator, fps: number): void {
    const stats = sim.stats();
    this.updateHierarchy(sim.getMoleculeBreakdown());
    this.updateStarCatalog(sim.effectors);
    this.updateHistory(sim.firedEvents);

    this.hudFps.textContent = fps.toFixed(0);
    this.hudN.textContent = String(stats.count);
    this.hudT.textContent = stats.temperatureK.toFixed(0);
    const years = stats.simTime * this.yearsPerUnit;
    const formatted = formatCosmicTime(years);
    this.hudTime.textContent = formatted;

    this.sTime.textContent = formatted;
    this.sEra.textContent = stats.currentEra;
    this.sA.textContent = stats.scaleFactor.toFixed(3);
    this.sHubble.textContent = stats.hubbleRate.toFixed(4);

    this.sTtarget.textContent = sim.targetTemperatureK.toFixed(0);
    this.sTmeas.textContent = stats.temperatureK.toFixed(1);
    this.sN.textContent = String(stats.count);
    this.sKE.textContent = stats.kineticEnergy.toFixed(1);
    this.sPE.textContent = stats.potentialEnergy.toFixed(1);
    this.sBonds.textContent = String(stats.bondCount);

    this.sStars.textContent = String(stats.starsAlive);
    this.sNS.textContent = String(stats.neutronStars);
    this.sBH.textContent = String(stats.blackHoles);
    this.sNeb.textContent = String(stats.nebulae);
    this.sMStar.textContent = stats.totalStarMass.toFixed(0);
    this.sMBH.textContent = stats.totalBHMass.toFixed(0);
    this.sSfTotal.textContent = String(stats.starsFormed);

    this.sZStars.textContent = stats.meanStellarMetallicity.toFixed(3);
    this.sZ.textContent = stats.globalMetallicity.toFixed(3);

    this.sDM.textContent = stats.darkMass.toFixed(0);
    this.sBary.textContent = stats.baryonMass.toFixed(1);
    this.sFus.textContent = String(stats.fusionEvents);

    for (const e of this.evIds) {
      e.el.textContent = String(stats.eventCounts[e.key]);
    }

    this.pushTimeSeriesSample(stats);
    this.drawTimeSeriesChart();
    this.drawMassHistogram(sim.effectors);
  }

  private drawMassHistogram(effectors: Effector[]): void {
    if (!this.massCanvas) return;
    const ctx = this.massCanvas.getContext('2d');
    if (!ctx) return;

    // Bin alive stars by spectral class
    const counts = new Array(this.massBins.length).fill(0) as number[];
    let total = 0;
    for (const e of effectors) {
      if (e.type !== 'star') continue;
      const m = e.strength;
      for (let i = 0; i < this.massBins.length; i++) {
        if (m < this.massBins[i].upper) { counts[i]++; total++; break; }
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = this.massCanvas.clientWidth;
    const cssH = this.massCanvas.clientHeight;
    if (this.massCanvas.width !== cssW * dpr || this.massCanvas.height !== cssH * dpr) {
      this.massCanvas.width = cssW * dpr;
      this.massCanvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!this.massLegendBuilt) {
      this.massLegend.innerHTML = '';
      for (const b of this.massBins) {
        const span = document.createElement('span');
        span.style.color = b.color;
        span.textContent = b.label;
        this.massLegend.appendChild(span);
      }
      this.massLegendBuilt = true;
    }

    if (total === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('아직 형성된 별 없음', 8, cssH / 2);
      return;
    }

    // Stacked horizontal bar: width per bin ∝ count / total
    let x = 0;
    for (let i = 0; i < this.massBins.length; i++) {
      const w = (counts[i] / total) * cssW;
      if (w < 0.5) { x += w; continue; }
      ctx.fillStyle = this.massBins[i].color;
      ctx.fillRect(x, 0, w, cssH);
      if (w > 22) {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(counts[i]), x + 4, cssH / 2);
      }
      x += w;
    }
  }

  private pushTimeSeriesSample(stats: ReturnType<Simulator['stats']>): void {
    const values = [stats.starsAlive, stats.blackHoles, stats.neutronStars, stats.nebulae];
    for (let i = 0; i < this.tsSeries.length; i++) {
      const s = this.tsSeries[i];
      s.data.push(values[i]);
      if (s.data.length > this.tsCapacity) s.data.shift();
    }
  }

  private drawTimeSeriesChart(): void {
    if (!this.tsCanvas) return;
    const ctx = this.tsCanvas.getContext('2d');
    if (!ctx) return;

    // Match backing-store resolution to CSS size for crisp lines
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.tsCanvas.clientWidth;
    const cssH = this.tsCanvas.clientHeight;
    if (this.tsCanvas.width !== cssW * dpr || this.tsCanvas.height !== cssH * dpr) {
      this.tsCanvas.width = cssW * dpr;
      this.tsCanvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Build legend once
    if (!this.tsLegendBuilt) {
      this.tsLegend.innerHTML = '';
      for (const s of this.tsSeries) {
        const span = document.createElement('span');
        span.style.color = s.color;
        span.textContent = s.label;
        this.tsLegend.appendChild(span);
      }
      this.tsLegendBuilt = true;
    }

    // Y-axis autoscale (shared across series so they're comparable)
    let maxV = 1;
    for (const s of this.tsSeries) {
      for (const v of s.data) if (v > maxV) maxV = v;
    }

    const padX = 4;
    const padY = 4;
    const plotW = cssW - padX * 2;
    const plotH = cssH - padY * 2;

    // Baseline + ceiling guide lines (subtle)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, cssH - padY);
    ctx.lineTo(cssW - padX, cssH - padY);
    ctx.moveTo(padX, padY);
    ctx.lineTo(cssW - padX, padY);
    ctx.stroke();

    // Series plots
    for (const s of this.tsSeries) {
      if (s.data.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const n = s.data.length;
      for (let i = 0; i < n; i++) {
        const t = (n - 1) === 0 ? 0 : i / (n - 1);
        const x = padX + t * plotW;
        const y = padY + plotH - (s.data[i] / maxV) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Y-axis max label
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(String(Math.round(maxV)), padX + 2, padY + 1);
  }

  setDropHighlight(active: boolean): void {
    this.viewport.classList.toggle('drop-target', active);
  }

  private updateHistory(fired: { event: CosmicEvent; firedAt: number }[]): void {
    if (fired.length < this.renderedHistoryCount) {
      this.historyBody.innerHTML = '';
      this.renderedHistoryCount = 0;
    }
    for (let i = this.renderedHistoryCount; i < fired.length; i++) {
      const { event, firedAt } = fired[i];
      const row = document.createElement('div');
      row.className = 'hist-row';
      const years = firedAt * this.yearsPerUnit;
      const yearStr = formatCosmicTime(years);
      row.innerHTML = `<div class="hist-time">t = ${yearStr}</div><div class="hist-name">◆ ${event.name}</div><div class="hist-desc">${event.description}</div>`;
      this.historyBody.appendChild(row);
    }
    this.renderedHistoryCount = fired.length;
  }

  showEvent(ev: CosmicEvent): void {
    this.banner.innerHTML = `<div class="ev-name">${ev.name}</div><div class="ev-desc">${ev.description}</div>`;
    this.banner.classList.add('show');
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), 3800);
  }

  setEffectorClickHandler(handler: (eff: Effector) => void): void {
    this.onSelectEffector = handler;
  }

  private updateStarCatalog(effectors: Effector[]): void {
    const seen = new Set<Effector>();
    const named = effectors.filter((e) => !!e.name);
    named.sort((a, b) => b.strength - a.strength);
    let rank = 0;
    for (const eff of named) {
      rank++;
      seen.add(eff);
      let row = this.starRows.get(eff);
      if (!row) {
        row = document.createElement('div');
        row.className = 'star-row';
        const rankEl = document.createElement('span');
        rankEl.className = 'star-rank';
        const dot = document.createElement('span');
        dot.className = 'star-dot';
        const name = document.createElement('span');
        name.className = 'star-name';
        const mass = document.createElement('span');
        mass.className = 'star-mass';
        row.append(rankEl, dot, name, mass);
        row.addEventListener('click', () => this.onSelectEffector?.(eff));
        this.starBody.appendChild(row);
        this.starRows.set(eff, row);
      }
      const rankEl = row.children[0] as HTMLElement;
      const dot = row.children[1] as HTMLElement;
      const nameEl = row.children[2] as HTMLElement;
      const massEl = row.children[3] as HTMLElement;
      rankEl.textContent = `#${rank}`;
      const color = effectorSwatchColor(eff);
      dot.style.background = color;
      dot.style.boxShadow = `0 0 6px ${color}`;
      nameEl.textContent = eff.name || '';
      massEl.textContent = `M ${eff.strength.toFixed(0)}`;
      this.starBody.appendChild(row);
    }
    for (const [eff, row] of this.starRows) {
      if (!seen.has(eff)) {
        row.remove();
        this.starRows.delete(eff);
      }
    }
  }

  log(message: string, kind: 'info' | 'event' = 'info'): void {
    const line = document.createElement('div');
    if (kind === 'event') line.className = 'ev';
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${message}`;
    this.eventLog.prepend(line);
    while (this.eventLog.childElementCount > 40) {
      this.eventLog.lastElementChild?.remove();
    }
  }

  get guiHost(): HTMLElement {
    return document.getElementById('gui-host')!;
  }
}
