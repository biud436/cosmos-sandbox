import { Effector, Simulator } from './physics/Simulator';
import { spectralClassFromT } from './physics/stellarPhysics';
import { loadSavedPreset, QualityPreset, QUALITY_LABELS, savePreset, settingsOf } from './render/GraphicsSettings';
import { Scene } from './render/Scene';
import { Dex } from './ship/Dex';
import { ModeManager } from './ship/ModeManager';
import { PlanetLab, interiorLayersOf } from './ship/PlanetLab';
import { GAS_PALETTES } from './ship/shaders/jupiterGas';
import { PLANET_PROFILES, profileById } from './ship/PlanetProfiles';
import { generatePlanetSystem, planetClassLabel, planetPosition } from './ship/PlanetSystem';
import { ShipController } from './ship/ShipController';
import { ShipHUD, formatRealDistance } from './ship/ShipHUD';
import { ShipMenu } from './ship/ShipMenu';
import { StarSystemView } from './ship/StarSystemRenderer';
import { Controls, INTERNAL_DT, BASE_SUBSTEPS_PER_FRAME } from './ui/Controls';
import { Layout } from './ui/Layout';
import { PRESETS } from './ui/presets';
import { Tools } from './ui/Tools';
import { LRU } from './util/LRU';
import * as THREE from 'three';

const BOX_HALF = 150;
const MAX_PARTICLES = 9000;
const MAX_PER_SPECIES = 3500;
const CUTOFF = 2.5;

const viewport = document.getElementById('viewport');
if (!viewport) throw new Error('#viewport not found');

const sim = new Simulator({ boxHalf: BOX_HALF, maxParticles: MAX_PARTICLES, cutoff: CUTOFF });
let currentGfxPreset: QualityPreset = loadSavedPreset();
const scene = new Scene(viewport, BOX_HALF, MAX_PER_SPECIES, settingsOf(currentGfxPreset));
const layout = new Layout();

let lastFusionLog = 0;
sim.onFusion = (event) => {
  scene.pulseOrigin(event.position);
  const now = performance.now();
  if (now - lastFusionLog > 250) {
    layout.log(`Fusion H+H → He · E≈${event.energy.toFixed(1)}`, 'event');
    lastFusionLog = now;
  }
};

sim.onStarFormation = (position, atoms) => {
  scene.pulseOrigin(position);
  layout.log(`★ Star formed from ${atoms} atoms`, 'event');
};

sim.onNebulaFormation = (_position, mass) => {
  layout.log(`☁ Nebula formed · M≈${mass.toFixed(0)}`, 'event');
};

sim.onCosmicEvent = (ev) => {
  layout.showEvent(ev);
  layout.log(`◆ ${ev.name} — ${ev.description}`, 'event');
  layout.updateStats(sim, fps);
};

sim.onStellarMerger = (position, mass) => {
  scene.pulseOrigin(position);
  layout.log(`★ + ★ → ★ merger · M=${mass.toFixed(0)}`, 'event');
};

sim.onSupernova = (position, mass) => {
  scene.pulseOrigin(position);
  scene.pulseOrigin(position);
  layout.log(`✦ Supernova! M=${mass.toFixed(0)} → ● Black hole`, 'event');
};

const controls = new Controls(
  sim,
  layout.guiHost,
  scene,
  (distribution) => {
    sim.reset(distribution);
    const n = Object.values(distribution).reduce((a, b) => a + b, 0);
    layout.log(`Reset → ${n} particles`);
  },
  (preset) => {
    layout.setPreset(preset.name);
    layout.setTimeScale(preset.initialTimeScale);
    layout.setYearsPerUnit(preset.yearsPerUnit);
  },
);

const modeManager = new ModeManager({
  internalDt: INTERNAL_DT,
  baseSubstepsPerFrame: BASE_SUBSTEPS_PER_FRAME,
});

const ship = new ShipController({
  camera: scene.camera,
  domElement: scene.renderer.domElement,
  // No maxSpeed override — use ShipController's sub-light default (0.2c
  // cruise, 0.8c with boost). Interstellar travel is expected to need warp.
});

const shipHUD = new ShipHUD(viewport);
const dex = new Dex();
const shipMenu = new ShipMenu(viewport);

// LRU of materialized star systems. Capacity ~64 keeps memory bounded while
// still letting the player wander between several recently-visited stars
// without triggering re-generation. onEvict disposes meshes/materials.
// The Dex stays exhaustive — the LRU only caps GPU resources.
const starSystems = new LRU<number, StarSystemView>(64, (_id, view) => view.dispose());

