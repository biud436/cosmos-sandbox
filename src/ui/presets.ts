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
    selfGravity: 1.6,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { H: 1400, He: 220, DM: 1400 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 1,
    yearsPerUnit: 30_000_000,
    thermostatCoolOnly: true,
    initialPattern: 'clumpy',
    initialClumpCount: 8,
    initialClumpSpread: 0.14,
    initialBoundingRadius: 0.50,
    initialVelocityScale: 0.15,
    hubbleRate: 0.12,
    hubbleDecay: 0.4,
    openBoundary: true,
    starFormationEnabled: false,
    starFormationRadius: 1.4,
    starFormationCount: 4,
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
        time: 12.0,
        name: 'First Stars · Population III',
        description: '암흑 시대의 끝. 가스가 응집되어 최초의 별이 일제히 탄생합니다.',
        action: (sim) => {
          sim.starFormationEnabled = true;
          sim.starFormationRadius = 1.4;
          sim.starFormationCount = 4;
          sim.forceFormStars(60, 2.0, 4);
        },
      },
      {
        time: 18.0,
        name: 'Galaxy Assembly',
        description: '여러 은하가 형성되며, 각 은하 중심에 SMBH 씨앗이 생깁니다.',
        action: (sim) => {
          sim.seedGalaxies({
            galaxyCount: 8,
            starsPerGalaxy: 28,
            radius: 3.5,
            starClusterSize: 4,
            orbitalSpeed: 0.7,
            centralBHMass: 35,
            centralBHRadius: 0.32,
          });
        },
      },
      {
        time: 28.0,
        name: 'Stellar Baby Boom',
        description: '남은 가스가 응집해 별이 폭발적으로 더 탄생합니다.',
        action: (sim) => {
          sim.forceFormStars(80, 2.0, 4);
        },
      },
      {
        time: 40.0,
        name: 'Supermassive Growth',
        description: '가장 큰 은하의 중심 BH가 별과 가스를 빨아들이며 급성장합니다.',
        action: (sim) => {
          let biggest: { x: number; y: number; z: number; mass: number } | null = null;
          for (const e of sim.effectors) {
            if (e.type !== 'blackhole') continue;
            if (!biggest || e.strength > biggest.mass) biggest = { x: e.x, y: e.y, z: e.z, mass: e.strength };
          }
          if (biggest) {
            for (const e of sim.effectors) {
              if (e.type === 'blackhole' && e.strength === biggest.mass && e.x === biggest.x) {
                e.strength = Math.min(300, e.strength * 2.4);
                e.radius = Math.max(0.5, Math.cbrt(e.strength) * 0.18);
                break;
              }
            }
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
