import { coreSetNodeCount, coreSetViewport, coreStep, createSimCore } from './sim-kernel'
import type { SimCore } from './sim-kernel'
import { resizeGrid } from './grid'
import type {
  ReplayMessage,
  SnapshotPayload,
} from './protocol'

// Binary layouts (little-endian, no JSON).
//
// Snapshot header (16 uint32 words = 64 bytes):
//  0 magic  1 version  2 stepCount  3 count  4 capacity
//  5 width(float-bits)  6 height(float-bits)  7 rngState
//  8 accumulator(float-bits)  9 paused  10..15 reserved
// Followed by capacity copies of: x,y,vx,vy,radius (Float32) and color (byte),
// i.e. 21 bytes per node, byte-aligned (no padding needed).
export const SNAP_MAGIC = 0x534e4150
export const SNAP_VERSION = 1
export const SNAP_HEADER_WORDS = 16
export const SNAP_HEADER_BYTES = SNAP_HEADER_WORDS * 4
export const SNAP_BYTES_PER_NODE = 4 * 5 + 1

export interface Snapshot {
  payload: SnapshotPayload
  transfer: Transferable[]
}

// Exports a complete restorable snapshot as one transferable ArrayBuffer.
// Copies the SoA buffers (they stay live in the running simulation).
export function exportSnapshot(
  core: SimCore,
  frame: number,
  seed: number,
): Snapshot {
  const { state } = core
  const cap = state.capacity
  const size = SNAP_HEADER_BYTES + cap * SNAP_BYTES_PER_NODE
  const buffer = new ArrayBuffer(size)
  const dv = new DataView(buffer)
  dv.setUint32(0, SNAP_MAGIC, true)
  dv.setUint32(4, SNAP_VERSION, true)
  dv.setUint32(8, core.stepCount, true)
  dv.setUint32(12, frame, true)
  dv.setUint32(16, state.count, true)
  dv.setUint32(20, cap, true)
  dv.setFloat32(24, state.width, true)
  dv.setFloat32(28, state.height, true)
  dv.setUint32(32, core.rng.value, true)
  dv.setFloat32(36, core.accumulator, true)
  dv.setUint32(40, core.paused ? 1 : 0, true)
  dv.setUint32(44, seed >>> 0, true)
  let offset = SNAP_HEADER_BYTES
  for (let i = 0; i < cap; i++) {
    dv.setFloat32(offset, state.x[i], true)
    dv.setFloat32(offset + 4, state.y[i], true)
    dv.setFloat32(offset + 8, state.vx[i], true)
    dv.setFloat32(offset + 12, state.vy[i], true)
    dv.setFloat32(offset + 16, state.radius[i], true)
    dv.setUint8(offset + 20, state.color[i])
    offset += SNAP_BYTES_PER_NODE
  }
  return {
    payload: { type: 'snapshot', buffer, frame },
    transfer: [buffer],
  }
}

// Restores a snapshot into an existing core in place (same canvas/grid
// pipeline). The grid is purely derived state and is rebuilt on the next
// step, so it is not part of the snapshot.
export function restoreSnapshot(core: SimCore, buffer: ArrayBuffer): number {
  const dv = new DataView(buffer)
  if (buffer.byteLength < SNAP_HEADER_BYTES) {
    throw new Error('snapshot too small')
  }
  if (dv.getUint32(0, true) !== SNAP_MAGIC) throw new Error('bad snapshot magic')
  if (dv.getUint32(4, true) !== SNAP_VERSION) {
    throw new Error('unsupported snapshot version')
  }
  const stepCount = dv.getUint32(8, true)
  const frame = dv.getUint32(12, true)
  const count = dv.getUint32(16, true)
  const cap = dv.getUint32(20, true)
  if (cap !== core.state.capacity) throw new Error('snapshot capacity mismatch')
  const width = dv.getFloat32(24, true)
  const height = dv.getFloat32(28, true)
  const rngState = dv.getUint32(32, true)
  const accumulator = dv.getFloat32(36, true)
  const paused = dv.getUint32(40, true) !== 0
  const { state, grid } = core
  let offset = SNAP_HEADER_BYTES
  for (let i = 0; i < cap; i++) {
    state.x[i] = dv.getFloat32(offset, true)
    state.y[i] = dv.getFloat32(offset + 4, true)
    state.vx[i] = dv.getFloat32(offset + 8, true)
    state.vy[i] = dv.getFloat32(offset + 12, true)
    state.radius[i] = dv.getFloat32(offset + 16, true)
    state.color[i] = dv.getUint8(offset + 20)
    offset += SNAP_BYTES_PER_NODE
  }
  state.count = count
  state.width = width
  state.height = height
  resizeGrid(grid, width, height)
  core.rng.value = rngState
  core.stepCount = stepCount
  core.accumulator = accumulator
  core.paused = paused
  return frame
}

