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
  hubbleRate?: number;
  hubbleDecay?: number;
  openBoundary?: boolean;
  starFormationEnabled?: boolean;
  starFormationRadius?: number;
  starFormationCount?: number;
  starFormationCooldown?: number;
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
    description: '작고 차가운 종자에서 시작 → 팽창은 빠르게 감속 → DM 헤일로에 가스가 응집 → 첫 별 탄생.',
    temperatureK: 30,
    gravity: 0,
    windX: 0,
    selfGravity: 2.0,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { H: 540, He: 80, DM: 380 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 1,
    yearsPerUnit: 30_000_000,
    thermostatCoolOnly: true,
    initialPattern: 'clumpy',
    initialClumpCount: 5,
    initialBoundingRadius: 0.30,
    initialVelocityScale: 0.15,
    hubbleRate: 0.12,
    hubbleDecay: 0.4,
    openBoundary: true,
    starFormationEnabled: false,
    starFormationRadius: 2.4,
    starFormationCount: 4,
    starFormationCooldown: 0.3,
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
        action: (sim) => { sim.bbnConvert(0.44); },
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
        time: 12.0,
        name: 'First Stars · Population III',
        description: '암흑 시대의 끝. 최초의 별이 탄생합니다.',
        action: (sim) => {
          sim.starFormationEnabled = true;
          sim.forceFormStars(5, 3.0, 3);
        },
      },
      {
        time: 25.0,
        name: 'Galaxy Assembly',
        description: '별 다발이 회전하며 원시 은하를 이룹니다.',
        action: (sim) => {
          sim.forceFormStars(12, 3.8, 3);
          sim.spinUpRecentStars(0.8, 0.5);
        },
      },
      {
        time: 45.0,
        name: 'Central Black Hole',
        description: '은하 중심에서 거대한 별이 붕괴해 초대질량 BH의 씨앗이 됩니다.',
        action: (sim) => {
          let sumX = 0, sumY = 0, sumZ = 0, totM = 0;
          for (const e of sim.effectors) {
            if (e.type === 'star') { sumX += e.x * e.strength; sumY += e.y * e.strength; sumZ += e.z * e.strength; totM += e.strength; }
          }
          if (totM > 0) {
            const bh = sim.addEffector('blackhole', sumX / totM, sumY / totM, sumZ / totM);
            bh.strength = 60;
            bh.radius = 0.4;
          }
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
