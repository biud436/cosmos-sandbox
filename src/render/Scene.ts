import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SPECIES } from '../physics/types';
import { Effector, EffectorType, Simulator } from '../physics/Simulator';
import { GraphicsSettings } from './GraphicsSettings';
import {
  SKY_NEBULA_VERT, SKY_NEBULA_FRAG, BOUNDARY_SHELL_VERT, BOUNDARY_SHELL_FRAG,
  GAS_VERT, GAS_FRAG, GAS_HALO_VERT, GAS_HALO_FRAG,
  EFFECTOR_VERT, EFFECTOR_FRAG,
} from './shaders';
import { BondRenderer } from './renderers/BondRenderer';
import { GalaxyRenderer } from './renderers/GalaxyRenderer';
import { OrbitTrailRenderer } from './renderers/OrbitTrailRenderer';

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

export class Scene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly boxHalf: number;
  // High-LOD particle meshes (icosa detail=2, 320 tri) — used for particles
  // whose projected pixel size exceeds the LOD threshold. Distant particles
  // are routed to speciesMeshesLo (detail=0, 20 tri) instead, dropping ~16x
  // the triangle work for tiny dots that wouldn't show subdivision anyway.
  private readonly speciesMeshes: THREE.InstancedMesh[] = [];
  private readonly speciesMeshesLo: THREE.InstancedMesh[] = [];
  private readonly speciesCapacity: number[];
  private readonly speciesCountsLoScratch: Int32Array = new Int32Array(SPECIES.length);
  // Projection scale (= canvasH / (2 * tan(fovY/2))) cached for the
  // solid-mode LOD pick. pixelSize ≈ radius * projScaleY / dist.
  // Refreshed by onResize / constructor.
  private projScaleY = 1;
  private readonly tmpMat = new THREE.Matrix4();
  private boxMesh: THREE.LineSegments | null = null;
  private gridMesh: THREE.GridHelper | null = null;
  private universeMesh: THREE.LineSegments | null = null;
  private universeShell: THREE.Mesh | null = null;
  private bonds!: BondRenderer;
  readonly visibility = {
    particles: true,
    bonds: true,
    boundary: false,
    stars: true,
    blackholes: true,
    repulsors: true,
    freezers: true,
    orbits: false,
    galaxies: true,
    nebulae: true,
    neutronStars: true,
  };
  private galaxies!: GalaxyRenderer;
  private orbits!: OrbitTrailRenderer;
  private effectorViews = new Map<Effector, {
    group: THREE.Group;
    mat: THREE.ShaderMaterial;
    selectionRing: THREE.Mesh;
    influenceRing: THREE.Mesh | null;
    lastConsumed?: number;
    accretion?: number;
  }>();
  private effectorClock = 0;
  private selectedEffector: Effector | null = null;
  private renderMode: 'solid' | 'gas' = 'solid';
  private gasPoints: THREE.Points | null = null;
  private gasHaloPoints: THREE.Points | null = null;
  private gasGeom: THREE.BufferGeometry | null = null;
  private gasPositions: Float32Array | null = null;
  private gasColors: Float32Array | null = null;
  private gasSizes: Float32Array | null = null;
  private readonly maxParticlesTotal: number;
  // Far-field starfield + nebula. Parented to a group that tracks the camera
  // each frame so the player always feels surrounded — otherwise far zooms
  // or Hubble expansion push the camera outside the fixed-radius shell and
  // half the sky goes dark.
  private skyGroup: THREE.Group | null = null;

  /** Live graphics settings — mutated in place by setQualityPreset(). Knobs
   *  read by hot paths (LOD threshold, etc.) dereference through this so
   *  changing a preset takes effect on the next frame. */
  graphicsSettings: GraphicsSettings;

  constructor(container: HTMLElement, boxHalf: number, maxPerSpecies: number, gfx: GraphicsSettings) {
    this.graphicsSettings = gfx;
    this.boxHalf = boxHalf;
    this.speciesCapacity = SPECIES.map(() => maxPerSpecies);
    this.maxParticlesTotal = maxPerSpecies * SPECIES.length;

    this.scene = new THREE.Scene();
    // Flat dark color — the omnidirectional starfield/nebula provides depth,
    // and a directional gradient would re-introduce the "one face dark" bug
    // when the camera looks outward in spaceship mode.
    this.scene.background = new THREE.Color(0x02030a);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, boxHalf * 80);
    this.camera.position.set(boxHalf * 1.6, boxHalf * 1.1, boxHalf * 1.6);

    // MSAA is a WebGLRenderer-construction option — can't be toggled at
    // runtime without re-creating the context. We read it from the live
    // graphics settings; changing it later requires a page reload (the
    // toolbar surfaces a hint when the player picks a preset that flips it).
    this.renderer = new THREE.WebGLRenderer({ antialias: gfx.antialias, powerPreference: 'high-performance' });
    const cap = gfx.pixelRatioCap;
    this.basePixelRatio = Math.min(window.devicePixelRatio, cap);
    this.currentPixelRatio = this.basePixelRatio;
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);

    this.buildEnvironment();
    this.buildUniverseBoundary();
    this.buildStarfield();
    this.buildParticleMeshes();
    this.buildGasRenderer();
    this.bonds = new BondRenderer(this.scene, this.maxParticlesTotal);
    this.galaxies = new GalaxyRenderer(this.scene);
    this.orbits = new OrbitTrailRenderer(this.scene, this.visibility.orbits);

    const ro = new ResizeObserver(() => this.onResize(container));
    ro.observe(container);
    // Initialize projScaleY / canvasH for LOD before the first frame runs.
    this.onResize(container);
  }

  private buildStarfield(): void {
    const skyGroup = new THREE.Group();
    skyGroup.frustumCulled = false;
    this.scene.add(skyGroup);
    this.skyGroup = skyGroup;
    const farR = this.boxHalf * 18;
    const count = this.graphicsSettings.starfieldCount;
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
    skyGroup.add(stars);

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
    skyGroup.add(nebula);
  }

  private buildUniverseBoundary(): void {
    const R = this.boxHalf;
    const cubeGeo = new THREE.BoxGeometry(R * 2, R * 2, R * 2);
    const edgesGeo = new THREE.EdgesGeometry(cubeGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x44ddff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const wire = new THREE.LineSegments(edgesGeo, edgesMat);
    wire.frustumCulled = false;
    wire.visible = this.visibility.boundary;
    this.scene.add(wire);
    this.universeMesh = wire;

    const shellGeo = new THREE.BoxGeometry(R * 2, R * 2, R * 2);
    const shellMat = new THREE.ShaderMaterial({
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x44ddff) },
      },
      vertexShader: BOUNDARY_SHELL_VERT,
      fragmentShader: BOUNDARY_SHELL_FRAG,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.frustumCulled = false;
    shell.visible = this.visibility.boundary;
    this.scene.add(shell);
    this.universeShell = shell;
  }

  setVisibility(group: keyof Scene['visibility'], visible: boolean): void {
    this.visibility[group] = visible;
    switch (group) {
      case 'particles':
        for (const m of this.speciesMeshes) m.visible = visible && this.renderMode === 'solid';
        for (const m of this.speciesMeshesLo) m.visible = visible && this.renderMode === 'solid';
        if (this.gasPoints) this.gasPoints.visible = visible && this.renderMode === 'gas';
        if (this.gasHaloPoints) this.gasHaloPoints.visible = visible && this.renderMode === 'gas';
        break;
      case 'bonds':
        this.bonds.setVisible(visible);
        break;
      case 'boundary':
        if (this.universeMesh) this.universeMesh.visible = visible;
        if (this.universeShell) this.universeShell.visible = visible;
        break;
      case 'orbits':
        this.orbits.setVisible(visible);
        break;
      case 'galaxies':
        this.galaxies.setVisible(visible);
        break;
    }
  }

  isVisible(group: keyof Scene['visibility']): boolean {
    return this.visibility[group];
  }

  private buildEnvironment(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(this.boxHalf * 2, this.boxHalf * 3, this.boxHalf * 2);
    this.scene.add(key);

    this.boxMesh = this.makeBoxLines(this.boxHalf);
    this.scene.add(this.boxMesh);

    const gridSize = this.boxHalf * 2;
    const grid = new THREE.GridHelper(gridSize, 12, 0x2a3142, 0x161a24);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = -this.boxHalf - 0.001;
    this.scene.add(grid);
    this.gridMesh = grid;
  }

  private makeBoxLines(half: number): THREE.LineSegments {
    const geo = new THREE.BoxGeometry(half * 2, half * 2, half * 2);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({ color: 0x3a4258, transparent: true, opacity: 0.55 });
    return new THREE.LineSegments(edges, mat);
  }

  setUniverseScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (this.universeMesh) this.universeMesh.scale.setScalar(scale);
    if (this.universeShell) this.universeShell.scale.setScalar(scale);
  }

  setBoxHalf(half: number): void {
    if (this.boxMesh) {
      this.scene.remove(this.boxMesh);
      this.boxMesh.geometry.dispose();
      (this.boxMesh.material as THREE.Material).dispose();
    }
    this.boxMesh = this.makeBoxLines(half);
    this.scene.add(this.boxMesh);
  }

  private buildGasRenderer(): void {
    const cap = this.maxParticlesTotal;
    const positions = new Float32Array(cap * 3);
    const colors = new Float32Array(cap * 3);
    const sizes = new Float32Array(cap);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geom.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelScale: { value: this.renderer.getPixelRatio() * window.innerHeight * 0.5 },
        uRedshiftNear: { value: 80 },
        uRedshiftFar: { value: 500 },
      },
      vertexShader: GAS_VERT,
      fragmentShader: GAS_FRAG,
    });

    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.visible = false;
    this.scene.add(points);

    // Macro halo pass: same buffers, much larger sprite, no wisp noise.
    // Heavy overlap of these big soft Gaussians makes nearby particles read
    // as a single nebula cluster rather than discrete dots.
    const haloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelScale: { value: this.renderer.getPixelRatio() * window.innerHeight * 0.5 },
        uRedshiftNear: { value: 80 },
        uRedshiftFar: { value: 500 },
        uSizeMul: { value: 3.2 },
      },
      vertexShader: GAS_HALO_VERT,
      fragmentShader: GAS_HALO_FRAG,
    });
    const halo = new THREE.Points(geom, haloMat);
    halo.frustumCulled = false;
    halo.visible = false;
    halo.renderOrder = -1; // draw behind the detail pass
    this.scene.add(halo);

    this.gasGeom = geom;
    this.gasPoints = points;
    this.gasHaloPoints = halo;
    this.gasPositions = positions;
    this.gasColors = colors;
    this.gasSizes = sizes;
  }

  setRenderMode(mode: 'solid' | 'gas'): void {
    if (mode === this.renderMode) return;
    this.renderMode = mode;
    const useSolid = mode === 'solid';
    const show = this.visibility.particles;
    for (const m of this.speciesMeshes) m.visible = show && useSolid;
    for (const m of this.speciesMeshesLo) m.visible = show && useSolid;
    if (this.gasPoints) this.gasPoints.visible = show && !useSolid;
    if (this.gasHaloPoints) this.gasHaloPoints.visible = show && !useSolid;
  }

  setEnvironmentVisible(visible: boolean): void {
    if (this.boxMesh) this.boxMesh.visible = visible;
    if (this.gridMesh) this.gridMesh.visible = visible;
  }

  /** Switch to a new graphics-quality preset at runtime. AA is NOT changed
   *  here — that's a renderer-construction flag and needs a fresh context.
   *  Returns `true` if the caller should prompt for a page reload because
   *  AA mismatch is now visible. */
  applyGraphicsSettings(next: GraphicsSettings): boolean {
    const prev = this.graphicsSettings;
    this.graphicsSettings = next;
    // DPR cap. We pin currentPixelRatio to the new base immediately; the
    // adaptive loop (if enabled) can still dip it later if FPS sags.
    this.basePixelRatio = Math.min(window.devicePixelRatio, next.pixelRatioCap);
    this.currentPixelRatio = this.basePixelRatio;
    this.renderer.setPixelRatio(this.currentPixelRatio);
    // Starfield count change requires a rebuild — cheap (a few thousand verts).
    if (prev.starfieldCount !== next.starfieldCount && this.skyGroup) {
      this.rebuildStarfield();
    }
    // AA can't change at runtime. Report mismatch so the caller can toast.
    return prev.antialias !== next.antialias;
  }

  /** Tear down the existing starfield + skybox dome and rebuild from the
   *  current settings. Used when the player changes density at runtime. */
  private rebuildStarfield(): void {
    if (!this.skyGroup) return;
    // Dispose children of skyGroup (the Points + the inner-shell nebula
    // mesh). Their geometries/materials are one-off per build.
    for (const child of [...this.skyGroup.children]) {
      this.skyGroup.remove(child);
      const m = child as THREE.Mesh | THREE.Points;
      const geo = (m.geometry as THREE.BufferGeometry | undefined);
      if (geo) geo.dispose();
      const mat = (m.material as THREE.Material | THREE.Material[] | undefined);
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    }
    this.scene.remove(this.skyGroup);
    this.skyGroup = null;
    this.buildStarfield();
  }

  private buildParticleMeshes(): void {
    // High LOD: detail=2 = 320 triangles per sphere. Looks correctly round
    // for particles big enough to occupy >8 screen pixels.
    const sphereGeoHi = new THREE.IcosahedronGeometry(1, 2);
    // Low LOD: detail=0 = 20 triangles. Indistinguishable from the hi-LOD
    // mesh once a particle shrinks under ~6px on screen, but renders 16x
    // cheaper. Materially the same per-instance setMatrixAt cost, so the
    // CPU side stays flat.
    const sphereGeoLo = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < SPECIES.length; i++) {
      const species = SPECIES[i];
      const matHi = new THREE.MeshBasicMaterial({ color: species.color });
      const meshHi = new THREE.InstancedMesh(sphereGeoHi, matHi, this.speciesCapacity[i]);
      meshHi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshHi.count = 0;
      meshHi.frustumCulled = false;
      this.scene.add(meshHi);
      this.speciesMeshes.push(meshHi);

      const matLo = new THREE.MeshBasicMaterial({ color: species.color });
      const meshLo = new THREE.InstancedMesh(sphereGeoLo, matLo, this.speciesCapacity[i]);
      meshLo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshLo.count = 0;
      meshLo.frustumCulled = false;
      this.scene.add(meshLo);
      this.speciesMeshesLo.push(meshLo);
    }
  }

  private readonly tmpFrustum = new THREE.Frustum();
  private readonly tmpProjView = new THREE.Matrix4();
  private readonly tmpSphere = new THREE.Sphere();
  // Reused per-frame scratch buffers — avoid GC churn in the 60Hz sync path.
  private readonly speciesCountsScratch: Int32Array = new Int32Array(SPECIES.length);
  private readonly aliveEffectorScratch: Set<Effector> = new Set<Effector>();

  sync(sim: Simulator, frameDt = 1 / 60): void {
    const n = sim.count;
    this.setUniverseScale(sim.scaleFactor);

    // Build frustum FIRST so all syncs can cull against it
    this.camera.updateMatrixWorld();
    this.tmpProjView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.tmpFrustum.setFromProjectionMatrix(this.tmpProjView);

    this.bonds.sync(sim);
    this.syncEffectors(sim, frameDt);
    this.orbits.sync(sim, this.selectedEffector, this.visibility.orbits, frameDt);
    this.galaxies.sync(sim, this.tmpFrustum, this.visibility.galaxies, frameDt);

    if (this.renderMode === 'solid') {
      const counts = this.speciesCountsScratch;
      const countsLo = this.speciesCountsLoScratch;
      counts.fill(0);
      countsLo.fill(0);
      // pixelSize ≈ radius * projScaleY / dist. Threshold pulled from the
      // live quality settings — smaller = more particles upgraded to hi-LOD
      // (looks crisper; costs more triangles). Squared for cheap comparison:
      // (radius * projScaleY)² < THRESH² * dist².
      const lodPixelThresh = this.graphicsSettings.particleLodPx;
      const lodCoef = this.projScaleY / lodPixelThresh;
      const camX = this.camera.position.x;
      const camY = this.camera.position.y;
      const camZ = this.camera.position.z;
      for (let i = 0; i < n; i++) {
        const s = sim.species[i];
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        const radius = SPECIES[s].sigma * 1.1;
        this.tmpSphere.center.set(px, py, pz);
        this.tmpSphere.radius = radius;
        if (!this.tmpFrustum.intersectsSphere(this.tmpSphere)) continue;
        // LOD pick: hi if (radius * lodCoef) > dist, else lo.
        const dx = px - camX, dy = py - camY, dz = pz - camZ;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const cutoff = radius * lodCoef;
        const useHi = cutoff * cutoff > dist2;
        const targetMesh = useHi ? this.speciesMeshes[s] : this.speciesMeshesLo[s];
        const targetCounts = useHi ? counts : countsLo;
        const slot = targetCounts[s]++;
        if (slot >= this.speciesCapacity[s]) continue;
        this.tmpMat.makeScale(radius, radius, radius);
        this.tmpMat.setPosition(px, py, pz);
        targetMesh.setMatrixAt(slot, this.tmpMat);
      }
      for (let s = 0; s < SPECIES.length; s++) {
        this.speciesMeshes[s].count = counts[s];
        if (counts[s] > 0) this.speciesMeshes[s].instanceMatrix.needsUpdate = true;
        this.speciesMeshesLo[s].count = countsLo[s];
        if (countsLo[s] > 0) this.speciesMeshesLo[s].instanceMatrix.needsUpdate = true;
      }
    } else if (this.gasGeom && this.gasPositions && this.gasColors && this.gasSizes) {
      let write = 0;
      const cap = Math.min(n, this.maxParticlesTotal);
      for (let i = 0; i < cap; i++) {
        const s = sim.species[i];
        const sp = SPECIES[s];
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        this.tmpSphere.center.set(px, py, pz);
        this.tmpSphere.radius = sp.sigma * 1.5;
        if (!this.tmpFrustum.intersectsSphere(this.tmpSphere)) continue;
        const isDM = sp.name === 'DM';
        this.gasPositions[write * 3 + 0] = px;
        this.gasPositions[write * 3 + 1] = py;
        this.gasPositions[write * 3 + 2] = pz;
        const r = ((sp.color >> 16) & 0xff) / 255;
        const g = ((sp.color >> 8) & 0xff) / 255;
        const b = (sp.color & 0xff) / 255;
        // DM: barely visible (halo hint), baryonic gas: full intensity
        const dim = isDM ? 0.28 : 0.85;
        this.gasColors[write * 3 + 0] = r * dim;
        this.gasColors[write * 3 + 1] = g * dim;
        this.gasColors[write * 3 + 2] = b * dim;
        // Large, heavily-overlapping point sprites so additive blending forms
        // diffuse nebulae rather than visibly distinct particles.
        this.gasSizes[write] = sp.sigma * (isDM ? 10.0 : 18.0);
        write++;
      }
      this.gasGeom.setDrawRange(0, write);
      // Only upload the slice that was actually written. updateRange tells
      // three.js to skip the rest of the (possibly large) attribute buffer.
      if (write > 0) {
        const pos = this.gasGeom.getAttribute('position') as THREE.BufferAttribute;
        const col = this.gasGeom.getAttribute('color') as THREE.BufferAttribute;
        const sz  = this.gasGeom.getAttribute('size')  as THREE.BufferAttribute;
        pos.clearUpdateRanges(); pos.addUpdateRange(0, write * 3); pos.needsUpdate = true;
        col.clearUpdateRanges(); col.addUpdateRange(0, write * 3); col.needsUpdate = true;
        sz.clearUpdateRanges();  sz.addUpdateRange(0, write);      sz.needsUpdate  = true;
      }
    }
  }

  private visibilityKeyFor(type: EffectorType): keyof Scene['visibility'] {
    switch (type) {
      case 'star': return 'stars';
      case 'blackhole': return 'blackholes';
      case 'repulsor': return 'repulsors';
      case 'freezer': return 'freezers';
      case 'nebula': return 'nebulae';
      case 'neutron_star': return 'neutronStars';
    }
  }

  private syncEffectors(sim: Simulator, frameDt: number): void {
    this.effectorClock += frameDt;
    const alive = this.aliveEffectorScratch;
    alive.clear();
    for (const eff of sim.effectors) alive.add(eff);
    for (const [eff, view] of this.effectorViews) {
      if (!alive.has(eff)) {
        this.scene.remove(view.group);
        this.effectorViews.delete(eff);
      }
    }
    const camPos = this.camera.position;
    const rsNear = 80;
    const rsFar = 500;
    for (const eff of sim.effectors) {
      let view = this.effectorViews.get(eff);
      if (!view) {
        view = this.createEffectorView(eff.type);
        this.effectorViews.set(eff, view);
      }
      const typeVisible = this.visibility[this.visibilityKeyFor(eff.type)];
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
      const inFrustum = this.tmpFrustum.intersectsSphere(this.tmpSphere);
      view.group.visible = typeVisible && inFrustum;
      if (!view.group.visible) continue;
      view.group.position.set(eff.x, eff.y, eff.z);
      view.group.scale.setScalar(eff.radius * scaleBoost);
      view.group.lookAt(this.camera.position);
      view.mat.uniforms.uTime.value = this.effectorClock;
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
      const selected = eff === this.selectedEffector;
      view.selectionRing.visible = selected;
      if (selected) {
        (view.selectionRing.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.3 * Math.sin(this.effectorClock * 5);
      }
      if (view.influenceRing) {
        view.influenceRing.visible = selected;
        if (selected) {
          (view.influenceRing.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.06 * Math.sin(this.effectorClock * 2);
        }
      }
    }
  }

  private createEffectorView(type: EffectorType): { group: THREE.Group; mat: THREE.ShaderMaterial; selectionRing: THREE.Mesh; influenceRing: THREE.Mesh | null } {
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

  pickEffector(clientX: number, clientY: number, sim: Simulator): Effector | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
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

  setSelectedEffector(eff: Effector | null): void {
    this.selectedEffector = eff;
    if (!eff) {
      this.followAnchor = null;
      return;
    }
    // If a focus animation isn't currently running the follow lock should
    // start immediately. Otherwise the animation hands the anchor off when
    // it completes (see focusInternal).
    if (this.focusAnimationId === null) {
      this.followAnchor = new THREE.Vector3(eff.x, eff.y, eff.z);
    }
  }

  getSelectedEffector(): Effector | null {
    return this.selectedEffector;
  }

  // Camera lock-on: once an effector is selected, the camera tracks its
  // motion every frame so the user can keep watching it. The anchor stores
  // where the effector was last frame so we can apply the delta to both the
  // OrbitControls target and the camera position — preserving the user's
  // current orbit/zoom relative to the body.
  private followAnchor: THREE.Vector3 | null = null;

  private updateCameraFollow(): void {
    const eff = this.selectedEffector;
    if (!eff || !this.followAnchor) return;
    if (this.focusAnimationId !== null) return;

    const dx = eff.x - this.followAnchor.x;
    const dy = eff.y - this.followAnchor.y;
    const dz = eff.z - this.followAnchor.z;
    if (dx === 0 && dy === 0 && dz === 0) return;

    this.controls.target.x += dx;
    this.controls.target.y += dy;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;

    this.followAnchor.set(eff.x, eff.y, eff.z);
  }

  private focusAnimationId: number | null = null;

  focusOn(position: [number, number, number], distance = 6): void {
    this.focusInternal(() => position, distance);
  }

  focusOnEffector(eff: Effector, distance = 6): void {
    this.focusInternal(() => [eff.x, eff.y, eff.z] as [number, number, number], distance);
  }

  private focusInternal(getPos: () => [number, number, number], distance: number): void {
    if (this.focusAnimationId !== null) {
      cancelAnimationFrame(this.focusAnimationId);
      this.focusAnimationId = null;
    }

    const startTarget = this.controls.target.clone();
    const startCam = this.camera.position.clone();
    const offsetDir = this.camera.position.clone().sub(this.controls.target);
    const offsetLen = offsetDir.length();
    if (offsetLen > 0.1) offsetDir.multiplyScalar(distance / offsetLen);
    else offsetDir.set(distance, distance * 0.6, distance);

    const t0 = performance.now();
    const dur = 600;
    const animate = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = getPos();
      const liveTarget = new THREE.Vector3(p[0], p[1], p[2]);
      const liveCam = liveTarget.clone().add(offsetDir);
      this.controls.target.lerpVectors(startTarget, liveTarget, k);
      this.camera.position.lerpVectors(startCam, liveCam, k);
      if (t < 1) {
        this.focusAnimationId = requestAnimationFrame(animate);
      } else {
        this.controls.target.copy(liveTarget);
        this.camera.position.copy(liveCam);
        this.focusAnimationId = null;
        // Hand off to per-frame follow if we're focusing on the selection
        if (this.selectedEffector) {
          this.followAnchor = liveTarget.clone();
        }
      }
    };
    this.focusAnimationId = requestAnimationFrame(animate);
  }

  worldFromScreen(clientX: number, clientY: number): [number, number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const plane = new THREE.Plane(camDir.clone().negate(), 0);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
  }

  isInsideViewport(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  pulseOrigin(position: [number, number, number]): void {
    const geo = new THREE.SphereGeometry(0.5, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    const burst = new THREE.Mesh(geo, mat);
    burst.position.set(position[0], position[1], position[2]);
    this.scene.add(burst);
    const start = performance.now();
    const animate = () => {
      const t = (performance.now() - start) / 400;
      if (t >= 1) {
        this.scene.remove(burst);
        geo.dispose();
        mat.dispose();
        return;
      }
      const s = 1 + t * 5;
      burst.scale.set(s, s, s);
      mat.opacity = 0.9 * (1 - t);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  /**
   * Active camera controller mode. In 'ship' mode OrbitControls is disabled
   * so the ShipController (which lives outside Scene) can drive the camera
   * directly without fighting damping. Selection follow is also suspended.
   */
  setControllerMode(mode: 'orbit' | 'ship'): void {
    if (mode === 'ship') {
      this.controls.enabled = false;
      this.followAnchor = null;
    } else {
      this.controls.enabled = true;
      // After taking back control, point OrbitControls at whatever the
      // camera is currently looking at (~1 unit in front), so the user
      // doesn't snap to the old origin target.
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.controls.target.copy(this.camera.position).addScaledVector(dir, 10);
      this.controls.update();
    }
  }

  /** Find the nearest star/NS/BH effector to a world-space point. */
  nearestStar(sim: Simulator, point: THREE.Vector3): { eff: Effector; distance: number } | null {
    let best: Effector | null = null;
    let bestD = Infinity;
    for (const e of sim.effectors) {
      if (e.type !== 'star' && e.type !== 'neutron_star' && e.type !== 'blackhole') continue;
      const dx = e.x - point.x;
      const dy = e.y - point.y;
      const dz = e.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = e; }
    }
    return best ? { eff: best, distance: Math.sqrt(bestD) } : null;
  }

  render(): void {
    if (this.controls.enabled) {
      this.updateCameraFollow();
      this.controls.update();
    }
    if (this.skyGroup) this.skyGroup.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  // --- Adaptive DPR ---------------------------------------------------------
  // High-DPI displays (Retina/4K) often render at 4× the pixel count of the
  // canvas size, which is the single most expensive thing in fill-rate-bound
  // scenes. We start at the device DPR (capped at 2), then ratchet down when
  // FPS sags and back up when it recovers. The user feels smoother frames in
  // exchange for slightly softer rendering until they stop moving.
  /** Initial DPR cap snapshot — recomputed when a new quality preset is
   *  applied. Adaptive DPR may temporarily drive currentPixelRatio below
   *  this but never above. */
  private basePixelRatio: number;
  private currentPixelRatio: number;
  private dprDownAccum = 0;
  private dprUpAccum = 0;
  /** Called once per second-ish with the rolling FPS measurement. */
  adaptPixelRatio(fps: number, dt: number): void {
    // Adaptive DPR is opt-in per the player's quality preset. With it off,
    // we hold currentPixelRatio at basePixelRatio regardless of FPS — the
    // player explicitly asked for quality over smoothness.
    if (!this.graphicsSettings.adaptiveDPR) return;
    // Only react after we've taken a real measurement. fps=0 in the first
    // few frames would otherwise stampede us down to the floor.
    if (fps <= 1) return;
    if (fps < 45) {
      this.dprDownAccum += dt;
      this.dprUpAccum = 0;
      if (this.dprDownAccum > 0.6 && this.currentPixelRatio > 0.6) {
        const next = Math.max(0.6, this.currentPixelRatio - 0.25);
        this.currentPixelRatio = next;
        this.renderer.setPixelRatio(next);
        this.dprDownAccum = 0;
      }
    } else if (fps > 58 && this.currentPixelRatio < this.basePixelRatio) {
      this.dprUpAccum += dt;
      this.dprDownAccum = 0;
      if (this.dprUpAccum > 2.5) {
        const next = Math.min(this.basePixelRatio, this.currentPixelRatio + 0.25);
        this.currentPixelRatio = next;
        this.renderer.setPixelRatio(next);
        this.dprUpAccum = 0;
      }
    } else {
      this.dprDownAccum *= 0.5;
      this.dprUpAccum *= 0.5;
    }
  }

  private onResize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const pixelScale = this.renderer.getPixelRatio() * h * 0.5;
    if (this.gasPoints) {
      (this.gasPoints.material as THREE.ShaderMaterial).uniforms.uPixelScale.value = pixelScale;
    }
    if (this.gasHaloPoints) {
      (this.gasHaloPoints.material as THREE.ShaderMaterial).uniforms.uPixelScale.value = pixelScale;
    }
    // Half-height of the canvas in pixels, divided by tan(fovY/2) — the
    // projection scale used in solid-mode LOD: pixel_radius ≈ radius * projScaleY / dist.
    const fovYRad = this.camera.fov * Math.PI / 180;
    this.projScaleY = (h * 0.5) / Math.tan(fovYRad * 0.5);
  }
}
