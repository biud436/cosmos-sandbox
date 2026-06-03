// Atmosphere shell shaders for procedural planets. Everything is computed in
// world space so the sun direction (a world-space vector from planet → host
// star) lines up with the geometric normal of the shell directly. BackSide
// lets us see the dome from inside when the camera is close, while the
// additive blend over fresnel gives the classic limb-glow look.

export const ATMOSPHERE_VERT = /* glsl */`
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const ATMOSPHERE_FRAG = /* glsl */`
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  uniform vec3 uColor;
  uniform float uThickness;
  uniform vec3 uSunDir;
  uniform float uHasSun;
  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float NdotV = abs(dot(N, V));
    // Sharper rim falloff (3.0 instead of 2.5) concentrates the halo at
    // the limb so the rim doesn't bleed inward across the planet edge.
    float rim = pow(1.0 - NdotV, 3.0);
    // Day-side bias: scattering brightest where the planet faces the star,
    // dimmest at midnight. Without a sun (BH/NS host), we skip the bias.
    float day = mix(1.0, max(dot(N, uSunDir), 0.0) * 0.85 + 0.15, uHasSun);
    // Reduce the global multiplier and tighten the alpha cap so the
    // atmosphere reads as glow, not as a wash.
    float a = rim * day * uThickness * 0.65;
    gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.55));
  }
`;
