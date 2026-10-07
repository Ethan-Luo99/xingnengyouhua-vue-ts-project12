import { WorkerRuntime } from './worker-runtime'
import { DEFAULT_SEED } from './sim-kernel'
import type {
  InitMessage,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from './protocol'

interface SimWorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

const scope = globalThis as unknown as SimWorkerScope
const pending: MainToWorkerMessage[] = []
let runtime: WorkerRuntime | null = null

scope.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data
  if (runtime) {
    runtime.handleMessage(msg)
    return
  }
  if (msg.type !== 'init') {
    pending.push(msg)
    return
  }
  const init = msg as InitMessage
  runtime = new WorkerRuntime(
    init.capacity,
    init.canvas,
    scope,
    init.seed ?? DEFAULT_SEED,
  )
  for (const queued of pending) runtime.handleMessage(queued)
  pending.length = 0
  runtime.start()
  scope.postMessage({ type: 'ready' })
})
