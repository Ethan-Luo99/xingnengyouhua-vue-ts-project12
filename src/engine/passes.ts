import type { SimState, SimPass } from './types'
import type { Grid } from './grid'
import { buildGrid } from './grid'

const CENTER_PULL = 1.2
const RESTITUTION = 0.9
const DAMPING = 0.999

export function applyForces(s: SimState, dt: number): void {
  const cx = s.width * 0.5
  const cy = s.height * 0.5
  for (let i = 0; i < s.count; i++) {
    s.vx[i] += (cx - s.x[i]) * CENTER_PULL * dt
    s.vy[i] += (cy - s.y[i]) * CENTER_PULL * dt
  }
}

export function makeCollisionPass(grid: Grid): SimPass {
  return (s: SimState, _dt: number): void => {
    buildGrid(grid, s)
    const { cols, rows, offsets, entries } = grid
    const { x, y, vx, vy, radius } = s
    const n = s.count
    for (let i = 0; i < n; i++) {
      const xi = x[i]
      const yi = y[i]
      const ri = radius[i]
      const ccx = Math.min(cols - 1, Math.max(0, (xi / grid.cellSize) | 0))
      const ccy = Math.min(rows - 1, Math.max(0, (yi / grid.cellSize) | 0))
      const cy0 = Math.max(0, ccy - 1)
      const cy1 = Math.min(rows - 1, ccy + 1)
      const cx0 = Math.max(0, ccx - 1)
      const cx1 = Math.min(cols - 1, ccx + 1)
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const cell = cy * cols + cx
          const end = offsets[cell + 1]
          for (let k = offsets[cell]; k < end; k++) {
            const j = entries[k]
            if (j <= i) continue
            const dx = x[j] - xi
            const dy = y[j] - yi
            const minDist = ri + radius[j]
            const d2 = dx * dx + dy * dy
            if (d2 >= minDist * minDist || d2 < 1e-6) continue
            const d = Math.sqrt(d2)
            const nx = dx / d
            const ny = dy / d
            const push = (minDist - d) * 0.5
            x[i] -= nx * push
            y[i] -= ny * push
            x[j] += nx * push
            y[j] += ny * push
            const rvn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny
            if (rvn < 0) {
              const imp = -rvn * 0.5 * RESTITUTION
              vx[i] -= nx * imp
              vy[i] -= ny * imp
              vx[j] += nx * imp
              vy[j] += ny * imp
            }
          }
        }
      }
    }
  }
}

export function integrate(s: SimState, dt: number): void {
  const { x, y, vx, vy, radius } = s
  const w = s.width
  const h = s.height
  for (let i = 0; i < s.count; i++) {
    let nvx = vx[i] * DAMPING
    let nvy = vy[i] * DAMPING
    let nx = x[i] + nvx * dt
    let ny = y[i] + nvy * dt
    const r = radius[i]
    if (nx < r) {
      nx = r
      nvx = -nvx * RESTITUTION
    } else if (nx > w - r) {
      nx = w - r
      nvx = -nvx * RESTITUTION
    }
    if (ny < r) {
      ny = r
      nvy = -nvy * RESTITUTION
    } else if (ny > h - r) {
      ny = h - r
      nvy = -nvy * RESTITUTION
    }
    x[i] = nx
    y[i] = ny
    vx[i] = nvx
    vy[i] = nvy
  }
}
