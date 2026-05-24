export interface Preset {
  name: string;
  description: string;
  temperatureK: number;
  gravity: number;
  windX: number;
  selfGravity: number;
  bondingEnabled: boolean;
  fusionEnabled: boolean;
  distribution: Record<string, number>;
  renderMode: 'solid' | 'gas';
  showEnvironment: boolean;
  initialTimeScale: number;
  yearsPerUnit: number;
}

export const PRESETS: Preset[] = [
  {
    name: '우주 가스 구름',
    description: '차가운 수소·헬륨 + 약한 자기중력 + 화학 결합. H 원자들이 만나면 H₂ 분자 형성.',
    temperatureK: 35,
    gravity: 0,
    windX: 0,
    selfGravity: 0.25,
    bondingEnabled: true,
    fusionEnabled: false,
    distribution: { H: 520, He: 90 },
    renderMode: 'gas',
    showEnvironment: false,
    initialTimeScale: 2,
    yearsPerUnit: 1_000_000,
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
