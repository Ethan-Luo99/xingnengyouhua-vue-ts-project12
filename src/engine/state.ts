import type { SimState } from './types'

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

function seedNode(s: SimState, i: number): void {
  s.x[i] = Math.random() * s.width
  s.y[i] = Math.random() * s.height
  const angle = Math.random() * Math.PI * 2
  const speed = 20 + Math.random() * 60
  s.vx[i] = Math.cos(angle) * speed
  s.vy[i] = Math.sin(angle) * speed
  s.radius[i] = 2.5 + Math.random() * 3.5
  s.color[i] = i % PALETTE.length
}

export function setNodeCount(s: SimState, n: number): void {
  const target = Math.max(0, Math.min(n, s.capacity))
  if (target > s.count) {
    for (let i = s.count; i < target; i++) seedNode(s, i)
  }
  s.count = target
}
