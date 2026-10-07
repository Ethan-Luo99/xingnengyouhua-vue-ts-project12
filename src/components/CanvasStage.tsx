import { useEffect, useRef, useState } from 'react'
import { createStageEngine } from '../engine/stage-engine'
import type { HudStats, StageEngine, StageMode } from '../engine/stage-engine'
import type { SelftestResultMessage } from '../engine/protocol'

const NODE_OPTIONS = [500, 1000, 2000, 4000]
const MAX_CAPACITY = 4096
const INITIAL_NODE_COUNT = 1000

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<StageEngine | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [stats, setStats] = useState<HudStats | null>(null)
  const [paused, setPaused] = useState(false)
  const [nodeCount, setNodeCount] = useState(INITIAL_NODE_COUNT)
  const [mode, setMode] = useState<StageMode | null>(null)
  const [recording, setRecording] = useState(false)
  const [hasRecording, setHasRecording] = useState(false)
  const [selftest, setSelftest] = useState<SelftestResultMessage | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = createStageEngine(MAX_CAPACITY)
    engineRef.current = engine
    engine.onStats = setStats
    engine.onModeChange = setMode
    engine.onSelftest = (result) => setSelftest(result)
    setMode(engine.mode)
    engine.mount(container, INITIAL_NODE_COUNT)

    // Test-only escape hatch (opt-in query param): lets headless CDP tests
    // exercise snapshot export/import through the real engine protocol.
    if (new URLSearchParams(location.search).has('enginehook')) {
      ;(window as unknown as { __simEngine?: StageEngine }).__simEngine = engine
    }

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

    const selftestRequested = new URLSearchParams(location.search).has('selftest')
    if (selftestRequested) {
      // Worker mode starts after the init handshake; main-thread fallback is
      // ready synchronously after mount.
      if (engine.mode === 'main') {
        engine.startSelftest()
      } else {
        engine.onReady = () => engine.startSelftest()
      }
    }

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      dprQuery.removeEventListener('change', onDprChange)
      engine.onStats = null
      engine.onModeChange = null
      engine.onSelftest = null
      engine.onReady = null
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

  useEffect(() => {
    if (!selftest) return
    // Surface the worker-side result on the page console too.
    // eslint-disable-next-line no-console
    console.log(selftest.summary)
    for (const c of selftest.checkpoints) {
      // eslint-disable-next-line no-console
      console.log(
        `  frame ${String(c.frame).padStart(3)} live=${c.live} ` +
          `snapshot=${c.snapshot} replay=${c.replay} ${c.pass ? 'PASS' : 'FAIL'}`,
      )
    }
  }, [selftest])

  const toggleRecording = () => {
    const next = !recording
    setRecording(next)
    if (!next) setHasRecording(true)
    engineRef.current?.setRecording(next)
  }

  const replay = () => {
    engineRef.current?.replayToCurrentFrame()
  }

  const exportSnap = async () => {
    const engine = engineRef.current
    if (!engine) return
    const buffer = await engine.exportSnapshot()
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sim-snapshot-f${stats?.frame ?? 0}.bin`
    link.click()
    URL.revokeObjectURL(url)
  }

  const onImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    file.arrayBuffer().then((buffer) => engineRef.current?.importSnapshot(buffer))
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
        <div className="timetravel" role="group" aria-label="时间旅行">
          <button
            type="button"
            className={recording ? 'recording' : ''}
            onClick={toggleRecording}
          >
            {recording ? '停止录制' : '录制'}
          </button>
          <button type="button" onClick={replay} disabled={!hasRecording}>
            回放
          </button>
          <button type="button" onClick={exportSnap}>
            导出快照
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            导入快照
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            hidden
            onChange={onImportFile}
          />
        </div>
        {mode && (
          <span className={`mode-badge mode-${mode}`}>
            {mode === 'worker' ? 'Worker + OffscreenCanvas' : '主线程回退'}
          </span>
        )}
        {selftest && (
          <span
            className={`mode-badge selftest-${selftest.pass ? 'pass' : 'fail'}`}
          >
            自检 {selftest.pass ? 'PASS' : 'FAIL'}
          </span>
        )}
        {stats && (
          <div className="stats">
            <span>帧 {stats.frame}</span>
            <span>哈希 {stats.hash}</span>
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
