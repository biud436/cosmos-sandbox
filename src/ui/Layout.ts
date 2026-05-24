import { SPECIES } from '../physics/types';
import { CosmicEvent, Effector, MoleculeEntry, Simulator } from '../physics/Simulator';
import { formatCosmicTime } from './timeFormat';

export class Layout {
  private readonly hierBody = document.getElementById('hier-body')!;
  private readonly presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
  private readonly btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
  private readonly btnStep = document.getElementById('btn-step') as HTMLButtonElement;
  private readonly btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
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

  constructor() {
    SPECIES;
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

    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        const paused = opts.onPauseToggle();
        this.setPausedUI(paused);
      } else if (e.code === 'Period') {
        opts.onStep();
      }
    });

    this.sScale.textContent = `×${opts.initialTimeScale}`;
  }

  private setPausedUI(paused: boolean): void {
    this.btnPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    this.btnStep.disabled = !paused;
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
    this.sTtarget.textContent = sim.targetTemperatureK.toFixed(0);
    this.sTmeas.textContent = stats.temperatureK.toFixed(1);
    this.sN.textContent = String(stats.count);
    this.sKE.textContent = stats.kineticEnergy.toFixed(1);
    this.sPE.textContent = stats.potentialEnergy.toFixed(1);
    this.sFus.textContent = String(stats.fusionEvents);
    this.sBonds.textContent = String(stats.bondCount);
    this.sBH.textContent = String(sim.effectors.length);
    this.sStars.textContent = String(stats.starsFormed);
    this.sA.textContent = stats.scaleFactor.toFixed(3);
    this.sDM.textContent = stats.darkMass.toFixed(0);
    this.sBary.textContent = stats.baryonMass.toFixed(1);
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
      const color = eff.type === 'star' ? '#ffd28a' : '#9affb2';
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
