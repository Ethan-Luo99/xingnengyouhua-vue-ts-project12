import type { SimState } from './types'

export interface Grid {
  cellSize: number
  cols: number
  rows: number
  counts: Int32Array
  offsets: Int32Array
  entries: Int32Array
  cursor: Int32Array
}

export function createGrid(cellSize: number, capacity: number): Grid {
  return {
    cellSize,
    cols: 0,
    rows: 0,
    counts: new Int32Array(0),
    offsets: new Int32Array(0),
    entries: new Int32Array(capacity),
    cursor: new Int32Array(0),
  }
}

export function resizeGrid(g: Grid, width: number, height: number): void {
  const cols = Math.max(1, Math.ceil(width / g.cellSize))
  const rows = Math.max(1, Math.ceil(height / g.cellSize))
  if (cols === g.cols && rows === g.rows) return
  g.cols = cols
  g.rows = rows
  const cells = cols * rows
  g.counts = new Int32Array(cells)
  g.offsets = new Int32Array(cells + 1)
  g.cursor = new Int32Array(cells)
}

export function ensureGridCapacity(g: Grid, capacity: number): void {
  if (g.entries.length < capacity) g.entries = new Int32Array(capacity)
}

function cellOf(g: Grid, px: number, py: number): number {
  const cx = Math.min(g.cols - 1, Math.max(0, (px / g.cellSize) | 0))
  const cy = Math.min(g.rows - 1, Math.max(0, (py / g.cellSize) | 0))
  return cy * g.cols + cx
}

export function buildGrid(g: Grid, s: SimState): void {
  const { counts, offsets, entries, cursor } = g
  counts.fill(0)
  const n = s.count
  for (let i = 0; i < n; i++) {
    counts[cellOf(g, s.x[i], s.y[i])]++
  }
  let sum = 0
  for (let c = 0; c < counts.length; c++) {
    offsets[c] = sum
    cursor[c] = sum
    sum += counts[c]
  }
  offsets[counts.length] = sum
  for (let i = 0; i < n; i++) {
    entries[cursor[cellOf(g, s.x[i], s.y[i])]++] = i
  }
}
