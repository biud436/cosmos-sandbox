import * as THREE from 'three';
import { NOISE_GLSL } from './planet';

// Live, interactive gas-giant atmosphere for the photoreal observation mode
// (PlanetLab). The far view is the real jupiter.jpg sticker, unchanged. As the
// camera dollies in until the planet fills the frame, the *same* texture starts
// to churn: a domain-warped noise field (the "maze algorithm" — iterated fbm
// fed back into its own sample) displaces the texture's UVs so the real bands
// flow and curl, finer filaments emerge below the texture's resolution, and the
// cursor can stir local vortices into the actual clouds.
//
// Crucially the color stays the *texture's* color — the real band layout, the
// Great Red Spot, the browns and creams — so a zoom-in still reads as Jupiter,
// not a generic procedural ball. The palette is only an optional restyle
// (uPaletteMix > 0); the default "목성" palette leaves the texture untouched.

export const MAX_SWIRLS = 8;

export const JUPITER_GAS_VERT = /* glsl */ `
  varying vec3 vDir;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    // Object-space unit direction = the seamless noise domain (no UV poles).
    vDir = normalize(position);
    // Geometry UVs drive the equirectangular texture, identical to how the
    // stock MeshStandard sphere mapped jupiter.jpg — so the far (uDetail=0)
    // view matches the original textured planet exactly, and the warp below is
    // expressed as a displacement of these same UVs.
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const JUPITER_GAS_FRAG = /* glsl */ `
  varying vec3 vDir;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  uniform float uTime;
  uniform vec3  uSunDir;        // world-space, planet -> sun
  uniform float uFlow;          // churn speed (animates the warp field)
  uniform float uTurb;          // warp amplitude (how far the bands swirl)
  uniform float uWarpFreq;      // spatial frequency of the warp
  uniform float uContrast;      // palette restyle contrast
  uniform vec3  uPalette[5];    // restyle color ramp (low -> high tone)
  uniform float uPaletteMix;    // 0 = keep texture color (realistic), 1 = restyle
  uniform vec3  uAccent;        // bright filament highlight
  uniform vec3  uNightFloor;    // shadow-side multiplier tint
  uniform sampler2D uMap;       // photoreal texture (the color source)
  uniform float uDetail;        // 0 = static texture (far), 1 = full churn (close)
  uniform int   uSwirlCount;
  uniform vec2  uSwirlUv[${MAX_SWIRLS}];
  // x = radius (angular-ish), y = twist (rad, signed), z = tint amount, w unused
  uniform vec4  uSwirlParam[${MAX_SWIRLS}];
  uniform vec3  uSwirlTint[${MAX_SWIRLS}];

  ${NOISE_GLSL}

  // 6-octave fbm — more octaves than the base lib so close-ups keep revealing
  // finer cloud filaments.
  float jfbm(vec3 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { f += a * snoise(p); p *= 2.02; a *= 0.5; }
    return f;
  }
  float jridge(vec3 p) { return 1.0 - abs(jfbm(p)); }

  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    if (t < 1.0) return mix(uPalette[0], uPalette[1], t);
    if (t < 2.0) return mix(uPalette[1], uPalette[2], t - 1.0);
    if (t < 3.0) return mix(uPalette[2], uPalette[3], t - 2.0);
    return mix(uPalette[3], uPalette[4], t - 3.0);
  }

  void main() {
    vec2 uv = vUv;

    // Far view: plain texture, and the whole noise stack is skipped (uniform
    // branch -> coherent), so distant frames cost what the old sticker did.
    if (uDetail > 0.004) {
      vec3 n = normalize(vDir);
      float lat = n.y;

      // --- Animated domain-warp: churn the bands in place (no net scroll, so
      // the real features don't slide away). Time evolves the noise field. ---
      vec3 p = n * (uWarpFreq * 0.5 + 1.0);
      vec3 tw = vec3(0.0, uTime * uFlow * 0.4, uTime * uFlow * 0.25);
      vec3 w1 = vec3(jfbm(p + tw + 1.7), jfbm(p + tw + 9.2), jfbm(p + tw + 3.1));
      vec3 w2 = vec3(jfbm(p + 4.0 * w1 + 1.0), jfbm(p + 4.0 * w1 + 8.3), jfbm(p + 4.0 * w1 + 2.8));
      // UV displacement, mostly longitudinal, calmed toward the poles where the
      // equirectangular map compresses.
      vec2 warp = vec2(w2.x, w2.y * 0.55) * (uTurb * 0.013) * (1.0 - 0.6 * abs(lat));
      uv += warp * uDetail;

      // --- Interactive stir: each swirl rotates the texture sampling around a
      // point, twisting the real clouds into a vortex. ---
      vec3 tintSum = vec3(0.0);
      float tintW = 0.0;
      for (int i = 0; i < ${MAX_SWIRLS}; i++) {
        if (i >= uSwirlCount) break;
        vec2 c = uSwirlUv[i];
        vec4 pr = uSwirlParam[i];
        vec2 d = uv - c;
        d.x -= floor(d.x + 0.5); // wrap longitude difference to [-0.5, 0.5]
        // 2× on d.x makes the falloff round in angle (uv.x spans 360°, y 180°).
        float r = length(vec2(d.x * 2.0, d.y));
        float w = smoothstep(pr.x, 0.0, r);
        float ang = w * pr.y;
        float cs = cos(ang), sn = sin(ang);
        uv = c + vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
        tintSum += uSwirlTint[i] * w * pr.z;
        tintW += w * pr.z;
      }

      uv.x = fract(uv.x);
      uv.y = clamp(uv.y, 0.001, 0.999);
      vec3 col = texture2D(uMap, uv).rgb;

      // --- Fine procedural filaments below the texture's resolution. ---
      float veins = jridge(p * 2.0 + w2);
      col *= 1.0 + (veins - 0.5) * 0.20 * uDetail;
      col = mix(col, uAccent, smoothstep(0.62, 0.95, veins) * 0.10 * uDetail);

      // --- Stir tint (subtle fresh-gas brightening where the cursor passed). ---
      if (tintW > 0.001) col = mix(col, tintSum / tintW, clamp(tintW, 0.0, 0.5));

      // --- Optional palette restyle. 목성 keeps uPaletteMix = 0 (texture color);
      // the artistic palettes remap luminance to a color ramp. ---
      if (uPaletteMix > 0.001) {
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        float tone = clamp((luma - 0.5) * uContrast + 0.5, 0.0, 1.0);
        col = mix(col, ramp(tone), uPaletteMix * uDetail);
      }

      gl_FragColor = vec4(shade(col), 1.0);
      return;
    }

    gl_FragColor = vec4(shade(texture2D(uMap, uv).rgb), 1.0);
  }
