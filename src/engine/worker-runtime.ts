import { SimCore, FIXED_DT } from './sim-core'
import { createOffscreenSprites, render } from './render'
import type { AnyCanvas } from './render'
import { FrameStatsSampler } from './sampler'
import { encodeStats } from './protocol'
import type {
  MainToWorkerMessage,
  SelfTestReportMessage,
  TimelineMode,
  WorkerToMainMessage,
} from './protocol'
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
import type { DeterministicRun } from './selftest'

const MAX_STEPS = 3
const STATS_INTERVAL_MS = 500
const FALLBACK_FRAME_MS = 1000 / 60
const REPLAY_STEPS_PER_TICK = 2

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

interface PendingSelfTest {
  run: DeterministicRun
  replayHashes: Map<number, number>
}

export class WorkerRuntime {
  private readonly core: SimCore
  private readonly sprites: AnyCanvas[]
  private readonly sampler = new FrameStatsSampler()
  private readonly journal = new ControlJournal()
  private readonly capacity: number
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

  private mode: TimelineMode = 'live'
  private recording = false
  private recordBaseline: ArrayBuffer | null = null
  private replayTarget = -1
  private replayIdx = 0
  private pendingSelfTest: PendingSelfTest | null = null

  constructor(capacity: number, canvas: OffscreenCanvas, scope: WorkerScope) {
    this.capacity = capacity
    this.core = new SimCore(capacity)
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
        this.recordControl(CONTROL_PAUSE, msg.paused ? 1 : 0)
        break
      case 'record':
        this.setRecording(msg.recording)
        break
      case 'replay':
        this.startReplay(msg.target)
        break
      case 'snapshot-export':
        this.exportSnapshot(msg.requestId)
        break
      case 'snapshot-import':
        this.importSnapshot(msg.requestId, msg.buffer)
        break
      case 'selftest':
        this.runSelfTest()
        break
      case 'selftest-buffers':
        this.finishSelfTest(msg.baseline, msg.snapshot300)
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
      this.advanceReplay(now)
    }

