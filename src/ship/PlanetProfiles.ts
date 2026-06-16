// Photoreal planet profiles for the 정밀 행성 관측 모드 (planet lab). Each
// profile points at real satellite-derived equirectangular texture maps that
// live under public/textures/ (fetched by scripts/fetch-textures.sh). The lab
// renders one profile at a time, framed as a hero close-up.
//
// Texture paths are the 4K base that ships in the repo. An 8K hero set exists
// locally (gitignored, reproduce with `bash scripts/fetch-textures.sh`); to use
// it, point these paths at the *_8k.* variants.

export interface PlanetProfile {
  id: string;
  label: string;
  /** Lab-space sphere radius. Both bodies frame the same, so we keep this at
   *  1.0 and let the camera standoff be identical between profiles. */
  radius: number;
  /** Equatorial→polar squash. Earth/Mars are nearly spherical; kept subtle. */
  oblateness: number;
  /** Self-rotation period (visual seconds per turn). */
  rotationPeriodSec: number;
  /** Axial tilt, radians. */
  axialTilt: number;
  textures: {
    /** Daytime albedo (sRGB). Required. */
    map: string;
    /** Tangent-space normal map (linear). */
    normalMap?: string;
    /** Per-pixel roughness (linear) — e.g. Earth oceans glossy, land matte. */
    roughnessMap?: string;
    /** Night city lights (sRGB), shown only on the dark side. */
    emissiveMap?: string;
    /** Cloud cover (white = cloud), used as an alpha mask on a separate shell. */
    cloudsMap?: string;
  };
  /** City-lights brightness multiplier when emissiveMap is present. */
  emissiveIntensity?: number;
  /** Cloud shell, if cloudsMap is set. */
  clouds?: { scale: number; rotationPeriodSec: number; opacity: number };
  /** Additive atmospheric limb glow (reuses the procedural atmosphere shell). */
  atmosphere?: { color: [number, number, number]; thickness: number; scale: number };
  /** Optional natural satellite (Earth's Moon). */
  moon?: { map: string; radius: number; distance: number; orbitPeriodSec: number };
  /** One-line caption shown in the lab UI. */
  caption: string;
}

const EARTH_DIR = '/textures/earth';
const MARS_DIR = '/textures/mars';
const ENV_DIR = '/textures/env';

export const PLANET_PROFILES: PlanetProfile[] = [
  {
    id: 'earth',
    label: '🌍 지구',
    radius: 1.0,
    oblateness: 0.0033,
    rotationPeriodSec: 140,
    axialTilt: 0.4101, // 23.44°
    textures: {
      map: `${EARTH_DIR}/earth_day_4k.jpg`,
      normalMap: `${EARTH_DIR}/earth_normal_4k.png`,
      roughnessMap: `${EARTH_DIR}/earth_roughness_4k.png`,
      emissiveMap: `${EARTH_DIR}/earth_night_4k.jpg`,
      cloudsMap: `${EARTH_DIR}/earth_clouds_4k.jpg`,
    },
    emissiveIntensity: 1.8,
    clouds: { scale: 1.012, rotationPeriodSec: 115, opacity: 0.9 },
    atmosphere: { color: [0.32, 0.55, 1.0], thickness: 0.9, scale: 1.025 },
    moon: { map: `${ENV_DIR}/moon_color_4k.jpg`, radius: 0.273, distance: 4.2, orbitPeriodSec: 320 },
    caption: '지구 — NASA Blue Marble / Black Marble · 실시간 주야 경계 · 자전하는 구름 · 해양 정반사',
  },
  {
    id: 'mars',
    label: '🔴 화성',
    radius: 1.0,
    oblateness: 0.0059,
    rotationPeriodSec: 144,
    axialTilt: 0.4398, // 25.19°
    textures: {
      map: `${MARS_DIR}/mars_color_4k.jpg`,
    },
    atmosphere: { color: [0.92, 0.52, 0.34], thickness: 0.32, scale: 1.018 },
    caption: '화성 — NASA Viking/MGS 색 지도 · 얇은 CO₂ 헤이즈 (기복 normal 맵은 후속 추가 예정)',
  },
];

export function profileById(id: string): PlanetProfile | undefined {
  return PLANET_PROFILES.find((p) => p.id === id);
}
