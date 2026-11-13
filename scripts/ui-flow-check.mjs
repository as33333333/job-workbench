/**
 * 浏览器端到端流程检查：载入样例分析 → 采纳一条修改 → 生成针对性简历 → 跳转简历工作台
 * 运行：node scripts/ui-flow-check.mjs [url]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const URL = process.argv[2] || 'http://localhost:8788/'
const PORT = 9334
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-flow-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const errors = []

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page
    } catch { /* 等待启动 */ }
    await sleep(250)
  }
  throw new Error('Chrome 启动超时')
}

async function main() {
  const target = await getTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
  await new Promise(r => ws.addEventListener('open', r))
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text)
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '))
    }
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: URL })
  await sleep(2500)

  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  // 1) 进入分析页并载入最新样例分析
  await run(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('JD分析'))?.click()`)
  await sleep(800)
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史分析')?.click()`)
  await sleep(600)
  const sampleIndex = await run(`(() => {
    const rows = [...document.querySelectorAll('.setting-row')]
    const i = rows.findIndex(r => r.innerText.includes('AI分析') && r.innerText.includes('样例数据'))
    return i >= 0 ? i : 0
  })()`)
  console.log('选择历史记录索引:', sampleIndex)
  await run(`document.querySelectorAll('.setting-row')[${sampleIndex}].click()`)
  await sleep(1800)
  console.log('载入样例分析:', await run(`!!document.querySelector('.an-verdict')`))
  console.log('是否样例:', await run(`document.body.innerText.includes('样例数据')`))

  // 2) 切到简历修改，采纳第一条
  await run(`[...document.querySelectorAll('.an-tab')].find(b=>b.textContent.includes('简历修改'))?.click()`)
  await sleep(700)
  const changeCount = await run(`document.querySelectorAll('.an-change').length`)
  console.log('修改条目数:', changeCount)
  await run(`[...document.querySelectorAll('.an-change')][0].querySelector('button.primary')?.click()`)
  await sleep(1200)
  const adoptedText = await run(`(document.querySelector('.an-change.adopted .st-ok')||{}).innerText || ''`)
  console.log('采纳状态:', adoptedText || '未检测到')
  console.log('侧栏进度:', await run(`document.querySelector('.an-progress-row b')?.innerText || ''`))

  // 3) 生成针对性简历（侧栏按钮）
  await run(`[...document.querySelectorAll('.an-side button')].find(b=>b.textContent.includes('生成针对性简历'))?.click()`)
  await sleep(2500)
  const onResume = await run(`document.body.innerText.includes('AI 智能改简历') || !!document.querySelector('.editor-wrap')`)
  console.log('跳转到简历工作台:', onResume)
  const generated = await run(`(() => {
    const ta = document.querySelector('.editor-pane textarea')
    return {
      contentLoaded: !!ta && ta.value.length > 50,
      hasAdoptedSentence: !!ta && ta.value.includes('12 个业务指标口径'),
      hasAnalysisNotice: document.body.innerText.includes('原始简历未被改动')
    }
  })()`)
  console.log('生成版本内容:', JSON.stringify(generated))

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(path.resolve(process.cwd(), 'data/ui-flow-check.png'), Buffer.from(shot.data, 'base64'))
  console.log('控制台错误数:', errors.length)
  for (const e of [...new Set(errors)].slice(0, 6)) console.log('  !', String(e).slice(0, 160))
  ws.close()
}

main().catch(e => { console.error('流程检查失败:', e.message); process.exitCode = 1 })
  .finally(async () => {
    await sleep(300)
    try { chrome.kill('SIGKILL') } catch { /* 忽略 */ }
  })
