import { useEffect, useRef, useState } from 'react'
import { createStageEngine } from '../engine/stage-engine'
import type { StageEngine, StageMode } from '../engine/stage-engine'
import type { FrameStats } from '../engine/sampler'

const NODE_OPTIONS = [500, 1000, 2000, 4000]
const MAX_CAPACITY = 4096
const INITIAL_NODE_COUNT = 1000

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<StageEngine | null>(null)
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [paused, setPaused] = useState(false)
  const [nodeCount, setNodeCount] = useState(INITIAL_NODE_COUNT)
  const [mode, setMode] = useState<StageMode | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = createStageEngine(MAX_CAPACITY)
    engineRef.current = engine
    engine.onStats = setStats
    engine.onModeChange = setMode
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

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      dprQuery.removeEventListener('change', onDprChange)
      engine.onStats = null
      engine.onModeChange = null
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
        {mode && (
          <span className={`mode-badge mode-${mode}`}>
            {mode === 'worker' ? 'Worker + OffscreenCanvas' : '主线程回退'}
          </span>
        )}
        {stats && (
          <div className="stats">
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
