export interface ViewportMessage {
  type: 'viewport'
  width: number
  height: number
  dpr: number
}

export interface NodeCountMessage {
  type: 'node-count'
  count: number
}

export interface PauseMessage {
  type: 'pause'
  paused: boolean
}

export interface InitMessage {
  type: 'init'
  capacity: number
  canvas: OffscreenCanvas
}

export type MainToWorkerMessage =
  | InitMessage
  | ViewportMessage
  | NodeCountMessage
  | PauseMessage

export type StatsKind = 'frame-stats'

export interface WorkerStatsMessage {
  type: 'stats'
  buffer: ArrayBuffer
}

export interface WorkerReadyMessage {
  type: 'ready'
}

export type WorkerToMainMessage = WorkerStatsMessage | WorkerReadyMessage

export const STATS_FIELDS = 5

export function encodeStats(
  fps: number,
  p50: number,
  p95: number,
  p99: number,
  dropRate: number,
): ArrayBuffer {
  const data = new Float32Array(STATS_FIELDS)
  data[0] = fps
  data[1] = p50
  data[2] = p95
  data[3] = p99
  data[4] = dropRate
  return data.buffer
}

export function decodeStats(buffer: ArrayBuffer): {
  fps: number
  p50: number
  p95: number
  p99: number
  dropRate: number
} {
  const data = new Float32Array(buffer)
  return {
    fps: data[0],
    p50: data[1],
    p95: data[2],
    p99: data[3],
    dropRate: data[4],
  }
}
