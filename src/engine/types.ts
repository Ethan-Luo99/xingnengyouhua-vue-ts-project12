export interface SimState {
  count: number
  capacity: number
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  radius: Float32Array
  color: Uint8Array
  /** Deterministic PRNG state (mulberry32). One element is enough. */
  rngState: Uint32Array
  width: number
  height: number
}

export type SimPass = (s: SimState, dt: number) => void