    this.drawFrame()
    this.maybeReport(now)
  }

  private drawFrame(): void {
    if (this.ctx) render(this.ctx, this.core.state, this.sprites)
  }

  private reportNow(): void {
    if (!this.sampler.hasEnoughSamples) return
    const stats = this.sampler.snapshot()
    this.lastStatsAt = performance.now()
    this.emit(
      encodeStats(
        stats.fps,
        stats.p50,
        stats.p95,
        stats.p99,
        stats.dropRate,
        this.core.frameCount,
        hashState(this.core.state),
      ),
    )
  }

  private maybeReport(now: number): void {
    if (!this.sampler.hasEnoughSamples) return
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return
    this.lastStatsAt = now
    const stats = this.sampler.snapshot()
    this.emit(
      encodeStats(
        stats.fps,
        stats.p50,
        stats.p95,
        stats.p99,
        stats.dropRate,
        this.core.frameCount,
        hashState(this.core.state),
      ),
    )
  }

  private setViewport(width: number, height: number, dpr: number): void {
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(width * dpr))
      this.canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.core.setViewport(width, height)
    this.recordControl(CONTROL_VIEWPORT, width, height)
    this.drawFrame()
  }

  private setNodeCount(n: number): void {
    this.core.setNodeCount(n)
    this.recordControl(CONTROL_NODE_COUNT, n)
  }

  // ---- time travel -------------------------------------------------------

  private recordControl(kind: number, a: number, b = 0): void {
    if (!this.recording || this.mode !== 'live') return
    this.journal.record(this.core.frameCount, kind, a, b)
    this.emitTimeline()
  }

  private setRecording(on: boolean): void {
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
      // The throttled stats stream may lag the true frame by up to 500ms;
      // flush exact telemetry so the recorded "last frame" hash is usable.
      this.reportNow()
    }
    this.emitTimeline()
  }

  private startReplay(target: number): void {
    if (this.mode === 'replaying') return
    const baseline = this.recordBaseline
    if (!baseline) return
    this.recording = false
    const header = restoreSnapshot(baseline, this.core.state, this.core.grid)
    this.core.setFrame(header.frame)
    this.accumulator = 0
    this.replayIdx = 0
    // Frame numbers are absolute: never target a frame before the baseline.
    this.replayTarget = Math.max(target, header.frame)
    this.mode = 'replaying'
    this.applyDueControls()
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

  private advanceReplay(now: number): void {
    if (this.replayTarget < 0) return
    let guard = 0
    while (
      this.core.frameCount < this.replayTarget &&
      guard < REPLAY_STEPS_PER_TICK
    ) {
      // Live semantics: a message tagged at frame f is applied before the
      // f -> f+1 step. Apply controls at the current frame, then step.
      this.applyDueControls()
      this.core.step()
      guard++
    }
    // Controls tagged exactly at the target frame land after the final step,
    // matching the post-arrival live state at that frame.
    this.applyDueControls()
    if (this.core.frameCount >= this.replayTarget) {
      this.replayTarget = -1
      this.mode = 'live'
      this.paused = true
      // Flush exact end-of-replay telemetry so the HUD does not show a
      // throttled, earlier-frame hash.
      this.lastStatsAt = now
      this.reportNow()
      this.emitTimeline()
    }
  }

  private exportSnapshot(requestId: number): void {
    const buffer = takeSnapshot({
      state: this.core.state,
      grid: this.core.grid,
      frame: this.core.frameCount,
      accumulator: this.accumulator,
      paused: this.paused,
    })
    this.post({ type: 'snapshot-exported', requestId, buffer }, [buffer])
  }

  private importSnapshot(requestId: number, buffer: ArrayBuffer): void {
    const header = restoreSnapshot(buffer, this.core.state, this.core.grid)
    this.core.setFrame(header.frame)
    this.accumulator = header.accumulator
    this.paused = header.paused
    this.cancelReplay()
    this.recording = false
    this.drawFrame()
    const hash = hashState(this.core.state)
    this.lastStatsAt = performance.now()
    this.reportNow()
    this.post({ type: 'snapshot-imported', requestId, frame: header.frame, hash })
    this.emitTimeline()
  }

  // ---- self-test ---------------------------------------------------------

  private runSelfTest(): void {
    const run = runDeterministic(this.capacity)
    const replayHashes = replayJournal(
      this.capacity,
      run.journal,
      run.frames,
    )
    this.pendingSelfTest = { run, replayHashes }
    // Cross the worker -> main boundary by transfer, then back again.
    this.post(
      {
        type: 'selftest-snapshots',
        baseline: run.baseline,
        snapshot300: run.snapshot300,
      },
      [run.baseline, run.snapshot300],
    )
  }

  private finishSelfTest(baseline: ArrayBuffer, snapshot300: ArrayBuffer): void {
    const pending = this.pendingSelfTest
    if (!pending) return
    this.pendingSelfTest = null
    const { run, replayHashes } = pending
    const snapshotHashes = snapshotRestoreLeg(
      this.capacity,
      run.journal,
      baseline,
      snapshot300,
      run.frames,
    )
    const roundtripHash = verifyRestoredSnapshot(this.capacity, snapshot300)
    const report = buildReport(
      run,
      replayHashes,
      snapshotHashes,
      roundtripHash,
      true,
    )
    this.post(reportToMessage(report))
  }

  private emitTimeline(): void {
    this.post({
      type: 'timeline',
      mode: this.mode,
      frame: this.core.frameCount,
      hash: hashState(this.core.state),
      paused: this.paused,
      recording: this.recording,
      replaying: this.mode === 'replaying',
      messages: this.journal.length,
    })
  }

  private post(message: WorkerToMainMessage, transfer?: Transferable[]): void {
    if (transfer) this.scope.postMessage(message, transfer)
    else this.scope.postMessage(message)
  }
}

function reportToMessage(report: {
  pass: boolean
  transferred: boolean
  snapshotRoundtrip: boolean
  checkpoints: SelfTestReportMessage['checkpoints']
  failures: string[]
}): SelfTestReportMessage {
  return { type: 'selftest-report', ...report }
}
