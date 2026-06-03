// Far-field backdrop shaders: the omnidirectional nebula shell that wraps the
// starfield, and the universe-boundary cube shell with its fresnel rim glow.

export const SKY_NEBULA_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const SKY_NEBULA_FRAG = /* glsl */`
  varying vec3 vDir;
  uniform vec3 colorA;
  uniform vec3 colorB;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    f = f*f*(3.0-2.0*f);
    float n = mix(
      mix(mix(hash(i+vec3(0,0,0)), hash(i+vec3(1,0,0)), f.x),
          mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
          mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y),
      f.z);
    return n;
  }
  void main() {
    float n = noise(vDir * 3.0) * 0.6 + noise(vDir * 8.0) * 0.4;
    vec3 col = mix(colorB, colorA, smoothstep(0.35, 0.85, n));
    float alpha = smoothstep(0.45, 0.9, n) * 0.45;
    gl_FragColor = vec4(col, alpha);
  }
`;

export const BOUNDARY_SHELL_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const BOUNDARY_SHELL_FRAG = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform vec3 uColor;
  void main() {
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
    // Stronger rim glow + a base interior tint so the boundary stays
    // legible even when zoomed far out (post-Hubble universe is large).
    float rimGlow = pow(rim, 2.5) * 0.42;
    float interior = 0.025;
    float a = rimGlow + interior;
    gl_FragColor = vec4(uColor, a);
  }
`;
