/**
 * 无头 Chrome 渲染检查：打开工作台 → 切到「JD分析」→ 载入样例分析 → 截图并收集控制台错误
 * 运行：node scripts/ui-check.mjs [url]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const URL = process.argv[2] || 'http://localhost:8788/'
const PORT = 9333
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ui-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

const errors = []
const pageLogs = []

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
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '))
    }
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      errors.push(msg.params.entry.text)
    }
  })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: URL })
  await sleep(2500)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result?.value
  }

  const navCount = await evalJs(`document.querySelectorAll('.nav-item').length`)
  console.log('导航项数量:', navCount)

  // 切到「JD分析」
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('JD分析'))?.click()`)
  await sleep(1200)
  const hasAnalyze = await evalJs(`!!document.querySelector('.an-input-grid') || document.body.innerText.includes('开始分析')`)
  console.log('分析页渲染:', hasAnalyze)

  // 打开历史分析，逐条检查主要状态（样例AI / 基础检查 / 输入不足 / 旧版结构）
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史分析')?.click()`)
  await sleep(700)
  const historyRows = await evalJs(`document.querySelectorAll('.setting-row').length`)
  console.log('历史记录条数:', historyRows)
  for (let i = 0; i < historyRows; i++) {
    await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史分析')?.click()`)
    await sleep(400)
    await evalJs(`document.querySelectorAll('.setting-row')[${i}].click()`)
    await sleep(1400)
    const st = await evalJs(`(() => {
      const t = document.body.innerText
      return {
        sample: !!document.querySelector('.an-header .st-unknown') && t.includes('样例数据'),
        ai: t.includes('AI 深度分析'),
        basic: t.includes('基础文本检查'),
        blocked: t.includes('输入材料不足'),
        legacy: t.includes('旧版分析结果'),
        score: !!document.querySelector('.an-score'),
        reqRows: document.querySelectorAll('.an-row').length,
        rec: (document.querySelector('.an-verdict .st')||{}).innerText || '',
        answered: document.body.innerText.includes('已回答（'),
        sampleBadge: document.body.innerText.includes('样例数据')
      }
    })()`)
    console.log(`  记录#${i}:`, JSON.stringify(st))
  }

  // 载入第一条（最新，样例数据）用于截图
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史分析')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelectorAll('.setting-row')[0].click()`)
  await sleep(1500)

  const summary = await evalJs(`(() => {
    const t = document.body.innerText
    return {
      hasVerdict: !!document.querySelector('.an-verdict'),
      tabs: [...document.querySelectorAll('.an-tab')].map(b=>b.textContent.trim()),
      reqRows: document.querySelectorAll('.an-row').length,
      hasScore: !!document.querySelector('.an-score'),
      hasSidebar: !!document.querySelector('.an-side'),
      textLen: t.length
    }
  })()`)
  console.log('分析页结构:', JSON.stringify(summary))

  // 展开第一条要求
  await evalJs(`document.querySelector('.an-row-main')?.click()`)
  await sleep(500)
  console.log('展开证据块:', await evalJs(`document.querySelectorAll('.an-detail').length > 0`))

  // 切到简历修改页签
  await evalJs(`[...document.querySelectorAll('.an-tab')].find(b=>b.textContent.includes('简历修改'))?.click()`)
  await sleep(600)
  console.log('简历修改条目:', await evalJs(`document.querySelectorAll('.an-change').length`))

  // 回到要求对照页签，检查移动端卡片布局
  await evalJs(`[...document.querySelectorAll('.an-tab')].find(b=>b.textContent.includes('要求对照'))?.click()`)
  await sleep(500)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(600)
  const mobile = await evalJs(`(() => {
    const row = document.querySelector('.an-row-main')
    if (!row) return null
    const cs = getComputedStyle(row)
    return { cols: cs.gridTemplateColumns.split(' ').length, width: window.innerWidth }
  })()`)
  console.log('移动端首行栅格列数:', JSON.stringify(mobile))
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await sleep(400)

  // 设置页：AI 配置区与定时采集区渲染检查
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('设置'))?.click()`)
  await sleep(1000)
  const settingsState = await evalJs(`({
    aiSection: document.body.innerText.includes('AI 服务'),
    schedulerSection: document.body.innerText.includes('每日定时采集'),
    hasSave: document.body.innerText.includes('保存设置')
  })`)
  console.log('设置页:', JSON.stringify(settingsState))

  // 回到分析页，载入样例分析后截图
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('JD分析'))?.click()`)
  await sleep(800)
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史分析')?.click()`)
  await sleep(500)
  await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.setting-row')]
    const i = rows.findIndex(r => r.innerText.includes('AI分析') && r.innerText.includes('样例数据'))
    rows[i >= 0 ? i : 0].click()
  })()`)
  await sleep(1500)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const out = path.resolve(process.cwd(), 'data/ui-check.png')
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('截图:', out)

  console.log('控制台错误数:', errors.length)
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  !', String(e).slice(0, 200))
  ws.close()
}

main().catch(e => { console.error('检查失败:', e.message); process.exitCode = 1 })
  .finally(async () => {
    await sleep(300)
    try { chrome.kill('SIGKILL') } catch { /* 忽略 */ }
  })