// FNV-1a (32-bit) over the exact bytes of every state field. Hashing the
// raw float bytes (not number-to-string) makes equality bit-for-bit: two
// runs must produce identical Float32 bit patterns, not just close values.
export function stateHash(core: SimCore): string {
  const s = core.state
  let h = 0x811c9dc5
  const mixWord = (w: number): void => {
    h ^= w & 0xff
    h = Math.imul(h, 0x01000193)
    h ^= (w >>> 8) & 0xff
    h = Math.imul(h, 0x01000193)
    h ^= (w >>> 16) & 0xff
    h = Math.imul(h, 0x01000193)
    h ^= (w >>> 24) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  const mixBytes = (bytes: Uint8Array, from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
  }
  mixWord(core.stepCount)
  mixWord(s.count)
  mixWord(core.rng.value)
  mixWord(floatBits(s.width))
  mixWord(floatBits(s.height))
  const n = s.count
  mixBytes(new Uint8Array(s.x.buffer), 0, n * 4)
  mixBytes(new Uint8Array(s.y.buffer), 0, n * 4)
  mixBytes(new Uint8Array(s.vx.buffer), 0, n * 4)
  mixBytes(new Uint8Array(s.vy.buffer), 0, n * 4)
  mixBytes(new Uint8Array(s.radius.buffer), 0, n * 4)
  mixBytes(s.color, 0, n)
  return (h >>> 0).toString(16).padStart(8, '0')
}

function floatBits(v: number): number {
  scratchFloat[0] = v
  return scratchView.getUint32(0, true)
}

const scratchFloat = new Float32Array(1)
const scratchView = new DataView(scratchFloat.buffer)

// Records the control message sequence (worker-side, during recording).
// Only deterministic control inputs are captured; wall-clock timing is not.
export interface RecordedControl {
  frame: number
  message: ReplayMessage
}

export class ControlRecorder {
  readonly messages: RecordedControl[] = []
  private recording = false
  private startFrame = 0
  private endFrame = 0
  private baseline: ArrayBuffer | null = null

  start(): void {
    this.messages.length = 0
    this.recording = true
    this.baseline = null
  }

  // Begins recording and pins the frame + baseline snapshot at that instant.
  begin(frame: number, baselineSnapshot: ArrayBuffer): void {
    this.start()
    this.startFrame = frame
    this.endFrame = frame
    this.baseline = baselineSnapshot
  }

  stop(): number {
    this.recording = false
    return this.messages.length
  }

  markEnd(frame: number): void {
    this.endFrame = frame
  }

  get frameRange(): { start: number; end: number } {
    return { start: this.startFrame, end: this.endFrame }
  }

  get baselineSnapshot(): ArrayBuffer | null {
    return this.baseline
  }

  get isRecording(): boolean {
    return this.recording
  }

  record(frame: number, message: ReplayMessage): void {
    if (this.recording) {
      this.messages.push({ frame, message })
      this.endFrame = frame
    }
  }
}

// Rebuilds the end-of-recording state: restore the baseline captured when
// recording began, then re-apply frame-anchored controls up to the recording
// end frame. Reproduces the exact state whether or not the run was paused.
export function replayRecording(
  capacity: number,
  seed: number,
  recorder: ControlRecorder,
): SimCore {
  const core = createSimCore(capacity, seed)
  if (recorder.baselineSnapshot) {
    restoreSnapshot(core, recorder.baselineSnapshot.slice(0))
  }
  const end = recorder.frameRange.end
  let cursor = 0
  const guardMax = end - recorder.frameRange.start + recorder.messages.length + 4
  let guard = 0
  while (core.stepCount < end && guard++ < guardMax) {
    while (
      cursor < recorder.messages.length &&
      recorder.messages[cursor].frame <= core.stepCount
    ) {
      applyOneMessage(core, recorder.messages[cursor].message)
      cursor++
    }
    if (core.paused) break
    coreStep(core)
  }
  // Apply controls anchored exactly at the end frame (e.g. the final pause)
  // so the restored core carries the correct paused flag and node count.
  while (cursor < recorder.messages.length) {
    const rec = recorder.messages[cursor]
    if (rec.frame > end) break
    applyOneMessage(core, rec.message)
    cursor++
  }
  return core
}

// Replays a frame-anchored control sequence from a fresh core and returns
// hashes at the requested step numbers. Semantics: a record anchored at
// frame f arrives in the live run after f steps have already completed, so
// it is applied between the hash at f and the f -> f+1 step; records at the
// same frame apply in arrival order. The driver advances exactly one fixed
// step per frame, so results depend solely on (initial state, control
// sequence) -- never on wall clock.
export function replaySequence(
  core: SimCore,
  records: readonly RecordedControl[],
  hashFrames: readonly number[],
): { frame: number; hash: string }[] {
  const wanted = new Set(hashFrames)
  const result: { frame: number; hash: string }[] = []
  const maxStep = hashFrames[hashFrames.length - 1]
  let cursor = 0
  const drain = (): void => {
    while (cursor < records.length && records[cursor].frame <= core.stepCount) {
      applyOneMessage(core, records[cursor].message)
      cursor++
    }
  }
  let guard = 0
  const guardMax = maxStep + records.length + 2
  while (core.stepCount <= maxStep && guard++ < guardMax) {
    if (wanted.has(core.stepCount)) {
      result.push({ frame: core.stepCount, hash: stateHash(core) })
    }
    if (core.stepCount === maxStep) break
    drain()
    // Paused with no further resume record: the sequence ends here.
    if (core.paused) break
    coreStep(core)
  }
  return result
}

function applyOneMessage(core: SimCore, msg: ReplayMessage): void {
  if (msg.type === 'viewport') coreSetViewport(core, msg.width, msg.height)
  else if (msg.type === 'node-count') coreSetNodeCount(core, msg.count)
  else core.paused = msg.paused
}
