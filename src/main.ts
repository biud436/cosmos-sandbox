import { Simulator } from './physics/Simulator';
import { Scene } from './render/Scene';
import { Controls, INTERNAL_DT, BASE_SUBSTEPS_PER_FRAME } from './ui/Controls';
import { Layout } from './ui/Layout';
import { PRESETS } from './ui/presets';
import { Tools } from './ui/Tools';

const BOX_HALF = 150;
const MAX_PARTICLES = 8000;
const MAX_PER_SPECIES = 3000;
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

layout.bindToolbar({
  presets: PRESETS.map((p) => p.name),
  initialPreset: controls.state.preset,
  initialTimeScale: controls.state.timeScale,
  onPreset: (name) => {
    controls.applyPresetByName(name);
    layout.log(`Preset → ${name}`);
  },
  onPauseToggle: () => controls.togglePause(),
  onStep: () => {
    if (!controls.state.paused) return;
    sim.step(INTERNAL_DT);
  },
  onReset: () => sim.reset(controls.getDistribution()),
  onTimeScale: (scale) => {
    controls.setTimeScale(scale);
    layout.log(`Time scale → ×${scale}`);
  },
  onToggleOrbits: () => {
    const next = !scene.isVisible('orbits');
    scene.setVisibility('orbits', next);
    layout.log(`공전 궤도 ${next ? '표시' : '숨김'}`);
  },
});

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
  scene.setSelectedEffector(null);
  controls.showSelectedEffector(null);
  if (reason === 'merged')   layout.log(`Black hole merged · M=${eff.strength.toFixed(0)}`, 'event');
  if (reason === 'consumed') layout.log(`Star consumed by black hole`, 'event');
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

let lastTime = performance.now();
let frames = 0;
let fpsTimer = 0;
let fps = 0;

function loop(): void {
  const now = performance.now();
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (!controls.state.paused && controls.state.timeScale > 0) {
    const desired = BASE_SUBSTEPS_PER_FRAME * controls.state.timeScale;
    const substeps = Math.max(1, Math.round(desired));
    for (let s = 0; s < substeps; s++) sim.step(INTERNAL_DT);
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
