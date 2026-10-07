import { MainEngine } from './main-engine'
import { decodeStats } from './protocol'
import type {
  InitMessage,
  MainToWorkerMessage,
  NodeCountMessage,
  PauseMessage,
  SelftestResultMessage,
  ViewportMessage,
  WorkerToMainMessage,
} from './protocol'
import type { FrameStats } from './sampler'
import { DEFAULT_SEED } from './sim-kernel'

import SimWorker from './sim.worker.ts?worker'

export type StageMode = 'worker' | 'main'

export interface HudStats extends FrameStats {
  frame: number
  hash: string
}

export interface StageEngine {
  readonly mode: StageMode
  onStats: ((stats: HudStats) => void) | null
  onModeChange: ((mode: StageMode) => void) | null
  onReady: (() => void) | null
  onSelftest: ((result: SelftestResultMessage) => void) | null
  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement
  setViewport(width: number, height: number, dpr: number): void
  setNodeCount(count: number): void
  setPaused(paused: boolean): void
  setRecording(active: boolean): void
  exportSnapshot(): Promise<ArrayBuffer>
  importSnapshot(buffer: ArrayBuffer): void
  replayToCurrentFrame(): void
  startSelftest(): void
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
  readonly mode: StageMode = 'main'
  onStats: ((stats: HudStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null
  onReady: (() => void) | null = null
  onSelftest: ((result: SelftestResultMessage) => void) | null = null

  private readonly engine: MainEngine
  private latestFrame = 0
  private latestHash = '--------'

  constructor(capacity: number) {
    this.engine = new MainEngine(capacity)
    this.engine.onStats = (stats) =>
      this.onStats?.({ ...stats, frame: this.latestFrame, hash: this.latestHash })
    this.engine.onFrame = (info) => {
      this.latestFrame = info.frame
      this.latestHash = info.hash
    }
    this.engine.onSelftest = (result) => this.onSelftest?.(result)
  }

  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    this.engine.attach(canvas)
    this.engine.setNodeCount(initialNodeCount)
    this.engine.start()
    queueMicrotask(() => this.onReady?.())
    return canvas
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.engine.setViewport(width, height, dpr)
  }

  setNodeCount(count: number): void {
    this.engine.setNodeCount(count)
  }

  setPaused(paused: boolean): void {
    this.engine.paused = paused
  }

  setRecording(active: boolean): void {
    this.engine.setRecording(active)
  }

  exportSnapshot(): Promise<ArrayBuffer> {
    return Promise.resolve(this.engine.exportSnapshotBuffer())
  }

  importSnapshot(buffer: ArrayBuffer): void {
    this.engine.importSnapshotBuffer(buffer)
  }

  replayToCurrentFrame(): void {
    this.engine.replayFromRecording()
  }

  startSelftest(): void {
    this.engine.runSelfTest()
  }

  unmount(): void {
    this.engine.onStats = null
    this.engine.onFrame = null
    this.engine.onSelftest = null
    this.engine.detach()
  }
}

class WorkerStageEngine implements StageEngine {
  mode: StageMode = 'worker'
  onStats: ((stats: HudStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null
  onReady: (() => void) | null = null
  onSelftest: ((result: SelftestResultMessage) => void) | null = null

  private readonly capacity: number
  private worker: Worker | null = null
  private fallback: MainStageEngine | null = null
  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private disposed = false
  private viewport: ViewportMessage | null = null
  private nodeCount: NodeCountMessage = { type: 'node-count', count: 0 }
  private pauseState: PauseMessage = { type: 'pause', paused: false }
  private recording = false
  private nextSnapshotRequestId = 1
  private readonly snapshotWaiters = new Map<
    number,
    (buffer: ArrayBuffer) => void
  >()

  constructor(capacity: number) {
    this.capacity = capacity
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
        const data = event.data
        if (data.type === 'stats') {
          this.onStats?.(decodeStats(data.buffer))
        } else if (data.type === 'ready') {
          this.onReady?.()
        } else if (data.type === 'snapshot') {
          const resolve = this.snapshotWaiters.get(data.requestId)
          if (resolve) {
            this.snapshotWaiters.delete(data.requestId)
            resolve(data.buffer)
          }
        } else if (data.type === 'selftest-result') {
          this.onSelftest?.(data)
        }
      }
      worker.onerror = () => {
        if (!this.disposed && !this.fallback) this.activateFallback()
      }
      const offscreen = canvas.transferControlToOffscreen()
      const initMessage: InitMessage = {
        type: 'init',
        capacity: this.capacity,
        seed: DEFAULT_SEED,
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

  setRecording(active: boolean): void {
    this.recording = active
    if (this.fallback) this.fallback.setRecording(active)
    else this.post({ type: 'record', active })
  }

  exportSnapshot(): Promise<ArrayBuffer> {
    if (this.fallback) return this.fallback.exportSnapshot()
    const requestId = this.nextSnapshotRequestId++
    const promise = new Promise<ArrayBuffer>((resolve) => {
      this.snapshotWaiters.set(requestId, resolve)
    })
    this.post({ type: 'export-snapshot', requestId })
    return promise
  }

  importSnapshot(buffer: ArrayBuffer): void {
    if (this.fallback) {
      this.fallback.importSnapshot(buffer)
      return
    }
    // Transfer ownership; the main thread keeps a reference only until send.
    this.post({ type: 'import-snapshot', buffer }, [buffer])
  }

  replayToCurrentFrame(): void {
    if (this.fallback) this.fallback.replayToCurrentFrame()
    else this.post({ type: 'replay-start' })
  }

  startSelftest(): void {
    if (this.fallback) this.fallback.startSelftest()
    else this.post({ type: 'selftest-start' })
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
    this.snapshotWaiters.clear()
    if (this.fallback) {
      this.fallback.onStats = null
      this.fallback.onSelftest = null
      this.fallback.unmount()
      this.fallback = null
    }
    this.canvas?.remove()
    this.canvas = null
    this.container = null
  }

  private post(msg: MainToWorkerMessage, transfer: Transferable[] = []): void {
    if (!this.disposed && this.worker) this.worker.postMessage(msg, transfer)
  }

  private activateFallback(): void {
    const worker = this.worker
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      this.worker = null
    }
    this.snapshotWaiters.clear()
    this.canvas?.remove()
    const container = this.container
    if (!container) return
    const fallback = new MainStageEngine(this.capacity)
    fallback.onStats = (stats) => this.onStats?.(stats)
    fallback.onSelftest = (result) => this.onSelftest?.(result)
    fallback.onReady = () => this.onReady?.()
    fallback.mount(container, this.nodeCount.count)
    if (this.viewport) {
      fallback.setViewport(
        this.viewport.width,
        this.viewport.height,
        this.viewport.dpr,
      )
    }
    fallback.setPaused(this.pauseState.paused)
    if (this.recording) fallback.setRecording(true)
    this.fallback = fallback
    this.canvas = container.querySelector('canvas')
    this.mode = 'main'
    this.onModeChange?.('main')
  }
}
