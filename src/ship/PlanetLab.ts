import * as THREE from 'three';
import { PlanetProfile } from './PlanetProfiles';
import { ATMOSPHERE_VERT, ATMOSPHERE_FRAG } from './shaders/atmosphere';

// Isolated photoreal-planet lab. Owns its OWN THREE.Scene so it can render a
// single real body (Earth/Mars) from texture maps without touching any of the
// particle-universe renderers in Scene.ts. The main loop swaps to
// `renderer.render(planetLab.scene, camera)` while in planet mode.
//
// One fixed sun direction lights the body; the camera (driven by the shared
// OrbitControls) orbits the origin where the planet sits. Night-side city
// lights, drifting clouds, a limb-glow atmosphere shell, and an optional moon
// are assembled per profile.

const SUN_DIR = new THREE.Vector3(1, 0.18, 0.42).normalize();
const SPHERE_SEGMENTS: [number, number] = [96, 64];

interface SpinTarget { obj: THREE.Object3D; periodSec: number; }

export class PlanetLab {
  readonly scene = new THREE.Scene();
  private readonly maxAniso: number;
  private readonly texLoader = new THREE.TextureLoader();
  private readonly texCache = new Map<string, THREE.Texture>();
  private readonly sunLight: THREE.DirectionalLight;

  private bodyGroup: THREE.Group | null = null;
  private currentId: string | null = null;

  // Per-frame animation state for the active body.
  private spins: SpinTarget[] = [];
  private moonPivot: THREE.Object3D | null = null;
  private moonPeriodSec = 1;
  private setSunViewDir: ((v: THREE.Vector3) => void) | null = null;
  private elapsed = 0;
  private readonly tmpSunView = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.scene.background = new THREE.Color(0x05060d);

    // Very low ambient so the night side stays dark enough for city lights to
    // read, but the limb isn't pure black. The directional sun does the work.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.05));

