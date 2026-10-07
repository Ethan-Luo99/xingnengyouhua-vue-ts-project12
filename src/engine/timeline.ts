import type { SimCore } from './sim-core'

/**
 * Recorded control-message sequence.
 *
 * Entries are fixed-stride little-endian records in a growable ArrayBuffer
 * (no JSON, no per-entry object allocation):
 *   0 frame f64 — frame boundary at which the message was applied
 *   8 kind  u32 — 0 viewport | 1 node-count | 2 pause
 *  16 a     f64 — viewport width | node count | paused(0/1)
 *  24 b     f64 — viewport height | 0 | 0
 *
 * Append order is chronological (frame-monotonic); replay walks the same
 * order, which keeps every floating-point accumulation order identical to
 * the first run.
 */
export const CONTROL_VIEWPORT = 0
export const CONTROL_NODE_COUNT = 1
export const CONTROL_PAUSE = 2

const STRIDE = 32
const BLOCK = 16

export class ControlJournal {
  private buffer = new ArrayBuffer(BLOCK * STRIDE)
  private view = new DataView(this.buffer)
  private _length = 0

  get length(): number {
    return this._length
  }

  record(frame: number, kind: number, a = 0, b = 0): void {
    if (this._length * STRIDE >= this.buffer.byteLength) this.grow()
    const off = this._length * STRIDE
    this.view.setFloat64(off, frame, true)
    this.view.setUint32(off + 8, kind, true)
    this.view.setFloat64(off + 16, a, true)
    this.view.setFloat64(off + 24, b, true)
    this._length++
  }

  frameAt(i: number): number {
    return this.view.getFloat64(i * STRIDE, true)
  }

  kindAt(i: number): number {
    return this.view.getUint32(i * STRIDE + 8, true)
  }

  aAt(i: number): number {
    return this.view.getFloat64(i * STRIDE + 16, true)
  }

  bAt(i: number): number {
    return this.view.getFloat64(i * STRIDE + 24, true)
  }

  applyAt(core: SimCore, i: number): void {
    const kind = this.kindAt(i)
    if (kind === CONTROL_VIEWPORT) {
      core.setViewport(this.aAt(i), this.bAt(i))
    } else if (kind === CONTROL_NODE_COUNT) {
      core.setNodeCount(this.aAt(i))
    }
    // CONTROL_PAUSE only affects the scheduler, not deterministic state.
  }

  clear(): void {
    this._length = 0
  }

  private grow(): void {
    const next = new ArrayBuffer(this.buffer.byteLength * 2)
    new Uint8Array(next).set(new Uint8Array(this.buffer))
    this.buffer = next
    this.view = new DataView(next)
  }
}
