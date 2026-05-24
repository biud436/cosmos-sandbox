import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SPECIES } from '../physics/types';
import { Effector, EffectorType, Simulator } from '../physics/Simulator';

export class Scene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly boxHalf: number;
  private readonly speciesMeshes: THREE.InstancedMesh[] = [];
  private readonly speciesCapacity: number[];
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
  };
  private galaxyHalos = new Map<Effector, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  private orbitLines: THREE.LineSegments | null = null;
  private orbitGeom: THREE.BufferGeometry | null = null;
  private orbitPositions: Float32Array | null = null;
  private selectedOrbitLines: THREE.LineSegments | null = null;
  private selectedOrbitGeom: THREE.BufferGeometry | null = null;
  private selectedOrbitPositions: Float32Array | null = null;
  private selectedOrbitLink: THREE.Line | null = null;
  private selectedOrbitLinkGeom: THREE.BufferGeometry | null = null;
  private selectedOrbitLinkPositions: Float32Array | null = null;
  private orbitSegments = 64;
  private orbitMaxStars = 300;
  private orbitFrameCounter = 0;
  private bondPositions: Float32Array | null = null;
  private effectorViews = new Map<Effector, { group: THREE.Group; mat: THREE.ShaderMaterial; selectionRing: THREE.Mesh; influenceRing: THREE.Mesh | null }>();
  private effectorClock = 0;
  private selectedEffector: Effector | null = null;
  private renderMode: 'solid' | 'gas' = 'solid';
  private gasPoints: THREE.Points | null = null;
  private gasGeom: THREE.BufferGeometry | null = null;
  private gasPositions: Float32Array | null = null;
  private gasColors: Float32Array | null = null;
  private gasSizes: Float32Array | null = null;
  private readonly maxParticlesTotal: number;

  constructor(container: HTMLElement, boxHalf: number, maxPerSpecies: number) {
    this.boxHalf = boxHalf;
    this.speciesCapacity = SPECIES.map(() => maxPerSpecies);
    this.maxParticlesTotal = maxPerSpecies * SPECIES.length;

    this.scene = new THREE.Scene();
    this.scene.background = this.makeGradientBackground();

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, boxHalf * 80);
    this.camera.position.set(boxHalf * 1.6, boxHalf * 1.1, boxHalf * 1.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
  }

  private makeGradientBackground(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0.0, '#0a0b18');
    g.addColorStop(0.4, '#0c0a1e');
    g.addColorStop(0.7, '#08070f');
    g.addColorStop(1.0, '#02020a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildStarfield(): void {
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
    this.scene.add(stars);

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
    this.scene.add(nebula);
  }

  private buildUniverseBoundary(): void {
    const R = this.boxHalf;
    const cubeGeo = new THREE.BoxGeometry(R * 2, R * 2, R * 2);
    const edgesGeo = new THREE.EdgesGeometry(cubeGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x44ddff,
      transparent: true,
      opacity: 0.25,
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
          float a = pow(rim, 4.0) * 0.18;
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
        if (this.gasPoints) this.gasPoints.visible = visible && this.renderMode === 'gas';
        break;
      case 'bonds':
        if (this.bondLines) this.bondLines.visible = visible;
        break;
      case 'boundary':
        if (this.universeMesh) this.universeMesh.visible = visible;
        if (this.universeShell) this.universeShell.visible = visible;
        break;
      case 'orbits':
        if (this.orbitLines) this.orbitLines.visible = visible;
        if (this.selectedOrbitLines) this.selectedOrbitLines.visible = visible;
        if (this.selectedOrbitLink) this.selectedOrbitLink.visible = visible;
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
      uniforms: { uPixelScale: { value: this.renderer.getPixelRatio() * window.innerHeight * 0.5 } },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        uniform float uPixelScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (uPixelScale / max(-mv.z, 0.001));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float d2 = dot(uv, uv);
          if (d2 > 1.0) discard;
          float core = exp(-d2 * 4.0);
          float halo = exp(-d2 * 1.4) * 0.45;
          float a = core + halo;
          gl_FragColor = vec4(vColor * a, a);
        }
      `,
    });

    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.visible = false;
    this.scene.add(points);

    this.gasGeom = geom;
    this.gasPoints = points;
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
    const verticesPerOrbit = this.orbitSegments * 2;
    const cap = this.orbitMaxStars * verticesPerOrbit * 3;
    const positions = new Float32Array(cap);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x4477aa,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.visible = this.visibility.orbits;
    this.scene.add(lines);
    this.orbitLines = lines;
    this.orbitGeom = geom;
    this.orbitPositions = positions;

    const selPositions = new Float32Array(verticesPerOrbit * 3);
    const selGeom = new THREE.BufferGeometry();
    selGeom.setAttribute('position', new THREE.BufferAttribute(selPositions, 3));
    selGeom.setDrawRange(0, 0);
    const selMat = new THREE.LineBasicMaterial({
      color: 0xffd66a,
      transparent: true,
      opacity: 0.95,
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
    if (this.gasPoints) this.gasPoints.visible = show && !useSolid;
  }

  setEnvironmentVisible(visible: boolean): void {
    if (this.boxMesh) this.boxMesh.visible = visible;
    if (this.gridMesh) this.gridMesh.visible = visible;
  }

  private buildParticleMeshes(): void {
    const sphereGeo = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < SPECIES.length; i++) {
      const species = SPECIES[i];
      const mat = new THREE.MeshBasicMaterial({ color: species.color });
      const mesh = new THREE.InstancedMesh(sphereGeo, mat, this.speciesCapacity[i]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.speciesMeshes.push(mesh);
    }
  }

  private readonly tmpFrustum = new THREE.Frustum();
  private readonly tmpProjView = new THREE.Matrix4();
  private readonly tmpSphere = new THREE.Sphere();

  sync(sim: Simulator, frameDt = 1 / 60): void {
    const n = sim.count;
    this.setUniverseScale(sim.scaleFactor);
    this.syncBonds(sim);
    this.syncEffectors(sim, frameDt);
    this.syncOrbits(sim);
    this.syncGalaxies(sim);

    this.camera.updateMatrixWorld();
    this.tmpProjView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.tmpFrustum.setFromProjectionMatrix(this.tmpProjView);

    if (this.renderMode === 'solid') {
      const counts = new Int32Array(SPECIES.length);
      for (let i = 0; i < n; i++) {
        const s = sim.species[i];
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        const radius = SPECIES[s].sigma * 1.1;
        this.tmpSphere.center.set(px, py, pz);
        this.tmpSphere.radius = radius;
        if (!this.tmpFrustum.intersectsSphere(this.tmpSphere)) continue;
        const slot = counts[s]++;
        if (slot >= this.speciesCapacity[s]) continue;
        this.tmpMat.makeScale(radius, radius, radius);
        this.tmpMat.setPosition(px, py, pz);
        this.speciesMeshes[s].setMatrixAt(slot, this.tmpMat);
      }
      for (let s = 0; s < SPECIES.length; s++) {
        this.speciesMeshes[s].count = counts[s];
        this.speciesMeshes[s].instanceMatrix.needsUpdate = true;
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
        const dim = isDM ? 0.55 : 1.0;
        this.gasColors[write * 3 + 0] = r * dim;
        this.gasColors[write * 3 + 1] = g * dim;
        this.gasColors[write * 3 + 2] = b * dim;
        this.gasSizes[write] = sp.sigma * (isDM ? 5.8 : 4.5);
        write++;
      }
      this.gasGeom.setDrawRange(0, write);
      (this.gasGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.gasGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      (this.gasGeom.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
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
    }
  }

  private syncGalaxies(sim: Simulator): void {
    const stars: Effector[] = [];
    const bhs: Effector[] = [];
    for (const e of sim.effectors) {
      if (e.type === 'star') stars.push(e);
      else if (e.type === 'blackhole') bhs.push(e);
    }
    const alive = new Set<Effector>(bhs);

    const maxR = new Map<Effector, number>();
    const starCount = new Map<Effector, number>();
    for (const s of stars) {
      let host: Effector | null = null;
      let bestD2 = Infinity;
      for (const bh of bhs) {
        if (bh.strength < s.strength * 1.5) continue;
        const dx = s.x - bh.x;
        const dy = s.y - bh.y;
        const dz = s.z - bh.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          host = bh;
        }
      }
      if (!host) continue;
      const r = Math.sqrt(bestD2);
      const cur = maxR.get(host) ?? 0;
      if (r > cur) maxR.set(host, r);
      starCount.set(host, (starCount.get(host) ?? 0) + 1);
    }

    for (const bh of bhs) {
      const count = starCount.get(bh) ?? 0;
      if (count < 3) {
        const existing = this.galaxyHalos.get(bh);
        if (existing) {
          this.scene.remove(existing.mesh);
          this.galaxyHalos.delete(bh);
        }
        continue;
      }
      let entry = this.galaxyHalos.get(bh);
      if (!entry) {
        const hue = (this.hashEffector(bh) % 360) / 360;
        const color = new THREE.Color().setHSL(hue, 0.55, 0.55);
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
        entry = { mesh, mat };
        this.galaxyHalos.set(bh, entry);
      }
      entry.mesh.position.set(bh.x, bh.y, bh.z);
      const radius = Math.max(2.5, (maxR.get(bh) ?? 4) * 1.15);
      entry.mesh.scale.setScalar(radius);
    }

    for (const [bh, entry] of this.galaxyHalos) {
      if (!alive.has(bh)) {
        this.scene.remove(entry.mesh);
        this.galaxyHalos.delete(bh);
      }
    }
  }

  private hashEffector(e: Effector): number {
    const k = Math.floor(e.bornAt * 1000) ^ Math.floor((e.x + 100) * 13) ^ Math.floor((e.y + 100) * 31);
    return ((k * 2654435761) >>> 0) & 0xffffff;
  }

  private syncOrbits(sim: Simulator): void {
    if (!this.visibility.orbits || !this.orbitGeom || !this.orbitPositions || !this.orbitLines) return;
    this.orbitFrameCounter++;
    if (this.orbitFrameCounter % 6 !== 0) return;

    const bhs: Effector[] = [];
    for (const e of sim.effectors) if (e.type === 'blackhole') bhs.push(e);

    const G = sim.effectorPairG;
    const segments = this.orbitSegments;
    const positions = this.orbitPositions;
    const selPositions = this.selectedOrbitPositions;
    let writeVertex = 0;
    let selWriteVertex = 0;
    const maxVerts = this.orbitMaxStars * segments * 2;
    const selMaxVerts = segments * 2;
    let selectedHost: Effector | null = null;
    let selectedStar: Effector | null = null;

    for (const star of sim.effectors) {
      if (star.type !== 'star') continue;
      const isSelected = star === this.selectedEffector;
      if (!isSelected && writeVertex >= maxVerts) continue;

      let host: Effector | null = null;
      let bestD2 = Infinity;
      for (const bh of bhs) {
        if (bh.strength < star.strength * 1.5) continue;
        const dx = star.x - bh.x;
        const dy = star.y - bh.y;
        const dz = star.z - bh.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          host = bh;
        }
      }
      if (!host) continue;

      const GM = G * host.strength;
      const rx = star.x - host.x;
      const ry = star.y - host.y;
      const rz = star.z - host.z;
      const vx = star.vx - host.vx;
      const vy = star.vy - host.vy;
      const vz = star.vz - host.vz;
      const rMag = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rMag < 1e-3) continue;
      const v2 = vx * vx + vy * vy + vz * vz;
      const energy = 0.5 * v2 - GM / rMag;
      if (energy >= 0) continue;
      const a = -GM / (2 * energy);

      const Lx = ry * vz - rz * vy;
      const Ly = rz * vx - rx * vz;
      const Lz = rx * vy - ry * vx;
      const L2 = Lx * Lx + Ly * Ly + Lz * Lz;
      if (L2 < 1e-6) continue;

      const evx = (vy * Lz - vz * Ly) / GM - rx / rMag;
      const evy = (vz * Lx - vx * Lz) / GM - ry / rMag;
      const evz = (vx * Ly - vy * Lx) / GM - rz / rMag;
      const e = Math.sqrt(evx * evx + evy * evy + evz * evz);
      if (e >= 0.97) continue;

      const eHatX = e > 1e-6 ? evx / e : rx / rMag;
      const eHatY = e > 1e-6 ? evy / e : ry / rMag;
      const eHatZ = e > 1e-6 ? evz / e : rz / rMag;
      const pPx = Ly * eHatZ - Lz * eHatY;
      const pPy = Lz * eHatX - Lx * eHatZ;
      const pPz = Lx * eHatY - Ly * eHatX;
      const pMag = Math.sqrt(pPx * pPx + pPy * pPy + pPz * pPz);
      if (pMag < 1e-6) continue;
      const perpX = pPx / pMag;
      const perpY = pPy / pMag;
      const perpZ = pPz / pMag;

      const semiLatus = a * (1 - e * e);
      let prevX = 0, prevY = 0, prevZ = 0;
      const writeToMain = writeVertex < maxVerts;
      for (let i = 0; i <= segments; i++) {
        const theta = (2 * Math.PI * i) / segments;
        const r = semiLatus / (1 + e * Math.cos(theta));
        const cT = Math.cos(theta);
        const sT = Math.sin(theta);
        const x = host.x + r * (cT * eHatX + sT * perpX);
        const y = host.y + r * (cT * eHatY + sT * perpY);
        const z = host.z + r * (cT * eHatZ + sT * perpZ);
        if (i > 0) {
          if (writeToMain && writeVertex + 1 < maxVerts) {
            positions[writeVertex * 3 + 0] = prevX;
            positions[writeVertex * 3 + 1] = prevY;
            positions[writeVertex * 3 + 2] = prevZ;
            writeVertex++;
            positions[writeVertex * 3 + 0] = x;
            positions[writeVertex * 3 + 1] = y;
            positions[writeVertex * 3 + 2] = z;
            writeVertex++;
          }
          if (isSelected && selPositions && selWriteVertex + 1 < selMaxVerts) {
            selPositions[selWriteVertex * 3 + 0] = prevX;
            selPositions[selWriteVertex * 3 + 1] = prevY;
            selPositions[selWriteVertex * 3 + 2] = prevZ;
            selWriteVertex++;
            selPositions[selWriteVertex * 3 + 0] = x;
            selPositions[selWriteVertex * 3 + 1] = y;
            selPositions[selWriteVertex * 3 + 2] = z;
            selWriteVertex++;
          }
        }
        prevX = x; prevY = y; prevZ = z;
      }
      if (isSelected) {
        selectedHost = host;
        selectedStar = star;
      }
    }

    this.orbitGeom.setDrawRange(0, writeVertex);
    (this.orbitGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    if (this.selectedOrbitGeom) {
      this.selectedOrbitGeom.setDrawRange(0, selWriteVertex);
      (this.selectedOrbitGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.selectedOrbitLink && this.selectedOrbitLinkGeom && this.selectedOrbitLinkPositions) {
      if (selectedStar && selectedHost) {
        const p = this.selectedOrbitLinkPositions;
        p[0] = selectedStar.x; p[1] = selectedStar.y; p[2] = selectedStar.z;
        p[3] = selectedHost.x; p[4] = selectedHost.y; p[5] = selectedHost.z;
        this.selectedOrbitLinkGeom.setDrawRange(0, 2);
        (this.selectedOrbitLinkGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        this.selectedOrbitLink.computeLineDistances();
      } else {
        this.selectedOrbitLinkGeom.setDrawRange(0, 0);
      }
    }
  }

  private syncEffectors(sim: Simulator, frameDt: number): void {
    this.effectorClock += frameDt;
    const alive = new Set(sim.effectors);
    for (const [eff, view] of this.effectorViews) {
      if (!alive.has(eff)) {
        this.scene.remove(view.group);
        this.effectorViews.delete(eff);
      }
    }
    for (const eff of sim.effectors) {
      let view = this.effectorViews.get(eff);
      if (!view) {
        view = this.createEffectorView(eff.type);
        this.effectorViews.set(eff, view);
      }
      const typeVisible = this.visibility[this.visibilityKeyFor(eff.type)];
      view.group.visible = typeVisible;
      if (!typeVisible) continue;
      view.group.position.set(eff.x, eff.y, eff.z);
      const scaleBoost = eff.type === 'star' ? 1.8 : eff.type === 'blackhole' ? 3.2 : 1.0;
      view.group.scale.setScalar(eff.radius * scaleBoost);
      view.group.lookAt(this.camera.position);
      view.mat.uniforms.uTime.value = this.effectorClock;
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
          void main() {
            vec2 c = vUv * 2.0 - 1.0;
            float r = length(c);
            if (r > 1.0 || r < 0.55) discard;
            float a = atan(c.y, c.x);
            float swirl = sin(a * 5.0 - uTime * 4.0 + (1.0 - r) * 14.0);
            float band = smoothstep(0.55, 0.62, r) * smoothstep(1.0, 0.92, r);
            vec3 hot = vec3(1.0, 0.85, 0.55);
            vec3 cool = vec3(1.0, 0.45, 0.15);
            vec3 col = mix(cool, hot, swirl * 0.5 + 0.5);
            gl_FragColor = vec4(col * (1.4 + swirl * 0.4), band * (0.85 + 0.15 * swirl));
          }
        `;
        break;
      case 'star':
        coreColor = 0xffe89a;
        fragmentShader = `
          varying vec2 vUv;
          uniform float uTime;
          void main() {
            vec2 c = vUv * 2.0 - 1.0;
            float r = length(c);
            if (r > 1.0) discard;
            float a = atan(c.y, c.x);
            float rays = abs(sin(a * 6.0 + uTime * 0.4)) * 0.55 + 0.45;
            float core = exp(-r * 3.5);
            float halo = exp(-r * 1.2) * 0.55;
            float spike = pow(max(1.0 - abs(c.x), 0.0), 28.0) + pow(max(1.0 - abs(c.y), 0.0), 28.0);
            float glow = core + halo * rays + spike * 0.45;
            vec3 col = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.97, 0.78), core);
            gl_FragColor = vec4(col * (1.0 + glow * 1.5), clamp(glow, 0.0, 1.0));
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
      uniforms: { uTime: { value: 0 } },
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

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.gasPoints) {
      const mat = this.gasPoints.material as THREE.ShaderMaterial;
      mat.uniforms.uPixelScale.value = this.renderer.getPixelRatio() * h * 0.5;
    }
  }
}
