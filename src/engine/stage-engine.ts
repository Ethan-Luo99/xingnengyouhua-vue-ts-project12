import { MainEngine } from './main-engine'
import { decodeStats } from './protocol'
import type {
  InitMessage,
  MainToWorkerMessage,
  NodeCountMessage,
  PauseMessage,
  ViewportMessage,
  WorkerToMainMessage,
} from './protocol'
import type { FrameStats } from './sampler'

import SimWorker from './sim.worker.ts?worker'

export type StageMode = 'worker' | 'main'

export interface StageEngine {
  mode: StageMode
  onStats: ((stats: FrameStats) => void) | null
  onModeChange: ((mode: StageMode) => void) | null
  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement
  setViewport(width: number, height: number, dpr: number): void
  setNodeCount(count: number): void
  setPaused(paused: boolean): void
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
  mode: StageMode = 'main'
  onStats: ((stats: FrameStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null

  private readonly engine: MainEngine
  private canvas: HTMLCanvasElement | null = null

  constructor(capacity: number) {
    this.engine = new MainEngine(capacity)
  }

  mount(container: HTMLElement, initialNodeCount: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    this.canvas = canvas
    this.engine.attach(canvas)
    this.engine.onStats = (stats) => this.onStats?.(stats)
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
    this.engine.paused = paused
  }

  unmount(): void {
    this.engine.onStats = null
    this.engine.detach()
    this.canvas?.remove()
    this.canvas = null
  }
}

class WorkerStageEngine implements StageEngine {
  mode: StageMode = 'worker'
  onStats: ((stats: FrameStats) => void) | null = null
  onModeChange: ((mode: StageMode) => void) | null = null

  private readonly capacity: number
  private worker: Worker | null = null
  private fallback: MainStageEngine | null = null
  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private disposed = false
  private viewport: ViewportMessage | null = null
  private nodeCount: NodeCountMessage = { type: 'node-count', count: 0 }
  private pauseState: PauseMessage = { type: 'pause', paused: false }

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
        if (event.data.type === 'stats') {
          this.onStats?.(decodeStats(event.data.buffer))
        }
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

  unmount(): void {
    this.disposed = true
    const worker = this.worker
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      this.worker = null
    }
    if (this.fallback) {
      this.fallback.onStats = null
      this.fallback.unmount()
      this.fallback = null
    }
    this.canvas?.remove()
    this.canvas = null
    this.container = null
  }

  private post(msg: MainToWorkerMessage): void {
    if (!this.disposed && this.worker) this.worker.postMessage(msg)
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
    this.mode = 'main'
    this.onModeChange?.('main')
  }
}
