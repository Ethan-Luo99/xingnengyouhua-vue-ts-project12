import { SimCore, FIXED_DT } from './sim-core'
import { createSprites, render } from './render'
import { FrameStatsSampler } from './sampler'
import type { FrameStats } from './sampler'
import {
  CONTROL_NODE_COUNT,
  CONTROL_PAUSE,
  CONTROL_VIEWPORT,
  ControlJournal,
} from './timeline'
import { hashState } from './hash'
import { restoreSnapshot, takeSnapshot } from './snapshot'
import {
  buildReport,
  replayJournal,
  runDeterministic,
  snapshotRestoreLeg,
  verifyRestoredSnapshot,
} from './selftest'
import type {
  SelfTestReportMessage,
  TimelineMode,
} from './protocol'

const MAX_STEPS = 3
const STATS_INTERVAL_MS = 500
const REPLAY_STEPS_PER_TICK = 2

export interface SnapshotResult {
  requestId: number
  buffer: ArrayBuffer
}

export interface ImportResult {
  requestId: number
  frame: number
  hash: number
}

export class MainEngine {
  readonly core: SimCore
  onStats: ((stats: FrameStats) => void) | null = null
  onTimeline: ((timeline: {
    mode: TimelineMode
    frame: number
    hash: number
    paused: boolean
    recording: boolean
    replaying: boolean
    messages: number
  }) => void) | null = null
  onSnapshotExported: ((result: SnapshotResult) => void) | null = null
  onSnapshotImported: ((result: ImportResult) => void) | null = null
  onSelfTestReport:
    | ((report: Omit<SelfTestReportMessage, 'type'>) => void)
    | null = null
  private paused = false

  private readonly journal = new ControlJournal()
  private readonly sampler = new FrameStatsSampler()
  private sprites: HTMLCanvasElement[] = []
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private rafId = 0
  private running = false
  private lastTime = 0
  private accumulator = 0
  private lastStatsAt = 0

  private mode: TimelineMode = 'live'
  private recording = false
  private recordBaseline: ArrayBuffer | null = null
  private replayTarget = -1
  private replayIdx = 0

  constructor(capacity: number) {
    this.core = new SimCore(capacity)
  }

  get state() {
    return this.core.state
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
    this.core.setViewport(width, height)
    this.recordControl(CONTROL_VIEWPORT, width, height)
    this.drawFrame()
  }

  setNodeCount(n: number): void {
    this.core.setNodeCount(n)
    this.recordControl(CONTROL_NODE_COUNT, n)
  }

  setPaused(value: boolean): void {
    this.paused = value
    this.recordControl(CONTROL_PAUSE, value ? 1 : 0)
  }

  setRecording(on: boolean): void {
    if (on === this.recording) return
    if (on) {
      this.cancelReplay()
      this.journal.clear()
      this.recordBaseline = takeSnapshot({
        state: this.core.state,
        grid: this.core.grid,
        frame: this.core.frameCount,
        accumulator: this.accumulator,
        paused: this.paused,
      })
      this.recording = true
    } else {
      this.recording = false
      this.reportNow()
    }
    this.emitTimeline()
  }

  startReplay(target: number): void {
    if (this.mode === 'replaying') return
    const baseline = this.recordBaseline
    if (!baseline) return
    this.recording = false
    const header = restoreSnapshot(baseline, this.core.state, this.core.grid)
    this.core.setFrame(header.frame)
    this.accumulator = 0
    this.replayIdx = 0
    this.replayTarget = Math.max(target, header.frame)
    this.mode = 'replaying'
    this.applyDueControls()
    this.emitTimeline()
  }

  exportSnapshot(requestId: number): void {
    const buffer = takeSnapshot({
      state: this.core.state,
      grid: this.core.grid,
      frame: this.core.frameCount,
      accumulator: this.accumulator,
      paused: this.paused,
    })
    this.onSnapshotExported?.({ requestId, buffer })
  }