function ensureSystemFor(eff: Effector): StarSystemView | null {
  let view = starSystems.get(eff.id);
  const firstVisitThisSession = !view;
  if (!view) {
    const data = generatePlanetSystem(eff);
    if (!data) return null;
    view = new StarSystemView(data, eff, scene.graphicsSettings);
    scene.scene.add(view.group);
    starSystems.set(eff.id, view);
    dex.recordPlanets(data, sim.simTime);
  }
  // Always record the visit (idempotent — bumps visit count on re-entry).
  const alreadyKnown = dex.starsArray().some((s) => s.starId === eff.id);
  dex.recordVisit(eff.id, eff.name ?? `${eff.type}-${eff.id}`, eff.type, sim.simTime);
  if (firstVisitThisSession && !alreadyKnown) {
    layout.log(`✨ 새로운 별 발견 — ${view.planetSystem.starName} · 행성 ${view.planetSystem.planets.length}개`, 'event');
    shipHUD.flashHint(`✨ ${view.planetSystem.starName} · 행성 ${view.planetSystem.planets.length}개 발견`);
  }
  return view;
}

// Smoothly glide the camera (in ship mode) to a target point. Cancels the
// ship's accumulated velocity and re-orients toward the target.
function flyTo(target: THREE.Vector3, standoff: number, label?: string): void {
  if (!ship.enabled) return;
  ship.glideTo(target, standoff, label);
}

function setShipMode(active: boolean): void {
  if (active) {
    if (planetActive) setPlanetMode(false); // the two modes are mutually exclusive
    modeManager.mode = 'ship';
    scene.setControllerMode('ship');
    ship.enable();
    shipHUD.setVisible(true);
    layout.log('🚀 우주선 모드 진입 — 클릭하여 마우스 잠금', 'event');
  } else {
    if (shipMenu.isOpen) shipMenu.close();
    ship.disable();
    scene.setControllerMode('orbit');
    modeManager.mode = 'sim';
    shipHUD.setVisible(false);
    // Hide all materialized star systems when leaving ship mode — they're
    // a ship-mode-only ornament and would clutter the cosmological view.
    for (const view of starSystems.values()) view.group.visible = false;
    layout.log('🌌 시뮬레이션 시점 복귀');
  }
  layout.setShipUI(active);
}

shipMenu.bind(dex, {
  onSelectStar: (entry) => {
    // Find the live effector by id; warn if it's gone.
    const eff = sim.effectors.find((e) => e.id === entry.starId);
    if (!eff) {
      shipHUD.flashHint(`${entry.starName}은(는) 더 이상 존재하지 않습니다.`);
      return;
    }
    flyTo(new THREE.Vector3(eff.x, eff.y, eff.z), Math.max(eff.radius * 6, 5), entry.starName);
  },
  onSelectPlanet: (entry) => {
    const eff = sim.effectors.find((e) => e.id === entry.starId);
    if (!eff) {
      shipHUD.flashHint(`호스트 별이 사라져 행성을 표시할 수 없습니다.`);
      return;
    }
    // Make sure the planet system is materialized so the planet has a mesh.
    const view = ensureSystemFor(eff);
    if (!view) return;
    view.group.visible = true;
    view.update(shipProperTime);
    // Derive the planet's current orbital position from Kepler dynamics so
    // we don't depend on the renderer's child-ordering convention.
    const planet = view.planetSystem.planets[entry.planetIndex];
    if (!planet) return;
    const rel: [number, number, number] = [0, 0, 0];
    planetPosition(planet, shipProperTime, rel);
    const target = new THREE.Vector3(eff.x + rel[0], eff.y + rel[1], eff.z + rel[2]);
    flyTo(target, Math.max(planet.visualRadius * 5, 1.5), entry.planetName);
  },
  onExitShipMode: () => setShipMode(false),
  onResetDex: () => {
    dex.clear();
    layout.log('도감 초기화', 'info');
  },
});

// ---- Photoreal planet observation mode ('planet') -------------------------
// An isolated lab scene rendering either the whole solar system (orrery, with
// real Kepler orbits) or a single body close-up / interior cutaway. Cosmic
// time freezes (see ModeManager); the shared OrbitControls orbit the lab
// origin. Fully separate from the particle universe.
let planetLab: PlanetLab | null = null;
let planetActive = false;
let planetCurrentId = 'orrery'; // body id, or 'orrery' for the system overview
let planetInterior = false;
const savedOrbit = { pos: new THREE.Vector3(), target: new THREE.Vector3(), min: 0, max: Infinity };

const planetPanel = document.getElementById('planet-panel') as HTMLElement;
const ppBodies = document.getElementById('pp-bodies') as HTMLElement;
const ppCaption = document.getElementById('pp-caption') as HTMLElement;
const ppGas = document.getElementById('pp-gas') as HTMLElement;
const ppLayers = document.getElementById('pp-layers') as HTMLElement;
const ppInteriorBtn = document.getElementById('pp-interior') as HTMLButtonElement;
const ppScaleBtn = document.getElementById('pp-scale') as HTMLButtonElement;
const ppExitBtn = document.getElementById('pp-exit') as HTMLButtonElement;
const btnPlanet = document.getElementById('btn-planet') as HTMLButtonElement;
const labCanvas = scene.renderer.domElement;
const ppButtons = new Map<string, HTMLButtonElement>();

