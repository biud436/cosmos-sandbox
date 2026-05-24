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
  private bondGeom: THREE.BufferGeometry | null = null;
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
    this.buildStarfield();
    this.buildParticleMeshes();
    this.buildGasRenderer();
    this.buildBondRenderer();

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
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    this.scene.add(lines);
    this.bondGeom = geom;
    this.bondPositions = positions;
  }

  setRenderMode(mode: 'solid' | 'gas'): void {
    if (mode === this.renderMode) return;
    this.renderMode = mode;
    const useSolid = mode === 'solid';
    for (const m of this.speciesMeshes) m.visible = useSolid;
    if (this.gasPoints) this.gasPoints.visible = !useSolid;
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

  sync(sim: Simulator, frameDt = 1 / 60): void {
    const n = sim.count;
    this.syncBonds(sim);
    this.syncEffectors(sim, frameDt);
    if (this.renderMode === 'solid') {
      const counts = new Int32Array(SPECIES.length);
      for (let i = 0; i < n; i++) {
        const s = sim.species[i];
        const slot = counts[s]++;
        if (slot >= this.speciesCapacity[s]) continue;
        const px = sim.positions[i * 3 + 0];
        const py = sim.positions[i * 3 + 1];
        const pz = sim.positions[i * 3 + 2];
        const radius = SPECIES[s].sigma * 1.1;
        this.tmpMat.makeScale(radius, radius, radius);
        this.tmpMat.setPosition(px, py, pz);
        this.speciesMeshes[s].setMatrixAt(slot, this.tmpMat);
      }
      for (let s = 0; s < SPECIES.length; s++) {
        this.speciesMeshes[s].count = counts[s];
        this.speciesMeshes[s].instanceMatrix.needsUpdate = true;
      }
    } else if (this.gasGeom && this.gasPositions && this.gasColors && this.gasSizes) {
      const cap = Math.min(n, this.maxParticlesTotal);
      for (let i = 0; i < cap; i++) {
        const s = sim.species[i];
        const sp = SPECIES[s];
        const isDM = sp.name === 'DM';
        this.gasPositions[i * 3 + 0] = sim.positions[i * 3 + 0];
        this.gasPositions[i * 3 + 1] = sim.positions[i * 3 + 1];
        this.gasPositions[i * 3 + 2] = sim.positions[i * 3 + 2];
        const r = ((sp.color >> 16) & 0xff) / 255;
        const g = ((sp.color >> 8) & 0xff) / 255;
        const b = (sp.color & 0xff) / 255;
        const dim = isDM ? 0.35 : 1.0;
        this.gasColors[i * 3 + 0] = r * dim;
        this.gasColors[i * 3 + 1] = g * dim;
        this.gasColors[i * 3 + 2] = b * dim;
        this.gasSizes[i] = sp.sigma * (isDM ? 5.0 : 4.5);
      }
      this.gasGeom.setDrawRange(0, cap);
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
      view.group.position.set(eff.x, eff.y, eff.z);
      view.group.scale.setScalar(eff.radius);
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
            float rays = abs(sin(a * 8.0 + uTime * 0.5)) * 0.4 + 0.6;
            float glow = exp(-r * 2.5) * rays;
            vec3 col = mix(vec3(1.0, 0.5, 0.1), vec3(1.0, 0.95, 0.7), glow);
            gl_FragColor = vec4(col * glow * 1.5, glow);
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

      const infRingGeo = new THREE.RingGeometry(4.8, 5.0, 64);
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

  focusOn(position: [number, number, number], distance = 6): void {
    const target = new THREE.Vector3(position[0], position[1], position[2]);
    const startTarget = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const len = offset.length();
    if (len > 0.1) offset.multiplyScalar(distance / len);
    const startCam = this.camera.position.clone();
    const endCam = target.clone().add(offset);
    const t0 = performance.now();
    const dur = 650;
    const animate = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.controls.target.lerpVectors(startTarget, target, k);
      this.camera.position.lerpVectors(startCam, endCam, k);
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
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