  importSnapshot(requestId: number, buffer: ArrayBuffer): void {
    const header = restoreSnapshot(buffer, this.core.state, this.core.grid)
    this.core.setFrame(header.frame)
    this.accumulator = header.accumulator
    this.paused = header.paused
    this.cancelReplay()
    this.recording = false
    this.drawFrame()
    const hash = hashState(this.core.state)
    this.reportNow()
    this.onSnapshotImported?.({ requestId, frame: header.frame, hash })
    this.emitTimeline()
  }

  runSelfTest(): void {
    const run = runDeterministic(this.core.state.capacity)
    const replayHashes = replayJournal(
      this.core.state.capacity,
      run.journal,
      run.frames,
    )
    // Fallback path has no worker boundary: structuredClone still verifies
    // the binary buffers survive a real serialization round trip.
    const cloned = structuredClone({
      baseline: run.baseline,
      snapshot300: run.snapshot300,
    }) as { baseline: ArrayBuffer; snapshot300: ArrayBuffer }
    const snapshotHashes = snapshotRestoreLeg(
      this.core.state.capacity,
      run.journal,
      cloned.baseline,
      cloned.snapshot300,
      run.frames,
    )
    const roundtripHash = verifyRestoredSnapshot(
      this.core.state.capacity,
      cloned.snapshot300,
    )
    const report = buildReport(
      run,
      replayHashes,
      snapshotHashes,
      roundtripHash,
      false,
    )
    this.onSelfTestReport?.(report)
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

  private recordControl(kind: number, a: number, b = 0): void {
    if (!this.recording || this.mode !== 'live') return
    this.journal.record(this.core.frameCount, kind, a, b)
    this.emitTimeline()
  }

  private cancelReplay(): void {
    if (this.mode !== 'replaying') return
    this.mode = 'live'
    this.replayTarget = -1
  }

  private applyDueControls(): void {
    while (
      this.replayIdx < this.journal.length &&
      this.journal.frameAt(this.replayIdx) === this.core.frameCount
    ) {
      this.journal.applyAt(this.core, this.replayIdx)
      this.replayIdx++
    }
  }

  private advanceReplay(): void {
    if (this.replayTarget < 0) return
    let guard = 0
    while (
      this.core.frameCount < this.replayTarget &&
      guard < REPLAY_STEPS_PER_TICK
    ) {
      // Live semantics: a message tagged at frame f was applied before step
      // f -> f+1. Apply controls at the current frame, then step.
      this.applyDueControls()
      this.core.step()
      guard++
    }
    // Controls tagged exactly at the target frame land after the final step,
    // matching the post-message-arrival live state at that frame.
    this.applyDueControls()
    if (this.core.frameCount >= this.replayTarget) {
      this.replayTarget = -1
      this.mode = 'live'
      this.paused = true
      this.reportNow()
      this.emitTimeline()
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    const frameMs = now - this.lastTime
    this.lastTime = now
    this.sampler.record(frameMs)

    if (this.mode === 'live') {
      if (!this.paused) {
        this.accumulator += Math.min(frameMs, 100) / 1000
        let steps = 0
        while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
          this.core.step()
          this.accumulator -= FIXED_DT
          steps++
        }
        if (steps === MAX_STEPS) this.accumulator = 0
      }
    } else {
      this.advanceReplay()
    }

    this.drawFrame()
    this.maybeReport(now)
  }

  private drawFrame(): void {
    if (this.ctx) render(this.ctx, this.core.state, this.sprites)
  }

  private reportNow(): void {
    if (!this.onStats || !this.sampler.hasEnoughSamples) return
    this.lastStatsAt = performance.now()
    const stats = this.sampler.snapshot()
    stats.frame = this.core.frameCount
    stats.hash = hashState(this.core.state)
    this.onStats(stats)
  }

  private maybeReport(now: number): void {
    if (!this.onStats || !this.sampler.hasEnoughSamples) return
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return
    this.lastStatsAt = now
    const stats = this.sampler.snapshot()
    stats.frame = this.core.frameCount
    stats.hash = hashState(this.core.state)
    this.onStats(stats)
  }

  private emitTimeline(): void {
    this.onTimeline?.({
      mode: this.mode,
      frame: this.core.frameCount,
      hash: hashState(this.core.state),
      paused: this.paused,
      recording: this.recording,
      replaying: this.mode === 'replaying',
      messages: this.journal.length,
    })
  }
}
