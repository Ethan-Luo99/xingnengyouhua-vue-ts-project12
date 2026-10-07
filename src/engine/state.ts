import type { SimState } from './types'

export const PALETTE = [
  '#7c6cf0',
  '#4cc9f0',
  '#f72585',
  '#ffd166',
  '#06d6a0',
  '#ef8354',
]

/** Fixed seed for the canonical initial state; same seed => same nodes. */
export const DEFAULT_SEED = 0x9e3779b9

export function createSimState(capacity: number): SimState {
  return {
    count: 0,
    capacity,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    color: new Uint8Array(capacity),
    rngState: new Uint32Array([DEFAULT_SEED]),
    width: 0,
    height: 0,
  }
}

/**
 * Deterministic PRNG (mulberry32). State lives inside SimState so it is
 * snapshotted/replayed together with the SoA buffers. No Math.random is
 * allowed anywhere in the deterministic kernel.
 */
export function nextRandom(s: SimState): number {
  let z = s.rngState[0] + 0x6d2b79f5
  s.rngState[0] = z
  z = Math.imul(z ^ (z >>> 15), z | 1)
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296
}

function seedNode(s: SimState, i: number): void {
  s.x[i] = nextRandom(s) * s.width
  s.y[i] = nextRandom(s) * s.height
  const angle = nextRandom(s) * Math.PI * 2
  const speed = 20 + nextRandom(s) * 60
  s.vx[i] = Math.cos(angle) * speed
  s.vy[i] = Math.sin(angle) * speed
  s.radius[i] = 2.5 + nextRandom(s) * 3.5
  s.color[i] = i % PALETTE.length
}

export function setNodeCount(s: SimState, n: number): void {
  const target = Math.max(0, Math.min(n, s.capacity))
  if (target > s.count) {
    for (let i = s.count; i < target; i++) seedNode(s, i)
  }
  s.count = target
}
