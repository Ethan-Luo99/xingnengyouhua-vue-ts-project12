import { SimCore } from './sim-core'
import {
  CONTROL_NODE_COUNT,
  CONTROL_PAUSE,
  CONTROL_VIEWPORT,
  ControlJournal,
} from './timeline'
import { hashState, hashHex } from './hash'
import { restoreSnapshot, takeSnapshot } from './snapshot'

export const SELFTEST_FRAMES = 600
export const SELFTEST_INTERVAL = 60

export interface ScriptedControl {
  frame: number
  kind: number
  a: number
  b?: number
}

export interface CheckpointRow {
  frame: number
  live: string
  replay: string
  snapshot: string
  match: boolean
}

export interface SelfTestReport {
  pass: boolean
  /** true when snapshot buffers physically crossed a worker boundary. */
  transferred: boolean
  /** hash after restoring the round-tripped snapshot at frame 300. */
  snapshotRoundtrip: boolean
  checkpoints: CheckpointRow[]
  failures: string[]
}

/**
 * Deterministic script: exercises all three control kinds, including raising
 * node count mid-run (advances the seeded RNG) and a viewport resize.
 */
export function selftestScript(capacity: number): ScriptedControl[] {
  return [
    { frame: 0, kind: CONTROL_VIEWPORT, a: 1000, b: 600 },
    { frame: 0, kind: CONTROL_NODE_COUNT, a: Math.min(1000, capacity) },
    { frame: 90, kind: CONTROL_PAUSE, a: 1 },
    { frame: 150, kind: CONTROL_PAUSE, a: 0 },
    { frame: 200, kind: CONTROL_VIEWPORT, a: 900, b: 540 },
    {
      frame: 300,
      kind: CONTROL_NODE_COUNT,
      a: Math.min(2000, capacity),
    },
  ]
}

export interface DeterministicRun {
  journal: ControlJournal
  frames: number[]
  live: Map<number, number>
  baseline: ArrayBuffer
  snapshot300: ArrayBuffer
}

/** Run the script from a brand-new core, recording the control journal. */
export function runDeterministic(capacity: number): DeterministicRun {
  const core = new SimCore(capacity)
  const journal = new ControlJournal()
  const controls = selftestScript(capacity)
  const live = new Map<number, number>()
  const frames: number[] = []
  let baseline = new ArrayBuffer(0)
  let snapshot300 = new ArrayBuffer(0)

  for (let target = 0; target <= SELFTEST_FRAMES; target++) {
    while (controls.length > 0 && controls[0].frame === target) {
      const control = controls.shift()!
      journal.record(target, control.kind, control.a, control.b ?? 0)
      journal.applyAt(core, journal.length - 1)
    }
    if (target === 0) {
      baseline = takeSnapshot({
        state: core.state,
        grid: core.grid,
        frame: 0,
        accumulator: 0,
        paused: false,
      })
    }
    if (target > 0) core.step()
    if (target === 300) {
      snapshot300 = takeSnapshot({
        state: core.state,
        grid: core.grid,
        frame: core.frameCount,
        accumulator: 0,
        paused: false,
      })
    }
    if (target % SELFTEST_INTERVAL === 0) {
      frames.push(target)
      live.set(target, hashState(core.state))
    }
  }
  return { journal, frames, live, baseline, snapshot300 }
}

function replayTo(
  core: SimCore,
  journal: ControlJournal,
  startFrame: number,
  frames: number[],
): Map<number, number> {
  const want = new Set(frames)
  const out = new Map<number, number>()
  let idx = 0
  while (idx < journal.length && journal.frameAt(idx) < startFrame) idx++
  for (let f = startFrame; f <= SELFTEST_FRAMES; f++) {
    while (idx < journal.length && journal.frameAt(idx) === f) {
      journal.applyAt(core, idx)
      idx++
    }
    if (f > startFrame) core.step()
    if (want.has(f)) out.set(f, hashState(core.state))
  }
  return out
}

/** Journal replay leg: fresh core + same message sequence. */
export function replayJournal(
  capacity: number,
  journal: ControlJournal,
  frames: number[],
): Map<number, number> {
  return replayTo(new SimCore(capacity), journal, 0, frames)
}

