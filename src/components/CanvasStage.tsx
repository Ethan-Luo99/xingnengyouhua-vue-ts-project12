import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import type { FrameStats } from '../engine/engine'

const NODE_OPTIONS = [500, 1000, 2000, 4000]
const MAX_CAPACITY = 4096

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [paused, setPaused] = useState(false)
  const [nodeCount, setNodeCount] = useState(1000)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const engine = new Engine(MAX_CAPACITY)
    engineRef.current = engine
    engine.attach(canvas)
    engine.onStats = setStats

    const applySize = () => {
      const rect = container.getBoundingClientRect()
      engine.setViewport(rect.width, rect.height, window.devicePixelRatio || 1)
    }
    applySize()

    const observer = new ResizeObserver(applySize)
    observer.observe(container)

    let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = () => {
      applySize()
      dprQuery.removeEventListener('change', onDprChange)
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    dprQuery.addEventListener('change', onDprChange)

    engine.start()

    return () => {
      observer.disconnect()
      dprQuery.removeEventListener('change', onDprChange)
      engine.onStats = null
      engine.detach()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setNodeCount(nodeCount)
  }, [nodeCount])

  useEffect(() => {
    const engine = engineRef.current
    if (engine) engine.paused = paused
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
      <div className="stage-canvas" ref={containerRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
