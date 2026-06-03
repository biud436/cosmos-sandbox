import { EffectorType } from '../../physics/Simulator';

// Effector aura shaders. Every effector type shares one billboarded plane and
// vertex shader (passes UV straight through); the fragment shader is swapped
// per type to draw its signature look — accretion disk, stellar glow, repulsor
// waves, freezer crystal, pulsar point, or nebula cloud.

export const EFFECTOR_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Galaxy halo: a back-side sphere shell with a facing-weighted interior tint
// plus a fresnel rim, giving distant star clusters a soft volumetric glow.
export const GALAXY_HALO_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const GALAXY_HALO_FRAG = /* glsl */`
  varying vec3 vN; varying vec3 vView;
  uniform vec3 uColor;
  void main() {
    float facing = abs(dot(vN, vView));
    float interior = 0.06 * (0.5 + 0.5 * facing);
    float rim = pow(1.0 - facing, 2.2) * 0.40;
    gl_FragColor = vec4(uColor, interior + rim);
  }
`;

// Per-type aura fragment shaders, selected by EffectorType in createEffectorView.
export const EFFECTOR_FRAG: Record<EffectorType, string> = {
  blackhole: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    uniform float uRedshift;
    uniform float uAccretion;

    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);

      // r < 0.42 is the BH shadow (the photons that fall in never reach us).
      // 0.42–0.50 is the photon-orbit ring (Schwarzschild light bending
      // wraps the far side of the disk around the shadow at 1.5 r_s).
      // 0.55–1.0 is the accretion disk proper.
      if (r > 1.0 || r < 0.42) discard;

      float photonMask = smoothstep(0.42, 0.45, r) * smoothstep(0.51, 0.48, r);

      float a = atan(c.y, c.x);
      float spinRate = 4.0 + uAccretion * 5.0;
      float swirl = sin(a * 5.0 - uTime * spinRate + (1.0 - r) * 14.0);
      float band = smoothstep(0.55, 0.62, r) * smoothstep(1.0, 0.92, r);

      // Transparent gap between photon ring and disk
      if (photonMask < 0.01 && band < 0.01) discard;

      // Disk shifts toward hot white as accretion rate increases
      vec3 hot = mix(vec3(1.0, 0.85, 0.55), vec3(1.0, 1.0, 0.92), uAccretion * 0.7);
      vec3 cool = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.65, 0.28), uAccretion * 0.5);
      vec3 diskCol = mix(cool, hot, swirl * 0.5 + 0.5);

      // Photon ring: hot near-white, Doppler-boosted on the approaching
      // side of the disk (+x in local UV is a stand-in for the rotation
      // direction; one side reads brighter — the M87/EHT signature).
      float doppler = 0.55 + 0.45 * c.x;
      vec3 ringCol = mix(vec3(1.0, 0.78, 0.55), vec3(1.0, 0.96, 0.82), doppler);
      float ringBright = (2.4 + uAccretion * 2.0) * (0.55 + doppler * 0.55);

      float brightness = 1.4 + uAccretion * 1.4;
      float alphaBoost = 1.0 + uAccretion * 0.55;

      vec3 col = ringCol * photonMask * ringBright
               + diskCol * band * (brightness + swirl * 0.4);
      float alpha = photonMask * 0.95
                  + band * (0.85 + 0.15 * swirl) * alphaBoost;

      vec3 tint = vec3(1.0 - 0.10 * uRedshift, 1.0 - 0.45 * uRedshift, 1.0 - 0.80 * uRedshift);
      col *= tint;
      float dim = 1.0 - 0.30 * uRedshift;

      gl_FragColor = vec4(col * dim, clamp(alpha, 0.0, 1.0));
    }
  `,
  star: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    uniform float uRedshift;
    uniform vec3 uColor;

    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);
      if (r > 1.0) discard;

      float core = exp(-r * 5.5);
      float halo = exp(-r * 1.4) * 0.42;
      float spike = pow(max(0.0, 1.0 - abs(c.x) * 8.0), 4.0)
                  + pow(max(0.0, 1.0 - abs(c.y) * 8.0), 4.0);
      spike *= exp(-r * 1.8) * 0.35;
      float twinkle = 0.92 + 0.08 * sin(uTime * 2.3);
      float glow = (core + halo + spike) * twinkle;

      // Spectral palette: core whitens (Planck blackbody peak shifts to
      // visible white at all temperatures); outer color follows uColor
      // which is set per-star from its mass-derived spectral class.
      vec3 hotCol = mix(uColor, vec3(1.0), 0.65);
      vec3 warmCol = uColor;
      vec3 col = mix(warmCol, hotCol, core);

      // Cosmological-style redshift: dim blue first, then green, preserve red
      vec3 tint = vec3(1.0 - 0.10 * uRedshift, 1.0 - 0.45 * uRedshift, 1.0 - 0.80 * uRedshift);
      col *= tint;

      float bright = 1.0 - 0.25 * uRedshift;
      gl_FragColor = vec4(col * (0.55 + glow * 1.05) * bright, clamp(glow, 0.0, 1.0));
    }
  `,
  repulsor: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);
      if (r > 1.0) discard;
      float wave = sin(r * 14.0 - uTime * 6.0);
      float band = smoothstep(0.0, 1.0, wave) * smoothstep(1.0, 0.3, r);
      vec3 col = vec3(1.0, 0.45, 0.25);
      gl_FragColor = vec4(col, band * 0.7);
    }
  `,
  freezer: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);
      if (r > 1.0) discard;
      float a = atan(c.y, c.x);
      float spokes = abs(sin(a * 6.0 + uTime * 0.4)) * 0.5 + 0.5;
      float crystal = smoothstep(1.0, 0.2, r) * spokes;
      vec3 col = vec3(0.55, 0.85, 1.0);
      gl_FragColor = vec4(col * (0.6 + crystal), crystal * 0.55);
    }
  `,
  neutron_star: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    uniform float uRedshift;

    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);
      if (r > 1.0) discard;

      // Sharp tiny point with a pulsar-like beat (rapid pulse mimics
      // millisecond rotation of a real NS).
      float pulse = 0.6 + 0.4 * sin(uTime * 7.5);
      float core = exp(-r * 14.0) * pulse;
      float halo = exp(-r * 2.8) * 0.28;
      float glow = core + halo;

      vec3 col = vec3(0.82, 0.94, 1.0);
      vec3 tint = vec3(1.0 - 0.10 * uRedshift, 1.0 - 0.45 * uRedshift, 1.0 - 0.80 * uRedshift);
      col *= tint;

      float bright = 1.0 - 0.25 * uRedshift;
      gl_FragColor = vec4(col * (0.55 + glow * 1.8) * bright, clamp(glow, 0.0, 1.0));
    }
  `,
  nebula: /* glsl */`
    varying vec2 vUv;
    uniform float uTime;
    uniform float uRedshift;
    uniform float uMass;
    uniform float uSeed;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += vnoise(p) * a;
        p *= 2.0;
        a *= 0.5;
      }
      return v;
    }
    void main() {
      // Position in plane-local [-1, 1] coords.
      vec2 c = vUv * 2.0 - 1.0;
      float baseR = length(c);

      // Hard discard well inside the plane's geometric bound so the
      // underlying square plane never reveals itself. Plane corners
      // sit at baseR = √2 ≈ 1.41 and edge-midpoints at 1.0 — we cap
      // visible density at 0.92, leaving an ~8% margin to the edge
      // and a generous margin to the corners.
      if (baseR > 0.95) discard;

      // Per-nebula offset so neighboring clouds don't share the exact
      // same wisp pattern. uSeed comes from eff.id mixed into the JS
      // side (createEffectorView wires it once at construction time).
      vec2 seedOff = vec2(uSeed * 41.7, uSeed * 73.3);
      vec2 q = vUv * 2.6 + seedOff + vec2(uTime * 0.018, -uTime * 0.013);

      // Multi-octave noise sampled at decorrelated origins. The two
      // mid-frequency layers add up to an irregular cloud body; the
      // fine layer punches local holes and adds wispy texture.
      float n1 = fbm(q);
      float n2 = fbm(q * 2.3 + vec2(5.7, -3.1) + seedOff * 0.4);
      float fine = fbm(q * 5.5) * 0.32;
      float cloud = n1 * 0.55 + n2 * 0.45 + fine;

      // Soft circular envelope. Pulls density to 0 by baseR=0.92 so
      // the visible cloud sits well inside the square plane — that
      // fixes the previous "rectangular bounding box visible" look
      // (where the wide window let cloud extend to plane edges).
      // The cloud's irregular silhouette still comes from noise; this
      // window is just a backstop that hides plane geometry.
      float window = smoothstep(0.92, 0.30, baseR);

      // Subtle core bias so the densest pixels statistically cluster
      // near the middle — without forcing a perfect disk.
      float coreBias = exp(-baseR * baseR * 0.85) * 0.35;

      // Density: bias the noise so values below ~0.35 read as "vacuum"
      // (holes), values above as cloud. Multiplied by the window to
      // pull the silhouette inside the plane but otherwise let noise
      // sculpt the shape.
      float density = max(0.0, cloud * 1.20 - 0.42 + coreBias) * window;
      // Discard truly empty fragments so the edge frays — every alpha
      // ramp ends at exactly 0 and the silhouette is the noise level
      // set, not a smooth gradient disk.
      if (density < 0.004) discard;

      // H-alpha + ionized oxygen palette: pink core, magenta/violet halo.
      vec3 coreCol = vec3(1.0, 0.55, 0.75);
      vec3 outerCol = vec3(0.55, 0.35, 0.85);
      vec3 col = mix(outerCol, coreCol, clamp(density * 1.6, 0.0, 1.0));
      vec3 tint = vec3(1.0 - 0.10 * uRedshift, 1.0 - 0.45 * uRedshift, 1.0 - 0.80 * uRedshift);
      col *= tint;
      float massPunch = smoothstep(8.0, 80.0, uMass);
      float a = clamp(density * (0.55 + 0.40 * massPunch), 0.0, 0.72);
      a *= 1.0 - 0.30 * uRedshift;
      gl_FragColor = vec4(col * (0.65 + density * 0.9), a);
    }
  `,
};
