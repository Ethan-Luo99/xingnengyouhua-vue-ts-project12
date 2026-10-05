export interface FrameStats {
  fps: number
  p50: number
  p95: number
  p99: number
  dropRate: number
}

const SAMPLE_SIZE = 600
const DROP_THRESHOLD_MS = 32

export class FrameStatsSampler {
  private readonly samples = new Float32Array(SAMPLE_SIZE)
  private readonly sorted = new Float32Array(SAMPLE_SIZE)
  private sampleIdx = 0
  private sampleCount = 0

  record(frameMs: number): void {
    this.samples[this.sampleIdx] = frameMs
    this.sampleIdx = (this.sampleIdx + 1) % SAMPLE_SIZE
    if (this.sampleCount < SAMPLE_SIZE) this.sampleCount++
  }

  snapshot(): FrameStats {
    const n = this.sampleCount
    this.sorted.set(this.samples.subarray(0, n))
    const arr = this.sorted.subarray(0, n)
    arr.sort()
    let sum = 0
    let dropped = 0
    for (let i = 0; i < n; i++) {
      sum += this.samples[i]
      if (this.samples[i] > DROP_THRESHOLD_MS) dropped++
    }
    const pick = (q: number): number => arr[Math.min(n - 1, Math.floor(n * q))]
    return {
      fps: 1000 / (sum / n),
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      dropRate: dropped / n,
    }
  }

  get hasEnoughSamples(): boolean {
    return this.sampleCount >= 30
  }
}
