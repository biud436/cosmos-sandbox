import * as THREE from 'three';
import { PlanetProfile } from './PlanetProfiles';
import { ATMOSPHERE_VERT, ATMOSPHERE_FRAG } from './shaders/atmosphere';
import { JupiterGasMaterial, GAS_PALETTES } from './shaders/jupiterGas';

// Isolated photoreal solar-system lab. Owns its own THREE.Scene so it can
// render either:
//   • an ORRERY — the Sun with all planets on Kepler orbits (real eccentricity
//     and inclination; radii/periods compressed so it fits and animates), or
//   • a single BODY close-up from texture maps, optionally cut away to reveal
//     a science-based interior cross-section.
// Nothing here touches the particle-universe renderers in Scene.ts; the main
// loop swaps to renderer.render(planetLab.scene, camera) while in this mode.

const SUN_DIR = new THREE.Vector3(1, 0.18, 0.42).normalize();
const SPHERE_SEGMENTS: [number, number] = [96, 64];

export type LabView = 'orrery' | 'body';

export interface InteriorLayer { rOuter: number; color: number; name: string; }

// --- Real orbital elements (a in AU, eccentricity, inclination in degrees) ---
const ORBITS: Record<string, { a: number; e: number; incDeg: number }> = {
  mercury: { a: 0.387, e: 0.2056, incDeg: 7.00 },
  venus:   { a: 0.723, e: 0.0068, incDeg: 3.39 },
  earth:   { a: 1.000, e: 0.0167, incDeg: 0.00 },
  mars:    { a: 1.524, e: 0.0934, incDeg: 1.85 },
  jupiter: { a: 5.203, e: 0.0484, incDeg: 1.30 },
  saturn:  { a: 9.537, e: 0.0539, incDeg: 2.49 },
  uranus:  { a: 19.19, e: 0.0473, incDeg: 0.77 },
  neptune: { a: 30.07, e: 0.0086, incDeg: 1.77 },
};
const ORRERY_ORDER = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

export type OrreryScale = 'real' | 'compact';

// Two orrery distance scales:
//   'real'    — orbit radius ∝ real semi-major axis (AU), so the vast gaps of
//               the outer system are honest. Inner planets cluster near the
//               Sun; you zoom/scroll to inspect them.
//   'compact' — √a compression so all eight planets read at once (schematic).
const REAL_AU = 2.4;                 // world units per AU in 'real' mode
const COMPACT_EARTH_R = 1.7 + 2.05;  // Earth's display radius in 'compact' mode

// Exaggerated planet sizes for the orrery (true-to-scale would be invisible).
function orreryBodyRadius(realEarthRadii: number): number {
  return Math.min(0.34, 0.085 + 0.062 * Math.sqrt(realEarthRadii));
}
const REAL_RADII: Record<string, number> = {
  mercury: 0.383, venus: 0.949, earth: 1.0, mars: 0.532,
  jupiter: 11.21, saturn: 9.45, uranus: 4.01, neptune: 3.88,
};