    this.sunLight = new THREE.DirectionalLight(0xfff6e8, 3.1);
    this.sunLight.position.copy(SUN_DIR).multiplyScalar(50);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target); // target defaults to origin

    // A simple bright sun disc far in the sun direction so the light has a
    // visible source when the camera pans toward it.
    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2cc }),
    );
    sunDisc.position.copy(SUN_DIR).multiplyScalar(140);
    this.scene.add(sunDisc);

    this.loadBackground('/textures/env/milkyway_bg_4k.jpg');
  }

  /** Swap the displayed body. Cheap on re-entry — textures stay cached. */
  setProfile(profile: PlanetProfile): void {
    if (this.currentId === profile.id) return;
    this.disposeBody();
    this.currentId = profile.id;

    const group = new THREE.Group();
    this.bodyGroup = group;
    this.scene.add(group);

    // Axial-tilt frame: the planet (and its clouds) spin around local Y while
    // the tilt frame tips that spin axis. A sphere shell (atmosphere) is tilt-
    // invariant, so we park it here too.
    const tilt = new THREE.Group();
    tilt.rotation.x = profile.axialTilt;
    group.add(tilt);

    const r = profile.radius;
    const squashY = r * (1 - profile.oblateness);

    // --- Planet body ---
    const planetGeom = new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]);
    const planetMat = this.buildBodyMaterial(profile);
    const planet = new THREE.Mesh(planetGeom, planetMat);
    planet.scale.set(r, squashY, r);
    tilt.add(planet);
    this.spins = [{ obj: planet, periodSec: profile.rotationPeriodSec }];

    // --- Clouds shell ---
    if (profile.textures.cloudsMap && profile.clouds) {
      const cg = new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]);
      const cloudMat = new THREE.MeshStandardMaterial({
        alphaMap: this.loadTexture(profile.textures.cloudsMap, false),
        transparent: true,
        depthWrite: false,
        color: 0xffffff,
        roughness: 1.0,
        metalness: 0.0,
        opacity: profile.clouds.opacity,
      });
      const clouds = new THREE.Mesh(cg, cloudMat);
      const cs = r * profile.clouds.scale;
      clouds.scale.set(cs, squashY * profile.clouds.scale, cs);
      tilt.add(clouds);
      this.spins.push({ obj: clouds, periodSec: profile.clouds.rotationPeriodSec });
    }

    // --- Atmosphere limb glow (reuses the procedural atmosphere shader) ---
    if (profile.atmosphere) {
      const a = profile.atmosphere;
      const ag = new THREE.SphereGeometry(1, 48, 32);
      const atmoMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(a.color[0], a.color[1], a.color[2]) },
          uThickness: { value: a.thickness },
          uSunDir: { value: SUN_DIR.clone() }, // world-space, constant
          // The Sun's "atmosphere" is a uniform corona (no day/night bias).
          uHasSun: { value: profile.selfLuminous ? 0 : 1 },
        },
        vertexShader: ATMOSPHERE_VERT,
        fragmentShader: ATMOSPHERE_FRAG,
      });
      const atmo = new THREE.Mesh(ag, atmoMat);
      const as = r * a.scale;
      atmo.scale.set(as, as, as);
      atmo.frustumCulled = false;
      tilt.add(atmo);
    }

    // --- Ring (Saturn) — lies in the body's equatorial plane, so it tips
    //     with the axial tilt but does not spin with the planet. ---
    if (profile.ring) {
      tilt.add(this.makeRing(profile.ring, r));
    }

    // --- Moon ---
    if (profile.moon) {
      const m = profile.moon;
      const pivot = new THREE.Group();
      const mg = new THREE.SphereGeometry(m.radius, 48, 32);
      const mm = new THREE.MeshStandardMaterial({
        map: this.loadTexture(m.map, true),
        roughness: 0.92,
        metalness: 0.0,
      });
      const moon = new THREE.Mesh(mg, mm);
      moon.position.set(m.distance, 0, 0);
      pivot.add(moon);
      group.add(pivot);
      this.moonPivot = pivot;
      this.moonPeriodSec = m.orbitPeriodSec;
    } else {
      this.moonPivot = null;
    }
  }

  /** Advance rotations and refresh the view-space sun direction used by the
   *  night-lights terminator. `camera` is the shared scene camera. */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.elapsed += dt;
    const TWO_PI = Math.PI * 2;
    for (const s of this.spins) {
      s.obj.rotation.y = (this.elapsed / s.periodSec) * TWO_PI;
    }
    if (this.moonPivot) {
      this.moonPivot.rotation.y = (this.elapsed / this.moonPeriodSec) * TWO_PI;
    }
    if (this.setSunViewDir) {
      camera.updateMatrixWorld();
      this.tmpSunView.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
      this.setSunViewDir(this.tmpSunView);
    }
  }

  /** Default camera standoff for framing a freshly-entered body. */
  get standoff(): number { return 3.0; }

  /** Build a flat ring in the XZ plane with radial UVs (u = inner→outer), so
   *  the equirectangular ring strip maps across the radius. */
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
      map: this.loadTexture(ring.map, true),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      opacity: ring.opacity,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2; // RingGeometry is in XY; tip it into XZ (equatorial)
    mesh.frustumCulled = false;
    return mesh;
  }

  private buildBodyMaterial(profile: PlanetProfile): THREE.Material {
    const t = profile.textures;
    this.setSunViewDir = null;

    if (profile.selfLuminous) {
      // The Sun emits its own light — render unlit so it stays uniformly bright
      // regardless of the lab's directional sun (which lights the planets).
      return new THREE.MeshBasicMaterial({ map: this.loadTexture(t.map, true) });
    }

    const mat = new THREE.MeshStandardMaterial({
      map: this.loadTexture(t.map, true),
      roughness: 1.0,
      metalness: 0.0,
    });
    if (t.normalMap) mat.normalMap = this.loadTexture(t.normalMap, false);
    if (t.roughnessMap) mat.roughnessMap = this.loadTexture(t.roughnessMap, false);
    if (t.bumpMap) {
      mat.bumpMap = this.loadTexture(t.bumpMap, false);
      mat.bumpScale = profile.bumpScale ?? 0.03;
    }

    if (t.emissiveMap) {
      // City lights: emissive is added regardless of lighting, so we mask it
      // to the night hemisphere via dot(normal, sunDir) in onBeforeCompile.
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveMap = this.loadTexture(t.emissiveMap, true);
      mat.emissiveIntensity = profile.emissiveIntensity ?? 1.5;
      const uSunViewDir = { value: SUN_DIR.clone() };
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uSunViewDir = uSunViewDir;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uSunViewDir;')
          .replace(
            '#include <emissivemap_fragment>',
            /* glsl */`#include <emissivemap_fragment>
            {
              float _sun = dot(normalize(normal), uSunViewDir);
              float _night = 1.0 - smoothstep(-0.15, 0.20, _sun);
              totalEmissiveRadiance *= _night;
            }`,
          );
      };
      this.setSunViewDir = (v: THREE.Vector3) => { uSunViewDir.value.copy(v); };
    }
    return mat;
  }

  private loadTexture(path: string, srgb: boolean): THREE.Texture {
    const cached = this.texCache.get(path);
    if (cached) return cached;
    const tex = this.texLoader.load(path);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = THREE.RepeatWrapping; // equirectangular: wrap the seam in longitude
    this.texCache.set(path, tex);
    return tex;
  }

  private loadBackground(path: string): void {
    this.texLoader.load(
      path,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.scene.background = tex;
      },
      undefined,
      () => { /* keep the dark fallback color if the panorama is absent */ },
    );
  }

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
  }

  dispose(): void {
    this.disposeBody();
    for (const tex of this.texCache.values()) tex.dispose();
    this.texCache.clear();
    const bg = this.scene.background;
    if (bg instanceof THREE.Texture) bg.dispose();
  }
}
