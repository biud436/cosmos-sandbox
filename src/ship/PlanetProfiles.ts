// Photoreal body profiles for the 정밀 행성 관측 모드 (planet lab). Each profile
// points at real satellite-derived equirectangular maps under public/textures/
// (fetched by scripts/fetch-textures.sh — Solar System Scope CC-BY-4.0 / NASA).
// The lab renders one body at a time, framed as a hero close-up.
//
// Earth/Mars ship a 4K base in the repo with an 8K hero original kept locally
// (gitignored). The other bodies commit a single base (≤4K, or native 2K for
// Uranus/Neptune). Rocky worlds carry an albedo-derived bump map so the
// terminator shows relief instead of a flat sticker (real MOLA/LOLA elevation
// is a later upgrade — see plans/codex-texture-prompts.md).

export interface PlanetProfile {
  id: string;
  label: string;
  radius: number;
  /** Equatorial→polar squash. Gas giants are visibly oblate. */
  oblateness: number;
  /** Self-rotation period (visual seconds/turn). Negative = retrograde. */
  rotationPeriodSec: number;
  axialTilt: number;
  /** Camera standoff used to frame this body on selection. */
  viewDistance: number;
  /** The Sun is self-luminous: rendered unlit (MeshBasic) + a corona. */
  selfLuminous?: boolean;
  textures: {
    map: string;
    normalMap?: string;
    roughnessMap?: string;
    bumpMap?: string;
    emissiveMap?: string;
    cloudsMap?: string;
  };
  bumpScale?: number;
  emissiveIntensity?: number;
  clouds?: { scale: number; rotationPeriodSec: number; opacity: number };
  atmosphere?: { color: [number, number, number]; thickness: number; scale: number };
  /** Planetary ring (Saturn). `map` is an equirectangular alpha strip mapped
   *  radially; inner/outer are in body radii. */
  ring?: { map: string; inner: number; outer: number; opacity: number };
  moon?: { map: string; radius: number; distance: number; orbitPeriodSec: number };
  caption: string;
}

const EARTH = '/textures/earth';
const MARS = '/textures/mars';
const SOLAR = '/textures/solar';
const ENV = '/textures/env';

