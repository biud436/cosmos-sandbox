// GLSL source for the main Scene's WebGL materials. Material construction,
// uniforms, and geometry stay in Scene.ts; these modules hold only the shader
// strings so the render logic reads without 250 lines of inline GLSL.
export * from './sky';
export * from './gas';
export * from './effectors';
