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

export interface RecordMessage {
  type: 'record'
  recording: boolean
}

export interface ReplayMessage {
  type: 'replay'
  target: number
}

export interface SnapshotExportMessage {
  type: 'snapshot-export'
  requestId: number
}

export interface SnapshotImportMessage {
  type: 'snapshot-import'
  requestId: number
  buffer: ArrayBuffer
}

export interface SelfTestMessage {
  type: 'selftest'
}

export interface SelfTestBuffersMessage {
  type: 'selftest-buffers'
  baseline: ArrayBuffer
  snapshot300: ArrayBuffer
}

export type MainToWorkerMessage =
  | InitMessage
  | ViewportMessage
  | NodeCountMessage
  | PauseMessage
  | RecordMessage
  | ReplayMessage
  | SnapshotExportMessage
  | SnapshotImportMessage
  | SelfTestMessage
  | SelfTestBuffersMessage

export interface WorkerStatsMessage {
  type: 'stats'
  buffer: ArrayBuffer
}

export interface WorkerReadyMessage {
  type: 'ready'
}

export interface SnapshotExportedMessage {
  type: 'snapshot-exported'
  requestId: number
  buffer: ArrayBuffer
}

export interface SnapshotImportedMessage {
  type: 'snapshot-imported'
  requestId: number
  frame: number
  hash: number
}

export type TimelineMode = 'live' | 'replaying'

export interface TimelineMessage {
  type: 'timeline'
  mode: TimelineMode
  frame: number
  hash: number
  paused: boolean
  recording: boolean
  replaying: boolean
  messages: number
}

export interface SelfTestCheckpoint {
  frame: number
  live: string
  replay: string
  snapshot: string
  match: boolean
}

export interface SelfTestReportMessage {
  type: 'selftest-report'
  transferred: boolean
  snapshotRoundtrip: boolean
  pass: boolean
  checkpoints: SelfTestCheckpoint[]
  failures: string[]
}

export interface SelfTestSnapshotsMessage {
  type: 'selftest-snapshots'
  baseline: ArrayBuffer
  snapshot300: ArrayBuffer
}

export type WorkerToMainMessage =
  | WorkerStatsMessage
  | WorkerReadyMessage
  | SnapshotExportedMessage
  | SnapshotImportedMessage
  | TimelineMessage
  | SelfTestReportMessage
  | SelfTestSnapshotsMessage

/**
 * Stats binary layout (28 bytes, little-endian):
 *   0  fps      f32
 *   4  p50      f32
 *   8  p95      f32
 *  12  p99      f32
 *  16  dropRate f32
 *  20  frame    f32 (exact: frame counters stay well below 2^24)
 *  24  hash     u32
 */
export const STATS_BYTES = 28

export function encodeStats(
  fps: number,
  p50: number,
  p95: number,
  p99: number,
  dropRate: number,
  frame: number,
  hash: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(STATS_BYTES)
  const dv = new DataView(buffer)
  dv.setFloat32(0, fps, true)
  dv.setFloat32(4, p50, true)
  dv.setFloat32(8, p95, true)
  dv.setFloat32(12, p99, true)
  dv.setFloat32(16, dropRate, true)
  dv.setFloat32(20, frame, true)
  dv.setUint32(24, hash >>> 0, true)
  return buffer
}

export function decodeStats(buffer: ArrayBuffer): {
  fps: number
  p50: number
  p95: number
  p99: number
  dropRate: number
  frame: number
  hash: number
} {
  const dv = new DataView(buffer)
  return {
    fps: dv.getFloat32(0, true),
    p50: dv.getFloat32(4, true),
    p95: dv.getFloat32(8, true),
    p99: dv.getFloat32(12, true),
    dropRate: dv.getFloat32(16, true),
    frame: dv.getFloat32(20, true),
    hash: dv.getUint32(24, true),
  }
}
