import type { SimState } from './types'
import type { Grid } from './grid'

/**
 * Binary snapshot format (little-endian, single transferable ArrayBuffer).
 *
 * Header (64 bytes):
 *   0  magic   u32 = 0x534e5031 ('SNP1')
 *   4  version u32
 *   8  capacity u32
 *   12 count    u32
 *   16 width    f64
 *   24 height   f64
 *   32 accumulator f64
 *   40 frame    u32
 *   44 paused   u32
 *   48 rngState u32
 *   52 cellSize f32
 *   56 cols     u32
 *   60 rows     u32
 * Regions (4-byte aligned):
 *   x,y,vx,vy,radius : f32[capacity]
 *   color            : u8[capacity]
 *   grid.counts      : i32[cols*rows]
 *   grid.offsets     : i32[cols*rows+1]
 *   grid.entries     : i32[capacity]
 *
 * The grid is deterministic derived data (rebuilt wholesale at the start of
 * every collision pass), but it is included so restore is byte-for-byte
 * complete rather than lazily reconstructed.
 */

export const SNAPSHOT_MAGIC = 0x534e5031
export const SNAPSHOT_VERSION = 1
const HEADER_BYTES = 64

export interface SnapshotSource {
  state: SimState
  grid: Grid
  frame: number
  accumulator: number
  paused: boolean
}

export interface RestoredHeader {
  frame: number
  accumulator: number
  paused: boolean
  count: number
  width: number
  height: number
}

function align4(byteOffset: number): number {
  return (byteOffset + 3) & ~3
}

export function takeSnapshot(src: SnapshotSource): ArrayBuffer {
  const { state: s, grid: g } = src
  const cap = s.capacity
  let offset = HEADER_BYTES
  const regions: Array<{ view: ArrayBufferView; offset: number }> = []
  const add = (view: ArrayBufferView): number => {
    const at = offset
    regions.push({ view, offset: at })
    offset = align4(at + view.byteLength)
    return at
  }
  add(s.x)
  add(s.y)
  add(s.vx)
  add(s.vy)
  add(s.radius)
  add(s.color)
  add(g.counts)
  add(g.offsets)
  add(g.entries)

  const buffer = new ArrayBuffer(offset)
  const view = new DataView(buffer)
  view.setUint32(0, SNAPSHOT_MAGIC, true)
  view.setUint32(4, SNAPSHOT_VERSION, true)
  view.setUint32(8, cap, true)
  view.setUint32(12, s.count, true)
  view.setFloat64(16, s.width, true)
  view.setFloat64(24, s.height, true)
  view.setFloat64(32, src.accumulator, true)
  view.setUint32(40, src.frame >>> 0, true)
  view.setUint32(44, src.paused ? 1 : 0, true)
  view.setUint32(48, s.rngState[0], true)
  view.setFloat32(52, g.cellSize, true)
  view.setUint32(56, g.cols, true)
  view.setUint32(60, g.rows, true)

  const bytes = new Uint8Array(buffer)
  for (const region of regions) {
    bytes.set(
      new Uint8Array(
        region.view.buffer,
        region.view.byteOffset,
        region.view.byteLength,
      ),
      region.offset,
    )
  }
  return buffer
}

export function restoreSnapshot(
  buffer: ArrayBuffer,
  state: SimState,
  grid: Grid,
): RestoredHeader {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('snapshot too short')
  }
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== SNAPSHOT_MAGIC) {
    throw new Error('bad snapshot magic')
  }
  const version = view.getUint32(4, true)
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version ${version}`)
  }
  const cap = view.getUint32(8, true)
  if (cap !== state.capacity) {
    throw new Error(
      `snapshot capacity ${cap} != engine capacity ${state.capacity}`,
    )
  }
  const count = view.getUint32(12, true)
  const width = view.getFloat64(16, true)
  const height = view.getFloat64(24, true)
  const accumulator = view.getFloat64(32, true)
  const frame = view.getUint32(40, true)
  const paused = view.getUint32(44, true) === 1
  const rng = view.getUint32(48, true)
  const cellSize = view.getFloat32(52, true)
  const cols = view.getUint32(56, true)
  const rows = view.getUint32(60, true)
  const cells = cols * rows

  const expected = align4(
    HEADER_BYTES +
      5 * cap * 4 +
      cap +
      cells * 4 +
      (cells + 1) * 4 +
      cap * 4,
  )
  if (buffer.byteLength < expected) {
    throw new Error('snapshot truncated')
  }

  const bytes = new Uint8Array(buffer)
  let offset = HEADER_BYTES
  const copy = (dst: ArrayBufferView): void => {
    new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(
      bytes.subarray(offset, offset + dst.byteLength),
    )
    offset = align4(offset + dst.byteLength)
  }
  copy(state.x)
  copy(state.y)
  copy(state.vx)
  copy(state.vy)
  copy(state.radius)
  copy(state.color)

  state.count = count
  state.width = width
  state.height = height
  state.rngState[0] = rng

  if (grid.cols !== cols || grid.rows !== rows || grid.cellSize !== cellSize) {
    grid.cellSize = cellSize
    grid.cols = cols
    grid.rows = rows
    grid.counts = new Int32Array(cells)
    grid.offsets = new Int32Array(cells + 1)
    grid.cursor = new Int32Array(cells)
    grid.entries = new Int32Array(cap)
  }
  copy(grid.counts)
  copy(grid.offsets)
  copy(grid.entries)

  return { frame, accumulator, paused, count, width, height }
}
