# Cosmos

> Web-based interactive particle sandbox — molecular dynamics, chemistry, self-gravity, miniature black holes, and toy nuclear fusion in your browser.

Cosmos simulates a population of particles over time under classical physics: Lennard-Jones intermolecular forces, harmonic chemical bonds, Newtonian self-gravity, and a simplified threshold-based nuclear fusion. Time can be paused, stepped, or scaled, and is reported in cosmic units (years → 만 / 억 / 조 년).

The viewport uses a Unity-style 5-panel layout: Toolbar · Hierarchy · Viewport · Inspector · Console.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle
```

Requires Node 18+.

---

## Features

### Physics
- **Lennard-Jones pair forces** with Lorentz–Berthelot mixing across species.
- **Velocity Verlet integration** with a velocity-rescaling thermostat.
- **Self-gravity** (softened Newtonian, O(N²)) for cosmic-scale clustering.
- **Chemical bonding**: harmonic springs between same-species atoms with valence limits; bonds form on close approach and break when over-stretched.
- **Toy nuclear fusion**: H + H → He when relative kinetic energy exceeds a threshold (momentum-conserving, with energy release).
- **Black holes**: drag-to-place gravity wells; particles inside the event horizon are consumed.
- **Boundary**: reflecting box (visualised by edge wireframe) or open space depending on preset.

### Particle species
| Species | Mass | σ | ε | Valence | Notes |
|---|---|---|---|---|---|
| H    | 0.05 | 0.55 | 0.35 | 1 | Forms H₂; can fuse to He |
| He   | 0.10 | 0.65 | 0.20 | 0 | Noble gas |
| N₂   | 0.70 | 1.00 | 1.00 | 0 | Already a molecule |
| O₂   | 0.80 | 1.00 | 1.10 | 0 | Already a molecule |
| Dust | 5.00 | 1.30 | 2.20 | 4 | Can form clusters |

Per-frame Union-Find on the bond graph reports the actual molecules present (e.g. `H₂`, `Dust ×4`) in the Hierarchy panel.

### Time model
- **Time scale**: ×0.25 / ×0.5 / ×1 / ×2 / ×4 / ×8 (substeps per frame). Internal `dt` is fixed.
- **Pause** (Space) freezes simulated time; **Step** (`.`) advances one tick.
- **Cosmic time display**: per-preset `yearsPerUnit` maps reduced simulation time to years and formats it in Korean (`년`, `만 년`, `억 년`, `조 년`).

### Presets

Top-level scene presets:
- **우주 가스 구름** — Cold H + He with self-gravity and bonding. H₂ forms; clouds collapse over millions of years.
- **공기 흐름** — Wind-blown N₂/O₂ + dust with bonding; dust aggregates into chains.
- **저온 응축** — Bond-active cold gas; condensation droplets form.
- **항성 내부 (융합)** — Hot, dense H; bonds break instantly, fusion dominates.

Sub-presets inside each Inspector folder (환경 / 입자 구성 / 화학 결합 / 핵융합) for fast partial overrides.

### Tools
- **Black Hole** button — drag from the Tools panel into the viewport. The button itself is a continuously rendered accretion-disk animation; a matching ghost follows the cursor. **Esc** cancels the drag. **Clear** removes all black holes.

---

## Controls

| Action | Key / UI |
|---|---|
| Pause / Resume | Toolbar `⏸ Pause` · `Space` |
| Single-step | `⏭ Step` (when paused) · `.` |
| Reset (re-spawn from current distribution) | `↺ Reset` |
| Preset / time scale | Toolbar dropdowns |
| Cancel black-hole drag | `Esc` |
| Camera | Mouse drag · scroll wheel (OrbitControls) |

---

## Architecture

```
src/
├── main.ts                Wires everything together; per-frame loop
├── physics/
│   ├── types.ts           Species table (mass/σ/ε/color/valence)
│   ├── SpatialGrid.ts     O(N) cell-list neighbor lookup
│   └── Simulator.ts       LJ + Verlet + thermostat + bonds + fusion + black holes
├── render/
│   └── Scene.ts           Three.js scene: starfield, nebula, InstancedMesh / Points particles,
│                          bond LineSegments, black-hole shader, screen-to-world helper
└── ui/
    ├── presets.ts         Top-level scene presets
    ├── subPresets.ts      Per-folder Inspector sub-presets
    ├── Controls.ts        lil-gui Inspector
    ├── Layout.ts          Hierarchy / Console / Toolbar bindings
    ├── Tools.ts           Black-hole tool: canvas animation + drag handler
    └── timeFormat.ts      Korean cosmic-time formatter
```

Physics is in reduced (LJ) units internally. Temperature is exposed in Kelvin via a calibration constant; cosmic time uses a per-preset `yearsPerUnit` multiplier.

---

## License

Personal sandbox / research project. Not currently published under a specific license.