`;

// `shade()` is injected just before main() at material build time so both the
// near and far paths share one lighting model (kept identical to the stock
// textured sphere: a soft terminator + gentle limb darkening).
const SHADE_GLSL = /* glsl */ `
  vec3 shade(vec3 albedo) {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndl = dot(N, normalize(uSunDir));
    float lit = smoothstep(-0.22, 0.55, ndl);
    vec3 col = albedo * mix(uNightFloor, vec3(1.0), lit);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    col *= mix(0.80, 1.06, smoothstep(0.0, 0.7, ndv));
    return col;
  }
  void main(`;

const FRAG_WITH_SHADE = JUPITER_GAS_FRAG.replace('void main(', SHADE_GLSL);

// ---- Palettes ---------------------------------------------------------------
// Colors are display-space (sRGB-ish) values — the ShaderMaterial output and
// the sampled texture are both written/read in display space, same convention
// as the atmosphere shell, so they compose without an explicit color transform.

export interface GasPalette {
  /** 5 ramp stops, low tone -> high tone (used only when paletteMix > 0). */
  stops: [number, number, number][];
  /** Bright filament highlight. */
  accent: [number, number, number];
  /** Shadow-side multiplier tint (keeps the night limb faintly visible). */
  nightFloor: [number, number, number];
  /** 0 keeps the real texture color (photoreal); >0 restyles toward `stops`. */
  paletteMix: number;
  flow: number;
  turb: number;
  warpFreq: number;
  contrast: number;
}

const HEX = (h: number): [number, number, number] => [
  ((h >> 16) & 255) / 255,
  ((h >> 8) & 255) / 255,
  (h & 255) / 255,
];

export const GAS_PALETTES: Record<string, { label: string; palette: GasPalette }> = {
  jupiter: {
    label: '목성 (실사)',
    palette: {
      stops: [HEX(0x6f4a36), HEX(0x9c6b46), HEX(0xc99b6a), HEX(0xe8c9a0), HEX(0xf4e7cf)],
      accent: HEX(0xfff3df),
      nightFloor: HEX(0x14100e),
      paletteMix: 0.0, // realistic: texture color untouched
      flow: 0.14, turb: 3.0, warpFreq: 6.0, contrast: 1.3,
    },
  },
  blue: {
    label: '외계 블루',
    palette: {
      stops: [HEX(0x12314f), HEX(0x2d5c80), HEX(0x5097b5), HEX(0x96cfdf), HEX(0xe2f4fa)],
      accent: HEX(0xeafaff),
      nightFloor: HEX(0x0a1420),
      paletteMix: 0.8,
      flow: 0.16, turb: 3.4, warpFreq: 7.0, contrast: 1.4,
    },
  },
  volcanic: {
    label: '화산',
    palette: {
      stops: [HEX(0x1f0c05), HEX(0x631f0c), HEX(0xb04a18), HEX(0xef8c28), HEX(0xffd27a)],
      accent: HEX(0xfff0c0),
      nightFloor: HEX(0x180a06),
      paletteMix: 0.82,
      flow: 0.2, turb: 3.8, warpFreq: 5.0, contrast: 1.5,
    },
  },
  mono: {
    label: '흑백',
    palette: {
      stops: [HEX(0x222222), HEX(0x5a5a5a), HEX(0x919191), HEX(0xc6c6c6), HEX(0xf2f2f2)],
      accent: HEX(0xffffff),
      nightFloor: HEX(0x101010),
      paletteMix: 0.9,
      flow: 0.14, turb: 3.0, warpFreq: 6.0, contrast: 1.6,
    },
  },
};

interface Swirl {
  uv: THREE.Vector2;
  radius: number;
  twist: number; // signed
  tintAmt: number;
  tint: THREE.Color;
  strength: number; // 0..1, decays
  decayPerSec: number;
}

export class JupiterGasMaterial {
  readonly material: THREE.ShaderMaterial;

  private readonly swirls: Swirl[] = [];
  private readonly uPalette: THREE.Color[];
  private readonly uSwirlUv: THREE.Vector2[];
  private readonly uSwirlParam: THREE.Vector4[];
  private readonly uSwirlTint: THREE.Color[];
  private readonly uAccent = new THREE.Color();
  private readonly uNightFloor = new THREE.Color();
  private readonly uSunDir = new THREE.Vector3(1, 0, 0);

  constructor(palette: GasPalette) {
    this.uPalette = palette.stops.map((s) => new THREE.Color(s[0], s[1], s[2]));
    while (this.uPalette.length < 5) this.uPalette.push(new THREE.Color(1, 1, 1));
    this.uSwirlUv = Array.from({ length: MAX_SWIRLS }, () => new THREE.Vector2(0, 0));
    this.uSwirlParam = Array.from({ length: MAX_SWIRLS }, () => new THREE.Vector4(0.2, 0, 0, 0));
    this.uSwirlTint = Array.from({ length: MAX_SWIRLS }, () => new THREE.Color(1, 1, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: JUPITER_GAS_VERT,
      fragmentShader: FRAG_WITH_SHADE,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: this.uSunDir },
        uFlow: { value: palette.flow },
        uTurb: { value: palette.turb },
        uWarpFreq: { value: palette.warpFreq },
        uContrast: { value: palette.contrast },
        uPalette: { value: this.uPalette },
        uPaletteMix: { value: palette.paletteMix },
        uAccent: { value: this.uAccent },
        uNightFloor: { value: this.uNightFloor },
        uMap: { value: null as THREE.Texture | null },
        uDetail: { value: 0 },
        uSwirlCount: { value: 0 },
        uSwirlUv: { value: this.uSwirlUv },
        uSwirlParam: { value: this.uSwirlParam },
        uSwirlTint: { value: this.uSwirlTint },
      },
    });

    this.applyPalette(palette);
  }

  setTime(t: number): void { this.material.uniforms.uTime.value = t; }
  setSun(v: THREE.Vector3): void { this.uSunDir.copy(v); }

  /** Photoreal texture — the color source for both far and near views. */
  setMap(tex: THREE.Texture): void { this.material.uniforms.uMap.value = tex; }

  /** LOD blend: 0 = static texture, 1 = full procedural churn. */
  setDetail(d: number): void { this.material.uniforms.uDetail.value = d; }
  getDetail(): number { return this.material.uniforms.uDetail.value; }

  setTurb(x: number): void { this.material.uniforms.uTurb.value = x; }
  setFlow(x: number): void { this.material.uniforms.uFlow.value = x; }
  getTurb(): number { return this.material.uniforms.uTurb.value; }
  getFlow(): number { return this.material.uniforms.uFlow.value; }

  applyPalette(p: GasPalette): void {
    for (let i = 0; i < 5; i++) {
      const s = p.stops[i] ?? [1, 1, 1];
      this.uPalette[i].setRGB(s[0], s[1], s[2]);
    }
    this.uAccent.setRGB(p.accent[0], p.accent[1], p.accent[2]);
    this.uNightFloor.setRGB(p.nightFloor[0], p.nightFloor[1], p.nightFloor[2]);
    this.material.uniforms.uFlow.value = p.flow;
    this.material.uniforms.uTurb.value = p.turb;
    this.material.uniforms.uWarpFreq.value = p.warpFreq;
    this.material.uniforms.uContrast.value = p.contrast;
    this.material.uniforms.uPaletteMix.value = p.paletteMix;
  }

  /** Inject a transient vortex at a texture UV (from the raycast hit). */
  stir(uv: THREE.Vector2, strength: number): void {
    if (this.swirls.length >= MAX_SWIRLS) this.swirls.shift(); // drop the oldest
    const s = Math.max(0.05, Math.min(1, strength));
    const sign = this.swirls.length % 2 === 0 ? 1 : -1;
    // Gentle, wide vortex so a cursor sweep reads as the clouds drifting under
    // your hand rather than snapping.
    this.swirls.push({
      uv: uv.clone(),
      radius: 0.16 + 0.10 * s,
      twist: sign * (0.30 + 0.70 * s),
      tintAmt: 0.10 + 0.16 * s,
      tint: this.uAccent.clone(),
      strength: 1,
      decayPerSec: 0.7,
    });
    this.repack();
  }

  /** Decay transient swirls; call once per frame. */
  update(dt: number): void {
    if (this.swirls.length === 0) return;
    for (let i = this.swirls.length - 1; i >= 0; i--) {
      this.swirls[i].strength -= this.swirls[i].decayPerSec * dt;
      if (this.swirls[i].strength <= 0) this.swirls.splice(i, 1);
    }
    this.repack();
  }

  private repack(): void {
    const count = Math.min(this.swirls.length, MAX_SWIRLS);
    for (let i = 0; i < count; i++) {
      const sw = this.swirls[i];
      this.uSwirlUv[i].copy(sw.uv);
      this.uSwirlParam[i].set(sw.radius, sw.twist * sw.strength, sw.tintAmt * sw.strength, 0);
      this.uSwirlTint[i].copy(sw.tint);
    }
    this.material.uniforms.uSwirlCount.value = count;
  }

  dispose(): void { this.material.dispose(); }
}