export const PLANET_PROFILES: PlanetProfile[] = [
  {
    id: 'sun', label: '☀️ 태양', radius: 1.0, oblateness: 0.0,
    rotationPeriodSec: 220, axialTilt: 0.126, viewDistance: 4.7, selfLuminous: true,
    textures: { map: `${SOLAR}/sun.jpg` },
    atmosphere: { color: [1.0, 0.68, 0.28], thickness: 1.5, scale: 1.22 },
    caption: '태양 — G2V 항성 · 광구 입상반(granulation) · 자체 발광 + 코로나 글로우',
  },
  {
    id: 'mercury', label: '☿ 수성', radius: 1.0, oblateness: 0.0,
    rotationPeriodSec: 210, axialTilt: 0.0006, viewDistance: 2.9,
    textures: { map: `${SOLAR}/mercury.jpg`, bumpMap: `${SOLAR}/mercury_bump.jpg` },
    bumpScale: 0.035,
    caption: '수성 — 대기 없는 크레이터 암석 표면 · MESSENGER 색 지도 · 알베도 기복',
  },
  {
    id: 'venus', label: '♀ 금성', radius: 1.0, oblateness: 0.0,
    rotationPeriodSec: -260, axialTilt: 0.046, viewDistance: 3.0,
    textures: { map: `${SOLAR}/venus.jpg` },
    atmosphere: { color: [0.96, 0.82, 0.5], thickness: 0.62, scale: 1.03 },
    caption: '금성 — 두꺼운 황산 구름에 완전히 덮인 대기 · 역자전',
  },
  {
    id: 'earth', label: '🌍 지구', radius: 1.0, oblateness: 0.0033,
    rotationPeriodSec: 140, axialTilt: 0.4101, viewDistance: 3.2,
    textures: {
      map: `${EARTH}/earth_day_4k.jpg`,
      normalMap: `${EARTH}/earth_normal_4k.png`,
      roughnessMap: `${EARTH}/earth_roughness_4k.png`,
      emissiveMap: `${EARTH}/earth_night_4k.jpg`,
      cloudsMap: `${EARTH}/earth_clouds_4k.jpg`,
    },
    emissiveIntensity: 1.8,
    clouds: { scale: 1.012, rotationPeriodSec: 115, opacity: 0.9 },
    atmosphere: { color: [0.32, 0.55, 1.0], thickness: 0.9, scale: 1.025 },
    moon: { map: `${ENV}/moon_color_4k.jpg`, radius: 0.273, distance: 4.2, orbitPeriodSec: 320 },
    caption: '지구 — Blue Marble/Black Marble · 주야 경계 도시불빛 · 자전 구름 · 해양 정반사 · 달',
  },
  {
    id: 'moon', label: '🌕 달', radius: 1.0, oblateness: 0.0,
    rotationPeriodSec: 200, axialTilt: 0.026, viewDistance: 2.7,
    textures: { map: `${ENV}/moon_color_4k.jpg`, bumpMap: `${ENV}/moon_bump_4k.jpg` },
    bumpScale: 0.05,
    caption: '달 — LRO 색 지도 · 바다(현무암 평원)와 고지대 · 알베도 기복',
  },
  {
    id: 'mars', label: '🔴 화성', radius: 1.0, oblateness: 0.0059,
    rotationPeriodSec: 144, axialTilt: 0.4398, viewDistance: 3.0,
    textures: { map: `${MARS}/mars_color_4k.jpg`, bumpMap: `${MARS}/mars_bump_4k.jpg` },
    bumpScale: 0.03,
    atmosphere: { color: [0.92, 0.52, 0.34], thickness: 0.3, scale: 1.018 },
    caption: '화성 — Viking/MGS 색 지도 · 얇은 CO₂ 헤이즈 · 알베도 기복 (MOLA 실측 기복은 후속)',
  },
  {
    id: 'jupiter', label: '🟠 목성', radius: 1.0, oblateness: 0.065,
    rotationPeriodSec: 60, axialTilt: 0.054, viewDistance: 3.6,
    textures: { map: `${SOLAR}/jupiter.jpg` },
    atmosphere: { color: [0.92, 0.82, 0.62], thickness: 0.45, scale: 1.02 },
    caption: '목성 — 가스 거대행성 · 띠와 대적점 · 빠른 자전으로 적도 팽대',
  },
  {
    id: 'saturn', label: '🪐 토성', radius: 1.0, oblateness: 0.098,
    rotationPeriodSec: 64, axialTilt: 0.466, viewDistance: 6.0,
    textures: { map: `${SOLAR}/saturn.jpg` },
    atmosphere: { color: [0.95, 0.86, 0.66], thickness: 0.38, scale: 1.02 },
    ring: { map: `${SOLAR}/saturn_ring.png`, inner: 1.25, outer: 2.3, opacity: 0.95 },
    caption: '토성 — 가스 거대행성 · 실측 고리(카시니 간극 포함) · 26.7° 기울기',
  },
  {
    id: 'uranus', label: '🔵 천왕성', radius: 1.0, oblateness: 0.023,
    rotationPeriodSec: 90, axialTilt: 1.706, viewDistance: 3.2,
    textures: { map: `${SOLAR}/uranus.jpg` },
    atmosphere: { color: [0.6, 0.86, 0.9], thickness: 0.5, scale: 1.02 },
    caption: '천왕성 — 메탄 청록 대기 · 옆으로 누운 98° 자전축',
  },
  {
    id: 'neptune', label: '🔷 해왕성', radius: 1.0, oblateness: 0.017,
    rotationPeriodSec: 80, axialTilt: 0.494, viewDistance: 3.2,
    textures: { map: `${SOLAR}/neptune.jpg` },
    atmosphere: { color: [0.3, 0.46, 0.95], thickness: 0.55, scale: 1.02 },
    caption: '해왕성 — 짙은 청색 메탄 대기 · 태양계 최외곽 거대행성',
  },
];

export function profileById(id: string): PlanetProfile | undefined {
  return PLANET_PROFILES.find((p) => p.id === id);
}
