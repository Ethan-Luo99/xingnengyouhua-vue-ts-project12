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
import { createOffscreenSprites, render } from './render'
import type { AnyCanvas } from './render'
import { FrameStatsSampler } from './sampler'
import { encodeStats } from './protocol'
import type {
  MainToWorkerMessage,
  ReplayMessage,
  WorkerToMainMessage,
} from './protocol'
import {
  ControlRecorder,
  exportSnapshot,
  replayRecording,
  restoreSnapshot,
  stateHash,
} from './time-travel'
import { runSelftest } from './selftest'

const STATS_INTERVAL_MS = 500
const FALLBACK_FRAME_MS = 1000 / 60

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

export class WorkerRuntime {
  private readonly core: SimCore
  private readonly sprites: AnyCanvas[]
  private readonly sampler = new FrameStatsSampler()
  private readonly recorder = new ControlRecorder()
  private readonly seed: number
  private readonly scope: WorkerScope
  private readonly useRaf: boolean

  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private rafId = 0
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private running = false
  private lastTime = 0
  private lastStatsAt = 0

  constructor(
    capacity: number,
    canvas: OffscreenCanvas,
    scope: WorkerScope,
    seed: number = DEFAULT_SEED,
  ) {
    this.core = createSimCore(capacity, seed)
    this.seed = seed >>> 0
    this.sprites = createOffscreenSprites()
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.scope = scope
    this.useRaf = typeof scope.requestAnimationFrame === 'function'
  }

  handleMessage(msg: MainToWorkerMessage): void {
    switch (msg.type) {
      case 'viewport':
        this.applyControl({
          type: 'viewport',
          width: msg.width,
          height: msg.height,
          dpr: msg.dpr,
        })
        break
      case 'node-count':
        this.applyControl({ type: 'node-count', count: msg.count })
        break
      case 'pause':
        this.applyControl({ type: 'pause', paused: msg.paused })
        break
      case 'record':
        if (msg.active) {
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
        break
      case 'export-snapshot':
        this.handleExport(msg.requestId)
        break
      case 'import-snapshot':
        this.handleImport(msg.buffer)
        break
      case 'replay-start':
        this.handleReplay()
        break
      case 'selftest-start':
        this.startSelftest()
        break
      case 'init':
        break
    }
  }

  // Applies a deterministic control input to the live core and records it
  // at the current logical frame.
  private applyControl(msg: ReplayMessage): void {
    if (this.recorder.isRecording) {
      this.recorder.record(this.core.stepCount, msg)
    }
    if (msg.type === 'viewport') {
      this.setViewport(msg.width, msg.height, msg.dpr)
    } else if (msg.type === 'node-count') {
      coreSetNodeCount(this.core, msg.count)
    } else {
      this.core.paused = msg.paused
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

    if (!this.core.paused) {
      this.core.accumulator += Math.min(frameMs, 100) / 1000
      let steps = 0
      while (this.core.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        coreStep(this.core, FIXED_DT)
        this.core.accumulator -= FIXED_DT
        steps++
      }
      if (steps === MAX_STEPS) this.core.accumulator = 0
    }

    this.drawFrame()
    this.maybeReport(now)
  }

  private drawFrame(): void {
    if (this.ctx) render(this.ctx, this.core.state, this.sprites)
  }

  private hashBits(): number {
    return parseInt(stateHash(this.core), 16)
  }

  private maybeReport(now: number): void {
    if (!this.sampler.hasEnoughSamples) return
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return
    this.lastStatsAt = now
    const s = this.sampler.snapshot()
    const buffer = encodeStats(
      s.fps,
      s.p50,
      s.p95,
      s.p99,
      s.dropRate,
      this.core.stepCount,
      this.hashBits(),
    )
    this.emit({ type: 'stats', buffer }, [buffer])
  }

  private setViewport(width: number, height: number, dpr: number): void {
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(width * dpr))
      this.canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    coreSetViewport(this.core, width, height)
    this.drawFrame()
  }

  private handleExport(requestId: number): void {
    const { payload, transfer } = exportSnapshot(
      this.core,
      this.core.stepCount,
      this.seed,
    )
    this.emit({ ...payload, requestId }, transfer)
  }

  private handleImport(buffer: ArrayBuffer): void {
    restoreSnapshot(this.core, buffer)
    // Backing store keeps the last viewport dpr; logical size is restored.
    this.drawFrame()
  }

  private handleReplay(): void {
    // Restore the start baseline and re-apply recorded controls to reproduce
    // the exact state at the moment recording stopped.
    const replayed = replayRecording(
      this.core.state.capacity,
      this.seed,
      this.recorder,
    )
    const snap = exportSnapshot(
      replayed,
      this.recorder.frameRange.end,
      this.seed,
    )
    restoreSnapshot(this.core, snap.payload.buffer)
    this.drawFrame()
  }

  private startSelftest(): void {
    const result = runSelftest(this.core.state.capacity, this.seed)
    this.emit({ type: 'selftest-result', ...result })
  }

  private emit(msg: WorkerToMainMessage, transfer: Transferable[] = []): void {
    this.scope.postMessage(msg, transfer)
  }
}
