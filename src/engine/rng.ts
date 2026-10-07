// Deterministic, seedable PRNG (Mulberry32). The simulation never calls
// Math.random(): every random choice comes from this stream, whose 32-bit
// state is captured in snapshots so it can be rewound and resumed.
export class DeterministicRng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  get value(): number {
    return this.state >>> 0
  }

  set value(next: number) {
    this.state = next >>> 0
  }
}
