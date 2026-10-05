// StrictMode lifecycle verification (dev double-invokes effects).
// Tracks dedicated worker targets across initial mount, reload and navigation.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'

const url = process.argv[2]
const chromeBin = join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
await readFile(chromeBin)
const userData = await mkdtemp(join(tmpdir(), 'life-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
  '--no-first-run', '--disable-gpu', '--force-device-scale-factor=2',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: '/tmp/deps/usr/lib/x86_64-linux-gnu' } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 50; i++) {
  try {
    var wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl
    break
  } catch { await sleep(100) }
}
const ws = new WebSocket(wsUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

let id = 1
const pend = new Map()
const workerState = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id != null && pend.has(`${m.id}:${m.sessionId ?? ''}`)) {
    const { resolve, reject } = pend.get(`${m.id}:${m.sessionId ?? ''}`)
    pend.delete(`${m.id}:${m.sessionId ?? ''}`)
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
  }
  if (m.method === 'Target.targetCreated' && m.params?.targetInfo?.type === 'worker') {
    workerState.set(m.params.targetInfo.targetId, 'alive')
  }
  if (m.method === 'Target.targetDestroyed' && workerState.has(m.params.targetId)) {
    workerState.set(m.params.targetId, 'destroyed')
  }
}
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = id++
  pend.set(`${i}:${sid ?? ''}`, { resolve: res, reject: rej })
  ws.send(JSON.stringify({ id: i, method, params, sessionId: sid }))
})
const stat = () => {
  let alive = 0, destroyed = 0
  for (const v of workerState.values()) {
    if (v === 'alive') alive++; else destroyed++
  }
  return { workersCreated: workerState.size, workersAlive: alive, workersDestroyed: destroyed }
}

await send('Target.setDiscoverTargets', { discover: true })
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, sessionId)
await send('Page.enable', {}, sessionId)

const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value

await send('Page.navigate', { url }, sessionId)
await sleep(4000)
const initial = {
  ...(await evalJs(`(() => ({
    badge: document.querySelector('.mode-badge')?.textContent || 'none',
    canvases: document.querySelectorAll('canvas').length,
  }))()`)),
  ...stat(),
}

await send('Page.reload', { ignoreCache: true }, sessionId)
await sleep(4000)
const afterReload = {
  canvases: await evalJs(`document.querySelectorAll('canvas').length`),
  badge: await evalJs(`document.querySelector('.mode-badge')?.textContent`),
  ...stat(),
}

await send('Page.navigate', { url: 'about:blank' }, sessionId)
await sleep(2500)
const afterLeave = stat()

await send('Page.navigate', { url }, sessionId)
await sleep(4000)
const afterReturn = {
  canvases: await evalJs(`document.querySelectorAll('canvas').length`),
  badge: await evalJs(`document.querySelector('.mode-badge')?.textContent`),
  ...stat(),
}

console.log(JSON.stringify({ initial, afterReload, afterLeave, afterReturn }, null, 2))
ws.close()
chrome.kill()
process.exit(0)
