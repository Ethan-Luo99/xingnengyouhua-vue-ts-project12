import type { SimState } from './types'
import { PALETTE } from './state'

const SPRITE_SIZE = 32

export function createSprites(): HTMLCanvasElement[] {
  return PALETTE.map((color) => {
    const c = document.createElement('canvas')
    c.width = SPRITE_SIZE
    c.height = SPRITE_SIZE
    const g = c.getContext('2d')!
    const half = SPRITE_SIZE / 2
    const grad = g.createRadialGradient(half, half, 0, half, half, half)
    grad.addColorStop(0, color)
    grad.addColorStop(0.75, color)
    grad.addColorStop(1, `${color}00`)
    g.fillStyle = grad
    g.beginPath()
    g.arc(half, half, half - 1, 0, Math.PI * 2)
    g.fill()
    return c
  })
}

export function render(
  ctx: CanvasRenderingContext2D,
  s: SimState,
  sprites: HTMLCanvasElement[],
): void {
  ctx.clearRect(0, 0, s.width, s.height)
  const { x, y, radius, color } = s
  for (let i = 0; i < s.count; i++) {
    const r = radius[i]
    ctx.drawImage(sprites[color[i]], x[i] - r, y[i] - r, r * 2, r * 2)
  }
}
