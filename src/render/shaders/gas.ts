// Gas/nebula particle shaders (solid-mode "gas" render path). Point sprites
// sized in screen space, additively blended, with a cosmological-style redshift
// tint applied by distance. The detail pass adds wisp noise so each particle
// isn't a perfect disc; the halo pass is a much larger, softer Gaussian whose
// heavy overlap fuses nearby particles into diffuse nebula structure.

export const GAS_VERT = /* glsl */`
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vRedshift;
  varying vec2 vSeed;
  uniform float uPixelScale;
  uniform float uRedshiftNear;
  uniform float uRedshiftFar;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    gl_PointSize = size * (uPixelScale / max(dist, 0.001));
    gl_Position = projectionMatrix * mv;
    float z = clamp((dist - uRedshiftNear) / max(uRedshiftFar - uRedshiftNear, 0.001), 0.0, 1.0);
    vRedshift = z;
    // Cosmological-ish redshift: blue dims fastest, green moderate, red preserved
    vec3 tint = vec3(1.0 - 0.10 * z, 1.0 - 0.45 * z, 1.0 - 0.80 * z);
    vColor = color * tint;
    // Per-particle wisp seed (derived from world position so each cloudlet differs)
    vSeed = vec2(position.x * 0.137 + position.z * 0.091, position.y * 0.113);
  }
`;

export const GAS_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vRedshift;
  varying vec2 vSeed;
  // Cheap value noise — single octave is enough; we layer two for variation.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
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
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(uv, uv);
    if (d2 > 1.0) discard;
    // Pure wide Gaussian — no hard core, pure blur
    float g = exp(-d2 * 1.4);
    // Wisp noise so each particle isn't a perfect disc: breaks the circular tell
    float n1 = vnoise(uv * 2.6 + vSeed * 7.0);
    float n2 = vnoise(uv * 5.8 - vSeed * 3.0);
    float wisp = mix(0.65, 1.0, n1 * 0.65 + n2 * 0.35);
    float a = g * wisp * 0.55 * (1.0 - 0.30 * vRedshift);
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export const GAS_HALO_VERT = /* glsl */`
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vRedshift;
  uniform float uPixelScale;
  uniform float uRedshiftNear;
  uniform float uRedshiftFar;
  uniform float uSizeMul;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    gl_PointSize = size * uSizeMul * (uPixelScale / max(dist, 0.001));
    gl_Position = projectionMatrix * mv;
    float z = clamp((dist - uRedshiftNear) / max(uRedshiftFar - uRedshiftNear, 0.001), 0.0, 1.0);
    vRedshift = z;
    vec3 tint = vec3(1.0 - 0.10 * z, 1.0 - 0.45 * z, 1.0 - 0.80 * z);
    vColor = color * tint;
  }
`;

export const GAS_HALO_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vRedshift;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(uv, uv);
    if (d2 > 1.0) discard;
    // Very soft Gaussian — pure halo, almost no peak. Overlapping halos
    // merge smoothly into larger nebula structure.
    float g = exp(-d2 * 0.9);
    float a = g * 0.085 * (1.0 - 0.35 * vRedshift);
    gl_FragColor = vec4(vColor * a, a);
  }
`;
