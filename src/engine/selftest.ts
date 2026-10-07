import {
  DEFAULT_SEED,
  coreSetNodeCount,
  coreSetViewport,
  coreStep,
  createSimCore,
} from './sim-kernel'
import type { SelftestCheckpoint } from './protocol'
import {
  ControlRecorder,
  exportSnapshot,
  replaySequence,
  restoreSnapshot,
  stateHash,
} from './time-travel'

export interface SelftestResult {
  pass: boolean
  checkpoints: SelftestCheckpoint[]
  summary: string
}

// Deterministic self-check, independent of rendering and wall clock:
//  1. live reference: fresh core + fixed initial controls, 600 fixed steps,
//     hashing every 60 frames;
//  2. snapshot recovery: at each checkpoint replay to it, serialize a
//     snapshot, restore into a second core, hash;
//  3. message replay: replay the recorded control sequence from scratch on
//     a third core, hash at the same checkpoints;
//  4. all three hashes must agree bit-for-bit at every checkpoint.
export function runSelftest(
  capacity: number,
  seed: number = DEFAULT_SEED,
  totalFrames = 600,
  interval = 60,
): SelftestResult {
  const frames: number[] = []
  for (let f = interval; f <= totalFrames; f += interval) frames.push(f)

  const recorder = new ControlRecorder()
  recorder.start()
  recorder.record(0, { type: 'viewport', width: 1280, height: 720, dpr: 1 })
  recorder.record(0, { type: 'node-count', count: 1000 })
  recorder.record(0, { type: 'pause', paused: false })

  // 1. Live reference run.
  const live = createSimCore(capacity, seed)
  coreSetViewport(live, 1280, 720)
  coreSetNodeCount(live, 1000)
  const liveHashes = new Map<number, string>()
  for (const f of frames) {
    while (live.stepCount < f) coreStep(live)
    liveHashes.set(f, stateHash(live))
  }

  // 2. Snapshot export -> import round trip at every checkpoint.
  const snapshotHashes = new Map<number, string>()
  for (const f of frames) {
    const target = createSimCore(capacity, seed)
    replaySequence(target, recorder.messages, [f])
    const snap = exportSnapshot(target, f, seed)
    const restored = createSimCore(capacity, seed)
    restoreSnapshot(restored, snap.payload.buffer.slice(0))
    snapshotHashes.set(f, stateHash(restored))
  }

  // 3. Pure control-sequence replay.
  const replayCore = createSimCore(capacity, seed)
  const rows = replaySequence(replayCore, recorder.messages, frames)
  const replayHashes = new Map<number, string>()
  for (const row of rows) replayHashes.set(row.frame, row.hash)
  recorder.stop()

  let allPass = true
  const checkpoints: SelftestCheckpoint[] = frames.map((f) => {
    const liveHash = liveHashes.get(f) ?? 'missing'
    const snapshotHash = snapshotHashes.get(f) ?? 'missing'
    const replayHash = replayHashes.get(f) ?? 'missing'
    const pass = liveHash === snapshotHash && liveHash === replayHash
    if (!pass) allPass = false
    return {
      frame: f,
      live: liveHash,
      snapshot: snapshotHash,
      replay: replayHash,
      pass,
    }
  })

  const summary = allPass
    ? `selftest PASS: live/snapshot/replay hashes match at ${frames.length} checkpoints`
    : `selftest FAIL: hash mismatch among ${frames.length} checkpoints`
  // eslint-disable-next-line no-console
  console.log(summary)
  for (const c of checkpoints) {
    // eslint-disable-next-line no-console
    console.log(
      `  frame ${String(c.frame).padStart(3)} live=${c.live} ` +
        `snapshot=${c.snapshot} replay=${c.replay} ${c.pass ? 'PASS' : 'FAIL'}`,
    )
  }
  return { pass: allPass, checkpoints, summary }
}