// Overview chip first, then one chip per body, built once.
for (const entry of [{ id: 'orrery', label: '태양계 전체' }, ...PLANET_PROFILES]) {
  const btn = document.createElement('button');
  btn.textContent = entry.label;
  btn.className = 'pl-chip';
  btn.addEventListener('click', () => selectView(entry.id));
  ppBodies.appendChild(btn);
  ppButtons.set(entry.id, btn);
}

// --- Cinematic dive-in: ease the camera to the target framing while the
// canvas blurs/zooms, so switching bodies feels like being pulled in. ---
let camTween: { fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number } | null = null;
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

function cameraFlyTo(toPos: THREE.Vector3, toTarget: THREE.Vector3, dur: number): void {
  camTween = {
    fromP: scene.camera.position.clone(), toP: toPos.clone(),
    fromT: scene.controls.target.clone(), toT: toTarget.clone(), t: 0, dur,
  };
  scene.controls.enabled = false;
  labCanvas.classList.add('pl-diving');
}

/** Camera position at `distance` from the origin, along `prefer` (or the
 *  current view direction when omitted). */
function standoff(distance: number, prefer?: THREE.Vector3): THREE.Vector3 {
  const dir = prefer ? prefer.clone() : scene.camera.position.clone().sub(scene.controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
  return dir.normalize().multiplyScalar(distance);
}

function selectView(id: string): void {
  if (!planetLab) return;
  if (id === 'orrery') {
    planetCurrentId = 'orrery';
    planetInterior = false;
    planetLab.showOrrery();
    const f = planetLab.orreryFraming;
    scene.controls.maxDistance = f.maxDistance;
    ppCaption.textContent = planetLab.orreryScaleMode === 'real'
      ? '태양계 — 실제 거리 비율(AU 비례) · 케플러 궤도. 바깥 행성일수록 멀어 작게 보입니다 (스크롤로 확대)'
      : '태양계 — 한눈에 보기용 압축 거리 · 실제 이심률·궤도경사 기반 케플러 궤도';
    cameraFlyTo(standoff(f.standoff, new THREE.Vector3(0.25, 0.7, 1)), new THREE.Vector3(0, 0, 0), 1.2);
  } else {
    const profile = profileById(id);
    if (!profile) return;
    planetCurrentId = id;
    scene.controls.maxDistance = 80;
    planetLab.showBody(profile, planetInterior);
    ppCaption.textContent = profile.caption;
    const dist = planetInterior ? profile.viewDistance * 1.15 : profile.viewDistance;
    // Angle the camera at the +x/+z cutaway wedge when showing the interior.
    const dir = planetInterior ? new THREE.Vector3(1, 0.55, 1) : undefined;
    cameraFlyTo(standoff(dist, dir), new THREE.Vector3(0, 0, 0), 0.9);
  }
  refreshPanel();
}

function refreshPanel(): void {
  for (const [bid, btn] of ppButtons) btn.classList.toggle('active', bid === planetCurrentId);
  const isBody = planetCurrentId !== 'orrery';
  // Procedural-gas live controls — only on a gas body's surface view.
  const showGas = isBody && !planetInterior && !!planetLab?.hasGas;
  ppGas.style.display = showGas ? 'flex' : 'none';
  if (showGas) syncGasControls();
  ppInteriorBtn.classList.toggle('hidden', !isBody);
  ppInteriorBtn.classList.toggle('active', planetInterior && isBody);
  ppInteriorBtn.textContent = planetInterior ? '표면 보기' : '내부 구조 보기';
  // Distance-scale toggle is orrery-only.
  ppScaleBtn.classList.toggle('hidden', isBody);
  if (planetLab) ppScaleBtn.textContent = planetLab.orreryScaleMode === 'real' ? '거리: 압축 보기로' : '거리: 실척 보기로';
  // Layer legend (outermost first) when an interior is shown.
  const showLayers = planetInterior && isBody;
  ppLayers.classList.toggle('show', showLayers);
  ppLayers.innerHTML = '';
  if (showLayers) {
    const layers = interiorLayersOf(planetCurrentId) ?? [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const row = document.createElement('div');
      row.className = 'pl-layer';
      const sw = document.createElement('span');
      sw.className = 'pl-swatch';
      sw.style.background = '#' + L.color.toString(16).padStart(6, '0');
      const name = document.createElement('span');
      name.textContent = L.name;
      row.append(sw, name);
      ppLayers.appendChild(row);
    }
  }
}

ppInteriorBtn.addEventListener('click', () => {
  if (planetCurrentId === 'orrery') return;
  planetInterior = !planetInterior;
  selectView(planetCurrentId);
});

ppScaleBtn.addEventListener('click', () => {
  if (planetCurrentId !== 'orrery' || !planetLab) return;
  planetLab.setOrreryScale(planetLab.orreryScaleMode === 'real' ? 'compact' : 'real');
  selectView('orrery'); // rebuild framing + caption for the new scale
});

// --- Procedural-gas (목성) live controls: palette + turbulence/flow + a hint.
// Built once; shown only while a procedural-gas body's surface is on screen.
const gasPalChips = new Map<string, HTMLButtonElement>();
let gasTurbSlider: HTMLInputElement;
let gasFlowSlider: HTMLInputElement;
{
  const palLabel = document.createElement('div');
  palLabel.className = 'pl-gas-label';
  palLabel.textContent = '색상 팔레트';
  const palRow = document.createElement('div');
  palRow.className = 'pl-gas-pals';
  for (const [key, { label }] of Object.entries(GAS_PALETTES)) {
    const chip = document.createElement('button');
    chip.className = 'pl-pal';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      if (!planetLab) return;
      planetLab.setGasPalette(key);
      syncGasControls();
    });
    palRow.appendChild(chip);
    gasPalChips.set(key, chip);
  }

  const mkSlider = (label: string, min: number, max: number, step: number): HTMLInputElement => {
    const row = document.createElement('div');
    row.className = 'pl-slider';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    row.append(name, input);
    ppGas.appendChild(row);
    return input;
  };

  ppGas.append(palLabel, palRow);
  gasTurbSlider = mkSlider('난류', 1.5, 6.0, 0.1);
  gasFlowSlider = mkSlider('흐름', 0.0, 0.18, 0.005);
  gasTurbSlider.addEventListener('input', () => planetLab?.setGasTurb(parseFloat(gasTurbSlider.value)));
  gasFlowSlider.addEventListener('input', () => planetLab?.setGasFlow(parseFloat(gasFlowSlider.value)));

  const hint = document.createElement('div');
  hint.className = 'pl-gas-label';
  hint.style.opacity = '0.6';
  hint.textContent = '확대하면 가스 구름이 나타납니다 · 커서로 휘젓기';
  ppGas.appendChild(hint);
}

