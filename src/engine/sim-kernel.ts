import type { SimPass, SimState } from './types'
import { setNodeCount } from './state'
import { createGrid, ensureGridCapacity, resizeGrid } from './grid'
import type { Grid } from './grid'
import { applyForces, integrate, makeCollisionPass } from './passes'
import { DeterministicRng } from './rng'

export const FIXED_DT = 1 / 60
export const MAX_STEPS = 3
export const MAX_RADIUS = 6
export const DEFAULT_SEED = 0x12345678

// Everything that determines simulation results: SoA buffers, geometry,
// node count, the RNG stream, and the number of fixed steps already taken.
// The wall-clock accumulator and paused flag are scheduling state, not
// simulation state, but they are captured too so a resume is seamless.
export interface SimCore {
  state: SimState
  grid: Grid
  pipeline: SimPass[]
  rng: DeterministicRng
  stepCount: number
  accumulator: number
  paused: boolean
}

export function createSimCore(
  capacity: number,
  seed: number = DEFAULT_SEED,
): SimCore {
  const state = {
    count: 0,
    capacity,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    color: new Uint8Array(capacity),
    width: 0,
    height: 0,
  }
  const grid = createGrid(MAX_RADIUS * 2, capacity)
  return {
    state,
    grid,
    pipeline: [applyForces, makeCollisionPass(grid), integrate],
    rng: new DeterministicRng(seed),
    stepCount: 0,
    accumulator: 0,
    paused: false,
  }
}

export function coreSetViewport(
  core: SimCore,
  width: number,
  height: number,
): void {
  core.state.width = width
  core.state.height = height
  resizeGrid(core.grid, width, height)
}

export function coreSetNodeCount(core: SimCore, n: number): void {
  ensureGridCapacity(core.grid, core.state.capacity)
  setNodeCount(core.state, n, core.rng)
}

// One deterministic fixed step. No wall clock, no random source other than
// the RNG embedded in the core, iteration is plain index order.
export function coreStep(core: SimCore, dt: number = FIXED_DT): void {
  for (let i = 0; i < core.pipeline.length; i++) {
    core.pipeline[i](core.state, dt)
  }
  core.stepCount++
}
