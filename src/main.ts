import { Effector, Simulator } from './physics/Simulator';
import { Scene } from './render/Scene';
import { Dex } from './ship/Dex';
import { ModeManager } from './ship/ModeManager';
import { generatePlanetSystem, planetClassLabel } from './ship/PlanetSystem';
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
const scene = new Scene(viewport, BOX_HALF, MAX_PER_SPECIES);
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
    view = new StarSystemView(data, eff);
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
    // Derive the planet's current orbital position from metadata so we
    // don't depend on the renderer's child-ordering convention.
    const planet = view.planetSystem.planets[entry.planetIndex];
    if (!planet) return;
    const angle = planet.phase0 + (shipProperTime / planet.periodSec) * Math.PI * 2;
    const sinI = Math.sin(planet.inclination);
    const cosI = Math.cos(planet.inclination);
    const x = Math.cos(angle) * planet.orbitRadius;
    const z = Math.sin(angle) * planet.orbitRadius;
    const target = new THREE.Vector3(eff.x + x, eff.y + z * sinI, eff.z + z * cosI);
    flyTo(target, Math.max(planet.visualRadius * 5, 1.5), entry.planetName);
  },
  onExitShipMode: () => setShipMode(false),
  onResetDex: () => {
    dex.clear();
    layout.log('도감 초기화', 'info');
  },
});

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

layout.bindToolbar({
  presets: PRESETS.map((p) => p.name),
  initialPreset: controls.state.preset,
  initialTimeScale: controls.state.timeScale,
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

function spectralLabel(mass: number): string {
  if (mass < 12)  return 'M (적색 왜성)';
  if (mass < 22)  return 'K (주황)';
  if (mass < 40)  return 'G (태양형)';
  if (mass < 70)  return 'F/A (백색)';
  if (mass < 130) return 'B (청백)';
  return            'O (청색 거성)';
}

function pickReticleTarget(camera: THREE.PerspectiveCamera): ReticleTarget | null {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
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
  for (const view of starSystems.values()) {
    if (!view.group.visible) continue;
    const center = view.group.position;
    for (let i = 0; i < view.planetSystem.planets.length; i++) {
      const planet = view.planetSystem.planets[i];
      const angle = planet.phase0 + (shipProperTime / planet.periodSec) * Math.PI * 2;
      const sinI = Math.sin(planet.inclination);
      const cosI = Math.cos(planet.inclination);
      const lx = Math.cos(angle) * planet.orbitRadius;
      const lz = Math.sin(angle) * planet.orbitRadius;
      const px = center.x + lx;
      const py = center.y + lz * sinI;
      const pz = center.z + lz * cosI;
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
            const a = planet.phase0 + (shipProperTime / planet.periodSec) * Math.PI * 2;
            const sI = Math.sin(planet.inclination);
            const cI = Math.cos(planet.inclination);
            const x = Math.cos(a) * planet.orbitRadius;
            const z = Math.sin(a) * planet.orbitRadius;
            return new THREE.Vector3(c.x + x, c.y + z * sI, c.z + z * cI);
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
        details.push({ k: '분광형', v: spectralLabel(captured.strength) });
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
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
