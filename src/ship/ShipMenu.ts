import { Dex, DexPlanetEntry, DexStarEntry } from './Dex';
import { planetClassLabel } from './PlanetSystem';

// In-ship menu opened by ESC. Modal overlay with tabs:
//   별 도감 / 행성 도감 / 설정 / 시뮬 복귀
//
// The menu releases pointer-lock (so the cursor is usable) and re-acquires
// it when closed. Sim time stays in ship-mode rules — opening the menu
// does NOT pause the world (player can leave it open and watch the sky).

export type ShipMenuTab = 'stars' | 'planets' | 'settings';

export interface ShipMenuCallbacks {
  onSelectStar: (entry: DexStarEntry) => void;
  onSelectPlanet: (entry: DexPlanetEntry) => void;
  onExitShipMode: () => void;
  onResetDex: () => void;
}

export class ShipMenu {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: Record<ShipMenuTab, HTMLElement>;
  private readonly statStars: HTMLElement;
  private readonly statPlanets: HTMLElement;
  private currentTab: ShipMenuTab = 'stars';
  private open_ = false;
  private callbacks: ShipMenuCallbacks | null = null;
  private dex: Dex | null = null;

  constructor(container: HTMLElement) {
    this.injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'ship-menu';
    this.root.innerHTML = `
      <div class="ship-menu-card">
        <div class="ship-menu-header">
          <div class="ship-menu-title">⏸ 우주선 메뉴</div>
          <div class="ship-menu-stats">
            <span>★ <b id="ship-menu-stars">0</b></span>
            <span>· 🪐 <b id="ship-menu-planets">0</b></span>
          </div>
        </div>
        <div class="ship-menu-tabs">
          <button data-tab="stars" class="ship-menu-tab active">★ 별 도감</button>
          <button data-tab="planets" class="ship-menu-tab">🪐 행성 도감</button>
          <button data-tab="settings" class="ship-menu-tab">⚙ 설정</button>
        </div>
        <div class="ship-menu-body" id="ship-menu-body"></div>
        <div class="ship-menu-footer">
          <button class="ship-menu-action" id="ship-menu-resume">▶ 우주선으로 복귀 (Tab)</button>
          <button class="ship-menu-action ghost" id="ship-menu-exit">🌌 시뮬레이션 시점으로</button>
        </div>
      </div>
    `;
    container.appendChild(this.root);
    this.body = this.root.querySelector('#ship-menu-body') as HTMLElement;
    this.statStars = this.root.querySelector('#ship-menu-stars') as HTMLElement;
    this.statPlanets = this.root.querySelector('#ship-menu-planets') as HTMLElement;
    this.tabs = {
      stars:    this.root.querySelector('[data-tab="stars"]')    as HTMLElement,
      planets:  this.root.querySelector('[data-tab="planets"]')  as HTMLElement,
      settings: this.root.querySelector('[data-tab="settings"]') as HTMLElement,
    };
    for (const tab of Object.keys(this.tabs) as ShipMenuTab[]) {
      this.tabs[tab].addEventListener('click', () => this.setTab(tab));
    }
    (this.root.querySelector('#ship-menu-resume') as HTMLElement).addEventListener('click', () => this.close());
    (this.root.querySelector('#ship-menu-exit') as HTMLElement).addEventListener('click', () => {
      this.close();
      this.callbacks?.onExitShipMode();
    });
    this.setVisible(false);
  }

  bind(dex: Dex, callbacks: ShipMenuCallbacks): void {
    this.dex = dex;
    this.callbacks = callbacks;
  }

  get isOpen(): boolean { return this.open_; }

