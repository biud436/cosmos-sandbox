import GUI from 'lil-gui';
import { Effector, Simulator } from '../physics/Simulator';
import { SPECIES } from '../physics/types';
import { Scene } from '../render/Scene';
import { Preset, PRESETS } from './presets';
import {
  BONDING_PRESETS,
  BondingPreset,
  COMPOSITION_PRESETS,
  CompositionPreset,
  ENV_PRESETS,
  EnvPreset,
  FUSION_PRESETS,
  FusionPreset,
} from './subPresets';

export interface ControlsState {
  paused: boolean;
  timeScale: number;
  preset: string;
}

export const INTERNAL_DT = 0.005;
export const BASE_SUBSTEPS_PER_FRAME = 1;

export class Controls {
  readonly state: ControlsState = {
    paused: false,
    timeScale: 1,
    preset: PRESETS[0].name,
  };

  private gui: GUI;
  private distributionControllers: Record<string, { setValue: (v: number) => void }> = {};
  private distribution: Record<string, number> = {};
  private suppressApply = false;
  private selectedFolder: GUI | null = null;
  private onDeleteEffector: ((eff: Effector) => void) | null = null;
  private subPresetState = {
    env: ENV_PRESETS[0].name,
    composition: COMPOSITION_PRESETS[0].name,
    bonding: BONDING_PRESETS[0].name,
    fusion: FUSION_PRESETS[0].name,
  };

  constructor(
    private sim: Simulator,
    container: HTMLElement,
    private scene: Scene,
    private onApplyDistribution: (distribution: Record<string, number>) => void,
    private onPresetApplied: (preset: Preset) => void,
  ) {
    this.gui = new GUI({ container, title: 'Parameters' });
    this.state.preset = PRESETS[0].name;
    this.state.timeScale = PRESETS[0].initialTimeScale;
    this.distribution = { ...PRESETS[0].distribution };
    this.buildEnvironmentFolder();
    this.buildDistributionFolder();
    this.buildBondingFolder();
    this.buildFusionFolder();
    this.buildCosmologyFolder();
    this.buildInitialConditionsFolder();
    this.buildEffectorPhysicsFolder();
    this.buildVisibilityFolder();
    this.applyPreset(PRESETS[0]);
  }

  private buildInitialConditionsFolder(): void {
    const folder = this.gui.addFolder('초기 조건');
    folder
      .add(this.sim, 'initialPattern', ['uniform', 'clumpy'])
      .name('초기 분포 패턴').listen();
    folder.add(this.sim, 'initialClumpCount', 1, 40, 1).name('클럼프 개수').listen();
    folder.add(this.sim, 'initialClumpSpread', 0.005, 0.30, 0.005).name('클럼프 퍼짐').listen();
    folder.add(this.sim, 'initialBoundingRadius', 0.05, 1.0, 0.05).name('초기 분포 반경').listen();
    folder.add(this.sim, 'initialVelocityScale', 0, 3, 0.05).name('초기 속도 스케일').listen();
    folder.add(this.sim, 'initialClumpRotation', 0, 3, 0.05).name('클럼프 자전 ω').listen();
  }

  private buildEffectorPhysicsFolder(): void {
    const folder = this.gui.addFolder('효과기 물리');
    folder.add(this.sim, 'effectorPairG', 0, 1.5, 0.01).name('효과기 상호 G').listen();
    folder.add(this.sim, 'starStarGMul', 0, 1.0, 0.01).name('별-별 G 배율').listen();
    folder.add(this.sim, 'starConsumeRadiusMul', 0.1, 1.0, 0.05).name('별 소비 반경 배율').listen();
    folder.add(this.sim, 'bhInspiralRate', 0, 5.0, 0.05).name('BH 중력파 inspiral').listen();
    folder.add(this.sim, 'bhInspiralRange', 1, 30, 0.5).name('BH inspiral 범위').listen();
    folder.add(this.sim, 'blackHoleG', 0, 4.0, 0.05).name('블랙홀 → 입자 G').listen();
    folder.add(this.sim, 'starG', 0, 4.0, 0.05).name('별 → 입자 G').listen();
    folder.add(this.sim, 'repulsorG', 0, 10, 0.1).name('반발자 G').listen();
    folder.add(this.sim, 'freezerDamp', 0.5, 0.999, 0.001).name('동결자 감쇠').listen();
    folder.add(this.sim, 'maxParticleSpeed', 0, 40, 0.5).name('입자 속도 캡').listen();
    folder.add(this.sim, 'maxEffectorSpeed', 0, 30, 0.5).name('효과기 속도 캡').listen();
    folder.add(this.sim, 'supernovaMassThreshold', 50, 500, 10).name('초신성 질량 임계').listen();
    folder.add(this.sim, 'supernovaFullDisruptionProb', 0, 1, 0.05).name('초신성 완전붕괴 확률').listen();
    folder.add(this.sim, 'supernovaEjectaSpeed', 0, 10, 0.1).name('초신성 분출 속도').listen();
    folder.add(this.sim, 'supernovaEjectaCountFactor', 0, 1, 0.01).name('초신성 분출 입자 계수').listen();
  }

