import { MainEngine } from './main-engine'
import { decodeStats } from './protocol'
import type {
  InitMessage,
  MainToWorkerMessage,
  NodeCountMessage,
  PauseMessage,
  SelfTestReportMessage,
  TimelineMessage,
  ViewportMessage,
  WorkerToMainMessage,
} from './protocol'
import type { FrameStats } from './sampler'

import SimWorker from './sim.worker.ts?worker'

export type StageMode = 'worker' | 'main'

export type StageCapability = 'worker-transfer' | 'main-clone'

export interface StageEngine {
  readonly mode: StageMode
  readonly capability: StageCapability
  onStats: ((stats: FrameStats) => void) | null
  onModeChange: ((mode: StageMode) => void) | null
  onTimeline: ((timeline: Omit<TimelineMessage, 'type'>) => void) | null
  onSelfTestReport:
    | ((report: Omit<SelfTestReportMessage, 'type'>) => void)
    | null
  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement
  setViewport(width: number, height: number, dpr: number): void
  setNodeCount(count: number): void
  setPaused(paused: boolean): void
  setRecording(recording: boolean): void
  replay(targetFrame: number): void
  exportSnapshot(): Promise<ArrayBuffer>
  importSnapshot(buffer: ArrayBuffer): Promise<{ frame: number; hash: number }>
  runSelfTest(): void
  unmount(): void
}

function supportsOffscreenWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  )
}

export function createStageEngine(capacity: number): StageEngine {
  const forceFallback =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('fallback')
  if (!forceFallback && supportsOffscreenWorker()) {
    return new WorkerStageEngine(capacity)
  }
  return new MainStageEngine(capacity)
}

class MainStageEngine implements StageEngine {
  onStats: ((stats: FrameStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null
  onTimeline: ((timeline: Omit<TimelineMessage, 'type'>) => void) | null = null
  onSelfTestReport:
    | ((report: Omit<SelfTestReportMessage, 'type'>) => void)
    | null = null

  private readonly engine: MainEngine
  private canvas: HTMLCanvasElement | null = null

  constructor(capacity: number) {
    this.engine = new MainEngine(capacity)
  }

  get mode(): StageMode {
    return 'main'
  }

  get capability(): StageCapability {
    return 'main-clone'
  }

  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    this.canvas = canvas
    this.engine.attach(canvas)
    this.engine.onStats = (stats) => this.onStats?.(stats)
    this.engine.onTimeline = (timeline) => this.onTimeline?.(timeline)
    this.engine.onSelfTestReport = (report) => this.onSelfTestReport?.(report)
    this.engine.setNodeCount(initialNodeCount)
    this.engine.start()
    return canvas
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.engine.setViewport(width, height, dpr)
  }

  setNodeCount(count: number): void {
    this.engine.setNodeCount(count)
  }

  setPaused(paused: boolean): void {
    this.engine.setPaused(paused)
  }

  setRecording(recording: boolean): void {
    this.engine.setRecording(recording)
  }

  replay(targetFrame: number): void {
    this.engine.startReplay(targetFrame)
  }

  exportSnapshot(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId()
      this.engine.onSnapshotExported = (result) => {
        if (result.requestId !== requestId) return
        this.engine.onSnapshotExported = null
        // Same-thread binary: keep ownership semantics equivalent to a clone.
        resolve(structuredClone(result.buffer))
      }
      this.engine.exportSnapshot(requestId)
      setTimeout(
        () => reject(new Error('snapshot export timed out')),
        1000,
      )
    })
  }

  importSnapshot(
    buffer: ArrayBuffer,
  ): Promise<{ frame: number; hash: number }> {
    return new Promise((resolve) => {
      const requestId = nextRequestId()
      this.engine.onSnapshotImported = (result) => {
        if (result.requestId !== requestId) return
        this.engine.onSnapshotImported = null
        resolve({ frame: result.frame, hash: result.hash })
      }
      this.engine.importSnapshot(requestId, structuredClone(buffer))
    })
  }

  runSelfTest(): void {
    this.engine.runSelfTest()
  }

  unmount(): void {
    this.engine.onStats = null
    this.engine.onTimeline = null
    this.engine.onSelfTestReport = null
    this.engine.detach()
    this.canvas?.remove()
    this.canvas = null
  }
}

let requestCounter = 0
function nextRequestId(): number {
  return ++requestCounter
}

