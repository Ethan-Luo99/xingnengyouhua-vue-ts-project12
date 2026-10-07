import { useEffect, useRef, useState } from 'react'
import { createStageEngine } from '../engine/stage-engine'
import type { StageEngine, StageMode } from '../engine/stage-engine'
import type { FrameStats } from '../engine/sampler'
import { hashHex } from '../engine/hash'
import type { SelfTestReportMessage } from '../engine/protocol'

const NODE_OPTIONS = [500, 1000, 2000, 4000]
const MAX_CAPACITY = 4096
const INITIAL_NODE_COUNT = 1000
const DEFAULT_REPLAY_TARGET = 600

interface TimelineState {
  frame: number
  hash: number
  paused: boolean
  recording: boolean
  replaying: boolean
  messages: number
}

type SelfTestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; report: Omit<SelfTestReportMessage, 'type'> }

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<StageEngine | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [paused, setPaused] = useState(false)
  const [nodeCount, setNodeCount] = useState(INITIAL_NODE_COUNT)
  const [mode, setMode] = useState<StageMode | null>(null)
  const [timeline, setTimeline] = useState<TimelineState>({
    frame: 0,
    hash: 0,
    paused: false,
    recording: false,
    replaying: false,
    messages: 0,
  })
  const [hasRecorded, setHasRecorded] = useState(false)
  const [replayTarget, setReplayTarget] = useState(DEFAULT_REPLAY_TARGET)
  const [busy, setBusy] = useState(false)
  const [selfTest, setSelfTest] = useState<SelfTestState>({ phase: 'idle' })
  const selfTestRef = useRef(selfTest)
  useEffect(() => {
    selfTestRef.current = selfTest
  }, [selfTest])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = createStageEngine(MAX_CAPACITY)
    engineRef.current = engine
    engine.onStats = setStats
    engine.onModeChange = setMode
    engine.onTimeline = (t) => {
      setTimeline({
        frame: t.frame,
        hash: t.hash,
        paused: t.paused,
        recording: t.recording,
        replaying: t.replaying,
        messages: t.messages,
      })
      // Replay ends paused inside the engine; keep the React checkbox in sync.
      setPaused(t.paused)
      if (t.recording) setHasRecorded(true)
    }
    engine.onSelfTestReport = (report) => {
      printSelfTest(report)
      setSelfTest({ phase: 'done', report })
    }
    setMode(engine.mode)
    engine.mount(container, INITIAL_NODE_COUNT)

    let lastCssWidth = -1
    let lastCssHeight = -1
    const applySize = () => {
      const rect = container.getBoundingClientRect()
      engine.setViewport(rect.width, rect.height, window.devicePixelRatio || 1)
      lastCssWidth = rect.width
      lastCssHeight = rect.height
    }
    applySize()

    const observer = new ResizeObserver(applySize)
    observer.observe(container)

    const onWindowResize = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width !== lastCssWidth || rect.height !== lastCssHeight) return
      applySize()
    }
    window.addEventListener('resize', onWindowResize)

    let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = () => {
      applySize()
      dprQuery.removeEventListener('change', onDprChange)
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    dprQuery.addEventListener('change', onDprChange)

    // StrictMode remounts synchronously, killing the first worker before this
    // timer fires; only the surviving engine runs the automatic self-test.
    const selfTestTimer =
      new URLSearchParams(location.search).get('selftest') === '1'
        ? window.setTimeout(() => {
            setSelfTest({ phase: 'running' })
            engine.runSelfTest()
          }, 600)
        : 0

    return () => {
      window.clearTimeout(selfTestTimer)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      dprQuery.removeEventListener('change', onDprChange)
      engine.onStats = null
      engine.onModeChange = null
      engine.onTimeline = null
      engine.onSelfTestReport = null
      engine.unmount()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setNodeCount(nodeCount)
  }, [nodeCount])

  useEffect(() => {
    engineRef.current?.setPaused(paused)
  }, [paused])

  const toggleRecord = () => {
    const next = !timeline.recording
    if (next) setHasRecorded(true)
    else setReplayTarget(Math.max(timeline.frame, 1))
    engineRef.current?.setRecording(next)
  }

  const runReplay = () => {
    engineRef.current?.replay(Math.max(1, Math.floor(replayTarget)))
  }

  const runManualSelfTest = () => {
    if (selfTestRef.current.phase === 'running') return
    setSelfTest({ phase: 'running' })
    engineRef.current?.runSelfTest()
  }

  const exportSnapshot = async () => {
    const engine = engineRef.current
    if (!engine || busy) return
    setBusy(true)
    try {
      const buffer = await engine.exportSnapshot()
      const blob = new Blob([buffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `sim-snapshot-f${Math.round(stats?.frame ?? timeline.frame)}.snp`
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusy(false)
    }
  }

  const onSnapshotFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const engine = engineRef.current
    if (!file || !engine) return
    setBusy(true)
    try {
      const buffer = await file.arrayBuffer()
      const result = await engine.importSnapshot(buffer)
      setHasRecorded(false)
      setPaused(true)
      setTimeline((prev) => ({ ...prev, frame: result.frame, hash: result.hash }))
    } catch (error) {
      console.error('[snapshot] import failed', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stage">
      <div className="stage-toolbar">
        <button type="button" onClick={() => setPaused((p) => !p)}>
          {paused ? '继续' : '暂停'}
        </button>
        <div className="node-options" role="group" aria-label="节点数量">
          {NODE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              className={n === nodeCount ? 'active' : ''}
              onClick={() => setNodeCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="toolbar-sep" />
        <button
          type="button"
          className={timeline.recording ? 'recording' : ''}
          onClick={toggleRecord}
        >
          {timeline.recording ? '● 停止录制' : '录制'}
        </button>
        <label className="replay-control">
          回放至
          <input
            type="number"
            min={1}
            step={1}
            value={replayTarget}
            onChange={(event) => setReplayTarget(Number(event.target.value))}
          />
          帧
        </label>
        <button
          type="button"
          onClick={runReplay}
          disabled={!hasRecorded || timeline.replaying || busy}
        >
          回放
        </button>
        <button type="button" onClick={exportSnapshot} disabled={busy}>
          导出快照
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          导入快照
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".snp,application/octet-stream"
          className="snapshot-file"
          onChange={onSnapshotFile}
        />
        <button type="button" onClick={runManualSelfTest}>
          自检
        </button>
        {mode && (
          <span
            className={`mode-badge mode-${mode}`}
            title={
              mode === 'worker'
                ? '快照经 Transferable ArrayBuffer 跨线程零拷贝传输'
                : '回退路径无 Worker 边界；快照经结构化克隆二进制传输，回放/录制同样支持'
            }
          >
            {mode === 'worker'
              ? 'Worker + OffscreenCanvas'
              : '主线程回退 · 快照=结构化克隆'}
          </span>
        )}
        {timeline.recording && (
          <span className="tt-badge tt-record">
            REC {timeline.messages} 条消息
          </span>
        )}
        {timeline.replaying && <span className="tt-badge tt-replay">回放中</span>}
        <SelfTestBadge state={selfTest} />
        {stats && (
          <div className="stats">
            <span>帧 {Math.round(stats.frame)}</span>
            <span>哈希 {hashHex(stats.hash)}</span>
            <span>{stats.fps.toFixed(0)} fps</span>
            <span>p50 {stats.p50.toFixed(1)}ms</span>
            <span>p95 {stats.p95.toFixed(1)}ms</span>
            <span>p99 {stats.p99.toFixed(1)}ms</span>
            <span>掉帧 {(stats.dropRate * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>
      <div className="stage-canvas" ref={containerRef} />
    </div>
  )
}

function SelfTestBadge({ state }: { state: SelfTestState }) {
  if (state.phase === 'idle') return null
  if (state.phase === 'running') {
    return <span className="tt-badge tt-selftest">确定性自检中…</span>
  }
  const { report } = state
  return (
    <span
      className={`tt-badge ${report.pass ? 'tt-pass' : 'tt-fail'}`}
      title={
        report.pass
          ? `三方哈希逐点一致 · 跨线程快照往返=${
              report.snapshotRoundtrip ? 'PASS' : 'FAIL'
            }`
          : report.failures.join('\n')
      }
    >
      自检 {report.pass ? 'PASS' : 'FAIL'}
      {report.transferred ? ' · Transferable' : ' · 结构化克隆'}
    </span>
  )
}

function printSelfTest(report: Omit<SelfTestReportMessage, 'type'>): void {
  const tag = '[selftest]'
  const verdict = report.pass ? 'PASS' : 'FAIL'
  console.log(
    `${tag} 确定性自检 ${verdict} — 首跑/消息回放/快照恢复三方哈希对比，` +
      `跨线程快照往返=${report.snapshotRoundtrip ? 'PASS' : 'FAIL'}，` +
      `传输=${report.transferred ? 'Transferable' : 'structuredClone'}`,
  )
  console.log(
    `${tag} ${"帧".padEnd(5)} ${"首跑".padEnd(10)} ${"消息回放".padEnd(
      10,
    )} ${"快照恢复".padEnd(10)} 结果`,
  )
  for (const row of report.checkpoints) {
    console.log(
      `${tag} ${String(row.frame).padEnd(5)} ${row.live.padEnd(10)} ${row.replay.padEnd(
        10,
      )} ${row.snapshot.padEnd(10)} ${row.match ? 'MATCH' : 'MISMATCH'}`,
    )
  }
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`${tag} ${failure}`)
  }
}
