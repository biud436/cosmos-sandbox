export class BarnesHut {
  theta2: number;
  softening2: number;

  private readonly maxNodes: number;
  private readonly nx: Float32Array;
  private readonly ny: Float32Array;
  private readonly nz: Float32Array;
  private readonly nhs: Float32Array;
  private readonly nmass: Float32Array;
  private readonly ncx: Float32Array;
  private readonly ncy: Float32Array;
  private readonly ncz: Float32Array;
  private readonly children: Int32Array;
  private readonly leafParticle: Int32Array;

  private positions: Float32Array | null = null;
  private masses: Float64Array | null = null;
  private nodeCount = 0;

  constructor(maxParticles: number, theta = 0.6, softening = 0.5) {
    this.theta2 = theta * theta;
    this.softening2 = softening * softening;
    this.maxNodes = Math.max(64, maxParticles * 12);
    this.nx = new Float32Array(this.maxNodes);
    this.ny = new Float32Array(this.maxNodes);
    this.nz = new Float32Array(this.maxNodes);
    this.nhs = new Float32Array(this.maxNodes);
    this.nmass = new Float32Array(this.maxNodes);
    this.ncx = new Float32Array(this.maxNodes);
    this.ncy = new Float32Array(this.maxNodes);
    this.ncz = new Float32Array(this.maxNodes);
    this.children = new Int32Array(this.maxNodes * 8);
    this.leafParticle = new Int32Array(this.maxNodes);
  }

  build(positions: Float32Array, masses: Float64Array, count: number, boxHalf: number): void {
    this.positions = positions;
    this.masses = masses;
    this.nodeCount = 0;
    this.allocNode(0, 0, 0, boxHalf * 1.6);
    for (let i = 0; i < count; i++) this.insert(0, i);
  }

  private allocNode(cx: number, cy: number, cz: number, hs: number): number {
    if (this.nodeCount >= this.maxNodes) return -1;
    const idx = this.nodeCount++;
    this.nx[idx] = cx;
    this.ny[idx] = cy;
    this.nz[idx] = cz;
    this.nhs[idx] = hs;
    this.nmass[idx] = 0;
    this.ncx[idx] = 0;
    this.ncy[idx] = 0;
    this.ncz[idx] = 0;
    this.leafParticle[idx] = -1;
    const cbase = idx * 8;
    for (let k = 0; k < 8; k++) this.children[cbase + k] = -1;
    return idx;
  }

  private hasChildren(node: number): boolean {
    const base = node * 8;
    for (let k = 0; k < 8; k++) if (this.children[base + k] !== -1) return true;
    return false;
  }

  private insert(node: number, p: number): void {
    const positions = this.positions!;
    const masses = this.masses!;
    const px = positions[p * 3 + 0];
    const py = positions[p * 3 + 1];
    const pz = positions[p * 3 + 2];
    const m = masses[p];

    const prevMass = this.nmass[node];
    const newMass = prevMass + m;
    if (newMass > 0) {
      this.ncx[node] = (this.ncx[node] * prevMass + px * m) / newMass;
      this.ncy[node] = (this.ncy[node] * prevMass + py * m) / newMass;
      this.ncz[node] = (this.ncz[node] * prevMass + pz * m) / newMass;
    }
    this.nmass[node] = newMass;

    if (this.leafParticle[node] === -1 && !this.hasChildren(node)) {
      this.leafParticle[node] = p;
      return;
    }

    if (this.leafParticle[node] !== -1) {
      const oldP = this.leafParticle[node];
      this.leafParticle[node] = -1;
      this.placeInChild(node, oldP);
    }

    this.placeInChild(node, p);
  }

  private placeInChild(node: number, p: number): void {
    const positions = this.positions!;
    const px = positions[p * 3 + 0];
    const py = positions[p * 3 + 1];
    const pz = positions[p * 3 + 2];
    const cx = this.nx[node];
    const cy = this.ny[node];
    const cz = this.nz[node];
    const childHs = this.nhs[node] * 0.5;
    if (childHs < 0.005) return;

    const ox = px >= cx ? 1 : 0;
    const oy = py >= cy ? 1 : 0;
    const oz = pz >= cz ? 1 : 0;
    const octant = ox | (oy << 1) | (oz << 2);

    const base = node * 8;
    let child = this.children[base + octant];
    if (child === -1) {
      const ccx = cx + (ox ? childHs : -childHs);
      const ccy = cy + (oy ? childHs : -childHs);
      const ccz = cz + (oz ? childHs : -childHs);
      child = this.allocNode(ccx, ccy, ccz, childHs);
      if (child === -1) return;
      this.children[base + octant] = child;
    }
    this.insert(child, p);
  }

  computeAcceleration(px: number, py: number, pz: number, selfIdx: number, G: number, out: [number, number, number]): void {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (this.nodeCount === 0) return;
    this.walk(0, px, py, pz, selfIdx, G, out);
  }

  private walk(node: number, px: number, py: number, pz: number, selfIdx: number, G: number, out: [number, number, number]): void {
    const m = this.nmass[node];
    if (m === 0) return;

    const dx = this.ncx[node] - px;
    const dy = this.ncy[node] - py;
    const dz = this.ncz[node] - pz;
    const r2 = dx * dx + dy * dy + dz * dz + this.softening2;

    const size = this.nhs[node] * 2;
    const isLeaf = this.leafParticle[node] !== -1;
    if (isLeaf || size * size < this.theta2 * r2) {
      if (this.leafParticle[node] === selfIdx) return;
      const invR = 1 / Math.sqrt(r2);
      const a = G * m * invR * invR * invR;
      out[0] += a * dx;
      out[1] += a * dy;
      out[2] += a * dz;
      return;
    }

    const base = node * 8;
    for (let k = 0; k < 8; k++) {
      const c = this.children[base + k];
      if (c !== -1) this.walk(c, px, py, pz, selfIdx, G, out);
    }
  }
}
