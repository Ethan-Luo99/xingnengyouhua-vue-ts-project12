import { useEffect, useRef, useState } from 'react'
import { Engine } from '../engine/engine'
import type { FrameStats } from '../engine/engine'
import type { EngineHandle } from '../engine/handle'
import { canUseWorkerEngine, WorkerEngine } from '../engine/workerEngine'

const NODE_OPTIONS = [500, 1000, 2000, 4000]
const MAX_CAPACITY = 4096

// 供冒烟测试与调试的 URL 覆盖参数：?engine=worker|main&nodes=2000
const params = new URLSearchParams(window.location.search)
const forcedEngine = params.get('engine')
const initialNodes = (() => {
  const n = Number(params.get('nodes'))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CAPACITY) : 1000
})()

function createEngine(canvas: HTMLCanvasElement): EngineHandle {
  if (forcedEngine !== 'main' && canUseWorkerEngine()) {
    try {
      const engine = new WorkerEngine(MAX_CAPACITY)
      engine.attach(canvas)
      return engine
    } catch {
      // Worker 构造或 OffscreenCanvas 转移失败时回退主线程实现。
    }
  }
  const engine = new Engine(MAX_CAPACITY)
  engine.attach(canvas)
  return engine
}

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<EngineHandle | null>(null)
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [paused, setPaused] = useState(false)
  const [nodeCount, setNodeCount] = useState(initialNodes)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 每次挂载新建 canvas 元素：transferControlToOffscreen 会永久
    // 转移画布控制权，StrictMode 重挂时必须使用全新元素。
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)

    const engine = createEngine(canvas)
    engineRef.current = engine
    engine.onStats = setStats

    const applySize = () => {
      const rect = container.getBoundingClientRect()
      engine.setViewport(rect.width, rect.height, window.devicePixelRatio || 1)
    }
    applySize()

    const observer = new ResizeObserver(applySize)
    observer.observe(container)

    // matchMedia 在真实浏览器跨屏拖动时即时触发；低频轮询兜底
    // （部分环境 DPR 变化不下发 change 事件）。4Hz 读一个缓存值，
    // 不属于每帧计算。
    let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = () => {
      applySize()
      dprQuery.removeEventListener('change', onDprChange)
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    dprQuery.addEventListener('change', onDprChange)
    let lastDpr = window.devicePixelRatio
    const dprPoll = setInterval(() => {
      if (window.devicePixelRatio !== lastDpr) {
        lastDpr = window.devicePixelRatio
        onDprChange()
      }
    }, 250)

    engine.start()

    return () => {
      observer.disconnect()
      dprQuery.removeEventListener('change', onDprChange)
      clearInterval(dprPoll)
      engine.onStats = null
      engine.detach()
      canvas.remove()
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
      </div>
    </div>
  )
}