function syncGasControls(): void {
  if (!planetLab) return;
  for (const [key, chip] of gasPalChips) chip.classList.toggle('active', key === planetLab.gasPalette);
  gasTurbSlider.value = String(planetLab.getGasTurb());
  gasFlowSlider.value = String(planetLab.getGasFlow());
}

// Pointer-stir: waving the cursor over a procedural-gas body injects swirls
// that locally twist the cloud flow. Hover (button up) stirs at full strength;
// while a button is held (OrbitControls rotating) we stir faintly so rotation
// stays readable instead of fighting the stir.
let lastStirMs = 0;
let lastStirX = 0;
let lastStirY = 0;
const stirNdc = new THREE.Vector2();
labCanvas.addEventListener('pointermove', (e) => {
  if (!planetActive || !planetLab || !planetLab.hasGas || camTween) return;
  // Only respond once the gas clouds are actually on screen (zoomed in). When
  // far, the planet is the plain texture and the cursor shouldn't disturb it.
  if (planetLab.gasDetail < 0.45) return;
  const rect = labCanvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  const now = performance.now();
  if (now - lastStirMs < 45) return; // cap stir rate
  const speed = Math.hypot(e.clientX - lastStirX, e.clientY - lastStirY);
  lastStirX = e.clientX;
  lastStirY = e.clientY;
  if (speed < 2.5) return; // ignore tiny jitter so it doesn't twitch
  lastStirMs = now;
  // Gentle, and fading with the LOD blend so it eases off as gas thins out.
  // Slower normalization (speed/110) means a brisk sweep, not a graze, stirs.
  const strength = Math.min(1, speed / 110) * planetLab.gasDetail * (e.buttons !== 0 ? 0.2 : 1.0);
  stirNdc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  planetLab.stirGasFromScreen(stirNdc, scene.camera, strength);
});

