// Realistic stellar physics helpers.
//
// The sim's mass unit is internal; we anchor it to the Sun via M_SUN_UNITS so
// that a strength=30 star reads as ~1 M⊙ (T≈5800 K, L≈1 L⊙). Everything
// downstream — color, light intensity, spectral class — derives from this.
//
// Mass→T uses a smoothed main-sequence relation (steeper at low mass than
// high mass) and Mass→L uses the standard piecewise M^α law. Both are
// approximations; they're close enough that the HR-diagram chromatic gradient
// reads correctly (red M dwarfs → yellow G → blue O).

export const M_SUN_UNITS = 30;
export const T_SUN_K = 5778;
export const L_SUN = 1;

/** Effective surface temperature (K) for a main-sequence star of given mass. */
export function effectiveTemperature(massUnits: number): number {
  const mSolar = Math.max(0.05, massUnits / M_SUN_UNITS);
  // Smooth interpolation of the M-T relation across the MS. Real exponent runs
  // ~0.5 at low mass to ~0.6 at high mass; we use 0.55 as a single fit.
  return T_SUN_K * Math.pow(mSolar, 0.55);
}

/** Bolometric luminosity (L⊙) — standard piecewise mass-luminosity law. */
export function luminosity(massUnits: number): number {
  const m = Math.max(0.05, massUnits / M_SUN_UNITS);
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2)    return Math.pow(m, 4.0);
  if (m < 55)   return 1.4 * Math.pow(m, 3.5);
  return 32000 * m; // very high mass — radiation-pressure-limited
}

export interface SpectralInfo {
  /** Single-letter Harvard class — O/B/A/F/G/K/M, plus 'D'(BH)/'N'(NS) where relevant. */
  cls: 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';
  /** Human-facing Korean label including a parenthetical color hint. */
  label: string;
}

/** Spectral classification from effective temperature. Boundaries are the
 *  conventional Harvard sequence (Morgan-Keenan). */
export function spectralClassFromT(T: number): SpectralInfo {
  if (T < 3700)  return { cls: 'M', label: 'M (적색 왜성)' };
  if (T < 5200)  return { cls: 'K', label: 'K (주황)' };
  if (T < 6000)  return { cls: 'G', label: 'G (태양형 황색)' };
  if (T < 7500)  return { cls: 'F', label: 'F (황백)' };
  if (T < 10000) return { cls: 'A', label: 'A (백색)' };
  if (T < 30000) return { cls: 'B', label: 'B (청백)' };
  return            { cls: 'O', label: 'O (청색 거성)' };
}

/** Approximate blackbody emission color in linear RGB [0,1]. Uses the
 *  Krystek/Charity color-temperature fit (the same curve used by most
 *  photo apps for white-balance presets), but rebased to keep saturation up
 *  at the cool end so M-dwarfs read as visibly red against the starfield
 *  instead of muddy salmon. */
export function blackbodyRGB(T: number): [number, number, number] {
  // Clamp to the curve's valid range.
  const t = Math.max(1000, Math.min(40000, T)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  // Push saturation a touch for cool stars so they look distinctly red.
  let rr = clamp(r), gg = clamp(g), bb = clamp(b);
  if (T < 3700) {
    gg *= 0.75;
    bb *= 0.55;
  } else if (T < 5200) {
    gg *= 0.92;
    bb *= 0.85;
  }
  return [rr, gg, bb];
}