/**
 * Snapshot leg: restore the round-tripped frame-0 snapshot into a fresh core,
 * then replay the same message sequence. Mirrors the user-facing
 * export → import → continue flow.
 */
export function restoreBaselineAndReplay(
  capacity: number,
  journal: ControlJournal,
  baseline: ArrayBuffer,
  frames: number[],
): Map<number, number> {
  const core = new SimCore(capacity)
  restoreSnapshot(baseline, core.state, core.grid)
  return replayTo(core, journal, 0, frames)
}

/**
 * Mid-run snapshot leg: restore the round-tripped frame-300 snapshot into a
 * fresh core, then apply only post-300 controls and continue stepping.
 */
export function restoreSnapshot300AndContinue(
  capacity: number,
  journal: ControlJournal,
  snapshot300: ArrayBuffer,
  frames: number[],
): Map<number, number> {
  const core = new SimCore(capacity)
  const header = restoreSnapshot(snapshot300, core.state, core.grid)
  core.setFrame(header.frame)
  core.setViewport(header.width, header.height)
  const want = new Set(frames)
  const out = new Map<number, number>()
  let idx = 0
  while (idx < journal.length && journal.frameAt(idx) <= 300) idx++
  if (want.has(300)) out.set(300, hashState(core.state))
  for (let f = 301; f <= SELFTEST_FRAMES; f++) {
    while (idx < journal.length && journal.frameAt(idx) === f) {
      journal.applyAt(core, idx)
      idx++
    }
    core.step()
    if (want.has(f)) out.set(f, hashState(core.state))
  }
  return out
}

/**
 * Full snapshot leg: pre-300 checkpoints come from restoring the frame-0
 * snapshot and replaying; post-300 checkpoints come from restoring the
 * mid-run frame-300 snapshot and continuing. Both snapshots have crossed the
 * transfer boundary (Transferable or structuredClone) by this point.
 */
export function snapshotRestoreLeg(
  capacity: number,
  journal: ControlJournal,
  baseline: ArrayBuffer,
  snapshot300: ArrayBuffer,
  frames: number[],
): Map<number, number> {
  const early = restoreBaselineAndReplay(
    capacity,
    journal,
    baseline,
    frames.filter((f) => f <= 300),
  )
  const late = restoreSnapshot300AndContinue(
    capacity,
    journal,
    snapshot300,
    frames.filter((f) => f > 300),
  )
  for (const [frame, hash] of late) early.set(frame, hash)
  return early
}

/** Verify the round-tripped mid-run snapshot hashes identically at frame 300. */
export function verifyRestoredSnapshot(
  capacity: number,
  snapshot300: ArrayBuffer,
): number {
  const core = new SimCore(capacity)
  const header = restoreSnapshot(snapshot300, core.state, core.grid)
  core.setViewport(header.width, header.height)
  return hashState(core.state)
}

export function buildReport(
  run: DeterministicRun,
  replayHashes: Map<number, number>,
  snapshotHashes: Map<number, number>,
  roundtripHash: number | null,
  transferred: boolean,
): SelfTestReport {
  const failures: string[] = []
  const live300 = run.live.get(300) ?? 0
  const snapshotRoundtrip = roundtripHash === live300
  if (roundtripHash !== null && !snapshotRoundtrip) {
    failures.push(
      `snapshot roundtrip @300: live ${hashHex(live300)} restored ${hashHex(
        roundtripHash,
      )}`,
    )
  }

  const checkpoints: CheckpointRow[] = run.frames.map((frame) => {
    const live = run.live.get(frame) ?? 0
    const replay = replayHashes.get(frame)
    const snapshot = snapshotHashes.get(frame)
    const match = replay === live && snapshot === live
    if (!match) {
      failures.push(
        `frame ${frame}: live ${hashHex(live)} replay ${
          replay === undefined ? 'missing' : hashHex(replay)
        } snapshot ${snapshot === undefined ? 'missing' : hashHex(snapshot)}`,
      )
    }
    return {
      frame,
      live: hashHex(live),
      replay: replay === undefined ? 'missing' : hashHex(replay),
      snapshot: snapshot === undefined ? 'missing' : hashHex(snapshot),
      match,
    }
  })

  return {
    pass: failures.length === 0,
    transferred,
    snapshotRoundtrip,
    checkpoints,
    failures,
  }
}