function setPlanetMode(active: boolean): void {
  if (active === planetActive) return;
  if (active) {
    if (ship.enabled) setShipMode(false); // mutually exclusive with ship mode
    if (!planetLab) planetLab = new PlanetLab(scene.renderer);
    // Remember the cosmological camera/orbit framing so we can restore it.
    savedOrbit.pos.copy(scene.camera.position);
    savedOrbit.target.copy(scene.controls.target);
    savedOrbit.min = scene.controls.minDistance;
    savedOrbit.max = scene.controls.maxDistance;

    planetActive = true;
    modeManager.mode = 'planet';
    scene.setControllerMode('orbit');
    scene.controls.enabled = true;
    scene.controls.minDistance = 1.25;
    scene.controls.maxDistance = 80;
    labCanvas.style.transition = 'filter .5s ease, transform .5s ease';

    selectView(planetCurrentId); // builds the view + dives the camera in
    planetPanel.style.display = 'block';
    layout.log('태양계 관측 모드 진입', 'event');
  } else {
    planetActive = false;
    modeManager.mode = 'sim';
    planetPanel.style.display = 'none';
    camTween = null;
    labCanvas.classList.remove('pl-diving');
    labCanvas.style.transition = '';
    // Restore the cosmological framing.
    scene.controls.enabled = true;
    scene.controls.minDistance = savedOrbit.min;
    scene.controls.maxDistance = savedOrbit.max;
    scene.camera.position.copy(savedOrbit.pos);
    scene.controls.target.copy(savedOrbit.target);
    scene.controls.update();
    layout.log('시뮬레이션 시점 복귀');
  }
  btnPlanet.textContent = planetActive ? '복귀' : '태양계';
  btnPlanet.classList.toggle('active', planetActive);
}

ppExitBtn.addEventListener('click', () => setPlanetMode(false));
btnPlanet.addEventListener('click', () => setPlanetMode(!planetActive));

// Menu shortcuts in ship mode:
//   Tab — open / close the menu (primary; edge-triggered, no auto-repeat).
//   Esc — close the menu when open; never opens. Plain Esc just releases
//         the browser pointer lock, which is what the OS-level expectation is.
window.addEventListener('keydown', (e) => {
  if (!ship.enabled) return;
  if (e.key === 'Tab') {
    if (e.repeat) return;
    // Block focus traversal so Tab doesn't escape to the surrounding chrome.
    e.preventDefault();
    if (shipMenu.isOpen) shipMenu.close();
    else shipMenu.open();
    return;
  }
  if (e.key === 'Escape') {
    if (shipMenu.isOpen) shipMenu.close();
  }
});

// G: engage circular orbit around the currently-reticled target. Tap again
// while orbiting to break out (or any thrust key). Edge-triggered so holding
// the key doesn't flip-flop the orbit state every frame.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'g') return;
  if (e.repeat) return;
  if (!ship.enabled) return;
  if (shipMenu.isOpen) return;
  if (ship.orbiting) { ship.exitOrbit(); shipHUD.flashHint('궤도 이탈'); return; }
  if (!reticleTarget) { shipHUD.flashHint('레티클에 대상이 없습니다'); return; }
  const r = Math.max(reticleTarget.radius * 4, 2);
  ship.enterOrbit(reticleTarget.getPosition, r, reticleTarget.label);
  shipHUD.flashHint(`궤도 진입 — ${reticleTarget.label}`);
});

// FA toggle feedback
ship.onFlightAssistToggle = (on) => {
  shipHUD.flashHint(on ? '비행 보조 ON — 키를 떼면 감속' : '비행 보조 OFF — 무마찰 (관성 유지)');
};

// Propulsion-mode flash. Z (or Shift+Z reverse) cycles modes; the HUD
// label updates the next frame from getState().
ship.onPropulsionChange = (spec) => {
  shipHUD.flashHint(`추진 모드 → ${spec.label} · ${spec.description}`);
};

// 실사 (realistic) mode toggle — V key. While on, ship cruises at approach
// speed and Shift fires a brief warp burst gated by the charge gauge.
ship.onRealisticToggle = (on) => {
  shipHUD.flashHint(on
    ? '실사 모드 전환 — Z 로 순항/고속/워프 선택 · Shift 유지 시 워프 burst (게이지)'
    : '실사 모드 해제 — 일반 추진으로 복귀');
};

layout.bindToolbar({
  presets: PRESETS.map((p) => p.name),
  initialPreset: controls.state.preset,
  initialTimeScale: controls.state.timeScale,
  gfxQualityOptions: (Object.keys(QUALITY_LABELS) as QualityPreset[]).map((id) => ({
    id,
    label: QUALITY_LABELS[id],
  })),
  initialGfxQuality: currentGfxPreset,
  onPreset: (name) => {
    controls.applyPresetByName(name);
    layout.log(`Preset → ${name}`);
  },
  onPauseToggle: () => {
    const paused = controls.togglePause();
    modeManager.paused = paused;
    return paused;
  },
  onStep: () => {
    if (!controls.state.paused) return;
    sim.step(INTERNAL_DT);
  },
  onReset: () => sim.reset(controls.getDistribution()),
  onTimeScale: (scale) => {
    controls.setTimeScale(scale);
    modeManager.timeScale = scale;
    layout.log(`Time scale → ×${scale}`);
  },
  onGfxQuality: (id) => {
    const next = id as QualityPreset;
    const aaChanged = scene.applyGraphicsSettings(settingsOf(next));
    currentGfxPreset = next;
    savePreset(next);
    layout.log(`그래픽 퀄리티 → ${QUALITY_LABELS[next]}`, 'event');
    if (aaChanged) {
      layout.log('AA 설정은 새로고침 후에 반영됩니다.', 'info');
    }
    // Invalidate any already-materialized star systems so the next visit
    // builds meshes at the new sphere resolution. LRU.clear() calls each
    // entry's onEvict (= view.dispose()) before clearing the map.
    starSystems.clear();
  },
  onToggleOrbits: () => {
    const next = !scene.isVisible('orbits');
    scene.setVisibility('orbits', next);
    layout.log(`공전 궤도 ${next ? '표시' : '숨김'}`);
  },
  onToggleShip: () => {
    const next = !ship.enabled;
    setShipMode(next);
    return next;
  },
});

