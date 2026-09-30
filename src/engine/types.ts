export interface SimState {
  count: number
  capacity: number
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  radius: Float32Array
  color: Uint8Array
  width: number
  height: number
}

export type SimPass = (s: SimState, dt: number) => void
