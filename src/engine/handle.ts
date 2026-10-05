import type { FrameStats } from './engine'

// CanvasStage 只依赖该接口：WorkerEngine（Worker + OffscreenCanvas）
// 与 Engine（主线程回退）可以互换。
export interface EngineHandle {
  onStats: ((stats: FrameStats) => void) | null
  paused: boolean
  attach(canvas: HTMLCanvasElement): void
  detach(): void
  setViewport(width: number, height: number, dpr: number): void
  setNodeCount(n: number): void
  start(): void
  stop(): void
}
