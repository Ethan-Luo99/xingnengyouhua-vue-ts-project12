import {
  DEFAULT_SEED,
  FIXED_DT,
  MAX_STEPS,
  coreSetNodeCount,
  coreSetViewport,
  coreStep,
  createSimCore,
} from './sim-kernel'
import type { SimCore } from './sim-kernel'
import type { SimState } from './types'
import { createSprites, render } from './render'
import { FrameStatsSampler } from './sampler'
import type { FrameStats } from './sampler'
import {
  ControlRecorder,
  exportSnapshot,
  replayRecording,
  restoreSnapshot,
  stateHash,
} from './time-travel'
import { runSelftest } from './selftest'
import type {
  ReplayMessage,
  SelftestResultMessage,
} from './protocol'

const MAX_CAPACITY = 4096

// Main-thread fallback. It runs the exact same deterministic SimCore as the
// worker, so recording / snapshot / replay / selftest behave identically on
// this path (the HUD badge only differs in where the work executes).
export class MainEngine {
  onStats: ((stats: FrameStats) => void) | null = null
  onSelftest: ((result: SelftestResultMessage) => void) | null = null
  onFrame: ((info: { frame: number; hash: string }) => void) | null = null

  readonly state: SimState
  private readonly core: SimCore
  private readonly capacity: number
  private readonly seed: number = DEFAULT_SEED
  private readonly recorder = new ControlRecorder()
  private readonly sampler = new FrameStatsSampler()
  private sprites: HTMLCanvasElement[] = []
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private rafId = 0
  private running = false
  private lastTime = 0
  private accumulator = 0
  private lastStatsAt = 0
  private lastEmittedFrame = -1

  constructor(capacity: number = MAX_CAPACITY) {
    this.capacity = capacity
    this.core = createSimCore(capacity, this.seed)
    this.state = this.core.state
  }

  get paused(): boolean {
    return this.core.paused
  }

  set paused(value: boolean) {
    this.record({ type: 'pause', paused: value })
    this.core.paused = value
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
    this.record({ type: 'viewport', width, height, dpr })
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(width * dpr))
      this.canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    coreSetViewport(this.core, width, height)
    this.drawFrame()
  }

  setNodeCount(n: number): void {
    this.record({ type: 'node-count', count: n })
    coreSetNodeCount(this.core, n)
  }

  setRecording(active: boolean): void {
    if (active) {
      const baseline = exportSnapshot(
        this.core,
        this.core.stepCount,
        this.seed,
      ).payload.buffer
      this.recorder.begin(this.core.stepCount, baseline)
    } else {
      this.recorder.markEnd(this.core.stepCount)
      this.recorder.stop()
    }
  }

  exportSnapshotBuffer(): ArrayBuffer {
    const { payload } = exportSnapshot(this.core, this.core.stepCount, this.seed)
    return payload.buffer
  }

  importSnapshotBuffer(buffer: ArrayBuffer): void {
    restoreSnapshot(this.core, buffer)
    this.drawFrame()
  }

  replayFromRecording(targetFrame?: number): void {
    const replayed = replayRecording(
      this.capacity,
      this.seed,
      this.recorder,
    )
    const snap = exportSnapshot(
      replayed,
      targetFrame ?? this.recorder.frameRange.end,
      this.seed,
    )
    restoreSnapshot(this.core, snap.payload.buffer)
    this.drawFrame()
  }

  runSelfTest(): SelftestResultMessage {
    const result = runSelftest(this.capacity, this.seed)
    const message: SelftestResultMessage = { type: 'selftest-result', ...result }
    this.onSelftest?.(message)
    return message
  }

  private record(message: ReplayMessage): void {
    this.recorder.record(this.core.stepCount, message)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.lastStatsAt = this.lastTime
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
    this.sampler.record(frameMs)

    if (!this.core.paused) {
      this.accumulator += Math.min(frameMs, 100) / 1000
      let steps = 0
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        coreStep(this.core, FIXED_DT)
        this.accumulator -= FIXED_DT
        steps++
      }
      if (steps === MAX_STEPS) this.accumulator = 0
    }

    this.drawFrame()
    if (this.core.stepCount !== this.lastEmittedFrame) {
      this.lastEmittedFrame = this.core.stepCount
      this.onFrame?.({ frame: this.core.stepCount, hash: stateHash(this.core) })
    }
    this.maybeReport(now)
  }

  private drawFrame(): void {
    if (this.ctx) render(this.ctx, this.core.state, this.sprites)
  }

  private maybeReport(now: number): void {
    if (!this.onStats || !this.sampler.hasEnoughSamples) return
    if (now - this.lastStatsAt < 500) return
    this.lastStatsAt = now
    this.onStats(this.sampler.snapshot())
  }
}
