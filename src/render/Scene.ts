import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SPECIES } from '../physics/types';
import { Effector, Simulator } from '../physics/Simulator';
import { GraphicsSettings } from './GraphicsSettings';
import {
  BOUNDARY_SHELL_VERT, BOUNDARY_SHELL_FRAG,
} from './shaders';
import { BondRenderer } from './renderers/BondRenderer';
import { GalaxyRenderer } from './renderers/GalaxyRenderer';
import { OrbitTrailRenderer } from './renderers/OrbitTrailRenderer';
import { EffectorRenderer } from './renderers/EffectorRenderer';
import { ParticleRenderer } from './renderers/ParticleRenderer';
import { StarfieldRenderer } from './renderers/StarfieldRenderer';

export class Scene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly boxHalf: number;
  // Projection scale (= canvasH / (2 * tan(fovY/2))) cached for the
  // solid-mode LOD pick. pixelSize ≈ radius * projScaleY / dist.
  // Refreshed by onResize / constructor, then handed to ParticleRenderer.sync.
  private projScaleY = 1;
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
  private effectors!: EffectorRenderer;
  private selectedEffector: Effector | null = null;
  private particles!: ParticleRenderer;
  private readonly maxParticlesTotal: number;
  private starfield!: StarfieldRenderer;

  /** Live graphics settings — mutated in place by setQualityPreset(). Knobs
   *  read by hot paths (LOD threshold, etc.) dereference through this so
   *  changing a preset takes effect on the next frame. */
  graphicsSettings: GraphicsSettings;

  constructor(container: HTMLElement, boxHalf: number, maxPerSpecies: number, gfx: GraphicsSettings) {
    this.graphicsSettings = gfx;
    this.boxHalf = boxHalf;
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
    this.starfield = new StarfieldRenderer(this.scene, boxHalf, gfx.starfieldCount);
    this.particles = new ParticleRenderer(this.scene, maxPerSpecies, this.renderer.getPixelRatio() * window.innerHeight * 0.5);
    this.bonds = new BondRenderer(this.scene, this.maxParticlesTotal);
    this.galaxies = new GalaxyRenderer(this.scene);
    this.orbits = new OrbitTrailRenderer(this.scene, this.visibility.orbits);
    this.effectors = new EffectorRenderer(this.scene, this.camera, this.renderer.domElement);

    const ro = new ResizeObserver(() => this.onResize(container));
    ro.observe(container);
    // Initialize projScaleY / canvasH for LOD before the first frame runs.
    this.onResize(container);
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
        this.particles.setVisible(visible);
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

  setRenderMode(mode: 'solid' | 'gas'): void {
    this.particles.setRenderMode(mode, this.visibility.particles);
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
    if (prev.starfieldCount !== next.starfieldCount) {
      this.starfield.rebuild(next.starfieldCount);
    }
    // AA can't change at runtime. Report mismatch so the caller can toast.
    return prev.antialias !== next.antialias;
  }

  private readonly tmpFrustum = new THREE.Frustum();
  private readonly tmpProjView = new THREE.Matrix4();

  sync(sim: Simulator, frameDt = 1 / 60): void {
    this.setUniverseScale(sim.scaleFactor);

    // Build frustum FIRST so all syncs can cull against it
    this.camera.updateMatrixWorld();
    this.tmpProjView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.tmpFrustum.setFromProjectionMatrix(this.tmpProjView);

    this.bonds.sync(sim);
    this.effectors.sync(sim, this.tmpFrustum, this.visibility, this.selectedEffector, frameDt);
    this.orbits.sync(sim, this.selectedEffector, this.visibility.orbits, frameDt);
    this.galaxies.sync(sim, this.tmpFrustum, this.visibility.galaxies, frameDt);

    this.particles.sync(sim, this.tmpFrustum, this.camera, this.projScaleY, this.graphicsSettings.particleLodPx);
  }

  pickEffector(clientX: number, clientY: number, sim: Simulator): Effector | null {
    return this.effectors.pick(clientX, clientY, sim);
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
    this.starfield.trackCamera(this.camera.position);
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
    this.particles.setPixelScale(this.renderer.getPixelRatio() * h * 0.5);
    // Half-height of the canvas in pixels, divided by tan(fovY/2) — the
    // projection scale used in solid-mode LOD: pixel_radius ≈ radius * projScaleY / dist.
    const fovYRad = this.camera.fov * Math.PI / 180;
    this.projScaleY = (h * 0.5) / Math.tan(fovYRad * 0.5);
  }
}
