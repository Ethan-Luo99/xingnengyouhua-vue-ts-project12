import type { FrameStats } from './engine'
import type { EngineHandle } from './handle'
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol'

export function canUseWorkerEngine(): boolean {
  return (
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype
  )
}

// 主线程门面：与 Engine 相同的命令式 API，内部转发到 Worker。
// 状态（viewport / nodeCount / paused）在主线程只保存"最近一次指令"，
// 用于 init 时一次性同步，模拟状态本身不复制。
export class WorkerEngine implements EngineHandle {
  onStats: ((stats: FrameStats) => void) | null = null

  private readonly capacity: number
  private worker: Worker | null = null
  private viewport = { width: 0, height: 0, dpr: 1 }
  private nodeCount = 0
  private pausedValue = false

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get paused(): boolean {
    return this.pausedValue
  }

  set paused(value: boolean) {
    this.pausedValue = value
    this.post({ type: 'setPaused', paused: value })
  }

  attach(canvas: HTMLCanvasElement): void {
    const offscreen = canvas.transferControlToOffscreen()
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker = worker
    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data
      if (msg.type === 'stats') this.onStats?.(msg.stats)
    }
    this.post(
      {
        type: 'init',
        canvas: offscreen,
        capacity: this.capacity,
        width: this.viewport.width,
        height: this.viewport.height,
        dpr: this.viewport.dpr,
        nodeCount: this.nodeCount,
        paused: this.pausedValue,
      },
      [offscreen],
    )
  }

  detach(): void {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    // 先摘除回调再 terminate，确保在途消息不再触达 React 侧。
    worker.onmessage = null
    worker.terminate()
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.viewport = { width, height, dpr }
    this.post({ type: 'resize', width, height, dpr })
  }

  setNodeCount(n: number): void {
    this.nodeCount = n
    this.post({ type: 'setNodeCount', count: n })
  }

  start(): void {
    this.post({ type: 'start' })
  }

  stop(): void {
    this.post({ type: 'stop' })
  }

  private post(msg: MainToWorkerMessage, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }
}
