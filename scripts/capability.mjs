// Verify runtime feature detection: remove a global before page scripts run.
// Usage: node scripts/capability.mjs <url> <worker|offscreen>
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'

const url = process.argv[2]
const remove = process.argv[3]
const candidates = [
  join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'),
]
const libDirs = ['/tmp/deps/usr/lib/x86_64-linux-gnu']
const chromeBin = candidates[0]
await readFile(chromeBin)
const userData = await mkdtemp(join(tmpdir(), 'cap-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${userData}`,'--no-first-run','--disable-gpu','--force-device-scale-factor=2','--window-size=1280,800','about:blank'],{stdio:'ignore',env:{...process.env,LD_LIBRARY_PATH:libDirs.join(':')}})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
for (let i=0;i<50;i++){try{var wsUrl=(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;break}catch{await sleep(100)}}
const ws=new WebSocket(wsUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=1;const pend=new Map()
const workerLifetimes=new Map()
ws.onmessage=e=>{
  const m=JSON.parse(e.data)
  if(m.id!=null&&pend.has(`${m.id}:${m.sessionId??''}`)){
    const{resolve,reject}=pend.get(`${m.id}:${m.sessionId??''}`)
    pend.delete(`${m.id}:${m.sessionId??''}`)
    if (m.error) reject(new Error(JSON.stringify(m))); else resolve(m.result)
  }
  if (m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.type === 'worker') {
    workerLifetimes.set(m.params.targetInfo.targetId,'alive')
  }
}
const send=(method,params={},sid)=>new Promise((res,rej)=>{const i=id++;pend.set(`${i}:${sid??''}`,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params,sessionId:sid}))})
await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
const {targetId}=await send('Target.createTarget',{url:'about:blank'})
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true})
await send('Page.enable',{},sessionId)
await send('Page.setBypassCSP',{enabled:true},sessionId)
const removed = remove === 'worker' ? 'window.Worker = undefined' : 'window.OffscreenCanvas = undefined'
await send('Page.addScriptToEvaluateOnNewDocument',{source:`${removed}; window.__removed = '${remove}';`},sessionId)
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:2,mobile:false},sessionId)
await send('Page.navigate',{url},sessionId)
await sleep(4000)
const r=await send('Runtime.evaluate',{expression:`(() => ({
  badge: document.querySelector('.mode-badge')?.textContent || 'none',
  hasStats: !!document.querySelector('.stats'),
  removed: window.__removed,
  workerType: typeof window.Worker,
  oscType: typeof window.OffscreenCanvas,
  canvasSize: (() => { const c=document.querySelector('canvas'); return c ? c.width+'x'+c.height : 'no-canvas' })(),
}))()`,returnByValue:true},sessionId)
await sleep(2000)
const shot=await send('Page.captureScreenshot',{format:'png'},sessionId)
await writeFile(`/tmp/cap-${remove}.png`,Buffer.from(shot.data,'base64'))
console.log(JSON.stringify({remove,...r.result.value,workersEver:workerLifetimes.size},null,2))
ws.close();chrome.kill();process.exit(0)
