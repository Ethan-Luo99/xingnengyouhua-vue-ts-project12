// Verify viewport/DPR messages keep backing store in sync with CSS size.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'

const url = process.argv[2]
const mode = process.argv[3] || ''
const chromeBin = join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
await readFile(chromeBin)
const userData = await mkdtemp(join(tmpdir(), 'resize-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,800', 'about:blank',
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id != null && pend.has(`${m.id}:${m.sessionId ?? ''}`)) {
    const { resolve, reject } = pend.get(`${m.id}:${m.sessionId ?? ''}`)
    pend.delete(`${m.id}:${m.sessionId ?? ''}`)
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
  }
}
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = id++
  pend.set(`${i}:${sid ?? ''}`, { resolve: res, reject: rej })
  ws.send(JSON.stringify({ id: i, method, params, sessionId: sid }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)

const samples = []
async function applyViewport(width, height, dpr) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId)
  // Real browsers fire window resize on cross-monitor moves; emulate that.
  await send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('resize'))` }, sessionId)
  await sleep(1500)
  return send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.querySelector('canvas')
      const rect = c.getBoundingClientRect()
      return {
        cssW: Math.round(rect.width),
        cssH: Math.round(rect.height),
        backingW: c.width,
        backingH: c.height,
        scaleX: c.width / rect.width,
        scaleY: c.height / rect.height,
        dpr: ${dpr},
      }
    })()`,
    returnByValue: true,
  }, sessionId).then((r) => r.result.value)
}

// initial viewport at dpr 2, then resize, then dpr change
await send('Page.navigate', { url: url + mode }, sessionId)
await sleep(3000)
samples.push({ step: 'initial 1280x800 dpr2', ...(await applyViewport(1280, 800, 2)) })
samples.push({ step: 'resize 900x600 dpr2', ...(await applyViewport(900, 600, 2)) })
samples.push({ step: 'resize 900x600 dpr1', ...(await applyViewport(900, 600, 1)) })
samples.push({ step: 'resize 1400x900 dpr1', ...(await applyViewport(1400, 900, 1)) })
samples.push({ step: 'back 1280x800 dpr2', ...(await applyViewport(1280, 800, 2)) })

const allMatch = samples.every((s) => Math.abs(s.scaleX - s.dpr) < 0.02 && Math.abs(s.scaleY - s.dpr) < 0.02)
console.log(JSON.stringify({ allMatch, samples }, null, 2))
ws.close()
chrome.kill()
process.exit(0)
