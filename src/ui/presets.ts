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
    distribution: { H: 400, He: 80, DM: 480 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 1,
    yearsPerUnit: 30_000_000,
    thermostatCoolOnly: true,
    initialPattern: 'clumpy',
    initialClumpCount: 5,
    initialBoundingRadius: 0.12,
    hubbleRate: 0.12,
    hubbleDecay: 0.4,
    openBoundary: true,
    starFormationEnabled: true,
    starFormationRadius: 1.4,
    starFormationCount: 8,
    starFormationCooldown: 0.2,
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
