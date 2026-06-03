import * as THREE from 'three';
import { Effector, EffectorType, Simulator } from '../../physics/Simulator';
import { EFFECTOR_VERT, EFFECTOR_FRAG } from '../shaders';

// Per-effector visibility flags this renderer reads each frame. Structurally a
// subset of the Scene's wider `visibility` object, so the Scene passes its own.
export interface EffectorVisibility {
  stars: boolean;
  blackholes: boolean;
  repulsors: boolean;
  freezers: boolean;
  nebulae: boolean;
  neutronStars: boolean;
}

interface EffectorView {
  group: THREE.Group;
  mat: THREE.ShaderMaterial;
  selectionRing: THREE.Mesh;
  influenceRing: THREE.Mesh | null;
  lastConsumed?: number;
  accretion?: number;
}

// Mass → spectral class color, approximating O/B/A/F/G/K/M sequence.
// Mass thresholds chosen for the compressed sim scale (not solar units).
// Colors picked from Planck blackbody at the corresponding effective temp,
// then desaturated slightly so massive stars don't go pure-blue.
function spectralColor(mass: number): [number, number, number] {
  if (mass < 12)  return [1.00, 0.55, 0.42]; // M-dwarf  (~3000K)
  if (mass < 22)  return [1.00, 0.72, 0.50]; // K        (~4500K)
  if (mass < 40)  return [1.00, 0.90, 0.72]; // G (sun)  (~5800K)
  if (mass < 70)  return [1.00, 0.98, 0.92]; // F/A      (~7000–8500K)
  if (mass < 130) return [0.82, 0.90, 1.00]; // B        (~15000K)
  return            [0.65, 0.80, 1.00];      // O/Wolf-Rayet (~30000K+)
}

// Metallicity tint: low-Z (Pop III) stars have less metal-line opacity in
// the photosphere → photosphere appears subtly bluer at the same effective
// temperature. High-Z stars look slightly warmer/redder. Effect is intentionally
// subtle so the dominant color signal stays the spectral class.
function applyMetallicityTint(rgb: [number, number, number], Z: number): [number, number, number] {
  // Map Z ∈ [0, 1] to t ∈ [-1, +1] (pristine → enriched)
  const t = Z * 2 - 1;
  return [
    rgb[0] * (1 + t * 0.08),
    rgb[1] * (1 - t * 0.02),
    rgb[2] * (1 - t * 0.08),
  ];
}