// Science-based interior layers (fraction of radius, from centre outward).
const INTERIORS: Record<string, InteriorLayer[]> = {
  sun: [
    { rOuter: 0.25, color: 0xfff7d0, name: '핵 (핵융합)' },
    { rOuter: 0.70, color: 0xffcf66, name: '복사층' },
    { rOuter: 0.985, color: 0xff8a30, name: '대류층' },
    { rOuter: 1.0, color: 0xffe08a, name: '광구' },
  ],
  mercury: [
    { rOuter: 0.83, color: 0xc6843e, name: '거대 철 핵' },
    { rOuter: 0.97, color: 0x8a6a55, name: '맨틀' },
    { rOuter: 1.0, color: 0x6b5b4f, name: '지각' },
  ],
  venus: [
    { rOuter: 0.50, color: 0xcf7d33, name: '철 핵' },
    { rOuter: 0.95, color: 0xab6b3a, name: '맨틀' },
    { rOuter: 1.0, color: 0x7a5a3a, name: '지각' },
  ],
  earth: [
    { rOuter: 0.19, color: 0xfff1a8, name: '내핵 (고체 철)' },
    { rOuter: 0.55, color: 0xffae3c, name: '외핵 (액체 철)' },
    { rOuter: 0.99, color: 0xb5482e, name: '맨틀' },
    { rOuter: 1.0, color: 0x4a4a4a, name: '지각' },
  ],
  moon: [
    { rOuter: 0.20, color: 0xcc7a3a, name: '핵' },
    { rOuter: 0.985, color: 0x7d7269, name: '맨틀' },
    { rOuter: 1.0, color: 0x9a948c, name: '지각' },
  ],
  mars: [
    { rOuter: 0.50, color: 0xd1772e, name: '철-황 핵' },
    { rOuter: 0.95, color: 0x8a3b22, name: '규산염 맨틀' },
    { rOuter: 1.0, color: 0x5a3320, name: '지각' },
  ],
  jupiter: [
    { rOuter: 0.15, color: 0x6b5a4a, name: '암석·얼음 핵' },
    { rOuter: 0.78, color: 0x9fb6d6, name: '금속 수소' },
    { rOuter: 0.95, color: 0xd8c39a, name: '액체 분자 수소' },
    { rOuter: 1.0, color: 0xe8d6b0, name: '대기 (구름띠)' },
  ],
  saturn: [
    { rOuter: 0.20, color: 0x6b5a4a, name: '암석·얼음 핵' },
    { rOuter: 0.55, color: 0x9fb6d6, name: '금속 수소' },
    { rOuter: 0.93, color: 0xe0cda0, name: '액체 수소' },
    { rOuter: 1.0, color: 0xeaddb8, name: '대기' },
  ],
  uranus: [
    { rOuter: 0.20, color: 0x5a5048, name: '암석 핵' },
    { rOuter: 0.80, color: 0x6fb7c4, name: '얼음 맨틀 (물·암모니아·메탄)' },
    { rOuter: 1.0, color: 0xa9e0e6, name: 'H/He 대기' },
  ],
  neptune: [
    { rOuter: 0.20, color: 0x4a4640, name: '암석 핵' },
    { rOuter: 0.80, color: 0x3f6fae, name: '얼음 맨틀' },
    { rOuter: 1.0, color: 0x5a7fc0, name: 'H/He 대기' },
  ],
};

export function interiorLayersOf(id: string): InteriorLayer[] | undefined { return INTERIORS[id]; }

