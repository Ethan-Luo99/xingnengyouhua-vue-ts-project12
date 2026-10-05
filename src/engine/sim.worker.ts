import { Engine } from './engine'
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol'

// 模拟状态唯一所有权在 Worker 侧：Engine 实例在此创建、步进并绘制到
// 转移过来的 OffscreenCanvas，主线程不持有任何每帧数据。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void
}

let engine: Engine | null = null

scope.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'init': {
      engine = new Engine(msg.capacity)
      engine.attach(msg.canvas)
      engine.setViewport(msg.width, msg.height, msg.dpr)
      engine.setNodeCount(msg.nodeCount)
      engine.paused = msg.paused
      engine.onStats = (stats) => scope.postMessage({ type: 'stats', stats })
      engine.start()
      scope.postMessage({ type: 'ready' })
      break
    }
    case 'resize':
      engine?.setViewport(msg.width, msg.height, msg.dpr)
      break
    case 'setNodeCount':
      engine?.setNodeCount(msg.count)
      break
    case 'setPaused':
      if (engine) engine.paused = msg.paused
      break
    case 'start':
      engine?.start()
      break
    case 'stop':
      engine?.stop()
      break
  }
}