// Renders the billboarded aura + core + selection/influence rings for every
// effector (star, BH, neutron star, repulsor, freezer, nebula). Owns one view
// group per live effector, reaping views whose effector has been removed. The
// Scene owns the selection state and camera; it forwards the current selection
// and per-type visibility into sync() each frame.
export class EffectorRenderer {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLCanvasElement;
  private readonly views = new Map<Effector, EffectorView>();
  private readonly aliveScratch = new Set<Effector>();
  private readonly tmpSphere = new THREE.Sphere();
  private clock = 0;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, domElement: HTMLCanvasElement) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
  }

  sync(sim: Simulator, frustum: THREE.Frustum, visibility: EffectorVisibility, selected: Effector | null, frameDt: number): void {
    this.clock += frameDt;
    const alive = this.aliveScratch;
    alive.clear();
    for (const eff of sim.effectors) alive.add(eff);
    for (const [eff, view] of this.views) {
      if (!alive.has(eff)) {
        this.scene.remove(view.group);
        this.views.delete(eff);
      }
    }
    const camPos = this.camera.position;
    const rsNear = 80;
    const rsFar = 500;
    for (const eff of sim.effectors) {
      let view = this.views.get(eff);
      if (!view) {
        view = this.createView(eff.type);
        this.views.set(eff, view);
      }
      const typeVisible = visibility[this.visibilityKeyFor(eff.type)];
      // Stars get a much larger visual halo so they read as actual stars and
      // dwarf the planets in their system (Sun:Jupiter ≈ 10:1 in real life;
      // 4× of the base 1.6 puts gas giants at ~25% of their host's visual
      // size — close enough to register as "different class of object").
      //
      // Nebulae are diffuse interstellar clouds spanning light-years, so they
      // must dwarf the stars embedded in them. 8× is paired with shader noise
      // (irregular feathered silhouette) so the result reads as a wispy cloud
      // volume, not a flat disk. Previously the nebula was a 0.5× compact
      // disk smaller than stars, which is physically backward.
      const scaleBoost =
        eff.type === 'star' ? 4.0 :
        eff.type === 'nebula' ? 8.0 :
        eff.type === 'neutron_star' ? 2.0 :
        1.0;
      const visualR = eff.radius * scaleBoost * 3.0;
      this.tmpSphere.center.set(eff.x, eff.y, eff.z);
      this.tmpSphere.radius = visualR;
      const inFrustum = frustum.intersectsSphere(this.tmpSphere);
      view.group.visible = typeVisible && inFrustum;
      if (!view.group.visible) continue;
      view.group.position.set(eff.x, eff.y, eff.z);
      view.group.scale.setScalar(eff.radius * scaleBoost);
      view.group.lookAt(this.camera.position);
      view.mat.uniforms.uTime.value = this.clock;
      if (view.mat.uniforms.uRedshift) {
        const dx = eff.x - camPos.x;
        const dy = eff.y - camPos.y;
        const dz = eff.z - camPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const z = Math.min(1, Math.max(0, (dist - rsNear) / (rsFar - rsNear)));
        view.mat.uniforms.uRedshift.value = z;
      }
      if (view.mat.uniforms.uMass) {
        view.mat.uniforms.uMass.value = eff.strength;
      }
      // Per-effector seed for shader noise decorrelation. Stable: derives
      // from eff.id only, so the same nebula keeps the same wisp pattern
      // across frames and re-renders.
      if (view.mat.uniforms.uSeed) {
        view.mat.uniforms.uSeed.value = (eff.id * 0.1729) % 1.0;
      }

      // Stellar spectral type + metallicity tint: outer color follows the
      // star's mass-derived effective temperature, with a subtle blue shift
      // for Pop III (Z=0) and warm shift for late-generation Pop I.
      if (eff.type === 'star' && view.mat.uniforms.uColor) {
        const spectral = spectralColor(eff.strength);
        const tinted = applyMetallicityTint(spectral, eff.metallicity ?? 0);
        (view.mat.uniforms.uColor.value as THREE.Color).setRGB(tinted[0], tinted[1], tinted[2]);
      }

      // BH accretion activity: low-pass filter of consumed-per-frame so the
      // glow ramps up smoothly while gas is falling in (AGN/quasar mode) and
      // fades out when the BH is dormant.
      if (eff.type === 'blackhole' && view.mat.uniforms.uAccretion) {
        const lastConsumed = view.lastConsumed ?? eff.consumed;
        const delta = Math.max(0, eff.consumed - lastConsumed);
        view.lastConsumed = eff.consumed;
        const target = Math.min(1, delta * 0.35);
        const prev = view.accretion ?? 0;
        const smoothed = prev * 0.85 + target * 0.15;
        view.accretion = smoothed;
        view.mat.uniforms.uAccretion.value = smoothed;
      }
      const isSelected = eff === selected;
      view.selectionRing.visible = isSelected;
      if (isSelected) {
        (view.selectionRing.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.3 * Math.sin(this.clock * 5);
      }
      if (view.influenceRing) {
        view.influenceRing.visible = isSelected;
        if (isSelected) {
          (view.influenceRing.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.06 * Math.sin(this.clock * 2);
        }
      }
    }
  }

  pick(clientX: number, clientY: number, sim: Simulator): Effector | null {
    const rect = this.domElement.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 1 } as any;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    let bestEff: Effector | null = null;
    let bestT = Infinity;
    for (const eff of sim.effectors) {
      const center = new THREE.Vector3(eff.x, eff.y, eff.z);
      const sphere = new THREE.Sphere(center, eff.radius * 1.2);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectSphere(sphere, hit)) {
        const t = raycaster.ray.origin.distanceTo(hit);
        if (t < bestT) {
          bestT = t;
          bestEff = eff;
        }
      }
    }
    return bestEff;
  }

  private visibilityKeyFor(type: EffectorType): keyof EffectorVisibility {
    switch (type) {
      case 'star': return 'stars';
      case 'blackhole': return 'blackholes';
      case 'repulsor': return 'repulsors';
      case 'freezer': return 'freezers';
      case 'nebula': return 'nebulae';
      case 'neutron_star': return 'neutronStars';
    }
  }

  private createView(type: EffectorType): EffectorView {
    const group = new THREE.Group();
    group.userData.pickable = true;

    // Core sphere color + visibility per effector type (presentation data; the
    // aura fragment shader itself lives in shaders/effectors as EFFECTOR_FRAG).
    const CORE: Record<EffectorType, { color: number; visible: boolean }> = {
      blackhole:    { color: 0x000000, visible: true },
      star:         { color: 0xffe89a, visible: true },
      repulsor:     { color: 0xff6644, visible: true },
      freezer:      { color: 0xaaddff, visible: false },
      neutron_star: { color: 0xcceeff, visible: false },
      nebula:       { color: 0xff88aa, visible: false },
    };
    const coreColor = CORE[type].color;
    const coreVisible = CORE[type].visible;
    const fragmentShader = EFFECTOR_FRAG[type];

    if (coreVisible) {
      const core = new THREE.Mesh(new THREE.SphereGeometry(type === 'blackhole' ? 1.0 : 0.7, 24, 24),
        new THREE.MeshBasicMaterial({ color: coreColor }));
      group.add(core);
    }

    let influenceRing: THREE.Mesh | null = null;
    if (type === 'blackhole') {
      const horizonGeo = new THREE.SphereGeometry(1.0, 24, 16);
      const horizonMat = new THREE.MeshBasicMaterial({
        color: 0xff4422,
        wireframe: true,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      });
      const horizonMesh = new THREE.Mesh(horizonGeo, horizonMat);
      group.add(horizonMesh);

      const infRingGeo = new THREE.RingGeometry(2.85, 3.0, 64);
      const infRingMat = new THREE.MeshBasicMaterial({
        color: 0xff8855,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      influenceRing = new THREE.Mesh(infRingGeo, infRingMat);
      influenceRing.visible = false;
      group.add(influenceRing);
    }

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRedshift: { value: 0 },
        uMass: { value: 0 },
        uColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
        uAccretion: { value: 0 },
        // Per-effector seed (set at construction from eff.id) used by the
        // nebula shader to decorrelate its noise field. Other types ignore it.
        uSeed: { value: 0 },
      },
      vertexShader: EFFECTOR_VERT,
      fragmentShader,
    });
    const aura = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), mat);
    group.add(aura);

    const ringGeo = new THREE.RingGeometry(1.6, 1.85, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x5499f7,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const selectionRing = new THREE.Mesh(ringGeo, ringMat);
    selectionRing.visible = false;
    group.add(selectionRing);

    this.scene.add(group);
    return { group, mat, selectionRing, influenceRing };
  }
}
