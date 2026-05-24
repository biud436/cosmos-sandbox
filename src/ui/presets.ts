import type { CosmicEvent } from '../physics/Simulator';

export interface Preset {
  name: string;
  description: string;
  temperatureK: number;
  gravity: number;
  windX: number;
  selfGravity: number;
  bondingEnabled: boolean;
  fusionEnabled: boolean;
  thermostatCoolOnly?: boolean;
  initialPattern?: 'uniform' | 'clumpy';
  initialClumpCount?: number;
  initialClumpSpread?: number;
  hubbleRate?: number;
  hubbleDecay?: number;
  openBoundary?: boolean;
  starFormationEnabled?: boolean;
  starFormationRadius?: number;
  starFormationCount?: number;
  starFormationCooldown?: number;
  starFormationDMMin?: number;
  starFormationDMRadius?: number;
  initialBoundingRadius?: number;
  cosmicEvents?: CosmicEvent[];
  initialVelocityScale?: number;
  distribution: Record<string, number>;
  renderMode: 'solid' | 'gas';
  showEnvironment: boolean;
  initialTimeScale: number;
  yearsPerUnit: number;
}

export const PRESETS: Preset[] = [
  {
    name: '빅뱅 (Big Bang)',
    description: '작고 차가운 종자에서 시작 → 팽창은 빠르게 감속 → DM 헤일로에 가스가 응집 → 여러 은하가 회전하며 탄생.',
    temperatureK: 30,
    gravity: 0,
    windX: 0,
    selfGravity: 0.9,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { H: 2400, He: 360, DM: 2400 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 1,
    yearsPerUnit: 30_000_000,
    thermostatCoolOnly: true,
    initialPattern: 'clumpy',
    initialClumpCount: 14,
    initialClumpSpread: 0.015,
    initialBoundingRadius: 0.85,
    initialVelocityScale: 0.15,
    hubbleRate: 0.12,
    hubbleDecay: 0.4,
    openBoundary: true,
    starFormationEnabled: false,
    starFormationRadius: 2.5,
    starFormationCount: 3,
    starFormationCooldown: 0.15,
    cosmicEvents: [
      {
        time: 0.5,
        name: 'Inflation Ends',
        description: '인플레이션 종료. 팽창이 급격히 감속합니다.',
        action: (sim) => {
          sim.hubbleDecay = Math.max(sim.hubbleDecay, 1.5);
          sim.coolAllParticles(0.6);
        },
      },
      {
        time: 2.0,
        name: 'Big Bang Nucleosynthesis',
        description: '빅뱅 핵합성 — 수소가 헬륨으로 변환됩니다.',
        action: (sim) => { sim.bbnConvert(0.30); },
      },
      {
        time: 5.0,
        name: 'Recombination · CMB',
        description: '원자 형성, 우주배경복사 방출. 우주가 투명해집니다.',
        action: (sim) => {
          sim.targetTemperatureK = Math.min(sim.targetTemperatureK, 5);
          sim.coolAllParticles(0.4);
        },
      },
      {
        time: 5.0,
        name: 'First Stars · Population III',
        description: '암흑 시대의 끝. 암흑물질 헤일로 안의 가스가 응집되어 최초의 별이 탄생합니다.',
        action: (sim) => {
          sim.starFormationEnabled = true;
          sim.starFormationRadius = 2.5;
          sim.starFormationCount = 3;
          sim.forceFormStars(60, 2.5, 4);
        },
      },
      {
        time: 10.0,
        name: 'Galaxy Assembly',
        description: '여러 별 무리가 회전하며 원시 은하가 형성됩니다. (블랙홀은 자연 형성에 맡김)',
        action: (sim) => {
          sim.seedGalaxies({
            galaxyCount: 14,
            starsPerGalaxy: 24,
            radius: 7.0,
            starClusterSize: 4,
            orbitalSpeed: 0.5,
          });
        },
      },
      {
        time: 18.0,
        name: 'Stellar Baby Boom',
        description: '남은 가스가 응집해 별이 폭발적으로 더 탄생합니다.',
        action: (sim) => {
          sim.forceFormStars(120, 2.0, 4);
        },
      },
      {
        time: 35.0,
        name: 'Second Wave',
        description: '남은 가스에서 다시 별이 형성됩니다.',
        action: (sim) => {
          sim.forceFormStars(80, 2.5, 4);
        },
      },
      {
        time: 60.0,
        name: 'Late Star Formation',
        description: '잔존 가스로 마지막 별들이 태어납니다.',
        action: (sim) => {
          sim.forceFormStars(60, 3.0, 3);
        },
      },
    ],
  },
  {
    name: '우주 가스 구름',
    description: '암흑물질 헤일로 + 클럼피 초기 조건. DM 중력 우물에 H/He가 끌려가 응집·구조 형성.',
    temperatureK: 12,
    gravity: 0,
    windX: 0,
    selfGravity: 1.0,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { H: 360, He: 60, DM: 420 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 4,
    yearsPerUnit: 5_000_000,
    thermostatCoolOnly: true,
    initialPattern: 'clumpy',
    initialClumpCount: 6,
    hubbleRate: 0.04,
    openBoundary: true,
    starFormationEnabled: true,
    starFormationRadius: 1.0,
    starFormationCount: 14,
  },
  {
    name: '공기 흐름',
    description: '약한 측면 바람. 먼지가 흐름에 실려 움직이며 서로 결합·응집.',
    temperatureK: 320,
    gravity: 0.01,
    windX: 0.05,
    selfGravity: 0,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { 'N₂': 220, 'O₂': 70, 'Dust': 24 },
    renderMode: 'solid',
    showEnvironment: true,
    initialTimeScale: 1,
    yearsPerUnit: 10,
  },
  {
    name: '저온 응축',
    description: '낮은 온도에서 분자 간 인력 우세 + 결합 활성 → 액적/응집 관찰.',
    temperatureK: 35,
    gravity: 0,
    windX: 0,
    selfGravity: 0,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { 'N₂': 180, 'O₂': 60 },
    renderMode: 'solid',
    showEnvironment: true,
    initialTimeScale: 1,
    yearsPerUnit: 100,
  },
  {
    name: '항성 내부 (융합)',
    description: '극고온 고밀도 수소. 결합은 즉시 깨지고 H+H→He 핵융합이 우세.',
    temperatureK: 18000,
    gravity: 0,
    windX: 0,
    selfGravity: 0.4,
    bondingEnabled: false,
    fusionEnabled: true,
    distribution: { H: 600, He: 40 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 2,
    yearsPerUnit: 1_000,
  },
];
