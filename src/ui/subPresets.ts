export interface EnvPreset {
  name: string;
  targetTemperatureK?: number;
  gravity?: number;
  windX?: number;
  selfGravity?: number;
  thermostatTau?: number;
}

export const ENV_PRESETS: EnvPreset[] = [
  { name: '— 선택 —' },
  { name: '극저온 20K', targetTemperatureK: 20, gravity: 0, windX: 0, selfGravity: 0 },
  { name: '저온 80K', targetTemperatureK: 80, gravity: 0, windX: 0, selfGravity: 0 },
  { name: '실온 300K', targetTemperatureK: 300, gravity: 0, windX: 0, selfGravity: 0 },
  { name: '고온 3000K', targetTemperatureK: 3000, gravity: 0, windX: 0, selfGravity: 0 },
  { name: '항성 18000K', targetTemperatureK: 18000, gravity: 0, windX: 0, selfGravity: 0.4 },
  { name: '지상 중력', gravity: 0.05 },
  { name: '무중력', gravity: 0, windX: 0, selfGravity: 0 },
  { name: '강풍', windX: 0.2 },
  { name: '약한 자기중력', selfGravity: 0.15 },
  { name: '강한 자기중력', selfGravity: 0.4 },
];

export interface CompositionPreset {
  name: string;
  distribution?: Record<string, number>;
}

export const COMPOSITION_PRESETS: CompositionPreset[] = [
  { name: '— 선택 —' },
  { name: '빈 상태', distribution: { H: 0, He: 0, 'N₂': 0, 'O₂': 0, Dust: 0 } },
  { name: '수소만 600', distribution: { H: 600, He: 0, 'N₂': 0, 'O₂': 0, Dust: 0 } },
  { name: '공기 (N₂+O₂)', distribution: { H: 0, He: 0, 'N₂': 240, 'O₂': 60, Dust: 0 } },
  { name: '우주 (H+He)', distribution: { H: 480, He: 80, 'N₂': 0, 'O₂': 0, Dust: 0 } },
  { name: '먼지 폭풍', distribution: { H: 0, He: 0, 'N₂': 80, 'O₂': 20, Dust: 100 } },
  { name: '혼합 전부', distribution: { H: 200, He: 50, 'N₂': 100, 'O₂': 50, Dust: 20 } },
];

export interface BondingPreset {
  name: string;
  bondingEnabled?: boolean;
  bondStiffness?: number;
  bondFormFactor?: number;
  bondBreakFactor?: number;
}

export const BONDING_PRESETS: BondingPreset[] = [
  { name: '— 선택 —' },
  { name: '비활성', bondingEnabled: false },
  { name: '약한 결합', bondingEnabled: true, bondStiffness: 30, bondFormFactor: 1.0, bondBreakFactor: 2.0 },
  { name: '표준', bondingEnabled: true, bondStiffness: 80, bondFormFactor: 1.2, bondBreakFactor: 3.0 },
  { name: '강한 결합', bondingEnabled: true, bondStiffness: 200, bondFormFactor: 1.4, bondBreakFactor: 5.0 },
  { name: '취약 결합', bondingEnabled: true, bondStiffness: 50, bondFormFactor: 1.2, bondBreakFactor: 1.8 },
];

export interface FusionPreset {
  name: string;
  fusionEnabled?: boolean;
  fusionThresholdReduced?: number;
  fusionEnergyRelease?: number;
}

export const FUSION_PRESETS: FusionPreset[] = [
  { name: '— 선택 —' },
  { name: '비활성', fusionEnabled: false },
  { name: '쉬움 (저 임계)', fusionEnabled: true, fusionThresholdReduced: 10, fusionEnergyRelease: 12 },
  { name: '표준', fusionEnabled: true, fusionThresholdReduced: 30, fusionEnergyRelease: 8 },
  { name: '어려움 (고 임계)', fusionEnabled: true, fusionThresholdReduced: 100, fusionEnergyRelease: 5 },
  { name: '폭발적', fusionEnabled: true, fusionThresholdReduced: 30, fusionEnergyRelease: 40 },
];
