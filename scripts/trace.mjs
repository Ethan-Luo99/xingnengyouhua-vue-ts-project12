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


const traceResults = {}
for (const n of [2000, 4000]) {
  await selectNodes(n)
  await sleep(6000)
  await send('Tracing.start', {
    traceConfig: {
      includedCategories: ['-*', 'devtools.timeline', 'disabled-by-default-v8.cpu_profiler'],
      options: 'record-as-much-as-possible',
    },
  }, pageSession)
  await sleep(5000)
  const chunks = []
  const gotData = new Promise((resolve) => {
    const handler = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Tracing.dataCollected') chunks.push(...msg.params.value)
      if (msg.method === 'Tracing.tracingComplete') {
        ws.removeEventListener('message', wrapped)
        resolve()
      }
    }
    const wrapped = (e) => handler(e)
    ws.addEventListener('message', wrapped)
  })
  await send('Tracing.end', {}, pageSession)
  await gotData

  const threadNames = []
  for (const ev of chunks) {
    if (ev.name === 'thread_name') threadNames.push({pid: ev.pid, tid: ev.tid, name: ev.args?.name})
  }
  if (process.env.DEBUG_TRACE) console.error('threadNames', JSON.stringify(threadNames.slice(0, 20)))
  const mainThreads = new Set()
  const workerThreads = new Set()
  for (const t of threadNames) {
    if (t.name === 'CrRendererMain') mainThreads.add(t.pid + ':' + t.tid)
    if (t.name === 'DedicatedWorker thread') workerThreads.add(t.pid + ':' + t.tid)
  }
  const collect = (threadSet, names) => {
    const ds = []
    let total = 0
    for (const ev of chunks) {
      if (typeof ev.dur !== 'number' || !names.includes(ev.name)) continue
      if (threadSet.has(ev.pid + ':' + ev.tid)) {
        ds.push(ev.dur)
        total += ev.dur
      }
    }
    ds.sort((a, b) => a - b)
    const pct = (q) => ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * q))] / 1000 : 0
    return {
      frames: ds.length,
      meanMs: ds.length ? Math.round((total / ds.length) / 10) / 100 : 0,
      p50Ms: Math.round(pct(0.5) * 100) / 100,
      p95Ms: Math.round(pct(0.95) * 100) / 100,
      busyPct: Math.round((total / 5000000) * 1000) / 10,
    }
  }
  const frameNames = ['FireAnimationFrame']
  const mainFrames = collect(mainThreads, frameNames)
  const workerFrames = collect(workerThreads, frameNames)
  const totalBusy = (threadSet) => {
    let total = 0
    for (const ev of chunks) {
      if (typeof ev.dur === 'number' && threadSet.has(ev.pid + ':' + ev.tid)) total += ev.dur
    }
    return Math.round((total / 5000000) * 1000) / 10
  }
  traceResults[n] = {
    mainFrames,
    workerFrames,
    mainThreadBusyPct: totalBusy(mainThreads),
    workerThreadBusyPct: totalBusy(workerThreads),
  }
}

const hud2000 = await measure(2000)
const hud4000 = await measure(4000)
console.log(JSON.stringify({
  label,
  hud2000,
  hud4000,
  trace: traceResults,
  workersEver: workerLifetimes.size,
  workersAlive: [...workerLifetimes.values()].filter((v) => v === 'alive').length,
}, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' }, pageSession)
const { writeFile } = await import('node:fs/promises')
await writeFile('/tmp/shot-' + label + '.png', Buffer.from(shot.data, 'base64'))
ws.close()
chrome.kill()
process.exit(0)
