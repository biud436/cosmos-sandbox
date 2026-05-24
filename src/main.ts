import { Simulator } from './physics/Simulator';
import { Scene } from './render/Scene';
import { Controls, INTERNAL_DT, BASE_SUBSTEPS_PER_FRAME } from './ui/Controls';
import { Layout } from './ui/Layout';
import { PRESETS } from './ui/presets';
import { Tools } from './ui/Tools';

const BOX_HALF = 12;
const MAX_PARTICLES = 2000;
const MAX_PER_SPECIES = 800;
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
});

new Tools({
  isInsideViewport: (x, y) => scene.isInsideViewport(x, y),
  worldFromScreen: (x, y) => scene.worldFromScreen(x, y),
  onPlaceBlackHole: (pos) => {
    sim.addBlackHole(pos[0], pos[1], pos[2]);
    layout.log(`Black hole placed @ (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)})`, 'event');
  },
  onClearBlackHoles: () => {
    sim.clearBlackHoles();
    layout.log('Black holes cleared.');
  },
  setViewportDropHighlight: (active) => layout.setDropHighlight(active),
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
