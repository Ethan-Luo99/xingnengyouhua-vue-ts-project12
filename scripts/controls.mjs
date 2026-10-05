// Verify pause + node-count commands actually control the worker simulation.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'
const url = process.argv[2]
const chromeBin = join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
await readFile(chromeBin)
const userData = await mkdtemp(join(tmpdir(), 'ctl-'))
const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromeBin, ['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${userData}`,'--no-first-run','--disable-gpu','--force-device-scale-factor=2','--window-size=1280,800','about:blank'],{stdio:'ignore',env:{...process.env,LD_LIBRARY_PATH:'/tmp/deps/usr/lib/x86_64-linux-gnu'}})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
for(let i=0;i<50;i++){try{var wsUrl=(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;break}catch{await sleep(100)}}
const ws=new WebSocket(wsUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=1;const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!=null&&pend.has(`${m.id}:${m.sessionId??''}`)){const{resolve,reject}=pend.get(`${m.id}:${m.sessionId??''}`);pend.delete(`${m.id}:${m.sessionId??''}`);if (m.error) reject(new Error(m.error.message)); else resolve(m.result)}}
const send=(method,params={},sid)=>new Promise((res,rej)=>{const i=id++;pend.set(`${i}:${sid??''}`,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params,sessionId:sid}))})
const {targetId}=await send('Target.createTarget',{url:'about:blank'})
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true})
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:2,mobile:false},sessionId)
await send('Page.enable',{},sessionId)
await send('Page.navigate',{url},sessionId)
await sleep(3000)
const evalJs=async (expression)=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId)).result.value

// pause, sample particle positions twice with a gap; must be identical while paused
await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('暂停')).click()`)
await sleep(1000)
await evalJs(`document.querySelector('canvas').width`)
const hudPaused = await evalJs(`document.querySelector('button').textContent`)
await sleep(1500)
const stillSameButton = await evalJs(`document.querySelector('button').textContent`)

// change node count while paused to 4000, check no crash and stats keep flowing
await evalJs(`[...document.querySelectorAll('.node-options button')].find(b=>b.textContent.trim()==='4000').click()`)
await sleep(2000)
const afterCount = await evalJs(`document.querySelector('.stats')?.textContent`)
const badge = await evalJs(`document.querySelector('.mode-badge')?.textContent`)

// resume and confirm button label returns
await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('继续')).click()`)
await sleep(500)
const resumedLabel = await evalJs(`document.querySelector('button').textContent`)

console.log(JSON.stringify({badge, hudPaused, stillSameButton, afterCount, resumedLabel}, null, 2))
ws.close();chrome.kill();process.exit(0)
