import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SPECIES } from '../physics/types';
import { Effector, EffectorType, Simulator } from '../physics/Simulator';

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
  private bondLines: THREE.LineSegments | null = null;
  private bondGeom: THREE.BufferGeometry | null = null;
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
  private galaxyHalos = new Map<string, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  private selectedOrbitLines: THREE.LineSegments | null = null;
  private selectedOrbitGeom: THREE.BufferGeometry | null = null;
  private selectedOrbitPositions: Float32Array | null = null;
  private selectedOrbitLink: THREE.Line | null = null;
  private selectedOrbitLinkGeom: THREE.BufferGeometry | null = null;
  private selectedOrbitLinkPositions: Float32Array | null = null;
  private orbitSegments = 96;
  private trailLines: THREE.Line | null = null;
  private trailGeom: THREE.BufferGeometry | null = null;
  private trailPositions: Float32Array | null = null;
  private trailColors: Float32Array | null = null;
  private trailCapacity = 512;
  private trailWriteIdx = 0;
  private trailCount = 0;
  private trailLastEffector: Effector | null = null;
  private trailSampleAccum = 0;
  private trailSampleInterval = 1 / 60; // record at ~60Hz max
  private bondPositions: Float32Array | null = null;
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

  constructor(container: HTMLElement, boxHalf: number, maxPerSpecies: number) {
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

    // antialias 비용은 fragment fill 의 25~40% 추가. Retina/4K (DPR≥1.5)
    // 에서는 pixel density 가 충분해서 AA 없이도 깨끗하게 보이므로 자동 off.
    // 저해상도 디스플레이에서만 MSAA 활성화.
    const wantAA = window.devicePixelRatio < 1.5;
    this.renderer = new THREE.WebGLRenderer({ antialias: wantAA, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    this.buildBondRenderer();
    this.buildOrbitRenderer();

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
    const count = 1800;
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
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
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
      `,
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
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vViewDir = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
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
      `,
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
        if (this.bondLines) this.bondLines.visible = visible;
        break;
      case 'boundary':
        if (this.universeMesh) this.universeMesh.visible = visible;
        if (this.universeShell) this.universeShell.visible = visible;
        break;
      case 'orbits':
        if (this.selectedOrbitLines) this.selectedOrbitLines.visible = visible;
        if (this.selectedOrbitLink) this.selectedOrbitLink.visible = visible;
        if (this.trailLines) this.trailLines.visible = visible;
        break;
      case 'galaxies':
        for (const { mesh } of this.galaxyHalos.values()) mesh.visible = visible;
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
      vertexShader: `
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
      `,
      fragmentShader: `
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
      `,
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
      vertexShader: `
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
      `,
      fragmentShader: `
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
      `,
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

  private buildBondRenderer(): void {
    const maxBonds = this.maxParticlesTotal * 4;
    const positions = new Float32Array(maxBonds * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x6688ff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    this.scene.add(lines);
    this.bondGeom = geom;
    this.bondLines = lines;
    this.bondPositions = positions;
  }

  private buildOrbitRenderer(): void {
    // Trail: actual path the selected effector has traveled, with vertex-color fade
    const trailCap = this.trailCapacity;
    const tPositions = new Float32Array(trailCap * 3);
    const tColors = new Float32Array(trailCap * 3);
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(tPositions, 3));
    trailGeom.setAttribute('color', new THREE.BufferAttribute(tColors, 3));
    trailGeom.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const trail = new THREE.Line(trailGeom, trailMat);
    trail.frustumCulled = false;
    trail.visible = this.visibility.orbits;
    this.scene.add(trail);
    this.trailLines = trail;
    this.trailGeom = trailGeom;
    this.trailPositions = tPositions;
    this.trailColors = tColors;

    const verticesPerOrbit = this.orbitSegments * 2;
    const selPositions = new Float32Array(verticesPerOrbit * 3);
    const selGeom = new THREE.BufferGeometry();
    selGeom.setAttribute('position', new THREE.BufferAttribute(selPositions, 3));
    selGeom.setDrawRange(0, 0);
    const selMat = new THREE.LineBasicMaterial({
      color: 0x6688aa,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const selLines = new THREE.LineSegments(selGeom, selMat);
    selLines.frustumCulled = false;
    selLines.visible = this.visibility.orbits;
    this.scene.add(selLines);
    this.selectedOrbitLines = selLines;
    this.selectedOrbitGeom = selGeom;
    this.selectedOrbitPositions = selPositions;

    const linkPositions = new Float32Array(2 * 3);
    const linkGeom = new THREE.BufferGeometry();
    linkGeom.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
    linkGeom.setDrawRange(0, 0);
    const linkMat = new THREE.LineDashedMaterial({
      color: 0xffd66a,
      transparent: true,
      opacity: 0.65,
      dashSize: 0.6,
      gapSize: 0.4,
      depthWrite: false,
    });
    const link = new THREE.Line(linkGeom, linkMat);
    link.frustumCulled = false;
    link.visible = this.visibility.orbits;
    this.scene.add(link);
    this.selectedOrbitLink = link;
    this.selectedOrbitLinkGeom = linkGeom;
    this.selectedOrbitLinkPositions = linkPositions;
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
  private readonly tmpL = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  // Reused per-frame scratch buffers — avoid GC churn in the 60Hz sync path.
  private readonly speciesCountsScratch: Int32Array = new Int32Array(SPECIES.length);
  private readonly aliveEffectorScratch: Set<Effector> = new Set<Effector>();
  private galaxyParentScratch: Int32Array | null = null;
  // Galaxy clustering is O(n²) on the star list — we throttle it to ~5Hz.
  // Halos are diffuse; a 200ms lag in their position/scale is imperceptible.
  private galaxyAccum = 0;
  private readonly galaxyInterval = 0.2;
  // Orbit Kepler solve and computeLineDistances are also expensive when the
  // selected body's orbit is large. Recompute the ellipse at ~10Hz; the
  // dashed connector line gets re-measured only when the host or selection
  // moved meaningfully (tracked below).
  private orbitAccum = 0;
  private readonly orbitInterval = 1 / 12;

  sync(sim: Simulator, frameDt = 1 / 60): void {
    const n = sim.count;
    this.setUniverseScale(sim.scaleFactor);

    // Build frustum FIRST so all syncs can cull against it
    this.camera.updateMatrixWorld();
    this.tmpProjView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.tmpFrustum.setFromProjectionMatrix(this.tmpProjView);

    this.syncBonds(sim);
    this.syncEffectors(sim, frameDt);
    this.orbitAccum += frameDt;
    if (this.orbitAccum >= this.orbitInterval || this.selectedEffector !== this.trailLastEffector) {
      this.orbitAccum = 0;
      this.syncOrbits(sim);
    }
    this.recordTrail(frameDt);
    this.galaxyAccum += frameDt;
    if (this.galaxyAccum >= this.galaxyInterval) {
      this.galaxyAccum = 0;
      this.syncGalaxies(sim);
    } else {
      // Cheap per-frame frustum-visibility refresh on the cached halos so
      // they pop in/out as the camera turns, without re-running clustering.
      for (const entry of this.galaxyHalos.values()) {
        this.tmpSphere.center.copy(entry.mesh.position);
        this.tmpSphere.radius = Math.max(entry.mesh.scale.x, entry.mesh.scale.y, entry.mesh.scale.z);
        entry.mesh.visible = this.visibility.galaxies && this.tmpFrustum.intersectsSphere(this.tmpSphere);
      }
    }

    if (this.renderMode === 'solid') {
      const counts = this.speciesCountsScratch;
      const countsLo = this.speciesCountsLoScratch;
      counts.fill(0);
      countsLo.fill(0);
      // pixelSize ≈ radius * projScaleY / dist. Threshold of 6px is the
      // empirically-found knee where icosa subdivision stops being visible
      // on a typical desktop monitor at default DPR. Squared for cheap
      // comparison: (radius * projScaleY) ² < THRESH² * dist².
      const lodPixelThresh = 6.0;
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

  private syncBonds(sim: Simulator): void {
    if (!this.bondGeom || !this.bondPositions) return;
    const m = sim.bondListLength;
    const cap = this.bondPositions.length / 6;
    const k = Math.min(m, cap);
    for (let b = 0; b < k; b++) {
      const i = sim.getBondVertex(b, 'i');
      const j = sim.getBondVertex(b, 'j');
      const off = b * 6;
      this.bondPositions[off + 0] = sim.positions[i * 3 + 0];
      this.bondPositions[off + 1] = sim.positions[i * 3 + 1];
      this.bondPositions[off + 2] = sim.positions[i * 3 + 2];
      this.bondPositions[off + 3] = sim.positions[j * 3 + 0];
      this.bondPositions[off + 4] = sim.positions[j * 3 + 1];
      this.bondPositions[off + 5] = sim.positions[j * 3 + 2];
    }
    this.bondGeom.setDrawRange(0, k * 2);
    (this.bondGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
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

  private recordTrail(dt: number): void {
    if (!this.trailGeom || !this.trailPositions || !this.trailColors || !this.trailLines) return;
    const sel = this.selectedEffector;
    if (!this.visibility.orbits || !sel) {
      this.trailGeom.setDrawRange(0, 0);
      this.trailLastEffector = null;
      this.trailCount = 0;
      this.trailWriteIdx = 0;
      return;
    }
    if (sel !== this.trailLastEffector) {
      this.trailCount = 0;
      this.trailWriteIdx = 0;
      this.trailLastEffector = sel;
      this.trailSampleAccum = 0;
    }
    this.trailSampleAccum += dt;
    if (this.trailSampleAccum < this.trailSampleInterval && this.trailCount > 0) {
      // still draw existing trail with updated last-segment to current position
      this.drawTrailBuffer(sel);
      return;
    }
    this.trailSampleAccum = 0;
    // Push current position into ring buffer
    const idx = this.trailWriteIdx;
    this.trailPositions[idx * 3 + 0] = sel.x;
    this.trailPositions[idx * 3 + 1] = sel.y;
    this.trailPositions[idx * 3 + 2] = sel.z;
    this.trailWriteIdx = (idx + 1) % this.trailCapacity;
    if (this.trailCount < this.trailCapacity) this.trailCount++;
    this.drawTrailBuffer(sel);
  }

  private drawTrailBuffer(sel: Effector): void {
    if (!this.trailGeom || !this.trailPositions || !this.trailColors) return;
    const cap = this.trailCapacity;
    const count = this.trailCount;
    // Order from oldest to newest into a linear position attribute
    // Use a temporary linear buffer in this.trailPositions via re-ordering? Too expensive.
    // Instead: write linear vertex order directly each frame from the ring.
    // Three.js Line draws in attribute order, so we need contiguous linear data.
    // Allocate a transient view — we keep the ring buffer for positions and copy to a contiguous array here.
    const linear = this._trailLinearScratch ??= new Float32Array(this.trailCapacity * 3);
    const colors = this.trailColors;
    const start = (this.trailWriteIdx - count + cap) % cap;
    for (let i = 0; i < count; i++) {
      const r = (start + i) % cap;
      linear[i * 3 + 0] = this.trailPositions[r * 3 + 0];
      linear[i * 3 + 1] = this.trailPositions[r * 3 + 1];
      linear[i * 3 + 2] = this.trailPositions[r * 3 + 2];
      // Fade: oldest dim, newest bright (warm gold)
      const t = count > 1 ? i / (count - 1) : 1;
      const a = t * t; // ease-in for tail
      colors[i * 3 + 0] = 1.0 * a;
      colors[i * 3 + 1] = 0.84 * a;
      colors[i * 3 + 2] = 0.42 * a;
    }
    // Append current position so the trail reaches the live effector
    if (count < cap) {
      linear[count * 3 + 0] = sel.x;
      linear[count * 3 + 1] = sel.y;
      linear[count * 3 + 2] = sel.z;
      colors[count * 3 + 0] = 1.0;
      colors[count * 3 + 1] = 0.85;
      colors[count * 3 + 2] = 0.5;
    }
    const posAttr = this.trailGeom.getAttribute('position') as THREE.BufferAttribute;
    (posAttr.array as Float32Array).set(linear);
    posAttr.needsUpdate = true;
    (this.trailGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.trailGeom.setDrawRange(0, Math.min(cap, count + 1));
  }

  private _trailLinearScratch: Float32Array | null = null;

  // Galaxy = a gravitationally-associated cluster of stars (with optional
  // central/embedded BHs). Detected via union-find linkage: two stars are
  // linked if within `galaxyLinkRadius` of each other. A connected component
  // of >= `galaxyMinStars` is rendered as a single diffuse halo. This drops
  // the previous "halo per BH" assumption (real galaxies don't need a BH,
  // and post-merger galaxies have multiple BHs inside one halo).
  //
  // linkRadius widened to capture loose stellar associations (real dwarf
  // galaxies span ~kpc with stars sparsely placed). minStars dropped to 3
  // so small clusters still register as a halo.
  private readonly galaxyLinkRadius = 18;
  private readonly galaxyMinStars = 3;
  private syncGalaxies(sim: Simulator): void {
    const stars: Effector[] = [];
    const bhs: Effector[] = [];
    for (const e of sim.effectors) {
      if (e.type === 'star') stars.push(e);
      else if (e.type === 'blackhole') bhs.push(e);
    }

    // Find seen halo IDs this frame so we can reap stale ones at the end
    const seenIds = new Set<string>();

    if (stars.length >= this.galaxyMinStars) {
      const n = stars.length;
      if (!this.galaxyParentScratch || this.galaxyParentScratch.length < n) {
        // Grow with headroom so we don't realloc on every minor star count bump.
        this.galaxyParentScratch = new Int32Array(Math.max(n * 2, 32));
      }
      const parent = this.galaxyParentScratch;
      for (let i = 0; i < n; i++) parent[i] = i;
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const linkR2 = this.galaxyLinkRadius * this.galaxyLinkRadius;
      for (let i = 0; i < n; i++) {
        const a = stars[i];
        for (let j = i + 1; j < n; j++) {
          const b = stars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          if (dx * dx + dy * dy + dz * dz < linkR2) {
            const ra = find(i), rb = find(j);
            if (ra !== rb) parent[ra] = rb;
          }
        }
      }

      const components = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        const list = components.get(r);
        if (list) list.push(i); else components.set(r, [i]);
      }

      for (const [, memberIdx] of components) {
        if (memberIdx.length < this.galaxyMinStars) continue;

        // Stable ID = oldest member's birth time (galaxies don't lose identity
        // when newer members join or old peripheral members drift away).
        let oldest = stars[memberIdx[0]];
        for (const i of memberIdx) {
          if (stars[i].bornAt < oldest.bornAt) oldest = stars[i];
        }
        const id = `g-${Math.round(oldest.bornAt * 1000)}-${oldest.name ?? ''}`;
        seenIds.add(id);

        // Mass-weighted COM
        let cx = 0, cy = 0, cz = 0, totM = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          cx += s.x * s.strength;
          cy += s.y * s.strength;
          cz += s.z * s.strength;
          totM += s.strength;
        }
        if (totM <= 0) continue;
        cx /= totM; cy /= totM; cz /= totM;

        // Include nearby BHs in COM (they sit at galactic centers) and let
        // them contribute to the halo extent — a post-merger galaxy with
        // multiple BHs still reads as one halo.
        const localBhs: Effector[] = [];
        let bhM = 0;
        for (const bh of bhs) {
          const dx = bh.x - cx, dy = bh.y - cy, dz = bh.z - cz;
          if (dx * dx + dy * dy + dz * dz < linkR2 * 2.25) {
            localBhs.push(bh);
            bhM += bh.strength;
          }
        }
        if (localBhs.length > 0) {
          // Re-center using BH mass too
          let ncx = cx * totM, ncy = cy * totM, ncz = cz * totM;
          for (const bh of localBhs) {
            ncx += bh.x * bh.strength;
            ncy += bh.y * bh.strength;
            ncz += bh.z * bh.strength;
          }
          const total = totM + bhM;
          cx = ncx / total; cy = ncy / total; cz = ncz / total;
        }

        // Radius = RMS distance of stars from COM, with a min floor.
        // RMS is robust against single eccentric-orbit outliers (vs. max).
        let sumR2 = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          const dx = s.x - cx;
          const dy = s.y - cy;
          const dz = s.z - cz;
          sumR2 += dx * dx + dy * dy + dz * dz;
        }
        const rmsR = Math.sqrt(sumR2 / memberIdx.length);
        const radius = Math.max(3.0, rmsR * 1.6 + 1.5);

        // Bulk velocity (mass-weighted) so we measure rotation in the COM frame
        let bvx = 0, bvy = 0, bvz = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          bvx += s.vx * s.strength;
          bvy += s.vy * s.strength;
          bvz += s.vz * s.strength;
        }
        bvx /= totM; bvy /= totM; bvz /= totM;

        // Angular momentum L = Σ m·(r × v) about COM. Disks have large coherent
        // L; elliptical/random-motion systems have |L| ~ 0.
        let Lx = 0, Ly = 0, Lz = 0;
        for (const i of memberIdx) {
          const s = stars[i];
          const rx = s.x - cx, ry = s.y - cy, rz = s.z - cz;
          const vx = s.vx - bvx, vy = s.vy - bvy, vz = s.vz - bvz;
          Lx += s.strength * (ry * vz - rz * vy);
          Ly += s.strength * (rz * vx - rx * vz);
          Lz += s.strength * (rx * vy - ry * vx);
        }
        const Lmag = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);

        // Rotational support ≈ |L| / (M · R · σ_v). We approximate σ_v with the
        // halo's RMS extent in lieu of a separate velocity-dispersion calc.
        // Large value → disk; small → spheroidal.
        const rotSupport = Lmag / Math.max(totM * radius, 1e-3);
        const flatness = Math.min(0.65, Math.max(0, rotSupport * 0.45));
        const polarR = radius * (1 - flatness);

        let entry = this.galaxyHalos.get(id);
        if (!entry) {
          const hue = (this.hashGalaxyId(id) % 360) / 360;
          const color = new THREE.Color().setHSL(hue, 0.55, 0.55);
          entry = this.createGalaxyHalo(color);
          this.galaxyHalos.set(id, entry);
        }
        entry.mesh.position.set(cx, cy, cz);

        // Align mesh's Y axis with the L vector so the oblate scaling
        // (radius, polarR, radius) sits perpendicular to the rotation axis.
        if (Lmag > 1e-3) {
          const inv = 1 / Lmag;
          this.tmpL.set(Lx * inv, Ly * inv, Lz * inv);
          entry.mesh.quaternion.setFromUnitVectors(this.tmpUp, this.tmpL);
        } else {
          entry.mesh.quaternion.identity();
        }
        entry.mesh.scale.set(radius, polarR, radius);

        this.tmpSphere.center.set(cx, cy, cz);
        this.tmpSphere.radius = radius;
        entry.mesh.visible = this.visibility.galaxies && this.tmpFrustum.intersectsSphere(this.tmpSphere);
      }
    }

    for (const [id, entry] of this.galaxyHalos) {
      if (!seenIds.has(id)) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mat.dispose();
        this.galaxyHalos.delete(id);
      }
    }
  }

  private createGalaxyHalo(color: THREE.Color): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
    const geo = new THREE.SphereGeometry(1, 32, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: color } },
      vertexShader: `
        varying vec3 vN; varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vN; varying vec3 vView;
        uniform vec3 uColor;
        void main() {
          float facing = abs(dot(vN, vView));
          float interior = 0.06 * (0.5 + 0.5 * facing);
          float rim = pow(1.0 - facing, 2.2) * 0.40;
          gl_FragColor = vec4(uColor, interior + rim);
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = this.visibility.galaxies;
    this.scene.add(mesh);
    return { mesh, mat };
  }

  private hashGalaxyId(id: string): number {
    let h = 5381;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
    }
    return h & 0xffffff;
  }

  private syncOrbits(sim: Simulator): void {
    if (!this.selectedOrbitGeom || !this.selectedOrbitPositions) return;
    const haveLink = !!(this.selectedOrbitLink && this.selectedOrbitLinkGeom && this.selectedOrbitLinkPositions);

    const clearAll = () => {
      this.selectedOrbitGeom!.setDrawRange(0, 0);
      if (haveLink) this.selectedOrbitLinkGeom!.setDrawRange(0, 0);
    };

    if (!this.visibility.orbits) { clearAll(); return; }
    const sel = this.selectedEffector;
    if (!sel || (sel.type !== 'star' && sel.type !== 'blackhole' && sel.type !== 'neutron_star')) {
      clearAll();
      return;
    }

    // Anything massive can act as a Kepler host — light BHs and NS still pull.
    const massive: Effector[] = [];
    for (const e of sim.effectors) {
      if (e === sel) continue;
      if (e.type === 'blackhole' || e.type === 'star' || e.type === 'neutron_star') {
        massive.push(e);
      }
    }

    const G = sim.effectorPairG;

    // The effective central GM should include the diffuse DM halo + gas the
    // body actually feels through Barnes-Hut self-gravity, not just the point
    // mass of a single companion. We add an "environment boost" proportional
    // to selfGravity so deeply-embedded bodies get a sensible orbit even
    // when their pointmass companion is weak.
    //
    // Plus a Hubble-expansion compensation factor: lab-frame separation grew
    // by effectorScaleFactor since Dark Energy began, which made PE = -GM/r
    // shrink. Boost GM by the same factor so previously-bound orbits remain
    // recognized as bound in the Kepler predictor.
    const envBoost = (sim.selfGravity > 0 ? 1.0 + sim.selfGravity * 1.5 : 1.0)
                   * sim.effectorScaleFactor;

    let host: { x: number; y: number; z: number } | null = null;
    let hostGM = 0, hostEnergy = 0;
    let hostRx = 0, hostRy = 0, hostRz = 0;
    let hostVx = 0, hostVy = 0, hostVz = 0;
    let hostRMag = 0;

    // Pass 1: any individual heavier body that produces a bound orbit.
    for (const m of massive) {
      if (m.strength < sel.strength * 0.5) continue; // need at least half our mass
      const rxB = sel.x - m.x;
      const ryB = sel.y - m.y;
      const rzB = sel.z - m.z;
      const rMagB = Math.sqrt(rxB * rxB + ryB * ryB + rzB * rzB);
      if (rMagB < 1e-3) continue;
      const vxB = sel.vx - m.vx;
      const vyB = sel.vy - m.vy;
      const vzB = sel.vz - m.vz;
      const v2B = vxB * vxB + vyB * vyB + vzB * vzB;
      const GMB = G * m.strength * envBoost;
      const eB = 0.5 * v2B - GMB / rMagB;
      if (eB >= 0) continue;
      if (!host || eB < hostEnergy) {
        host = m;
        hostEnergy = eB; hostGM = GMB;
        hostRx = rxB; hostRy = ryB; hostRz = rzB;
        hostVx = vxB; hostVy = vyB; hostVz = vzB;
        hostRMag = rMagB;
      }
    }

    // Pass 2 (fallback): cluster center of mass. Works even with a single
    // companion, and lets dwarf clusters / DM-bound stars show an orbit.
    if (!host && massive.length >= 1) {
      let mx = 0, my = 0, mz = 0, mvx = 0, mvy = 0, mvz = 0, totM = 0;
      for (const m of massive) {
        mx += m.x * m.strength;
        my += m.y * m.strength;
        mz += m.z * m.strength;
        mvx += m.vx * m.strength;
        mvy += m.vy * m.strength;
        mvz += m.vz * m.strength;
        totM += m.strength;
      }
      if (totM > 0) {
        mx /= totM; my /= totM; mz /= totM;
        mvx /= totM; mvy /= totM; mvz /= totM;
        const rxC = sel.x - mx;
        const ryC = sel.y - my;
        const rzC = sel.z - mz;
        const rMagC = Math.sqrt(rxC * rxC + ryC * ryC + rzC * rzC);
        if (rMagC > 1e-3) {
          const vxC = sel.vx - mvx;
          const vyC = sel.vy - mvy;
          const vzC = sel.vz - mvz;
          const v2C = vxC * vxC + vyC * vyC + vzC * vzC;
          // Inflate GM by the env boost too — bodies orbit the cluster +
          // its embedded DM halo, not just visible stars.
          const GMC = G * totM * envBoost * 1.3;
          const eC = 0.5 * v2C - GMC / rMagC;
          if (eC < 0) {
            host = { x: mx, y: my, z: mz };
            hostEnergy = eC; hostGM = GMC;
            hostRx = rxC; hostRy = ryC; hostRz = rzC;
            hostVx = vxC; hostVy = vyC; hostVz = vzC;
            hostRMag = rMagC;
          }
        }
      }
    }

    // No bound system found — body is unbound or in free streaming. The
    // recorded trail (drawn by recordTrail) is the only valid indicator.
    if (!host) { clearAll(); return; }

    const GM = hostGM;
    const rx = hostRx, ry = hostRy, rz = hostRz;
    const vx = hostVx, vy = hostVy, vz = hostVz;
    const rMag = hostRMag;
    const a = -GM / (2 * hostEnergy);

    const Lx = ry * vz - rz * vy;
    const Ly = rz * vx - rx * vz;
    const Lz = rx * vy - ry * vx;
    if (Lx * Lx + Ly * Ly + Lz * Lz < 1e-6) { clearAll(); return; }

    const evx = (vy * Lz - vz * Ly) / GM - rx / rMag;
    const evy = (vz * Lx - vx * Lz) / GM - ry / rMag;
    const evz = (vx * Ly - vy * Lx) / GM - rz / rMag;
    const e = Math.sqrt(evx * evx + evy * evy + evz * evz);
    // Allow highly eccentric orbits — only reject literally unbound.
    if (e >= 0.99) { clearAll(); return; }

    const eHatX = e > 1e-6 ? evx / e : rx / rMag;
    const eHatY = e > 1e-6 ? evy / e : ry / rMag;
    const eHatZ = e > 1e-6 ? evz / e : rz / rMag;
    const pPx = Ly * eHatZ - Lz * eHatY;
    const pPy = Lz * eHatX - Lx * eHatZ;
    const pPz = Lx * eHatY - Ly * eHatX;
    const pMag = Math.sqrt(pPx * pPx + pPy * pPy + pPz * pPz);
    if (pMag < 1e-6) { clearAll(); return; }
    const perpX = pPx / pMag;
    const perpY = pPy / pMag;
    const perpZ = pPz / pMag;

    const segments = this.orbitSegments;
    const semiLatus = a * (1 - e * e);
    const selPositions = this.selectedOrbitPositions;
    let write = 0;
    let prevX = 0, prevY = 0, prevZ = 0;
    for (let i = 0; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;
      const r = semiLatus / (1 + e * Math.cos(theta));
      const cT = Math.cos(theta);
      const sT = Math.sin(theta);
      const x = host.x + r * (cT * eHatX + sT * perpX);
      const y = host.y + r * (cT * eHatY + sT * perpY);
      const z = host.z + r * (cT * eHatZ + sT * perpZ);
      if (i > 0 && write + 1 < segments * 2) {
        selPositions[write * 3 + 0] = prevX;
        selPositions[write * 3 + 1] = prevY;
        selPositions[write * 3 + 2] = prevZ;
        write++;
        selPositions[write * 3 + 0] = x;
        selPositions[write * 3 + 1] = y;
        selPositions[write * 3 + 2] = z;
        write++;
      }
      prevX = x; prevY = y; prevZ = z;
    }
    this.selectedOrbitGeom.setDrawRange(0, write);
    (this.selectedOrbitGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    if (haveLink) {
      const p = this.selectedOrbitLinkPositions!;
      p[0] = sel.x; p[1] = sel.y; p[2] = sel.z;
      p[3] = host.x; p[4] = host.y; p[5] = host.z;
      this.selectedOrbitLinkGeom!.setDrawRange(0, 2);
      (this.selectedOrbitLinkGeom!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.selectedOrbitLink!.computeLineDistances();
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
    let coreColor: number;
    let coreVisible = true;
    let fragmentShader: string;

    switch (type) {
      case 'blackhole':
        coreColor = 0x000000;
        fragmentShader = `
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
        `;
        break;
      case 'star':
        coreColor = 0xffe89a;
        fragmentShader = `
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
        `;
        break;
      case 'repulsor':
        coreColor = 0xff6644;
        fragmentShader = `
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
        `;
        break;
      case 'freezer':
        coreColor = 0xaaddff;
        coreVisible = false;
        fragmentShader = `
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
        `;
        break;
      case 'neutron_star':
        coreColor = 0xcceeff;
        coreVisible = false;
        fragmentShader = `
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
        `;
        break;
      case 'nebula':
        coreColor = 0xff88aa;
        coreVisible = false;
        fragmentShader = `
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
        `;
        break;
    }

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
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
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
  private readonly basePixelRatio = Math.min(window.devicePixelRatio, 2);
  private currentPixelRatio = Math.min(window.devicePixelRatio, 2);
  private dprDownAccum = 0;
  private dprUpAccum = 0;
  /** Called once per second-ish with the rolling FPS measurement. */
  adaptPixelRatio(fps: number, dt: number): void {
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