  private buildCosmologyFolder(): void {
    const folder = this.gui.addFolder('우주론');
    folder.add(this.sim, 'hubbleRate', 0, 0.3, 0.001).name('Hubble H₀').listen();
    folder.add(this.sim, 'hubbleDecay', 0, 2, 0.01).name('Hubble decay α').listen();
    folder.add(this.sim, 'openBoundary').name('Open boundary').listen();
    folder.add(this.sim, 'starFormationEnabled').name('Star formation').listen();
    folder.add(this.sim, 'starFormationRadius', 0.3, 3.0, 0.05).name('SF radius').listen();
    folder.add(this.sim, 'starFormationCount', 4, 80, 1).name('SF threshold').listen();
    folder.add(this.sim, 'starFormationCooldown', 0.05, 2.0, 0.05).name('SF cooldown').listen();
    folder.add(this.sim, 'starFormationDMMin', 0, 40, 1).name('별 형성: 암흑물질 최소').listen();
    folder.add(this.sim, 'starFormationDMRadius', 0.5, 10, 0.1).name('별 형성: 암흑물질 헤일로 반경').listen();
    folder.add(this.sim, 'bhTheta', 0.1, 1.5, 0.05).name('BH θ').listen();
  }

  private buildVisibilityFolder(): void {
    const folder = this.gui.addFolder('시야 (Visibility)');
    const groups: { key: 'particles' | 'bonds' | 'boundary' | 'stars' | 'blackholes' | 'repulsors' | 'freezers' | 'orbits' | 'galaxies'; label: string }[] = [
      { key: 'particles', label: '입자' },
      { key: 'bonds', label: '결합' },
      { key: 'stars', label: '별' },
      { key: 'blackholes', label: '블랙홀' },
      { key: 'galaxies', label: '은하 헤일로' },
      { key: 'repulsors', label: '반발자' },
      { key: 'freezers', label: '동결자' },
      { key: 'orbits', label: '공전 궤도' },
      { key: 'boundary', label: '우주 경계' },
    ];
    for (const g of groups) {
      const proxy = { v: this.scene.isVisible(g.key) };
      folder
        .add(proxy, 'v')
        .name(g.label)
        .onChange((val: boolean) => this.scene.setVisibility(g.key, val));
    }
  }

  private buildBondingFolder(): void {
    const folder = this.gui.addFolder('화학 결합');
    folder
      .add(this.subPresetState, 'bonding', BONDING_PRESETS.map((p) => p.name))
      .name('▾ 빠른 적용')
      .onChange((name: string) => this.applyBondingPreset(name));
    folder.add(this.sim, 'bondingEnabled').name('Enable bonding').listen();
    folder.add(this.sim, 'bondStiffness', 10, 400, 1).name('Stiffness k').listen();
    folder.add(this.sim, 'bondFormFactor', 0.6, 2.0, 0.05).name('Form r/σ').listen();
    folder.add(this.sim, 'bondBreakFactor', 1.5, 6.0, 0.1).name('Break r/r₀').listen();
  }

  private applyBondingPreset(name: string): void {
    const preset = BONDING_PRESETS.find((p) => p.name === name) as BondingPreset | undefined;
    if (!preset) return;
    if (preset.bondingEnabled !== undefined) this.sim.bondingEnabled = preset.bondingEnabled;
    if (preset.bondStiffness !== undefined) this.sim.bondStiffness = preset.bondStiffness;
    if (preset.bondFormFactor !== undefined) this.sim.bondFormFactor = preset.bondFormFactor;
    if (preset.bondBreakFactor !== undefined) this.sim.bondBreakFactor = preset.bondBreakFactor;
  }

