import type { SimPass, SimState } from './types'
import { createSimState, setNodeCount } from './state'
import { createGrid, ensureGridCapacity, resizeGrid } from './grid'
import type { Grid } from './grid'
import { applyForces, integrate, makeCollisionPass } from './passes'

export const FIXED_DT = 1 / 60
const MAX_RADIUS = 6

/**
 * Pure deterministic simulation core shared by worker runtime, main-thread
 * fallback and the self-test harness. It owns no rendering, no timers and no
 * event sources: given the same initial state and the same ordered control
 * messages, step() produces bit-identical state.
 */
export class SimCore {
  readonly state: SimState
  readonly grid: Grid
  private readonly pipeline: SimPass[]
  private frame = 0

  constructor(capacity: number) {
    this.state = createSimState(capacity)
    this.grid = createGrid(MAX_RADIUS * 2, capacity)
    this.pipeline = [applyForces, makeCollisionPass(this.grid), integrate]
  }

  get frameCount(): number {
    return this.frame
  }

  setViewport(width: number, height: number): void {
    this.state.width = width
    this.state.height = height
    resizeGrid(this.grid, width, height)
  }

  setNodeCount(n: number): void {
    ensureGridCapacity(this.grid, this.state.capacity)
    setNodeCount(this.state, n)
  }

  /** One fixed deterministic step. */
  step(): void {
    for (const pass of this.pipeline) pass(this.state, FIXED_DT)
    this.frame++
  }

  resetFrameCounter(): void {
    this.frame = 0
  }

  setFrame(frame: number): void {
    this.frame = frame >>> 0
  }
}
