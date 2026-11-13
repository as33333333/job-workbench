import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSetting, setSetting } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COLLECTOR_DIR = path.join(__dirname, 'collector', 'boss-zhipin-scraper')
const LOG_FILE = path.join(__dirname, 'data', 'scheduler.log')
const CHECK_INTERVAL_MS = 30_000
const COLLECT_TIMEOUT_MS = 90 * 60_000     // 总时长上限（全量详情时每条 25~50 秒，留足余量；另有 10 分钟无输出看门狗）
const COLLECT_STALL_MS = 10 * 60_000       // 连续无任何输出视为卡死

const DEFAULTS = {
  enabled: true,
  time: '09:00',       // 每天定时采集时间（本地时区）
  city: '深圳',
  keyword: '产品经理',
  experience: '104',   // 103=1年内 104=1-3年 105=3-5年 106=5-10年 101=不限
  degree: '203',       // 202=大专 203=本科 204=硕士
  pages: 3,
  maxDetails: 0,       // 0 = 全部详情（一条 JD = 列表基础数据 + 详情正文）；>0 只对定时采集生效
}

let running = false
let runImportDeps = null
/* 采集进度：一条「完成」= 该岗位的基础数据（列表）+ 详情正文都已拿到 */
let progress = { stage: 'idle', done: 0, total: 0, listCount: 0, pages: 0, page: 0, message: '', startedAt: null, updatedAt: null }
const resetProgress = (stage = 'idle', message = '') => {
  progress = { stage, done: 0, total: 0, listCount: 0, pages: 0, page: 0, message, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}
export function currentProgress() { return { ...progress } }

export function scheduleConfig() {
  let saved = {}
  try { saved = JSON.parse(getSetting('scheduleConfig') || '{}') } catch { /* 用默认值 */ }
  return { ...DEFAULTS, ...saved }
}

export function saveScheduleConfig(patch = {}) {
  const cfg = scheduleConfig()
  if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled
  if (patch.time && /^\d{2}:\d{2}$/.test(patch.time)) cfg.time = patch.time
  for (const k of ['city', 'keyword', 'experience', 'degree']) {
    if (typeof patch[k] === 'string' && patch[k].trim() !== '') cfg[k] = patch[k].trim()
  }
  if (patch.pages !== undefined) cfg.pages = Math.min(10, Math.max(1, +patch.pages || 3))
  if (patch.maxDetails !== undefined) cfg.maxDetails = Math.min(50, Math.max(0, +patch.maxDetails || 0))
  setSetting('scheduleConfig', JSON.stringify(cfg))
  return cfg
}

export function scheduleStatus() {
  let lastRun = null
  try { lastRun = JSON.parse(getSetting('scheduleLastRun') || 'null') } catch { /* 忽略 */ }
  return { ...scheduleConfig(), running, progress: progress, lastRun, logFile: LOG_FILE }
}

function log(line) {
  const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}\n`
  try { fs.appendFileSync(LOG_FILE, text) } catch { /* 忽略日志写入失败 */ }
  console.log(`[定时采集] ${line}`)
}

function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

/* 运行一次采集（spawn 采集器脚本），结束后由 deps.runImport() 导入并回填 */
export async function runCollectOnce(reason = 'manual') {
  if (running) return { skipped: true, reason: '已有一次采集在运行中' }
  running = true
  const startedAt = new Date().toISOString()
  const result = { at: startedAt, reason, day: startedAt.slice(0, 10), ok: false }
  // 开始即落盘当天运行标记，防止服务重启后当日重复补跑
  setSetting('scheduleLastRun', JSON.stringify(result))
  try {
    const cfg = scheduleConfig()
    // 手动「立即运行」始终抓全量详情；定时任务可按设置限制数量（0 = 全部）
    const detailCap = reason === 'manual' ? 0 : (Number(cfg.maxDetails) || 0)
    const args = [
      'scripts/boss_cdp_raw.py',
      '--city', cfg.city, '--keyword', cfg.keyword,
      '--experience', String(cfg.experience), '--degree', String(cfg.degree),
      '--pages', String(cfg.pages),
    ]
    if (detailCap > 0) args.push('--max-details', String(detailCap))
    resetProgress('list', '正在抓取岗位列表…')
    log(`开始采集（${reason}）：${cfg.city} · ${cfg.keyword} · exp=${cfg.experience} · degree=${cfg.degree} · pages=${cfg.pages} · 详情=${detailCap > 0 ? detailCap + ' 个' : '全部'}`)
    const collect = await spawnCollect(args)
    result.collect = collect
    log(`采集结束：${collect.ok ? '成功' : `失败（${collect.error || 'exit ' + collect.code}）`}，输出 ${collect.outputFiles?.length || 0} 个结果文件`)
    if (!collect.ok) {
      result.error = collect.error
      const lastLines = (collect.progress || []).slice(-3)
      if (lastLines.length) log(`失败前最后输出：${lastLines.join(' ⏎ ').slice(0, 500)}`)
    }

    if (runImportDeps && collect.ok) {
      try {
        result.import = runImportDeps.runImport()
        log(`导入完成：新增 ${result.import.created}，更新 ${result.import.updated}，跳过 ${result.import.skipped}` +
          (result.import.backfill?.updated ? `，回填JD正文 ${result.import.backfill.updated} 个` : ''))
      } catch (e) {
        result.importError = e.message
        log(`导入失败：${e.message}`)
      }
    }
    result.ok = !!collect.ok
    progress.stage = collect.ok ? 'done' : 'failed'
    progress.message = collect.ok
      ? `已完成 ${progress.done}/${progress.total || progress.listCount} 条 JD（含详情）`
      : `采集失败：${collect.error || '未知原因'}`
    progress.updatedAt = new Date().toISOString()
  } catch (e) {
    result.error = e.message
    progress.stage = 'failed'
    progress.message = `执行异常：${e.message}`
    log(`执行异常：${e.message}`)
  } finally {
    running = false
  }
  result.progress = { ...progress }
  setSetting('scheduleLastRun', JSON.stringify(result))
  return result
}

/* 从采集器输出解析进度：done 只在「拿到详情」时 +1（一条 JD = 列表基础数据 + 详情） */
export function updateProgressFromLine(line) {
  const text = String(line || '')
  let m
  if ((m = /^=== 抓取岗位详情 \((\d+) 个\) ===/.exec(text))) {
    progress.stage = 'detail'
    progress.total = Number(m[1])
    progress.done = 0
    progress.message = `开始抓取详情：共 ${m[1]} 条 JD`
  } else if ((m = /^--- \[(\d+)\/(\d+) 页, (\d+) 条已抓\] ---/.exec(text))) {
    progress.stage = 'list'
    progress.page = Number(m[1])
    progress.pages = Number(m[2])
    progress.listCount = Number(m[3])
    progress.message = `抓列表：第 ${m[1]}/${m[2]} 页，已抓到 ${m[3]} 条`
  } else if ((m = /累计 (\d+)/.exec(text)) && /本页/.test(text)) {
    progress.listCount = Math.max(progress.listCount, Number(m[1]))
    if (!progress.total) progress.total = progress.listCount
    progress.message = `抓列表：第 ${progress.page || 1}/${progress.pages || '?'} 页，已抓到 ${progress.listCount} 条`
  } else if ((m = /^\[(\d+)\/(\d+)\] (.+)$/.exec(text))) {
    progress.stage = 'detail'
    progress.total = Number(m[2])
    progress.message = `正在抓第 ${m[1]}/${m[2]} 个：${m[3].slice(0, 40)}`
  } else if (/^JD: \d+ 字/.test(text)) {
    progress.done += 1
    progress.stage = 'detail'
    if (!progress.total) progress.total = progress.listCount
    progress.message = `已完成 ${progress.done}/${progress.total || '?'} 条 JD（含详情）`
  } else if (/^详情已保存:/.test(text)) {
    progress.stage = 'done'
    progress.message = `详情已保存：共 ${progress.done} 条 JD`
  }
  progress.updatedAt = new Date().toISOString()
}

function spawnCollect(args) {
  return new Promise(resolve => {
    let stdout = '', stderr = ''
    let killedReason = ''
    let child
    const recentLines = []                 // 最近若干行采集器输出，用于失败归因
    let lastOutputAt = Date.now()
    const pushLines = (chunk) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        lastOutputAt = Date.now()
        recentLines.push(line)
        if (recentLines.length > 60) recentLines.shift()
        updateProgressFromLine(line)
        log(`  │ ${line.slice(0, 300)}`)
      }
    }
    try {
      // -u：python 接管道时默认全缓冲，不加 -u 会导致进度/日志成块延迟
      child = spawn('python3', ['-u', ...args], { cwd: COLLECTOR_DIR, env: process.env })
    } catch (e) {
      return resolve({ ok: false, error: `无法启动采集器：${e.message}` })
    }
    const kill = (reason) => {
      if (killedReason) return
      killedReason = reason
      log(`${reason}，强制终止`)
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
    }
    const timer = setTimeout(() => kill(`采集超过 ${Math.round(COLLECT_TIMEOUT_MS / 60000)} 分钟未完成`), COLLECT_TIMEOUT_MS)
    // 看门狗：长时间没有任何输出，多半是 CDP/Chrome 卡死或等人扫码
    const stallTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > COLLECT_STALL_MS) {
        kill(`连续 ${Math.round(COLLECT_STALL_MS / 60000)} 分钟无任何输出（疑似 Chrome 无响应或等待登录）`)
      }
    }, 60_000)
    child.stdout.on('data', d => { stdout += d; pushLines(d) })
    child.stderr.on('data', d => { stderr += d; pushLines(d) })
    child.on('error', e => {
      clearTimeout(timer); clearInterval(stallTimer)
      resolve({
        ok: false,
        error: `采集器启动失败（需要先完成 --setup-chrome 登录配置）：${e.message}`,
        outputFiles: [], progress: recentLines.slice(-20), lastOutputAt: new Date(lastOutputAt).toISOString(),
        stdout: tail(stdout), stderr: tail(stderr),
      })
    })
    child.on('close', code => {
      clearTimeout(timer); clearInterval(stallTimer)
      resolve({
        ok: code === 0 && !killedReason,
        code,
        killedReason,
        outputFiles: parseOutputFiles(stdout),
        progress: recentLines.slice(-20),
        lastOutputAt: new Date(lastOutputAt).toISOString(),
        stdout: tail(stdout), stderr: tail(stderr),
        error: describeFail(code, stdout + stderr, killedReason),
      })
    })
  })
}

function describeFail(code, output, killedReason) {
  const text = String(output || '')
  if (/未检测到 BOSS直聘登录状态|login expired|登录查看完整内容/.test(text)) return '登录态失效：请在专用 Chrome 里重新登录 zhipin.com（或运行 --setup-chrome）'
  if (/验证|风控|RESTRICTED|停止登录探测/.test(text)) return '被 BOSS 风控拦截（出现验证/限流），请先在专用 Chrome 里完成验证再试'
  if (killedReason) return killedReason
  if (code !== 0) return `采集器退出码 ${code}，详见本次输出`
  return ''
}

const tail = (s, n = 2000) => String(s || '').slice(-n)
function parseOutputFiles(stdout) {
  const files = []
  const re = /([\w/.~-]*boss_(?:jobs|details)_\d{8}_\d{4}\.json)/g
  let m
  while ((m = re.exec(String(stdout || ''))) !== null) files.push(m[1])
  return [...new Set(files)]
}

/* 定时器：每30秒检查一次；错过9点（如电脑休眠）后启动服务会补跑当天任务 */
export function startScheduler(deps) {
  runImportDeps = deps || null
  setInterval(tick, CHECK_INTERVAL_MS)
  setTimeout(tick, 5_000)
  log(`调度器已启动：${scheduleConfig().enabled ? `每天 ${scheduleConfig().time} 采集` : '当前已停用'}`)
}

function tick() {
  const cfg = scheduleConfig()
  if (!cfg.enabled || running) return
  const last = (() => { try { return JSON.parse(getSetting('scheduleLastRun') || 'null') } catch { return null } })()
  const today = new Date().toISOString().slice(0, 10)
  // 当天只要在定时时间之后跑过（手动或定时），就不再补跑，避免重启反复触发
  const scheduleTime = todayAt(cfg.time).getTime()
  const lastStartedAt = last?.at ? new Date(last.at).getTime() : 0
  if (last?.day === today && lastStartedAt >= scheduleTime) return
  if (Date.now() >= scheduleTime) {
    log(`到达定时时间 ${cfg.time}，触发今日采集`)
    runCollectOnce('schedule').catch(e => log(`定时任务异常：${e.message}`))
  }
}
