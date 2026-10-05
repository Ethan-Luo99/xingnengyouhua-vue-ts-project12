import type { FrameStats } from './engine'

// 主线程 → Worker 的控制消息。帧循环数据（模拟状态、绘制）完全留在
// Worker 内，不经过 postMessage；跨线程的只有低频控制消息与节流后的
// 统计快照，因此帧路径上不存在 JSON/结构化克隆开销。
export type MainToWorkerMessage =
  | {
      type: 'init'
      canvas: OffscreenCanvas
      capacity: number
      width: number
      height: number
      dpr: number
      nodeCount: number
      paused: boolean
    }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'setNodeCount'; count: number }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'start' }
  | { type: 'stop' }

export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'stats'; stats: FrameStats }
