#!/usr/bin/env node
// Zero-dependency CDP driver for the ?selftest=1 time-travel check.
// Captures console output from the page AND the dedicated worker (worker
// console.* is forwarded as Runtime.consoleAPICalled on the worker session),
// then reads the HUD badge. Usage: node scripts/selftest.mjs <url>
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/selftest.mjs <url>')
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

const userData = await mkdtemp(join(tmpdir(), 'selftest-chrome-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--force-device-scale-factor=1',
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
const seenConsole = new Set()

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
    send('Runtime.enable', {}, msg.params.sessionId)
    send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => (a.type === 'string' ? a.value : a.description ?? a.value ?? ''))
      .join(' ')
    // Vite dev + flattened auto-attach can surface the same worker line twice.
    const key = `${msg.executionContextId ?? 0}:${text}`
    if (seenConsole.has(key)) return
    seenConsole.add(key)
    const label = msg.sessionId ? '[worker] ' : '[page]   '
    console.log(label + text)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
  }
}

await send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const pageSession = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
await send('Runtime.enable', {}, pageSession)
await send('Page.enable', {}, pageSession)
await send('Page.navigate', { url }, pageSession)

// Give the selftest (runs right after the worker handshake) time to finish.
await sleep(5000)

const badge = await send('Runtime.evaluate', {
  expression: `document.querySelector('.selftest-pass, .selftest-fail')?.textContent || 'NO-BADGE'`,
  returnByValue: true,
}, pageSession)
console.log('[hud]    ', badge.result.value)

chrome.kill()
process.exit(0)