class WorkerStageEngine implements StageEngine {
  onStats: ((stats: FrameStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null
  onTimeline: ((timeline: Omit<TimelineMessage, 'type'>) => void) | null = null
  onSelfTestReport:
    | ((report: Omit<SelfTestReportMessage, 'type'>) => void)
    | null = null

  private readonly capacity: number
  private worker: Worker | null = null
  private fallback: MainStageEngine | null = null
  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private disposed = false
  private viewport: ViewportMessage | null = null
  private nodeCount: NodeCountMessage = { type: 'node-count', count: 0 }
  private pauseState: PauseMessage = { type: 'pause', paused: false }
  private pendingExports = new Map<
    number,
    {
      resolve: (buffer: ArrayBuffer) => void
      reject: (error: Error) => void
    }
  >()
  private pendingImports = new Map<
    number,
    { resolve: (result: { frame: number; hash: number }) => void }
  >()

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get mode(): StageMode {
    return this.fallback ? 'main' : 'worker'
  }

  get capability(): StageCapability {
    return this.fallback ? 'main-clone' : 'worker-transfer'
  }

  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement {
    this.container = container
    this.nodeCount = { type: 'node-count', count: initialNodeCount }
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    this.canvas = canvas

    try {
      const worker = new SimWorker()
      this.worker = worker
      worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
        if (this.disposed) return
        this.handleWorkerMessage(event.data)
      }
      worker.onerror = () => {
        if (!this.disposed && !this.fallback) this.activateFallback()
      }
      const offscreen = canvas.transferControlToOffscreen()
      const initMessage: InitMessage = {
        type: 'init',
        capacity: this.capacity,
        canvas: offscreen,
      }
      worker.postMessage(initMessage, [offscreen])
      this.post(this.nodeCount)
      if (this.viewport) this.post(this.viewport)
      this.post(this.pauseState)
    } catch {
      this.activateFallback()
    }
    return canvas
  }

  private handleWorkerMessage(data: WorkerToMainMessage): void {
    switch (data.type) {
      case 'stats':
        this.onStats?.(decodeStats(data.buffer))
        break
      case 'snapshot-exported': {
        const pending = this.pendingExports.get(data.requestId)
        if (pending) {
          this.pendingExports.delete(data.requestId)
          pending.resolve(data.buffer)
        }
        break
      }
      case 'snapshot-imported': {
        const pending = this.pendingImports.get(data.requestId)
        if (pending) {
          this.pendingImports.delete(data.requestId)
          pending.resolve({ frame: data.frame, hash: data.hash })
        }
        break
      }
      case 'timeline':
        this.onTimeline?.({
          mode: data.mode,
          frame: data.frame,
          hash: data.hash,
          paused: data.paused,
          recording: data.recording,
          replaying: data.replaying,
          messages: data.messages,
        })
        break
      case 'selftest-report':
        this.onSelfTestReport?.({
          transferred: data.transferred,
          snapshotRoundtrip: data.snapshotRoundtrip,
          pass: data.pass,
          checkpoints: data.checkpoints,
          failures: data.failures,
        })
        break
      case 'selftest-snapshots':
        this.forwardSelfTestBuffers(data.baseline, data.snapshot300)
        break
      case 'ready':
        break
    }
  }

  private forwardSelfTestBuffers(
    baseline: ArrayBuffer,
    snapshot300: ArrayBuffer,
  ): void {
    this.post(
      { type: 'selftest-buffers', baseline, snapshot300 },
      [baseline, snapshot300],
    )
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.viewport = { type: 'viewport', width, height, dpr }
    if (this.fallback) this.fallback.setViewport(width, height, dpr)
    else this.post(this.viewport)
  }

  setNodeCount(count: number): void {
    this.nodeCount = { type: 'node-count', count }
    if (this.fallback) this.fallback.setNodeCount(count)
    else this.post(this.nodeCount)
  }

  setPaused(paused: boolean): void {
    this.pauseState = { type: 'pause', paused }
    if (this.fallback) this.fallback.setPaused(paused)
    else this.post(this.pauseState)
  }

  setRecording(recording: boolean): void {
    if (this.fallback) this.fallback.setRecording(recording)
    else this.post({ type: 'record', recording })
  }

  replay(targetFrame: number): void {
    if (this.fallback) this.fallback.replay(targetFrame)
    else this.post({ type: 'replay', target: targetFrame })
  }

  exportSnapshot(): Promise<ArrayBuffer> {
    if (this.fallback) return this.fallback.exportSnapshot()
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId()
      this.pendingExports.set(requestId, { resolve, reject })
      this.post({ type: 'snapshot-export', requestId })
      setTimeout(() => {
        if (this.pendingExports.delete(requestId)) {
          reject(new Error('snapshot export timed out'))
        }
      }, 2000)
    })
  }

  importSnapshot(
    buffer: ArrayBuffer,
  ): Promise<{ frame: number; hash: number }> {
    if (this.fallback) return this.fallback.importSnapshot(buffer)
    return new Promise((resolve) => {
      const requestId = nextRequestId()
      this.pendingImports.set(requestId, { resolve })
      this.post({ type: 'snapshot-import', requestId, buffer }, [buffer])
    })
  }

  runSelfTest(): void {
    if (this.fallback) {
      this.fallback.runSelfTest()
    } else {
      this.post({ type: 'selftest' })
    }
  }

  unmount(): void {
    this.disposed = true
    const worker = this.worker
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      this.worker = null
    }
    for (const pending of this.pendingExports.values()) {
      pending.reject(new Error('engine unmounted'))
    }
    this.pendingExports.clear()
    this.pendingImports.clear()
    if (this.fallback) {
      this.fallback.onStats = null
      this.fallback.onTimeline = null
      this.fallback.onSelfTestReport = null
      this.fallback.unmount()
      this.fallback = null
    }
    this.canvas?.remove()
    this.canvas = null
    this.container = null
  }

  private post(msg: MainToWorkerMessage, transfer?: Transferable[]): void {
    if (!this.disposed && this.worker) {
      if (transfer) this.worker.postMessage(msg, transfer)
      else this.worker.postMessage(msg)
    }
  }

  private activateFallback(): void {
    const worker = this.worker
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      this.worker = null
    }
    this.canvas?.remove()
    const container = this.container
    if (!container) return
    const fallback = new MainStageEngine(this.capacity)
    fallback.onStats = (stats) => this.onStats?.(stats)
    fallback.onTimeline = (timeline) => this.onTimeline?.(timeline)
    fallback.onSelfTestReport = (report) => this.onSelfTestReport?.(report)
    fallback.mount(container, this.nodeCount.count)
    if (this.viewport) {
      fallback.setViewport(
        this.viewport.width,
        this.viewport.height,
        this.viewport.dpr,
      )
    }
    fallback.setPaused(this.pauseState.paused)
    this.fallback = fallback
    this.canvas = container.querySelector('canvas')
    this.onModeChange?.('main')
  }
}