  private buildEnvironmentFolder(): void {
    const folder = this.gui.addFolder('환경');
    folder
      .add(this.subPresetState, 'env', ENV_PRESETS.map((p) => p.name))
      .name('▾ 빠른 적용')
      .onChange((name: string) => this.applyEnvPreset(name));
    folder.add(this.sim, 'targetTemperatureK', 1, 30000, 1).name('Temperature (K)').listen();
    folder.add(this.sim, 'gravity', -0.5, 0.5, 0.001).name('Gravity (-Y)').listen();
    folder.add(this.sim, 'windX', -0.5, 0.5, 0.001).name('Wind (+X)').listen();
    folder.add(this.sim, 'selfGravity', 0, 1.5, 0.01).name('Self-gravity').listen();
    folder.add(this.sim, 'thermostatTau', 0.05, 5, 0.05).name('Thermostat τ').listen();
  }

  private applyEnvPreset(name: string): void {
    const preset = ENV_PRESETS.find((p) => p.name === name) as EnvPreset | undefined;
    if (!preset) return;
    if (preset.targetTemperatureK !== undefined) this.sim.targetTemperatureK = preset.targetTemperatureK;
    if (preset.gravity !== undefined) this.sim.gravity = preset.gravity;
    if (preset.windX !== undefined) this.sim.windX = preset.windX;
    if (preset.selfGravity !== undefined) this.sim.selfGravity = preset.selfGravity;
    if (preset.thermostatTau !== undefined) this.sim.thermostatTau = preset.thermostatTau;
  }

  private buildDistributionFolder(): void {
    const folder = this.gui.addFolder('입자 구성');
    folder
      .add(this.subPresetState, 'composition', COMPOSITION_PRESETS.map((p) => p.name))
      .name('▾ 빠른 적용')
      .onChange((name: string) => this.applyCompositionPreset(name));
    for (const sp of SPECIES) {
      if (!(sp.name in this.distribution)) this.distribution[sp.name] = 0;
      const ctrl = folder
        .add(this.distribution, sp.name, 0, 5500, 1)
        .name(sp.name)
        .onChange(() => {
          if (this.suppressApply) return;
          this.onApplyDistribution(this.getDistribution());
        });
      this.distributionControllers[sp.name] = ctrl;
    }
    folder.add({ apply: () => this.onApplyDistribution(this.getDistribution()) }, 'apply').name('Reset & Apply');
  }

  private applyCompositionPreset(name: string): void {
    const preset = COMPOSITION_PRESETS.find((p) => p.name === name) as CompositionPreset | undefined;
    if (!preset || !preset.distribution) return;
    this.suppressApply = true;
    for (const [k, v] of Object.entries(preset.distribution)) {
      this.distribution[k] = v;
      this.distributionControllers[k]?.setValue(v);
    }
    this.suppressApply = false;
    this.onApplyDistribution(this.getDistribution());
  }

  private buildFusionFolder(): void {
    const folder = this.gui.addFolder('핵융합 (간이 모델)');
    folder
      .add(this.subPresetState, 'fusion', FUSION_PRESETS.map((p) => p.name))
      .name('▾ 빠른 적용')
      .onChange((name: string) => this.applyFusionPreset(name));
    folder.add(this.sim, 'fusionEnabled').name('Enable H+H→He').listen();
    folder.add(this.sim, 'fusionThresholdReduced', 1, 200, 1).name('KE 임계값').listen();
    folder.add(this.sim, 'fusionEnergyRelease', 0, 50, 0.5).name('방출 에너지').listen();
  }

  private applyFusionPreset(name: string): void {
    const preset = FUSION_PRESETS.find((p) => p.name === name) as FusionPreset | undefined;
    if (!preset) return;
    if (preset.fusionEnabled !== undefined) this.sim.fusionEnabled = preset.fusionEnabled;
    if (preset.fusionThresholdReduced !== undefined) this.sim.fusionThresholdReduced = preset.fusionThresholdReduced;
    if (preset.fusionEnergyRelease !== undefined) this.sim.fusionEnergyRelease = preset.fusionEnergyRelease;
  }

