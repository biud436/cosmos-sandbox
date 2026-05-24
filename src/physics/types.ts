export interface Species {
  readonly id: number;
  readonly name: string;
  readonly mass: number;
  readonly sigma: number;
  readonly epsilon: number;
  readonly color: number;
  readonly maxValence: number;
}

export const SPECIES: readonly Species[] = [
  { id: 0, name: 'H',   mass: 0.05, sigma: 0.55, epsilon: 0.35, color: 0xff5a7a, maxValence: 1 },
  { id: 1, name: 'He',  mass: 0.10, sigma: 0.65, epsilon: 0.20, color: 0xffd86b, maxValence: 0 },
  { id: 2, name: 'N₂',  mass: 0.70, sigma: 1.00, epsilon: 1.00, color: 0x6cc6ff, maxValence: 0 },
  { id: 3, name: 'O₂',  mass: 0.80, sigma: 1.00, epsilon: 1.10, color: 0x9affb2, maxValence: 0 },
  { id: 4, name: 'Dust',mass: 5.00, sigma: 1.30, epsilon: 2.20, color: 0xc89aff, maxValence: 4 },
  { id: 5, name: 'DM',  mass: 4.00, sigma: 0.40, epsilon: 0.00, color: 0x7a5ac4, maxValence: 0 },
  { id: 6, name: 'C',   mass: 0.60, sigma: 0.85, epsilon: 0.80, color: 0x555555, maxValence: 0 },
  { id: 7, name: 'Si',  mass: 1.40, sigma: 1.05, epsilon: 0.90, color: 0xb59a78, maxValence: 0 },
  { id: 8, name: 'Fe',  mass: 2.80, sigma: 1.10, epsilon: 1.20, color: 0xb87a55, maxValence: 0 },
  { id: 9, name: 'Au',  mass: 3.90, sigma: 1.15, epsilon: 1.40, color: 0xffd000, maxValence: 0 },
] as const;

export const K_BOLTZMANN_REDUCED = 1.0;
export const T_REDUCED_TO_KELVIN = 120;
