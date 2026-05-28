// Centralized graphics-quality presets. The player picks one from the
// toolbar; Scene.ts and StarSystemRenderer.ts subscribe to the live values
// so cheap knobs (LOD threshold, DPR cap, adaptive flag, starfield count,
// planet sphere resolution) take effect immediately. The one exception is
// MSAA, which is fixed at WebGLRenderer construction and so requires a
// full page reload to change — we surface that with a hint when the
// player picks a preset that would flip the AA bit.

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface GraphicsSettings {
  /** Cap on devicePixelRatio. Lower = fewer fragments to shade. */
  pixelRatioCap: number;
  /** When true, Scene.adaptPixelRatio() may temporarily lower DPR if FPS
   *  sags. When false, DPR is pinned to pixelRatioCap. */
  adaptiveDPR: boolean;
  /** WebGL antialias hint. Read once on Scene construction; changing it at
   *  runtime requires a fresh WebGLRenderer (page reload in practice). */
  antialias: boolean;
  /** Pixel-size threshold above which a particle uses the hi-LOD icosahedron.
   *  Smaller = more particles upgraded to hi-LOD → prettier but heavier. */
  particleLodPx: number;
  /** Background starfield density. */
  starfieldCount: number;
  /** Planet sphere mesh resolution. Tuple of (widthSegments, heightSegments).
   *  Applied to newly-created planet meshes; existing meshes keep their original
   *  resolution to avoid a costly rebuild of every materialized star system. */
  planetSphereSegments: [number, number];
  /** Sphere segments for the atmosphere shell — mirrors planetSphereSegments
   *  at slightly lower detail since the shell is silhouette-only. */
  atmoSphereSegments: [number, number];
}

export const QUALITY_PRESETS: Record<QualityPreset, GraphicsSettings> = {
  low: {
    pixelRatioCap: 1.0,
    adaptiveDPR: true,
    antialias: false,
    particleLodPx: 9,
    starfieldCount: 900,
    planetSphereSegments: [32, 16],
    atmoSphereSegments: [24, 16],
  },
  medium: {
    pixelRatioCap: 1.5,
    adaptiveDPR: true,
    antialias: false,
    particleLodPx: 6,
    starfieldCount: 1800,
    planetSphereSegments: [48, 32],
    atmoSphereSegments: [32, 24],
  },
  high: {
    pixelRatioCap: 2.0,
    adaptiveDPR: false,
    antialias: true,
    particleLodPx: 4,
    starfieldCount: 3000,
    planetSphereSegments: [64, 40],
    atmoSphereSegments: [48, 32],
  },
  ultra: {
    pixelRatioCap: 2.0,
    adaptiveDPR: false,
    antialias: true,
    particleLodPx: 2.5,
    starfieldCount: 5000,
    planetSphereSegments: [96, 64],
    atmoSphereSegments: [64, 40],
  },
};

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  low:    '저 (60FPS 목표)',
  medium: '중 (균형)',
  high:   '고 (퀄리티)',
  ultra:  '울트라 (최대)',
};

const STORAGE_KEY = 'cosmos:gfx-preset:v1';

/** Read the saved preset (or fall back to 'medium' on first run). */
export function loadSavedPreset(): QualityPreset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && raw in QUALITY_PRESETS) return raw as QualityPreset;
  } catch {
    // Storage disabled — silently fall back.
  }
  // Best-guess default by device: low-DPR small screen = low; everything
  // else = medium. We never auto-pick high/ultra — those are opt-in.
  if (window.devicePixelRatio < 1.25 && window.innerWidth < 1600) return 'low';
  return 'medium';
}

export function savePreset(preset: QualityPreset): void {
  try {
    localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // ignore
  }
}

export function settingsOf(preset: QualityPreset): GraphicsSettings {
  return QUALITY_PRESETS[preset];
}