// Seed initial sync between ModeManager and Controls state.
modeManager.timeScale = controls.state.timeScale;
modeManager.paused = controls.state.paused;

new Tools({
  isInsideViewport: (x, y) => scene.isInsideViewport(x, y),
  worldFromScreen: (x, y) => scene.worldFromScreen(x, y),
  onPlace: (type, pos) => {
    const eff = sim.addEffector(type, pos[0], pos[1], pos[2]);
    scene.setSelectedEffector(eff);
    controls.showSelectedEffector(eff);
    layout.log(`${type} placed @ (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)})`, 'event');
  },
  onClearAll: () => {
    sim.clearEffectors();
    scene.setSelectedEffector(null);
    controls.showSelectedEffector(null);
    layout.log('Effectors cleared.');
  },
  setViewportDropHighlight: (active) => layout.setDropHighlight(active),
});

controls.setDeleteHandler((eff) => {
  sim.removeEffector(eff);
});

layout.setEffectorClickHandler((eff) => {
  scene.setSelectedEffector(eff);
  scene.focusOnEffector(eff);
  controls.showSelectedEffector(eff);
});

sim.onEffectorRemoved = (eff, reason) => {
  // Only clear the selection if THIS effector was the one being watched —
  // otherwise every SN/merger in the simulation breaks the camera follow.
  if (scene.getSelectedEffector() === eff) {
    scene.setSelectedEffector(null);
    controls.showSelectedEffector(null);
  }

  if (reason === 'merged') {
    if (eff.type === 'blackhole')        layout.log(`● BH merged · M=${eff.strength.toFixed(0)}`, 'event');
    else if (eff.type === 'neutron_star') layout.log(`⚪ NS merged (kilonova)`, 'event');
    else                                  layout.log(`${eff.type} merged · M=${eff.strength.toFixed(0)}`, 'event');
  }
  if (reason === 'consumed') {
    if (eff.type === 'star')              layout.log(`★ Star consumed by BH`, 'event');
    else if (eff.type === 'neutron_star') layout.log(`⚪ NS consumed by BH`, 'event');
    else if (eff.type === 'nebula')       layout.log(`☁ Nebula dispersed`, 'event');
    else                                  layout.log(`${eff.type} consumed`, 'event');
  }
  if (reason === 'manual')   layout.log(`${eff.type} removed`);
};

const rendererEl = scene.renderer.domElement;
let downX = 0;
let downY = 0;
let downTime = 0;
rendererEl.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
  downTime = performance.now();
});
rendererEl.addEventListener('pointerup', (e) => {
  if (planetActive) return; // clicks orbit the lab body, never the hidden universe
  const dx = e.clientX - downX;
  const dy = e.clientY - downY;
  const dt = performance.now() - downTime;
  if (dx * dx + dy * dy > 16 || dt > 400) return;
  const picked = scene.pickEffector(e.clientX, e.clientY, sim);
  scene.setSelectedEffector(picked);
  controls.showSelectedEffector(picked);
});

layout.log('Cosmos sandbox ready.');

// Visit-radius floor in case the star has no system yet generated.
const VISIT_RADIUS_MIN = 60;
/** Wide acquisition cone: ~15° half-angle so planets aren't pixel-hunt. */
const RETICLE_CONE_COS = Math.cos(0.26);
/** Tighter "primary lock" cone for tie-breaking when multiple targets fit. */
const RETICLE_PRIMARY_COS = Math.cos(0.07);

interface ReticleTarget {
  kind: 'planet' | 'star';
  label: string;
  getPosition: () => THREE.Vector3;
  radius: number;
  color?: [number, number, number];
  details: { k: string; v: string }[];
}
let reticleTarget: ReticleTarget | null = null;

