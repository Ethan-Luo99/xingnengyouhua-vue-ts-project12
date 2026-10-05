#!/usr/bin/env node
// Zero-dependency smoke benchmark driving headless Chromium over CDP.
// Usage: node scripts/bench.mjs <url> <label> [settleMs]
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'

const url = process.argv[2]
const label = process.argv[3] || 'run'
const settleMs = Number(process.argv[4] || 12000)
if (!url) {
  console.error('usage: node scripts/bench.mjs <url> <label> [settleMs]')
  process.exit(1)
}

const candidates = [
  process.env.CHROME_BIN,
  join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'),
  join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
].filter(Boolean)
const libDirs = [
  process.env.CHROME_LIB_DIR,
  '/tmp/deps/usr/lib/x86_64-linux-gnu',
  '/tmp/chromelibs/extracted/usr/lib/x86_64-linux-gnu',
].filter(Boolean)

let chromeBin = null
for (const c of candidates) {
  try {
    await readFile(c)
    chromeBin = c
    break
  } catch {}
}
if (!chromeBin) {
  console.error('no chromium binary found')
  process.exit(1)
}

const userData = await mkdtemp(join(tmpdir(), 'bench-chrome-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--force-device-scale-factor=2',
  '--window-size=1280,800',
  'about:blank',
], {
  stdio: 'ignore',
  env: { ...process.env, LD_LIBRARY_PATH: libDirs.join(':') },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      return (await res.json()).webSocketDebuggerUrl
    } catch {
      await sleep(100)
    }
  }
  throw new Error('chrome devtools did not come up')
}

const ws = new WebSocket(await getWsUrl())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let nextId = 1
const pending = new Map()
const workerLifetimes = new Map()
let pageSession = null

function send(method, params = {}, sessionId = undefined) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) =>
    pending.set(`${id}:${sessionId ?? ''}`, { resolve, reject }))
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined) {
    const key = `${msg.id}:${msg.sessionId ?? ''}`
    const entry = pending.get(key)
    if (entry) {
      pending.delete(key)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
    return
  }
  if (msg.method === 'Target.attachedToTarget') {
    if (msg.params.targetInfo.type === 'worker') {
      workerLifetimes.set(msg.params.targetInfo.targetId, 'alive')
    }
    send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId)
    return
  }
  if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'worker') {
    workerLifetimes.set(msg.params.targetInfo.targetId, 'alive')
  }
  if (msg.method === 'Target.targetDestroyed' && workerLifetimes.has(msg.params.targetId)) {
    workerLifetimes.set(msg.params.targetId, 'destroyed')
  }
}

await send('Target.setDiscoverTargets', { discover: true })
await send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
pageSession = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId

await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
}, pageSession)
await send('Page.enable', {}, pageSession)
await send('Page.navigate', { url }, pageSession)
await sleep(2500)

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, pageSession)
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

async function selectNodes(n) {
  await evalJs(`[...document.querySelectorAll('.node-options button')]
    .find(b => b.textContent.trim() === '${n}').click()`)
}

async function readHud() {
  const raw = await evalJs(`(() => {
    const spans = [...document.querySelectorAll('.stats span')].map(s => s.textContent)
    const digits = (token) => {
      let out = ''
      for (const ch of token) {
        if ((ch >= '0' && ch <= '9') || ch === '.') out += ch
      }
      return out
    }
    const afterLabel = (s) => {
      const parts = s.split(' ')
      return Number(digits(parts[parts.length - 1]) || '0')
    }
    const firstNumber = (s) => {
      const parts = s.split(' ')
      return Number(digits(parts[0]) || '0')
    }
    return {
      badge: document.querySelector('.mode-badge')?.textContent || 'baseline(main)',
      spans,
      fps: firstNumber(spans.find(t => t.includes('fps')) || ''),
      p50: afterLabel(spans.find(t => t.startsWith('p50')) || ''),
      p95: afterLabel(spans.find(t => t.startsWith('p95')) || ''),
      p99: afterLabel(spans.find(t => t.startsWith('p99')) || ''),
      dropRate: afterLabel(spans.find(t => t.includes('掉帧')) || ''),
    }
  })()`)
  if (process.env.DEBUG_HUD) console.error('HUD', JSON.stringify(raw))
  return raw
}

async function measure(n) {
  await selectNodes(n)
  await sleep(settleMs)
  return { nodes: n, ...(await readHud()) }
}

const r2000 = await measure(2000)
const r4000 = await measure(4000)
await sleep(1000)

console.log(JSON.stringify({
  label,
  settleMs,
  r2000,
  r4000,
  workersEver: workerLifetimes.size,
  workersAlive: [...workerLifetimes.values()].filter((v) => v === 'alive').length,
}, null, 2))

ws.close()
chrome.kill()
process.exit(0)
