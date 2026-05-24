export class SpatialGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cellSize: number;
  private readonly origin: [number, number, number];
  private readonly head: Int32Array;
  private readonly next: Int32Array;

  constructor(box: { min: [number, number, number]; max: [number, number, number] }, cellSize: number, maxParticles: number) {
    this.cellSize = cellSize;
    this.origin = [box.min[0], box.min[1], box.min[2]];
    this.nx = Math.max(1, Math.ceil((box.max[0] - box.min[0]) / cellSize));
    this.ny = Math.max(1, Math.ceil((box.max[1] - box.min[1]) / cellSize));
    this.nz = Math.max(1, Math.ceil((box.max[2] - box.min[2]) / cellSize));
    this.head = new Int32Array(this.nx * this.ny * this.nz);
    this.next = new Int32Array(maxParticles);
  }

  private cellIndex(ix: number, iy: number, iz: number): number {
    return ix + this.nx * (iy + this.ny * iz);
  }

  private clampCell(v: number, n: number): number {
    if (v < 0) return 0;
    if (v >= n) return n - 1;
    return v;
  }

  rebuild(positions: Float32Array, count: number): void {
    this.head.fill(-1);
    const [ox, oy, oz] = this.origin;
    const inv = 1 / this.cellSize;
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3 + 0];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const ix = this.clampCell(Math.floor((px - ox) * inv), this.nx);
      const iy = this.clampCell(Math.floor((py - oy) * inv), this.ny);
      const iz = this.clampCell(Math.floor((pz - oz) * inv), this.nz);
      const c = this.cellIndex(ix, iy, iz);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  forEachNeighbor(i: number, positions: Float32Array, callback: (j: number) => void): void {
    const [ox, oy, oz] = this.origin;
    const inv = 1 / this.cellSize;
    const px = positions[i * 3 + 0];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const ix = this.clampCell(Math.floor((px - ox) * inv), this.nx);
    const iy = this.clampCell(Math.floor((py - oy) * inv), this.ny);
    const iz = this.clampCell(Math.floor((pz - oz) * inv), this.nz);
    for (let dz = -1; dz <= 1; dz++) {
      const cz = iz + dz;
      if (cz < 0 || cz >= this.nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = iy + dy;
        if (cy < 0 || cy >= this.ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx;
          if (cx < 0 || cx >= this.nx) continue;
          let j = this.head[this.cellIndex(cx, cy, cz)];
          while (j !== -1) {
            if (j > i) callback(j);
            j = this.next[j];
          }
        }
      }
    }
  }
}