function starTypeLabel(type: string): string {
  switch (type) {
    case 'star':         return '항성';
    case 'neutron_star': return '중성자별';
    case 'blackhole':    return '블랙홀';
    default:             return type;
  }
}

function spectralLabel(eff: Effector): string {
  // Prefer the cached temperature (real M-T relation); fall back to a mass
  // bin if it's missing (e.g. legacy effectors from before T was tracked).
  if (eff.temperatureK !== undefined) return spectralClassFromT(eff.temperatureK).label;
  const mass = eff.strength;
  if (mass < 12)  return 'M (적색 왜성)';
  if (mass < 22)  return 'K (주황)';
  if (mass < 40)  return 'G (태양형)';
  if (mass < 70)  return 'F/A (백색)';
  if (mass < 130) return 'B (청백)';
  return            'O (청색 거성)';
}

const _reticleForward = new THREE.Vector3();

function pickReticleTarget(camera: THREE.PerspectiveCamera): ReticleTarget | null {
  const forward = camera.getWorldDirection(_reticleForward);
  const origin = camera.position;
  let best: ReticleTarget | null = null;
  let bestScore = -Infinity;

  // Scoring: how centered (cos), weighted by apparent angular size so a
  // big nearby planet wins over a far star at the same crosshair offset,
  // and a primary-cone hit beats a wide-cone hit on ties.
  const scoreOf = (cos: number, d: number, bodyRadius: number): number => {
    const angularSize = Math.atan2(bodyRadius, Math.max(0.5, d));
    const center = (cos - RETICLE_CONE_COS) / (1 - RETICLE_CONE_COS); // 0..1
    const primary = cos >= RETICLE_PRIMARY_COS ? 0.5 : 0;
    return center * 1.0 + angularSize * 6.0 + primary;
  };

  // Planets in materialized systems
  const planetRel: [number, number, number] = [0, 0, 0];
  for (const view of starSystems.values()) {
    if (!view.group.visible) continue;
    const center = view.group.position;
    for (let i = 0; i < view.planetSystem.planets.length; i++) {
      const planet = view.planetSystem.planets[i];
      planetPosition(planet, shipProperTime, planetRel);
      const px = center.x + planetRel[0];
      const py = center.y + planetRel[1];
      const pz = center.z + planetRel[2];
      const dx = px - origin.x, dy = py - origin.y, dz = pz - origin.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < 0.001) continue;
      const cos = (dx*forward.x + dy*forward.y + dz*forward.z) / d;
      if (cos < RETICLE_CONE_COS) continue;
      const score = scoreOf(cos, d, planet.visualRadius);
      if (score > bestScore) {
        bestScore = score;
        const sysCenter = view;
        best = {
          kind: 'planet',
          label: planet.name,
          getPosition: () => {
            const c = sysCenter.group.position;
            const rel: [number, number, number] = [0, 0, 0];
            planetPosition(planet, shipProperTime, rel);
            return new THREE.Vector3(c.x + rel[0], c.y + rel[1], c.z + rel[2]);
          },
          radius: planet.visualRadius,
          color: planet.color,
          details: [
            { k: '분류',  v: planetClassLabel(planet.planetClass) },
            { k: '모성',  v: view.planetSystem.starName },
            { k: '궤도',  v: formatRealDistance(planet.orbitRadius) },
            { k: '반경',  v: formatRealDistance(planet.visualRadius) },
            { k: '주기',  v: `${planet.periodSec.toFixed(1)} s` },
          ],
        };
      }
    }
  }

  // Stars / compact objects
  for (const eff of sim.effectors) {
    if (eff.type !== 'star' && eff.type !== 'neutron_star' && eff.type !== 'blackhole') continue;
    const dx = eff.x - origin.x, dy = eff.y - origin.y, dz = eff.z - origin.z;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d < 0.001) continue;
    const cos = (dx*forward.x + dy*forward.y + dz*forward.z) / d;
    if (cos < RETICLE_CONE_COS) continue;
    const score = scoreOf(cos, d, eff.radius);
    if (score > bestScore) {
      bestScore = score;
      const captured = eff;
      const details: { k: string; v: string }[] = [
        { k: '종류', v: starTypeLabel(captured.type) },
        { k: '질량', v: `${captured.strength.toFixed(0)}` },
      ];
      if (captured.type === 'star') {
        details.push({ k: '분광형', v: spectralLabel(captured) });
        if (captured.temperatureK !== undefined) {
          details.push({ k: '표면온도', v: `${Math.round(captured.temperatureK).toLocaleString()} K` });
        }
        if (captured.luminositySolar !== undefined) {
          const L = captured.luminositySolar;
          const lLabel = L >= 100 ? `${L.toFixed(0)} L⊙`
                       : L >= 1   ? `${L.toFixed(1)} L⊙`
                                  : `${L.toFixed(3)} L⊙`;
          details.push({ k: '광도', v: lLabel });
        }
        if (captured.metallicity !== undefined) {
          details.push({ k: '금속성', v: `Z=${captured.metallicity.toFixed(3)}` });
        }
      }
      details.push({ k: '형성t', v: captured.bornAt.toFixed(1) });
      best = {
        kind: 'star',
        label: captured.name ?? `${captured.type}-${captured.id}`,
        getPosition: () => new THREE.Vector3(captured.x, captured.y, captured.z),
        radius: captured.radius,
        details,
      };
    }
  }

  return best;
}

