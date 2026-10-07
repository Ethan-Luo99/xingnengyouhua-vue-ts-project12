import type { SimState } from './types'
import type { DeterministicRng } from './rng'

export const PALETTE = [
  '#7c6cf0',
  '#4cc9f0',
  '#f72585',
  '#ffd166',
  '#06d6a0',
  '#ef8354',
]

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
    width: 0,
    height: 0,
  }
}

function seedNode(s: SimState, i: number, rng: DeterministicRng): void {
  s.x[i] = rng.next() * s.width
  s.y[i] = rng.next() * s.height
  const angle = rng.next() * Math.PI * 2
  const speed = 20 + rng.next() * 60
  s.vx[i] = Math.cos(angle) * speed
  s.vy[i] = Math.sin(angle) * speed
  s.radius[i] = 2.5 + rng.next() * 3.5
  s.color[i] = i % PALETTE.length
}

export function setNodeCount(
  s: SimState,
  n: number,
  rng: DeterministicRng,
): void {
  const target = Math.max(0, Math.min(n, s.capacity))
  if (target > s.count) {
    for (let i = s.count; i < target; i++) seedNode(s, i, rng)
  }
  s.count = target
}