function solveEccentricAnomaly(M: number, e: number): number {
  M = ((M + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 6; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

interface OrreryPlanet {
  mesh: THREE.Object3D;
  aDisp: number; e: number; incRad: number; argPeri: number; phase0: number; period: number;
}
interface SpinTarget { obj: THREE.Object3D; periodSec: number; }

export class PlanetLab {
  readonly scene = new THREE.Scene();
  view: LabView = 'body';

  private readonly maxAniso: number;
  private readonly texLoader = new THREE.TextureLoader();
  private readonly texCache = new Map<string, THREE.Texture>();
  private readonly sunLight: THREE.DirectionalLight;
  private readonly sunDisc: THREE.Mesh;
  // 90° wedge cut for interior cross-sections (keeps x<0 OR z<0).
  private readonly clipPlanes = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  ];

  private bodyGroup: THREE.Group | null = null;
  private orreryGroup: THREE.Group | null = null;
  private orreryPlanets: OrreryPlanet[] = [];
  private orreryScale: OrreryScale = 'real';
  private currentId: string | null = null;

  private spins: SpinTarget[] = [];
  private moonPivot: THREE.Object3D | null = null;
  private moonPeriodSec = 1;
  private setSunViewDir: ((v: THREE.Vector3) => void) | null = null;
  private elapsed = 0;
  private readonly tmpSunView = new THREE.Vector3();

  // Live procedural gas-giant surface (Jupiter). `gasMat` drives the shader
  // uniforms; `gasMesh` is the surface sphere kept around for pointer-stir
  // raycasting. Both null unless the current body uses proceduralGas.
  private gasMat: JupiterGasMaterial | null = null;
  private gasMesh: THREE.Mesh | null = null;
  private gasPaletteKey = 'jupiter';
  private gasRadius = 1;       // world radius of the gas body, for the LOD ramp
  private gasDetailValue = 0;  // last camera-distance LOD blend (0 tex .. 1 gas)
  private readonly raycaster = new THREE.Raycaster();

  constructor(renderer: THREE.WebGLRenderer) {
    renderer.localClippingEnabled = true;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.scene.background = new THREE.Color(0x05060d);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.05));
    this.sunLight = new THREE.DirectionalLight(0xfff6e8, 3.1);
    this.sunLight.position.copy(SUN_DIR).multiplyScalar(50);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2cc }),
    );
    this.sunDisc.position.copy(SUN_DIR).multiplyScalar(140);
    this.scene.add(this.sunDisc);

    this.loadBackground('/textures/env/milkyway_bg_4k.jpg');
  }

  // ---- Body close-up --------------------------------------------------------

  /** Show one body. `interior=true` renders the cutaway instead of the surface. */
  showBody(profile: PlanetProfile, interior: boolean): void {
    this.view = 'body';
    if (this.orreryGroup) this.orreryGroup.visible = false;
    this.sunDisc.visible = !profile.selfLuminous;
    this.sunLight.visible = true;

    if (this.currentId === profile.id + (interior ? ':in' : ':out')) return;
    this.disposeBody();
    this.currentId = profile.id + (interior ? ':in' : ':out');

    const group = new THREE.Group();
    this.bodyGroup = group;
    this.scene.add(group);
    const tilt = new THREE.Group();
    tilt.rotation.x = profile.axialTilt;
    group.add(tilt);

    const r = profile.radius;
    const squashY = r * (1 - profile.oblateness);

    if (interior) {
      this.buildInterior(profile, tilt, r);
      this.spins = []; // hold still so the cross-section is readable
      this.moonPivot = null;
      return;
    }

    // --- Surface ---
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]),
      this.buildBodyMaterial(profile),
    );
    planet.scale.set(r, squashY, r);
    tilt.add(planet);
    this.spins = [{ obj: planet, periodSec: profile.rotationPeriodSec }];
    if (this.gasMat) { this.gasMesh = planet; this.gasRadius = r; } // for raycast + LOD

    if (profile.textures.cloudsMap && profile.clouds) {
      const cloudMat = new THREE.MeshStandardMaterial({
        alphaMap: this.loadTexture(profile.textures.cloudsMap, false),
        transparent: true, depthWrite: false, color: 0xffffff,
        roughness: 1.0, metalness: 0.0, opacity: profile.clouds.opacity,
      });
      const clouds = new THREE.Mesh(new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]), cloudMat);
      const cs = r * profile.clouds.scale;
      clouds.scale.set(cs, squashY * profile.clouds.scale, cs);
      tilt.add(clouds);
      this.spins.push({ obj: clouds, periodSec: profile.clouds.rotationPeriodSec });
    }

    if (profile.atmosphere) tilt.add(this.makeAtmosphere(profile.atmosphere, r, !!profile.selfLuminous));
    if (profile.ring) tilt.add(this.makeRing(profile.ring, r));

    if (profile.moon) {
      const m = profile.moon;
      const pivot = new THREE.Group();
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(m.radius, 48, 32),
        new THREE.MeshStandardMaterial({ map: this.loadTexture(m.map, true), roughness: 0.92, metalness: 0.0 }),
      );
      moon.position.set(m.distance, 0, 0);
      pivot.add(moon);
      group.add(pivot);
      this.moonPivot = pivot;
      this.moonPeriodSec = m.orbitPeriodSec;
    } else {
      this.moonPivot = null;
    }
  }

  private buildInterior(profile: PlanetProfile, tilt: THREE.Group, r: number): void {
    const layers = INTERIORS[profile.id] ?? [{ rOuter: 1.0, color: 0x888888, name: '본체' }];
    for (let k = 0; k < layers.length; k++) {
      const L = layers[k];
      const isOuter = k === layers.length - 1;
      const geo = new THREE.SphereGeometry(L.rOuter * r, 80, 56);
      const mat = new THREE.MeshStandardMaterial({
        color: L.color,
        roughness: 0.82,
        metalness: profile.id === 'jupiter' || profile.id === 'saturn' ? 0.25 : 0.08,
        emissive: profile.selfLuminous ? new THREE.Color(L.color) : new THREE.Color(0x000000),
        emissiveIntensity: profile.selfLuminous ? 0.55 : 0.0,
        clippingPlanes: this.clipPlanes,
        clipIntersection: true, // keep (x<0 OR z<0): removes a 90° wedge
        side: THREE.DoubleSide, // so the wedge's inner walls are shaded
      });
      // The outermost shell wears the real surface texture so the un-cut part
      // still reads as the actual planet.
      if (isOuter) mat.map = this.loadTexture(profile.textures.map, true);
      tilt.add(new THREE.Mesh(geo, mat));
    }
  }

  // ---- Orrery ---------------------------------------------------------------

  showOrrery(): void {
    this.view = 'orrery';
    if (this.bodyGroup) this.bodyGroup.visible = false;
    this.sunDisc.visible = false; // the orrery has its own central sun
    this.sunLight.visible = false; // planets are unlit (schematic)
    if (this.orreryGroup) { this.orreryGroup.visible = true; return; }

    const group = new THREE.Group();
    this.orreryGroup = group;
    this.scene.add(group);
    this.orreryPlanets = [];

    // Central sun: emissive disc + corona glow.
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 48, 32),
      new THREE.MeshBasicMaterial({ map: this.loadTexture('/textures/solar/sun.jpg', true) }),
    );
    group.add(sun);
    group.add(this.makeAtmosphere({ color: [1.0, 0.66, 0.26], thickness: 1.3, scale: 1.5 }, 0.7, true));

    const orbitMat = new THREE.LineBasicMaterial({ color: 0x5b6b8c, transparent: true, opacity: 0.5 });

    ORRERY_ORDER.forEach((id, idx) => {
      const el = ORBITS[id];
      const aDisp = this.orreryRadius(el.a);
      const incRad = THREE.MathUtils.degToRad(el.incDeg);
      const argPeri = idx * 1.13;
      const phase0 = idx * 0.74;
      const period = this.orreryPeriod(aDisp);

      group.add(this.makeOrbitLine(aDisp, el.e, incRad, argPeri, orbitMat));

      const vr = orreryBodyRadius(REAL_RADII[id] ?? 1) * (this.orreryScale === 'real' ? 1.7 : 1.0);
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(vr, 32, 24),
        new THREE.MeshBasicMaterial({ map: this.loadTexture(this.orreryTexPath(id), true) }),
      );
      group.add(planet);

      // Saturn keeps a little ring even in the orrery.
      if (id === 'saturn') {
        const ring = this.makeRing({ map: '/textures/solar/saturn_ring.png', inner: 1.3, outer: 2.3, opacity: 0.9 }, vr);
        ring.rotation.x = -Math.PI / 2 + 0.4; // a touch of tilt so it reads
        planet.add(ring);
      }

      this.orreryPlanets.push({ mesh: planet, aDisp, e: el.e, incRad, argPeri, phase0, period });
    });
  }

  private orreryTexPath(id: string): string {
    if (id === 'earth') return '/textures/earth/earth_day_4k.jpg';
    return `/textures/solar/${id}.jpg`;
  }

  private orreryRadius(a: number): number {
    return this.orreryScale === 'real' ? 0.6 + REAL_AU * a : 1.7 + 2.05 * Math.sqrt(a);
  }

  private orreryPeriod(displayRadius: number): number {
    // 'real': linear in distance (sped up so distant planets still drift
    // visibly while staying inner-fast/outer-slow). 'compact': Kepler's 3rd
    // law for the displayed radii.
    if (this.orreryScale === 'real') return 6 * displayRadius;
    return (24 / Math.pow(COMPACT_EARTH_R, 1.5)) * Math.pow(displayRadius, 1.5);
  }

  get orreryScaleMode(): OrreryScale { return this.orreryScale; }

  /** Suggested camera standoff + zoom-out limit for the current scale. */
  get orreryFraming(): { standoff: number; maxDistance: number } {
    return this.orreryScale === 'real' ? { standoff: 92, maxDistance: 260 } : { standoff: 16, maxDistance: 80 };
  }

  setOrreryScale(scale: OrreryScale): void {
    if (scale === this.orreryScale) return;
    this.orreryScale = scale;
    this.disposeOrrery();
    if (this.view === 'orrery') this.showOrrery();
  }

  private disposeOrrery(): void {
    if (!this.orreryGroup) return;
    this.orreryGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.scene.remove(this.orreryGroup);
    this.orreryGroup = null;
    this.orreryPlanets = [];
  }

  private makeOrbitLine(aDisp: number, e: number, incRad: number, argPeri: number, mat: THREE.LineBasicMaterial): THREE.LineLoop {
    const SEG = 160;
    const pos = new Float32Array(SEG * 3);
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < SEG; i++) {
      const M = (i / SEG) * Math.PI * 2;
      this.keplerPos(aDisp, e, incRad, argPeri, M, out);
      pos[i * 3] = out[0]; pos[i * 3 + 1] = out[1]; pos[i * 3 + 2] = out[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const loop = new THREE.LineLoop(geo, mat);
    loop.frustumCulled = false;
    return loop;
  }

  /** Kepler ellipse position from mean anomaly M (Sun at a focus). */
  private keplerPos(aDisp: number, e: number, incRad: number, argPeri: number, M: number, out: [number, number, number]): void {
    const E = solveEccentricAnomaly(M, e);
    const xp = aDisp * (Math.cos(E) - e);
    const yp = aDisp * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    const cw = Math.cos(argPeri), sw = Math.sin(argPeri);
    const xr = xp * cw - yp * sw;
    const zr = xp * sw + yp * cw;
    out[0] = xr;
    out[1] = zr * Math.sin(incRad);
    out[2] = zr * Math.cos(incRad);
  }

  // ---- Shared builders ------------------------------------------------------

  private makeAtmosphere(a: { color: [number, number, number]; thickness: number; scale: number }, r: number, selfLuminous: boolean): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(a.color[0], a.color[1], a.color[2]) },
        uThickness: { value: a.thickness },
        uSunDir: { value: SUN_DIR.clone() },
        uHasSun: { value: selfLuminous ? 0 : 1 },
      },
      vertexShader: ATMOSPHERE_VERT,
      fragmentShader: ATMOSPHERE_FRAG,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
    const s = r * a.scale;
    mesh.scale.set(s, s, s);
    mesh.frustumCulled = false;
    return mesh;
  }

  private makeRing(ring: { map: string; inner: number; outer: number; opacity: number }, r: number): THREE.Mesh {
    const inner = ring.inner * r;
    const outer = ring.outer * r;
    const geo = new THREE.RingGeometry(inner, outer, 180, 1);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      uv.setXY(i, (tmp.length() - inner) / (outer - inner), 0.5);
    }
    uv.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: this.loadTexture(ring.map, true), transparent: true,
      side: THREE.DoubleSide, depthWrite: false, opacity: ring.opacity,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.frustumCulled = false;
    return mesh;
  }

  private buildBodyMaterial(profile: PlanetProfile): THREE.Material {
    const t = profile.textures;
    this.setSunViewDir = null;

    if (profile.proceduralGas) {
      const palette = (GAS_PALETTES[this.gasPaletteKey] ?? GAS_PALETTES.jupiter).palette;
      this.gasMat = new JupiterGasMaterial(palette);
      this.gasMat.setSun(SUN_DIR);
      // Far view = the real texture; gas is blended in only on close approach.
      this.gasMat.setMap(this.loadTexture(t.map, true));
      return this.gasMat.material;
    }

    if (profile.selfLuminous) {
      return new THREE.MeshBasicMaterial({ map: this.loadTexture(t.map, true) });
    }

    const mat = new THREE.MeshStandardMaterial({ map: this.loadTexture(t.map, true), roughness: 1.0, metalness: 0.0 });
    if (t.normalMap) mat.normalMap = this.loadTexture(t.normalMap, false);
    if (t.roughnessMap) mat.roughnessMap = this.loadTexture(t.roughnessMap, false);
    if (t.bumpMap) { mat.bumpMap = this.loadTexture(t.bumpMap, false); mat.bumpScale = profile.bumpScale ?? 0.03; }

    if (t.emissiveMap) {
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveMap = this.loadTexture(t.emissiveMap, true);
      mat.emissiveIntensity = profile.emissiveIntensity ?? 1.5;
      const uSunViewDir = { value: SUN_DIR.clone() };
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uSunViewDir = uSunViewDir;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uSunViewDir;')
          .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
            {
              float _sun = dot(normalize(normal), uSunViewDir);
              float _night = 1.0 - smoothstep(-0.15, 0.20, _sun);
              totalEmissiveRadiance *= _night;
            }`);
      };
      this.setSunViewDir = (v: THREE.Vector3) => { uSunViewDir.value.copy(v); };
    }
    return mat;
  }

  // ---- Per-frame ------------------------------------------------------------

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.elapsed += dt;
    const TWO_PI = Math.PI * 2;

    if (this.view === 'orrery') {
      const out: [number, number, number] = [0, 0, 0];
      for (const p of this.orreryPlanets) {
        const M = p.phase0 + (TWO_PI / p.period) * this.elapsed;
        this.keplerPos(p.aDisp, p.e, p.incRad, p.argPeri, M, out);
        p.mesh.position.set(out[0], out[1], out[2]);
        p.mesh.rotation.y += dt * 0.5;
      }
      return;
    }

    for (const s of this.spins) s.obj.rotation.y = (this.elapsed / s.periodSec) * TWO_PI;
    if (this.moonPivot) this.moonPivot.rotation.y = (this.elapsed / this.moonPeriodSec) * TWO_PI;
    if (this.gasMat) {
      this.gasMat.setTime(this.elapsed);
      this.gasMat.setSun(SUN_DIR);
      this.gasMat.update(dt);
      // LOD: the body sits at the scene origin and OrbitControls targets it,
      // so the camera distance is just its position length. The gas clouds
      // fade in only once the planet dominates the view (≈ filling the frame)
      // and the far view stays the plain photoreal texture.
      const dist = camera.position.length();
      const near = this.gasRadius * 1.7; // full gas at/closer than this
      const far = this.gasRadius * 2.8;  // pure texture at/beyond this
      let d = Math.max(0, Math.min(1, (far - dist) / (far - near)));
      d = d * d * (3 - 2 * d); // smoothstep ease
      this.gasDetailValue = d;
      this.gasMat.setDetail(d);
    }
    if (this.setSunViewDir) {
      camera.updateMatrixWorld();
      this.tmpSunView.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
      this.setSunViewDir(this.tmpSunView);
    }
  }

  // ---- Procedural gas interaction (Jupiter) ---------------------------------

  /** True when the current body is rendered with the live gas shader. */
  get hasGas(): boolean { return this.gasMat !== null && this.gasMesh !== null; }

  /** Current camera-distance LOD blend: 0 = texture (far), 1 = gas (close). */
  get gasDetail(): number { return this.gasDetailValue; }

  get gasPalette(): string { return this.gasPaletteKey; }

  /** Inject a swirl where a screen ray (NDC -1..1) hits the gas sphere.
   *  Returns true if the ray hit the planet. */
  stirGasFromScreen(ndc: THREE.Vector2, camera: THREE.Camera, strength: number): boolean {
    if (!this.gasMat || !this.gasMesh) return false;
    this.raycaster.setFromCamera(ndc, camera);
    const hits = this.raycaster.intersectObject(this.gasMesh, false);
    const uv = hits[0]?.uv;
    if (!uv) return false;
    // The hit UV is the same equirectangular coordinate the shader samples, so
    // the vortex lands exactly under the cursor on the real cloud bands.
    this.gasMat.stir(uv, strength);
    return true;
  }

  /** Swap the live color palette without rebuilding the body. */
  setGasPalette(key: string): void {
    if (!GAS_PALETTES[key]) return;
    this.gasPaletteKey = key;
    if (this.gasMat) this.gasMat.applyPalette(GAS_PALETTES[key].palette);
  }

  setGasTurb(x: number): void { this.gasMat?.setTurb(x); }
  setGasFlow(x: number): void { this.gasMat?.setFlow(x); }
  getGasTurb(): number { return this.gasMat?.getTurb() ?? 0; }
  getGasFlow(): number { return this.gasMat?.getFlow() ?? 0; }

  // ---- Disposal -------------------------------------------------------------

  private disposeBody(): void {
    if (!this.bodyGroup) return;
    this.bodyGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.scene.remove(this.bodyGroup);
    this.bodyGroup = null;
    this.spins = [];
    this.moonPivot = null;
    this.setSunViewDir = null;
    // Gas material is disposed by the traverse above (it's a mesh material);
    // just drop our references so stale stirs/raycasts can't target it.
    this.gasMat = null;
    this.gasMesh = null;
    this.gasDetailValue = 0;
  }

  private loadTexture(path: string, srgb: boolean): THREE.Texture {
    const cached = this.texCache.get(path);
    if (cached) return cached;
    const tex = this.texLoader.load(path);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = THREE.RepeatWrapping;
    this.texCache.set(path, tex);
    return tex;
  }

  private loadBackground(path: string): void {
    this.texLoader.load(path, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    }, undefined, () => { /* keep the dark fallback */ });
  }

  dispose(): void {
    this.disposeBody();
    this.disposeOrrery();
    for (const tex of this.texCache.values()) tex.dispose();
    this.texCache.clear();
    const bg = this.scene.background;
    if (bg instanceof THREE.Texture) bg.dispose();
  }
}