let lastTime = performance.now();
let frames = 0;
let fpsTimer = 0;
let fps = 0;
let shipProperTime = 0;

// Track alive effector ids so we can drop systems whose host star has been
// consumed/exploded — otherwise the orbits would linger pinned to (0,0,0)
// from a stale `eff` reference.
sim.onEffectorRemoved = ((prev) => (eff: Effector, reason: 'merged' | 'consumed' | 'manual') => {
  prev?.(eff, reason);
  starSystems.delete(eff.id);
  dex.markDead(eff.id);
})(sim.onEffectorRemoved);

function loop(): void {
  const now = performance.now();
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  // ModeManager keeps Controls state authoritative for sim, while letting
  // ship mode slow the cosmic clock as the pilot throttles up.
  modeManager.paused = controls.state.paused;
  modeManager.timeScale = controls.state.timeScale;
  if (ship.enabled) {
    const s = ship.getState();
    modeManager.shipThrottle = s.throttleNormalized;
  } else {
    modeManager.shipThrottle = 0;
  }

  const tick = modeManager.tick(elapsed);
  for (let s = 0; s < tick.simSteps; s++) sim.step(tick.simDt);

  // Planet mode renders an isolated lab scene instead of the particle
  // universe. Cosmic time is frozen (simSteps == 0), so we just animate the
  // body and draw it with the shared camera/controls.
  if (planetActive && planetLab) {
    planetLab.update(tick.shipDt, scene.camera);
    if (camTween) {
      camTween.t += tick.shipDt / camTween.dur;
      const k = easeOutCubic(Math.min(1, camTween.t));
      scene.camera.position.lerpVectors(camTween.fromP, camTween.toP, k);
      scene.controls.target.lerpVectors(camTween.fromT, camTween.toT, k);
      if (camTween.t >= 1) {
        camTween = null;
        labCanvas.classList.remove('pl-diving');
        scene.controls.enabled = true;
        scene.controls.update();
      }
    } else {
      scene.controls.update();
    }
    scene.renderer.render(planetLab.scene, scene.camera);

    frames++;
    fpsTimer += elapsed;
    if (fpsTimer >= 0.25) {
      fps = frames / fpsTimer;
      frames = 0;
      fpsTimer = 0;
      layout.updateStats(sim, fps);
      scene.adaptPixelRatio(fps, 0.25);
    }
    requestAnimationFrame(loop);
    return;
  }

  if (ship.enabled) {
    ship.update(tick.shipDt);
    shipProperTime += tick.shipDt;
    const state = ship.getState();
    const nearest = scene.nearestStar(sim, state.position);

    // Visit detection: trigger if the ship is within the system's outer
    // planet (for already-materialized systems) or a generous floor for
    // not-yet-materialized ones. Without the floor, tiny stars would have
    // a trigger smaller than their actual planet system and the player
    // could fly clean through without anything spawning.
    if (nearest) {
      const existing = starSystems.get(nearest.eff.id);
      const trigger = existing
        ? Math.max(existing.outerExtent * 1.4, VISIT_RADIUS_MIN)
        : VISIT_RADIUS_MIN;
      if (nearest.distance < trigger) {
        const view = ensureSystemFor(nearest.eff);
        if (view) view.group.visible = true;
      }
    }
    // Drive orbital motion + keep meshes pinned to (possibly moving) hosts.
    // Pass the ship's position so each system can advance its planets'
    // procedural-detail LOD uniform — close-up = full shader, far = flat.
    for (const view of starSystems.values()) {
      if (view.group.visible) view.update(shipProperTime, state.position);
    }
    reticleTarget = pickReticleTarget(scene.camera);
    const navTarget = ship.getNavTarget();
    shipHUD.update(state, scene.camera, nearest, reticleTarget, ship.flightAssist, ship.orbiting, navTarget);
  }

  scene.sync(sim, elapsed);
  scene.render();

  frames++;
  fpsTimer += elapsed;
  if (fpsTimer >= 0.25) {
    fps = frames / fpsTimer;
    frames = 0;
    fpsTimer = 0;
    layout.updateStats(sim, fps);
    // Let the renderer ratchet pixelRatio up/down based on rolling FPS.
    scene.adaptPixelRatio(fps, 0.25);
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
