import type { SimState } from './types'

/**
 * Deterministic 32-bit FNV-1a hash over the simulation state.
 *
 * Coverage: all SoA node buffers over [0, count), plus width/height/count and
 * RNG state. The accumulator and wall clock are intentionally excluded: they
 * are scheduling state, and two runs driven by the same fixed-step message
 * sequence must hash equal even if their RAF timing differed.
 */
export function hashState(s: SimState): number {
  let h = 0x811c9dc5
  const mixBytes = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
  }
  const mixView = (view: ArrayBufferView, activeBytes: number): void => {
    mixBytes(
      new Uint8Array(view.buffer, view.byteOffset, activeBytes),
    )
  }
  mixView(s.x, s.count * 4)
  mixView(s.y, s.count * 4)
  mixView(s.vx, s.count * 4)
  mixView(s.vy, s.count * 4)
  mixView(s.radius, s.count * 4)
  mixView(s.color, s.count)

  const scalars = new ArrayBuffer(24)
  const dv = new DataView(scalars)
  dv.setFloat64(0, s.width, true)
  dv.setFloat64(8, s.height, true)
  dv.setUint32(16, s.count, true)
  dv.setUint32(20, s.rngState[0], true)
  mixBytes(new Uint8Array(scalars))
  return h >>> 0
}

export function hashHex(h: number): string {
  return h.toString(16).padStart(8, '0')
}