  toggle(): void { this.open_ ? this.close() : this.open(); }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    // Release pointer-lock so the cursor can hit menu buttons.
    if (document.pointerLockElement) document.exitPointerLock();
    this.setVisible(true);
    this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.setVisible(false);
  }

  private setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  private setTab(tab: ShipMenuTab): void {
    this.currentTab = tab;
    for (const t of Object.keys(this.tabs) as ShipMenuTab[]) {
      this.tabs[t].classList.toggle('active', t === tab);
    }
    this.refresh();
  }

  private refresh(): void {
    if (!this.dex) return;
    this.statStars.textContent = String(this.dex.starCount());
    this.statPlanets.textContent = String(this.dex.planetCount());
    if (this.currentTab === 'stars') this.renderStars();
    else if (this.currentTab === 'planets') this.renderPlanets();
    else this.renderSettings();
  }

  private renderStars(): void {
    if (!this.dex) return;
    const entries = this.dex.starsArray();
    entries.sort((a, b) => b.firstSeenWall - a.firstSeenWall);
    this.body.innerHTML = '';
    if (entries.length === 0) {
      this.body.innerHTML = `<div class="ship-menu-empty">아직 방문한 별이 없습니다.<br/>별 근처로 비행하면 자동으로 등록됩니다.</div>`;
      return;
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = `dex-row${e.alive ? '' : ' dead'}`;
      row.innerHTML = `
        <div class="dex-row-main">
          <div class="dex-row-name">${escapeHtml(e.starName)} ${e.alive ? '' : '<span class="dex-tag">소멸</span>'}</div>
          <div class="dex-row-meta">${e.starType} · 최초 발견 t = ${e.firstSeenCosmic.toFixed(1)} · 방문 ${e.visits}회</div>
        </div>
        <button class="dex-row-go">→ 이동</button>
      `;
      (row.querySelector('.dex-row-go') as HTMLElement).addEventListener('click', () => {
        if (!e.alive) return;
        this.close();
        this.callbacks?.onSelectStar(e);
      });
      this.body.appendChild(row);
    }
  }

  private renderPlanets(): void {
    if (!this.dex) return;
    const entries = this.dex.planetsArray();
    entries.sort((a, b) => b.firstSeenWall - a.firstSeenWall);
    this.body.innerHTML = '';
    if (entries.length === 0) {
      this.body.innerHTML = `<div class="ship-menu-empty">아직 발견한 행성이 없습니다.<br/>별의 행성계를 통과하면 도감에 자동 등록됩니다.</div>`;
      return;
    }
    for (const p of entries) {
      const row = document.createElement('div');
      row.className = 'dex-row';
      const swatch = `rgb(${Math.round(p.color[0]*255)},${Math.round(p.color[1]*255)},${Math.round(p.color[2]*255)})`;
      row.innerHTML = `
        <div class="dex-row-swatch" style="background:${swatch};box-shadow:0 0 8px ${swatch}"></div>
        <div class="dex-row-main">
          <div class="dex-row-name">${escapeHtml(p.planetName)}</div>
          <div class="dex-row-meta">${planetClassLabel(p.planetClass)} · 궤도 ${p.orbitRadius.toFixed(1)}u · 발견 t = ${p.firstSeenCosmic.toFixed(1)}</div>
        </div>
        <button class="dex-row-go">→ 이동</button>
      `;
      (row.querySelector('.dex-row-go') as HTMLElement).addEventListener('click', () => {
        this.close();
        this.callbacks?.onSelectPlanet(p);
      });
      this.body.appendChild(row);
    }
  }

  private renderSettings(): void {
    if (!this.dex) return;
    this.body.innerHTML = `
      <div class="ship-menu-settings">
        <div class="ship-menu-section-title">도감</div>
        <div class="ship-menu-row">
          <div>
            <div class="ship-menu-row-title">기록된 별 ${this.dex.starCount()}개 · 행성 ${this.dex.planetCount()}개</div>
            <div class="ship-menu-row-desc">localStorage에 자동 저장됩니다.</div>
          </div>
          <button class="ship-menu-action ghost danger" id="ship-menu-reset">초기화</button>
        </div>
        <div class="ship-menu-section-title">조작</div>
        <div class="ship-menu-keys">
          <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — 전후좌우</div>
          <div><kbd>R</kbd><kbd>F</kbd> — 상승/하강</div>
          <div><kbd>Q</kbd><kbd>E</kbd> — 롤</div>
          <div><kbd>Shift</kbd> — 부스트 (×4)</div>
          <div><kbd>X</kbd> — 즉시 정지</div>
          <div><kbd>Space</kbd> — 비행 보조 토글</div>
          <div><kbd>G</kbd> — 조준 대상 궤도 진입/이탈</div>
          <div><kbd>Tab</kbd> — 메뉴 열기/닫기</div>
        </div>
        <div class="ship-menu-section-title">팁</div>
        <div class="ship-menu-tips">
          <b>우주선 모드에선 cosmic time이 동결</b>됩니다 — Hubble 팽창이 폭주하지
          않도록 막기 위해서이고, 우주 진화를 보려면 시뮬 모드로 복귀하세요.
          비행 보조(FA)가 ON이면 키를 떼는 즉시 부드럽게 감속합니다. OFF로 두면
          진짜 무중력 관성 비행이 됩니다.
        </div>
      </div>
    `;
    (this.body.querySelector('#ship-menu-reset') as HTMLElement).addEventListener('click', () => {
      if (!confirm('도감을 초기화합니다. 기록된 모든 별/행성이 사라집니다. 계속할까요?')) return;
      this.callbacks?.onResetDex();
      this.refresh();
    });
  }

  private injectStyles(): void {
    if (document.getElementById('ship-menu-styles')) return;
    const style = document.createElement('style');
    style.id = 'ship-menu-styles';
    style.textContent = `
      .ship-menu {
        position: absolute; inset: 0; z-index: 200;
        background: rgba(4, 6, 14, 0.78);
        backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        color: #e1ecff;
      }
      .ship-menu-card {
        width: 720px; max-width: 90%; max-height: 86%;
        background: linear-gradient(180deg, #0d1426, #060912);
        border: 1px solid rgba(120, 170, 240, 0.32);
        border-radius: 12px;
        box-shadow: 0 0 48px rgba(80, 140, 220, 0.18), 0 12px 60px rgba(0,0,0,0.6);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .ship-menu-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 20px; border-bottom: 1px solid rgba(120, 170, 240, 0.18);
      }
      .ship-menu-title { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
      .ship-menu-stats { color: #98b5d8; font-size: 13px; }
      .ship-menu-stats b { color: #e1ecff; font-variant-numeric: tabular-nums; }
      .ship-menu-tabs {
        display: flex; padding: 0 20px; gap: 4px;
        border-bottom: 1px solid rgba(120, 170, 240, 0.18);
      }
      .ship-menu-tab {
        background: transparent; border: none;
        color: #7c95b8; padding: 10px 14px; cursor: pointer;
        font-size: 13px; border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .ship-menu-tab:hover { color: #e1ecff; }
      .ship-menu-tab.active {
        color: #e1ecff; border-bottom-color: #4a8df6;
      }
      .ship-menu-body {
        flex: 1; overflow-y: auto; padding: 12px 20px;
      }
      .ship-menu-empty {
        text-align: center; color: #7c95b8; padding: 40px 0; line-height: 1.7;
      }
      .ship-menu-footer {
        display: flex; gap: 10px; justify-content: flex-end;
        padding: 12px 20px; border-top: 1px solid rgba(120, 170, 240, 0.18);
      }
      .ship-menu-action {
        background: linear-gradient(180deg, #2c4a7a, #1d3358);
        border: 1px solid rgba(120, 170, 240, 0.35);
        color: #e1ecff; padding: 8px 16px; border-radius: 6px;
        font-size: 13px; cursor: pointer;
      }
      .ship-menu-action:hover {
        background: linear-gradient(180deg, #355995, #243f6d);
      }
      .ship-menu-action.ghost {
        background: transparent; border-color: rgba(120, 170, 240, 0.2);
        color: #98b5d8;
      }
      .ship-menu-action.ghost:hover { color: #e1ecff; border-color: rgba(120, 170, 240, 0.45); }
      .ship-menu-action.danger { color: #ff9a9a; border-color: rgba(255, 140, 140, 0.3); }
      .ship-menu-action.danger:hover { color: #ffb6b6; }

      .dex-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px; align-items: center;
        padding: 10px 12px; margin-bottom: 6px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(120, 170, 240, 0.12);
        border-radius: 6px;
      }
      .dex-row.dead { opacity: 0.55; }
      .dex-row-swatch {
        width: 14px; height: 14px; border-radius: 50%;
      }
      .dex-row-main { min-width: 0; }
      .dex-row-name { font-size: 13px; color: #e1ecff; font-weight: 600; }
      .dex-row-meta { font-size: 11px; color: #7c95b8; margin-top: 2px; }
      .dex-tag {
        display: inline-block; margin-left: 6px; padding: 1px 6px; font-size: 9px;
        background: rgba(255, 100, 100, 0.15); color: #ff9a9a;
        border: 1px solid rgba(255, 100, 100, 0.3); border-radius: 3px;
      }
      .dex-row-go {
        background: transparent; border: 1px solid rgba(120, 170, 240, 0.35);
        color: #98b5d8; padding: 5px 10px; border-radius: 4px;
        font-size: 11px; cursor: pointer;
      }
      .dex-row-go:hover { color: #e1ecff; border-color: rgba(120, 170, 240, 0.6); }

      .ship-menu-settings { padding: 4px 0 20px; }
      .ship-menu-section-title {
        margin-top: 14px; margin-bottom: 8px; font-size: 11px;
        color: #7c95b8; text-transform: uppercase; letter-spacing: 1.5px;
      }
      .ship-menu-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; background: rgba(255,255,255,0.03);
        border: 1px solid rgba(120, 170, 240, 0.12); border-radius: 6px;
      }
      .ship-menu-row-title { color: #e1ecff; font-size: 13px; }
      .ship-menu-row-desc { color: #7c95b8; font-size: 11px; margin-top: 2px; }
      .ship-menu-keys {
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 18px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(120, 170, 240, 0.12); border-radius: 6px;
        font-size: 12px; color: #c5d6ef;
      }
      .ship-menu-keys kbd {
        display: inline-block; padding: 2px 6px; margin: 0 2px;
        background: rgba(120, 170, 240, 0.12);
        border: 1px solid rgba(120, 170, 240, 0.3);
        border-radius: 3px;
        color: #e1ecff;
        font-family: ui-monospace, monospace; font-size: 10.5px;
      }
      .ship-menu-tips {
        padding: 10px 12px; line-height: 1.6;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(120, 170, 240, 0.12); border-radius: 6px;
        font-size: 12px; color: #b3c7e6;
      }
    `;
    document.head.appendChild(style);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  } as Record<string, string>)[c]);
}
