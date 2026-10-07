// Discriminated-union wire protocol between the main thread and the worker.
// Binary payloads travel as transferable ArrayBuffers (never JSON).

export interface SnapshotPayload {
  type: 'snapshot'
  buffer: ArrayBuffer
  frame: number
}

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
  seed: number
  canvas: OffscreenCanvas
}

// Deterministic control inputs that fully determine simulation results.
export type ReplayMessage =
  | ViewportMessage
  | NodeCountMessage
  | PauseMessage

export interface RecordControlMessage {
  type: 'record'
  active: boolean
}

export interface ExportSnapshotMessage {
  type: 'export-snapshot'
  requestId: number
}

export interface ImportSnapshotMessage {
  type: 'import-snapshot'
  buffer: ArrayBuffer
}

export interface ReplayStartMessage {
  type: 'replay-start'
}

export interface SelftestStartMessage {
  type: 'selftest-start'
}

export type MainToWorkerMessage =
  | InitMessage
  | ViewportMessage
  | NodeCountMessage
  | PauseMessage
  | RecordControlMessage
  | ExportSnapshotMessage
  | ImportSnapshotMessage
  | ReplayStartMessage
  | SelftestStartMessage

// Worker -> main --------------------------------------------------------

// Compact periodic HUD frame: float32 [fps, p50, p95, p99, dropRate,
// frame, hash]. The 32-bit hash is read back as raw uint32 bits.
export const STATS_FIELDS = 7

export interface WorkerStatsMessage {
  type: 'stats'
  buffer: ArrayBuffer
}

export interface WorkerReadyMessage {
  type: 'ready'
}

export interface WorkerSnapshotMessage extends SnapshotPayload {
  requestId: number
}

export interface SelftestCheckpoint {
  frame: number
  live: string
  snapshot: string
  replay: string
  pass: boolean
}

export interface SelftestResultMessage {
  type: 'selftest-result'
  pass: boolean
  checkpoints: SelftestCheckpoint[]
  summary: string
}

export type WorkerToMainMessage =
  | WorkerStatsMessage
  | WorkerReadyMessage
  | WorkerSnapshotMessage
  | SelftestResultMessage

export function encodeStats(
  fps: number,
  p50: number,
  p95: number,
  p99: number,
  dropRate: number,
  frame: number,
  hash: number,
): ArrayBuffer {
  const data = new Float32Array(STATS_FIELDS)
  data[0] = fps
  data[1] = p50
  data[2] = p95
  data[3] = p99
  data[4] = dropRate
  data[5] = frame
  new DataView(data.buffer).setUint32(24, hash >>> 0, true)
  return data.buffer
}

export function decodeStats(buffer: ArrayBuffer): {
  fps: number
  p50: number
  p95: number
  p99: number
  dropRate: number
  frame: number
  hash: string
} {
  const data = new Float32Array(buffer)
  const hash = new DataView(buffer).getUint32(24, true)
  return {
    fps: data[0],
    p50: data[1],
    p95: data[2],
    p99: data[3],
    dropRate: data[4],
    frame: data[5] | 0,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  }
}
