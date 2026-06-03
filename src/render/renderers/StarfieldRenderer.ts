import * as THREE from 'three';
import { SKY_NEBULA_VERT, SKY_NEBULA_FRAG } from '../shaders';

// Far-field starfield + omnidirectional nebula dome. Both live under a group
// that tracks the camera every frame (trackCamera) so the player always feels
// surrounded — otherwise far zooms or Hubble expansion push the camera outside
// the fixed-radius shell and half the sky goes dark. Density is rebuildable at
// runtime when the quality preset changes.
export class StarfieldRenderer {
  private readonly boxHalf: number;
  private readonly group: THREE.Group;

  constructor(scene: THREE.Scene, boxHalf: number, starfieldCount: number) {
    this.boxHalf = boxHalf;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.build(starfieldCount);
  }

  /** Keep the sky shell centered on the camera so it always surrounds the view. */
  trackCamera(cameraPos: THREE.Vector3): void {
    this.group.position.copy(cameraPos);
  }

  /** Tear down the existing starfield + skybox dome and rebuild at a new
   *  density. Used when the player changes the quality preset at runtime. */
  rebuild(starfieldCount: number): void {
    // Dispose children (the Points + the inner-shell nebula mesh). Their
    // geometries/materials are one-off per build.
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const m = child as THREE.Mesh | THREE.Points;
      const geo = (m.geometry as THREE.BufferGeometry | undefined);
      if (geo) geo.dispose();
      const mat = (m.material as THREE.Material | THREE.Material[] | undefined);
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    }
    this.build(starfieldCount);
  }

  private build(count: number): void {
    const farR = this.boxHalf * 18;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tint = [
      [1.0, 1.0, 1.0],
      [0.75, 0.85, 1.0],
      [1.0, 0.9, 0.75],
      [1.0, 0.7, 0.7],
    ];
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = farR * (0.7 + Math.random() * 0.6);
      positions[i * 3 + 0] = r * s * Math.cos(t);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * s * Math.sin(t);
      const c = tint[(Math.random() * tint.length) | 0];
      const k = 0.4 + Math.random() * 0.6;
      colors[i * 3 + 0] = c[0] * k;
      colors[i * 3 + 1] = c[1] * k;
      colors[i * 3 + 2] = c[2] * k;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.5,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    this.group.add(stars);

    const nebulaGeo = new THREE.SphereGeometry(farR * 0.95, 32, 16);
    const nebulaMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        colorA: { value: new THREE.Color(0x2a1d4a) },
        colorB: { value: new THREE.Color(0x0a1a2e) },
      },
      vertexShader: SKY_NEBULA_VERT,
      fragmentShader: SKY_NEBULA_FRAG,
    });
    const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
    nebula.frustumCulled = false;
    this.group.add(nebula);
  }
}