  applyPreset(preset: Preset, applyDistribution = true): void {
    this.state.preset = preset.name;
    this.state.timeScale = preset.initialTimeScale;
    this.sim.targetTemperatureK = preset.temperatureK;
    this.sim.gravity = preset.gravity;
    this.sim.windX = preset.windX;
    this.sim.selfGravity = preset.selfGravity;
    this.sim.bondingEnabled = preset.bondingEnabled;
    this.sim.fusionEnabled = preset.fusionEnabled;
    this.sim.thermostatCoolOnly = preset.thermostatCoolOnly ?? false;
    this.sim.initialPattern = preset.initialPattern ?? 'uniform';
    if (preset.initialClumpCount !== undefined) this.sim.initialClumpCount = preset.initialClumpCount;
    if (preset.initialClumpSpread !== undefined) this.sim.initialClumpSpread = preset.initialClumpSpread;
    this.sim.hubbleRate = preset.hubbleRate ?? 0;
    this.sim.hubbleDecay = preset.hubbleDecay ?? 0;
    this.sim.openBoundary = preset.openBoundary ?? false;
    this.sim.starFormationEnabled = preset.starFormationEnabled ?? false;
    if (preset.starFormationRadius !== undefined) this.sim.starFormationRadius = preset.starFormationRadius;
    if (preset.starFormationCount !== undefined) this.sim.starFormationCount = preset.starFormationCount;
    if (preset.starFormationCooldown !== undefined) this.sim.starFormationCooldown = preset.starFormationCooldown;
    this.sim.starFormationDMMin = preset.starFormationDMMin ?? 0;
    this.sim.starFormationDMRadius = preset.starFormationDMRadius ?? 3.0;
    this.sim.initialBoundingRadius = preset.initialBoundingRadius ?? 0.9;
    this.sim.cosmicEvents = preset.cosmicEvents ?? [];
    this.sim.initialVelocityScale = preset.initialVelocityScale ?? 1.0;
    this.scene.setRenderMode(preset.renderMode);
    this.scene.setEnvironmentVisible(preset.showEnvironment && !this.sim.openBoundary);

    for (const sp of SPECIES) this.distribution[sp.name] = preset.distribution[sp.name] ?? 0;
    this.suppressApply = true;
    for (const [name, ctrl] of Object.entries(this.distributionControllers)) {
      ctrl.setValue(this.distribution[name]);
    }
    this.suppressApply = false;
    if (applyDistribution) this.onApplyDistribution(this.getDistribution());
    this.onPresetApplied(preset);
  }

  applyPresetByName(name: string): void {
    const p = PRESETS.find((x) => x.name === name);
    if (p) this.applyPreset(p);
  }

  togglePause(): boolean {
    this.state.paused = !this.state.paused;
    return this.state.paused;
  }

  setTimeScale(scale: number): void {
    this.state.timeScale = scale;
  }

  setDeleteHandler(handler: (eff: Effector) => void): void {
    this.onDeleteEffector = handler;
  }

  showSelectedEffector(eff: Effector | null): void {
    if (this.selectedFolder) {
      this.selectedFolder.destroy();
      this.selectedFolder = null;
    }
    if (!eff) return;

    const folder = this.gui.addFolder(`▸ Selected · ${eff.type}`);
    folder.open();
    folder.add(eff, 'x', -30, 30, 0.1).name('Position X').listen();
    folder.add(eff, 'y', -30, 30, 0.1).name('Position Y').listen();
    folder.add(eff, 'z', -30, 30, 0.1).name('Position Z').listen();
    const radiusRange = eff.type === 'freezer' ? [0.3, 8] : [0.3, 5];
    folder.add(eff, 'radius', radiusRange[0], radiusRange[1], 0.05).name('Radius').listen();
    if (eff.type === 'freezer') {
      folder.add(eff, 'strength', 0.5, 0.999, 0.001).name('Damping').listen();
    } else {
      folder.add(eff, 'strength', 1, 200, 1).name(eff.type === 'blackhole' || eff.type === 'star' ? 'Mass' : 'Strength').listen();
    }
    if (eff.type === 'blackhole' || eff.type === 'star') {
      const vel = folder.addFolder('Velocity (initial kick)');
      vel.add(eff, 'vx', -3, 3, 0.05).name('vx').listen();
      vel.add(eff, 'vy', -3, 3, 0.05).name('vy').listen();
      vel.add(eff, 'vz', -3, 3, 0.05).name('vz').listen();
    }
    if (eff.type === 'blackhole') {
      folder.add(eff, 'consumed').name('Consumed').disable().listen();
    }
    folder.add({ remove: () => this.onDeleteEffector?.(eff) }, 'remove').name('🗑 Delete');
    this.selectedFolder = folder;
  }

  getDistribution(): Record<string, number> {
    return { ...this.distribution };
  }
}
