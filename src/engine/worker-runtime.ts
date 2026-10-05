import type { SimPass, SimState } from './types'
import { createSimState, setNodeCount } from './state'
import { createGrid, resizeGrid, ensureGridCapacity } from './grid'
import type { Grid } from './grid'
import { applyForces, makeCollisionPass, integrate } from './passes'
import { createOffscreenSprites, render } from './render'
import type { AnyCanvas } from './render'
import { FrameStatsSampler } from './sampler'
import { encodeStats } from './protocol'
import type { MainToWorkerMessage } from './protocol'

const FIXED_DT = 1 / 60
const MAX_STEPS = 3
const STATS_INTERVAL_MS = 500
const MAX_RADIUS = 6
const FALLBACK_FRAME_MS = 1000 / 60

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

export class WorkerRuntime {
  private readonly state: SimState
  private readonly grid: Grid
  private readonly pipeline: SimPass[]
  private readonly sprites: AnyCanvas[]
  private readonly sampler = new FrameStatsSampler()
  private readonly emit: (buffer: ArrayBuffer) => void

  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private rafId = 0
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private running = false
  private paused = false
  private lastTime = 0
  private accumulator = 0
  private lastStatsAt = 0
  private readonly useRaf: boolean
  private readonly scope: WorkerScope

  constructor(capacity: number, canvas: OffscreenCanvas, scope: WorkerScope) {
    this.state = createSimState(capacity)
    this.grid = createGrid(MAX_RADIUS * 2, capacity)
    this.pipeline = [applyForces, makeCollisionPass(this.grid), integrate]
    this.sprites = createOffscreenSprites()
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.emit = (buffer) =>
      scope.postMessage({ type: 'stats', buffer } satisfies {
        type: 'stats'
        buffer: ArrayBuffer
      }, [buffer])
    this.useRaf = typeof scope.requestAnimationFrame === 'function'
    this.scope = scope
  }

  handleMessage(msg: MainToWorkerMessage): void {
    switch (msg.type) {
      case 'viewport':
        this.setViewport(msg.width, msg.height, msg.dpr)
        break
      case 'node-count':
        this.setNodeCount(msg.count)
        break
      case 'pause':
        this.paused = msg.paused
        break
      case 'init':
        break
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.lastStatsAt = this.lastTime
    this.scheduleNext()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.useRaf && this.scope.cancelAnimationFrame) {
      this.scope.cancelAnimationFrame(this.rafId)
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this.rafId = 0
  }

  private scheduleNext(): void {
    if (!this.running) return
    if (this.useRaf && this.scope.requestAnimationFrame) {
      this.rafId = this.scope.requestAnimationFrame(this.tick)
    } else {
      this.timeoutId = setTimeout(
        () => this.tick(performance.now()),
        FALLBACK_FRAME_MS,
      )
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    this.scheduleNext()

    const frameMs = now - this.lastTime
    this.lastTime = now
    this.sampler.record(frameMs)

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

  private maybeReport(now: number): void {
    if (!this.sampler.hasEnoughSamples) return
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return
    this.lastStatsAt = now
    const s = this.sampler.snapshot()
    this.emit(encodeStats(s.fps, s.p50, s.p95, s.p99, s.dropRate))
  }

  private setViewport(width: number, height: number, dpr: number): void {
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

  private setNodeCount(n: number): void {
    ensureGridCapacity(this.grid, this.state.capacity)
    setNodeCount(this.state, n)
  }
}
