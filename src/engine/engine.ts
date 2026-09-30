import type { SimPass } from './types'
import type { SimState } from './types'
import { createSimState, setNodeCount } from './state'
import { createGrid, resizeGrid, ensureGridCapacity } from './grid'
import type { Grid } from './grid'
import { applyForces, makeCollisionPass, integrate } from './passes'
import { createSprites, render } from './render'

const FIXED_DT = 1 / 60
const MAX_STEPS = 3
const STATS_INTERVAL_MS = 500
const SAMPLE_SIZE = 600
const MAX_RADIUS = 6
const DROP_THRESHOLD_MS = 32

export interface FrameStats {
  fps: number
  p50: number
  p95: number
  p99: number
  dropRate: number
}

export class Engine {
  readonly state: SimState
  onStats: ((stats: FrameStats) => void) | null = null
  paused = false

  private readonly grid: Grid
  private readonly pipeline: SimPass[]
  private sprites: HTMLCanvasElement[] = []
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private rafId = 0
  private running = false
  private lastTime = 0
  private accumulator = 0
  private readonly samples = new Float32Array(SAMPLE_SIZE)
  private readonly sorted = new Float32Array(SAMPLE_SIZE)
  private sampleIdx = 0
  private sampleCount = 0
  private lastStatsAt = 0

  constructor(capacity: number) {
    this.state = createSimState(capacity)
    this.grid = createGrid(MAX_RADIUS * 2, capacity)
    this.pipeline = [applyForces, makeCollisionPass(this.grid), integrate]
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    if (this.sprites.length === 0) this.sprites = createSprites()
  }

  detach(): void {
    this.stop()
    this.canvas = null
    this.ctx = null
  }

  setViewport(width: number, height: number, dpr: number): void {
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(width * dpr))
      this.canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.state.width = width
    this.state.height = height
    resizeGrid(this.grid, width, height)
    this.drawFrame()
  }

  setNodeCount(n: number): void {
    ensureGridCapacity(this.grid, this.state.capacity)
    setNodeCount(this.state, n)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    const frameMs = now - this.lastTime
    this.lastTime = now
    this.recordSample(frameMs)

    if (!this.paused) {
      this.accumulator += Math.min(frameMs, 100) / 1000
      let steps = 0
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        this.step(FIXED_DT)
        this.accumulator -= FIXED_DT
        steps++
      }
      if (steps === MAX_STEPS) this.accumulator = 0
    }

    this.drawFrame()
    this.maybeReport(now)
  }

  private step(dt: number): void {
    for (const pass of this.pipeline) pass(this.state, dt)
  }

  private drawFrame(): void {
    if (this.ctx) render(this.ctx, this.state, this.sprites)
  }

  private recordSample(ms: number): void {
    this.samples[this.sampleIdx] = ms
    this.sampleIdx = (this.sampleIdx + 1) % SAMPLE_SIZE
    if (this.sampleCount < SAMPLE_SIZE) this.sampleCount++
  }

  private maybeReport(now: number): void {
    if (!this.onStats || this.sampleCount < 30) return
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return
    this.lastStatsAt = now
    const n = this.sampleCount
    this.sorted.set(this.samples.subarray(0, n))
    const arr = this.sorted.subarray(0, n)
    arr.sort()
    let sum = 0
    let dropped = 0
    for (let i = 0; i < n; i++) {
      sum += this.samples[i]
      if (this.samples[i] > DROP_THRESHOLD_MS) dropped++
    }
    const pick = (q: number): number => arr[Math.min(n - 1, Math.floor(n * q))]
    this.onStats({
      fps: 1000 / (sum / n),
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      dropRate: dropped / n,
    })
  }
}
