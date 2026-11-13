import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'

import {
  createJob, updateJob, jobById, listJobs, deleteJob, jobExists,
  createDocument, updateDocument, documentById, listDocuments, deleteDocument,
  createAnalysis, updateAnalysis, analysisById, listAnalyses, deleteAnalysis,
  createResumeVersion, updateResumeVersion, resumeVersionById, listResumeVersions,
  getSetting, setSetting,
} from './db.js'
import {
  aiConfig, aiReady, saveAiConfig, aiParseJd, heuristicParseJd,
  aiExtractCommon, aiRewriteResume, testConnection,
  DEFAULT_API_BASE, DEFAULT_MODEL,
} from './ai.js'
import {
  SCHEMA_VERSION, checkInputs, analyzeBasic, analyzeWithAi, normalizeTuning, DEFAULT_TUNING, TUNING_RULES,
} from './analysis.js'
import { stripJdNoise, jdLooksIncomplete } from './jobtext.js'
import {
  GREETING_PLACEHOLDERS, DEFAULT_GREETING, normalizeGreeting, renderGreeting,
} from './greeting.js'
import { extractPdfSmart, assessText, cleanText } from './pdftext.js'
import {
  scheduleConfig, saveScheduleConfig, scheduleStatus, runCollectOnce, startScheduler,
} from './scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads')

/* 轻量 .env 加载：存在 .env 时注入环境变量（不覆盖已有值），便于部署时配置 AI Key */
const envPath = path.join(__dirname, '.env')
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx < 1) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (!process.env[key]) process.env[key] = val
  }
  console.log('[配置] 已加载 .env')
}
const app = express()
app.use(express.json({ limit: '40mb' }))

const nowIso = () => new Date().toISOString()

/* ================= 分析运行参数（设置页可调） ================= */
const ANALYSIS_TUNING_KEY = 'analysisTuning'
function analysisTuning() {
  let saved = {}
  try { saved = JSON.parse(getSetting(ANALYSIS_TUNING_KEY) || '{}') } catch { saved = {} }
  return normalizeTuning(saved)
}
function saveAnalysisTuning(raw) {
  const next = normalizeTuning({ ...analysisTuning(), ...(raw || {}) })
  setSetting(ANALYSIS_TUNING_KEY, JSON.stringify(next))
  return next
}

/* ================= 打招呼文案（设置页可配，模板渲染在 greeting.js） ================= */
const GREETING_KEY = 'greetingConfig'
function greetingConfig() {
  let saved = {}
  try { saved = JSON.parse(getSetting(GREETING_KEY) || '{}') } catch { saved = {} }
  return normalizeGreeting(saved)
}
function saveGreetingConfig(raw) {
  const next = normalizeGreeting({ ...greetingConfig(), ...(raw || {}) })
  setSetting(GREETING_KEY, JSON.stringify(next))
  return next
}

/* ================= 通用解析工具 ================= */
export function parseSalary(text) {
  if (!text) return { min: null, max: null, note: '' }
  const t = String(text)
  let note = ''
  let main = t
  if (t.includes('·')) { const parts = t.split('·'); main = parts[0]; note = parts.slice(1).join('·') }
  let m = main.match(/(\d+(?:\.\d+)?)\s*[-–~至]\s*(\d+(?:\.\d+)?)\s*([kK千wW万]?)/)
  if (m) {
    const unit = /[wW万]/.test(m[3]) ? 10 : 1
    return { min: Math.round(+m[1] * unit), max: Math.round(+m[2] * unit), note }
  }
  m = main.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])\s*以上/)
  if (m) {
    const unit = /[wW万]/.test(m[2]) ? 10 : 1
    return { min: Math.round(+m[1] * unit), max: null, note }
  }
  m = main.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])/)
  if (m) {
    const unit = /[wW万]/.test(m[2]) ? 10 : 1
    return { min: Math.round(+m[1] * unit), max: Math.round(+m[1] * unit), note }
  }
  return { min: null, max: null, note: t }
}

export function parseExperience(text) {
  const t = String(text || '')
  if (/在校|实习/.test(t)) return { min: 0, max: 0, recruitType: '实习' }
  if (/应届|校招/.test(t)) return { min: 0, max: 0, recruitType: '校招' }
  if (/经验不限|不限/.test(t)) return { min: 0, max: 99, recruitType: '社招' }
  const m = t.match(/(\d+)\s*[-–~]\s*(\d+)\s*年/)
  if (m) return { min: +m[1], max: +m[2], recruitType: '社招' }
  const m2 = t.match(/(\d+)\s*年以上/)
  if (m2) return { min: +m2[1], max: 99, recruitType: '社招' }
  const m3 = t.match(/(\d+)\s*年以内/)
  if (m3) return { min: 0, max: +m3[1], recruitType: '社招' }
  return { min: 0, max: 99, recruitType: '社招' }
}

/* boss-zhipin-scraper / 通用JSON 的宽容字段映射 */
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k]
  }
  return ''
}

function normalizeImportRow(row, source) {
  if (!row || typeof row !== 'object') return null
  const title = String(pick(row, ['title', 'jobName', 'jobname', 'name', '岗位名', '职位名', '职位', '岗位'])).trim()
  if (!title) return null
  const locationFull = String(pick(row, ['location', 'cityDistrict', 'workAddress', '工作地点', '地址'])).trim()
  const city = String(pick(row, ['city', 'cityName', '城市'])).trim() || locationFull.split('·')[0].trim()
  const tagsRaw = String(pick(row, ['tags', 'tags_list', 'job_labels', 'jobLabels', '标签']))
  const skillsRaw = pick(row, ['skills', 'skill_tags', 'skillTags', '技能'])
  const tagList = String(skillsRaw).split(/[|,，、]/).map(s => s.trim()).filter(Boolean)
  const expEdu = tagsRaw.split(/[|,，、]/).map(s => s.trim()).filter(Boolean)
  const experienceText = String(pick(row, ['experience', 'experienceName', 'jobExperience', '经验', '工作年限'])) || expEdu.find(s => /年|应届|在校|不限$/.test(s)) || ''
  const education = String(pick(row, ['education', 'degree', 'degreeName', 'jobDegree', '学历'])) || expEdu.find(s => /大专|本科|硕士|研究生|博士|高中|中专/.test(s)) || ''
  const exp = parseExperience(experienceText)
  const sal = parseSalary(pick(row, ['salary', 'salaryDesc', 'salaryText', '薪资', '薪资范围']))
  const welfare = String(pick(row, ['welfare', 'welfareList', '福利'])).trim()
  const description = stripJdNoise(pick(row, ['description', 'jd', 'jobDesc', 'postDescription', '描述', '详情', '职位描述', 'content']) || '')
  const tags = [...new Set([...tagList, ...expEdu])].filter(t => t && !/^\d+$/.test(t)).slice(0, 15)
  const desc = (welfare ? `【福利】${welfare}\n\n` : '') + description
  return {
    title,
    category: String(pick(row, ['category', '岗位类别'])) || (/产品/.test(title) ? '产品经理' : ''),
    company: String(pick(row, ['company', 'companyName', 'boss_name', 'brandName', '公司名', '公司'])).trim(),
    city, address: locationFull,
    recruitType: exp.recruitType,
    expMin: exp.min, expMax: exp.max,
    experienceText: experienceText || (exp.max === 99 ? '经验不限' : ''),
    salaryMin: sal.min, salaryMax: sal.max,
    salaryText: String(pick(row, ['salary', 'salaryDesc', 'salaryText', '薪资'])),
    salaryNote: sal.note,
    education, tags, description: desc,
    source,
    sourceUrl: String(pick(row, ['url', 'job_link', 'link', 'jobUrl', 'jobLink', '职位链接', 'detailUrl', 'sourceUrl'])),
    bossActive: String(pick(row, ['boss_active_status', 'bossActive', '活跃状态'])),
    publishedAt: String(pick(row, ['publishedAt', 'publishTime', 'publishTimeStr', '发布时间', 'updateDate'])) || null,
  }
}

function upsertImportRow(row, extra = {}) {
  const data = { ...row, ...extra, importedAt: nowIso() }
  const existId = jobExists({ sourceUrl: data.sourceUrl, title: data.title, company: data.company, city: data.city })
  if (existId) {
    const existing = jobById(existId)
    // 增量合并：新数据带有更完整的JD详情/字段时更新已有岗位
    const patch = {}
    if (data.description && data.description.length > (existing.description || '').length) {
      patch.description = data.description
      if (data.tags?.length) patch.tags = data.tags
      if (data.bossActive) patch.bossActive = data.bossActive
    }
    if (data.salaryText && !existing.salaryText) patch.salaryText = data.salaryText
    if (data.education && !existing.education) patch.education = data.education
    if (Object.keys(patch).length) return { created: false, updated: true, id: existId, job: updateJob(existId, patch) }
    return { created: false, updated: false, id: existId, job: existing }
  }
  return { created: true, updated: false, id: null, job: createJob(data) }
}

/* 简易 CSV 解析（支持引号转义） */
function parseCsv(text) {
  const rows = []
  let cur = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { cur.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      if (cur.some(c => c.trim() !== '')) rows.push(cur)
      cur = []
    } else field += ch
  }
  cur.push(field)
  if (cur.some(c => c.trim() !== '')) rows.push(cur)
  if (!rows.length) return []
  const headers = rows[0].map(h => h.replace(/^\uFEFF/, '').trim())
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
}

function extractRecords(content, filename) {
  const trimmed = String(content).trim()
  let rows = null
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed)
      rows = Array.isArray(data) ? data
        : (data.jobs || data.details || data.data || data.list || data.result || null)
      if (rows && !Array.isArray(rows)) rows = null
    } catch { /* fallthrough */ }
  }
  if (!rows) {
    if (/\.csv$/i.test(filename || '') || trimmed.includes(',') && trimmed.split('\n')[0].includes(',')) {
      rows = parseCsv(trimmed)
    }
  }
  if (!rows) throw new Error('无法识别的文件格式：请提供采集器导出的 JSON 或 CSV 文件')
  return rows
}

/* ================= 采集器（boss-zhipin-scraper）结果目录 ================= */
export const SCRAPER_RESULT_DIR = getSetting('scraperDir') || path.join(os.homedir(), '.boss-zhipin-scraper', 'job-result')

function scraperFiles() {
  if (!fs.existsSync(SCRAPER_RESULT_DIR)) return []
  return fs.readdirSync(SCRAPER_RESULT_DIR)
    .filter(f => /^boss_(jobs|details)_.*\.json$/i.test(f))
    .map(f => {
      const full = path.join(SCRAPER_RESULT_DIR, f)
      const st = fs.statSync(full)
      return { file: f, path: full, size: st.size, mtime: st.mtime.toISOString(), kind: /jobs/i.test(f) ? 'list' : 'details' }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

app.get('/api/scraper/status', (req, res) => {
  const files = scraperFiles()
  const enriched = files.map(f => {
    const data = readJsonSafe(f.path)
    return {
      ...f,
      kind: /jobs/i.test(f.file) ? 'list' : 'details',
      total: data?.total ?? (Array.isArray(data) ? data.length : null),
      scrapedAt: data?.scraped_at || null,
      keyword: data?.keyword || '',
      city: data?.city || '',
    }
  })
  res.json({ dir: SCRAPER_RESULT_DIR, exists: fs.existsSync(SCRAPER_RESULT_DIR), files: enriched })
})

app.post('/api/jobs/import-scraper', (req, res) => {
  const { files } = req.body || {}
  res.json(runScraperImport(Array.isArray(files) && files.length ? files : null))
})

/* 采集结果导入核心（供 API 与每日定时任务复用） */
export function runScraperImport(filesFilter = null) {
  const all = scraperFiles()
  let listFiles = all.filter(f => f.kind === 'list')
  let detailFiles = all.filter(f => f.kind === 'details')
  if (filesFilter) {
    listFiles = listFiles.filter(f => filesFilter.includes(f.file))
    detailFiles = detailFiles.filter(f => filesFilter.includes(f.file))
  }
  if (!listFiles.length) {
    throw new Error(`未找到采集结果。请先运行 boss-zhipin-scraper 采集，确认目录 ${SCRAPER_RESULT_DIR} 下有 boss_jobs_*.json`)
  }

  // 详情记录按 数字job_id 与 链接中的加密job_id 双键索引（两者都可能是库内岗位的唯一关联）
  const detailMap = new Map()
  for (const f of detailFiles) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.details || data?.jobs || [])
    for (const r of recs) {
      if (!r || typeof r !== 'object' || (!r.jd && !r.skill_tags)) continue
      const linkId = String(String(r.job_link || r.link || '').match(/job_detail\/([^.?/]+)/)?.[1] || '')
      for (const key of [String(r.job_id || ''), linkId]) {
        if (key && !detailMap.has(key)) detailMap.set(key, r)
      }
    }
  }

  let created = 0, skipped = 0, updated = 0, noDetail = 0
  const createdJobs = []
  for (const f of listFiles) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.jobs || [])
    for (const r of recs) {
      const linkId = String(String(r?.job_link || '').match(/job_detail\/([^.?/]+)/)?.[1] || '')
      const d = detailMap.get(String(r?.job_id || '')) || detailMap.get(linkId)
      if (!d) noDetail++
      const row = normalizeImportRow({ ...r, ...(d || {}), job_link: r.job_link || d?.job_link }, 'boss-zhipin-scraper')
      if (!row) continue
      const out = upsertImportRow(row)
      if (out.created) { created++; createdJobs.push(out.job) } else if (out.updated) updated++
      else skipped++
    }
  }
  return { ok: true, created, updated, skipped, noDetail: detailFiles.length ? noDetail : 0, createdJobs }
}

/* 用采集详情文件回填库内缺失/过短的JD正文（匹配 key：sourceUrl 中的加密job_id） */
export function backfillDetailsFromScraper() {
  const detailFiles = scraperFiles().filter(f => f.kind === 'details')
  if (!detailFiles.length) return { ok: false, reason: '结果目录中没有详情文件（boss_details_*.json）' }
  const detailMap = new Map()
  for (const f of detailFiles) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.details || data?.jobs || [])
    for (const r of recs) {
      if (!r || typeof r !== 'object') continue
      const jd = String(r.jd || '')
      const linkId = String(String(r.job_link || r.link || '').match(/job_detail\/([^.?/]+)/)?.[1] || '')
      for (const key of [String(r.job_id || ''), linkId]) {
        // 同一岗位存在多条详情时保留最长JD
        const prev = detailMap.get(key)
        if (key && jd.length > String(prev?.jd || '').length) detailMap.set(key, r)
      }
    }
  }
  let matched = 0, updated = 0
  for (const job of listJobs()) {
    const linkId = String(String(job.sourceUrl || '').match(/job_detail\/([^.?/]+)/)?.[1] || '')
    if (!linkId) continue
    const d = detailMap.get(linkId)
    const jd = stripJdNoise(d?.jd || '')
    if (!jd) continue
    matched++
    if (jd.length > (job.description || '').length + 20) {
      updateJob(job.id, { description: jd, bossActive: d.boss_active_status || job.bossActive })
      updated++
    }
  }
  return { ok: true, matched, updated }
}

app.post('/api/jobs/backfill-details', (req, res) => {
  if (req.body?.deep) return res.json(startDeepBackfill())
  res.json(backfillDetailsFromScraper())
})

/* ---------- 深度补齐：对库内JD不全的岗位重新抓取详情页（异步任务） ---------- */
const COLLECTOR_DIR = path.join(__dirname, 'collector', 'boss-zhipin-scraper')
const deepState = { running: false, last: null }

const encryptIdOf = (url) => String(String(url || '').match(/job_detail\/([^.?/]+)/)?.[1] || '')

function countJobsLackingJd() {
  return listJobs().filter(j => jdLooksIncomplete(j) && encryptIdOf(j.sourceUrl)).length
}

function buildDeepBackfillInput() {
  const lacking = listJobs().filter(j => jdLooksIncomplete(j) && encryptIdOf(j.sourceUrl))
  if (!lacking.length) return null
  // 从已有列表结果里找回岗位的采集记录（详情抓取需要 job_id）
  const listRecs = new Map()
  for (const f of scraperFiles().filter(f => f.kind === 'list')) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.jobs || [])
    for (const r of recs) {
      const id = encryptIdOf(r?.job_link)
      if (id && !listRecs.has(id)) listRecs.set(id, r)
    }
  }
  const recs = []
  for (const job of lacking) { const r = listRecs.get(encryptIdOf(job.sourceUrl)); if (r) recs.push(r) }
  if (!recs.length) return null
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const file = path.join(SCRAPER_RESULT_DIR, `backfill_input_${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify({ keyword: '产品经理', city: '深圳', jobs: recs }))
  return { file, total: recs.length, lacking: lacking.length }
}

export function startDeepBackfill() {
  if (deepState.running) return { skipped: true, reason: '深度补齐已在进行中，请稍候' }
  if (countJobsLackingJd() === 0) return { skipped: true, reason: '库内岗位JD均已完整，无需补齐' }
  const input = buildDeepBackfillInput()
  if (!input) {
    deepState.last = { at: nowIso(), ok: false, error: 'JD不全的岗位在采集结果列表中找不到对应记录，无法重新抓取' }
    return { skipped: true, reason: deepState.last.error }
  }
  deepState.running = true
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const detailOutput = path.join(SCRAPER_RESULT_DIR, `boss_details_backfill_${stamp}.json`)
  console.log(`[深度补齐] 开始：待补 ${input.total} 个岗位（JD<300字的共 ${input.lacking} 个）`)
  const child = spawn('python3', [
    'scripts/boss_cdp_raw.py', '--input', input.file,
    '--detail', '--detail-output', detailOutput,
    '--max-details', String(Math.min(input.total, 120)),
  ], { cwd: COLLECTOR_DIR, env: process.env })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }, 40 * 60_000)
  child.on('error', e => {
    clearTimeout(timer)
    deepState.running = false
    deepState.last = { at: nowIso(), ok: false, error: `采集器启动失败：${e.message}` }
    console.log(`[深度补齐] 失败：${e.message}`)
  })
  child.on('close', code => {
    clearTimeout(timer)
    const merged = code === 0 ? backfillDetailsFromScraper() : null
    deepState.running = false
    deepState.last = {
      at: nowIso(), ok: code === 0, code,
      pending: input.total, backfill: merged,
      error: code === 0 ? ''
        : (stderr.includes('login') || stderr.includes('登录') ? '登录态失效，需重新 --setup-chrome 登录后再试'
          : `采集器退出码 ${code}`),
      stdout: String(stdout).slice(-1500),
    }
    console.log(`[深度补齐] 结束：${deepState.last.ok ? '成功' : '失败'}${merged ? `，回填JD ${merged.updated}/${merged.matched} 个` : ''}`)
  })
  return { started: true, pending: input.total, detailOutput }
}

app.get('/api/jobs/backfill-details', (req, res) => {
  res.json({ running: deepState.running, last: deepState.last, lackingNow: countJobsLackingJd() })
})

/* ================= 岗位 API ================= */
app.get('/api/jobs', (req, res) => {
  res.json(listJobs())
})

app.post('/api/jobs', (req, res) => {
  const b = req.body || {}
  if (!b.title) return res.status(400).json({ error: '岗位名称不能为空' })
  const exp = parseExperience(b.experienceText)
  const sal = parseSalary(b.salaryText)
  const job = createJob({
    title: b.title, category: b.category || (/产品/.test(b.title) ? '产品经理' : ''),
    company: b.company || '', city: b.city || '', recruitType: b.recruitType || exp.recruitType,
    expMin: b.expMin ?? exp.min, expMax: b.expMax ?? exp.max,
    experienceText: b.experienceText || '', salaryMin: b.salaryMin ?? sal.min,
    salaryMax: b.salaryMax ?? sal.max, salaryText: b.salaryText || '',
    salaryNote: b.salaryNote || sal.note, education: b.education || '',
    tags: Array.isArray(b.tags) ? b.tags : [], description: b.description || '',
    source: b.source || '手动添加', sourceUrl: b.sourceUrl || '', publishedAt: b.publishedAt || null,
  })
  res.json(job)
})

app.post('/api/jobs/import', async (req, res) => {
  try {
    const { mode = 'text', content = '', sourceUrl = '' } = req.body || {}
    let text = '', url = sourceUrl
    if (mode === 'url') {
      if (!sourceUrl) return res.status(400).json({ error: '请填写岗位链接' })
      const r = await fetchUrlText(sourceUrl)
      text = r.text
      if (text.length < 80) throw new Error('抓取到的内容太短，目标页面可能有登录墙或反爬验证，建议在页面上全选复制JD文本后用「粘贴导入」')
    } else {
      text = content
      if (!text || text.trim().length < 20) return res.status(400).json({ error: 'JD文本太短' })
    }

    let parsed = {}
    let parsedBy = 'heuristic'
    if (aiReady()) {
      try { parsed = await aiParseJd(text); parsedBy = 'ai' } catch { parsed = {} }
    }
    const fallback = heuristicParseJd(text)
    parsed = {
      title: parsed.title || fallback.title,
      category: parsed.category || fallback.category,
      company: parsed.company || fallback.company,
      city: parsed.city || fallback.city,
      recruitType: parsed.recruitType || fallback.recruitType,
      expMin: parsed.expMin ?? fallback.expMin,
      expMax: parsed.expMax ?? fallback.expMax,
      experienceText: parsed.experienceText || fallback.experienceText,
      education: parsed.education || fallback.education,
      salaryMin: parsed.salaryMin ?? fallback.salaryMin,
      salaryMax: parsed.salaryMax ?? fallback.salaryMax,
      salaryText: parsed.salaryText || fallback.salaryText,
      salaryNote: parsed.salaryNote || fallback.salaryNote,
      tags: Array.isArray(parsed.tags) && parsed.tags.length ? parsed.tags : fallback.tags,
      publishedAt: parsed.publishedAt || fallback.publishedAt || null,
    }
    const job = createJob({
      ...parsed, description: text, source: mode === 'url' ? '链接导入' : '粘贴导入',
      sourceUrl: url, importedAt: nowIso(),
    })
    res.json({ ok: true, job, parsedBy })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/jobs/import-batch', (req, res) => {
  try {
    const { content, filename = 'import.json', source = '批量导入' } = req.body || {}
    const rows = extractRecords(content, filename)
    let created = 0, skipped = 0, updated = 0
    const createdJobs = []
    for (const r of rows) {
      const row = normalizeImportRow(r, source)
      if (!row) continue
      const out = upsertImportRow(row)
      if (out.created) { created++; createdJobs.push(out.job) } else if (out.updated) updated++
      else skipped++
    }
    res.json({ ok: true, total: rows.length, created, updated, skipped, createdJobs })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.put('/api/jobs/:id', (req, res) => {
  const b = req.body || {}
  const fields = {}
  for (const k of ['title', 'category', 'company', 'city', 'recruitType', 'experienceText',
    'education', 'salaryText', 'salaryNote', 'description', 'sourceUrl', 'status', 'source']) {
    if (b[k] !== undefined) fields[k] = b[k]
  }
  if (b.salaryMin !== undefined || b.salaryMax !== undefined || b.salaryText !== undefined) {
    const sal = parseSalary(fields.salaryText ?? jobById(req.params.id)?.salaryText)
    fields.salaryMin = b.salaryMin ?? sal.min
    fields.salaryMax = b.salaryMax ?? sal.max
  }
  if (b.expMin !== undefined) fields.expMin = b.expMin
  if (b.expMax !== undefined) fields.expMax = b.expMax
  if (Array.isArray(b.tags)) fields.tags = b.tags
  if (b.favorite !== undefined) fields.favorite = b.favorite ? 1 : 0
  if (b.status === '已投递') fields.appliedAt = nowIso()
  const job = updateJob(req.params.id, fields)
  if (!job) return res.status(404).json({ error: '岗位不存在' })
  res.json(job)
})

/* 打招呼：preview 只渲染、不落数据；send 记录文案与时间，并按配置推进状态 */
app.post('/api/jobs/:id/greeting/preview', (req, res) => {
  const job = jobById(req.params.id)
  if (!job) return res.status(404).json({ error: '岗位不存在' })
  const config = greetingConfig()
  const override = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  res.json({ text: override || renderGreeting(config, job), config, job })
})

app.post('/api/jobs/:id/greeting', (req, res) => {
  const job = jobById(req.params.id)
  if (!job) return res.status(404).json({ error: '岗位不存在' })
  const config = greetingConfig()
  const override = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : ''
  const text = override || renderGreeting(config, job)
  if (!text) return res.status(400).json({ error: '打招呼文案为空，请先在设置里配置模板' })
  const fields = { greetingText: text, greetedAt: nowIso() }
  // 只推进「未处理 / 不感兴趣」，不覆盖已投递、面试中、offer 等更靠后的进度
  if (config.markStatus !== '不修改' && ['未处理', '不感兴趣'].includes(job.status || '未处理')) {
    fields.status = config.markStatus
  }
  res.json({ text, config, job: updateJob(job.id, fields) })
})

app.delete('/api/jobs/:id', (req, res) => {
  deleteJob(req.params.id)
  res.json({ ok: true })
})

/* ================= 信息库 API ================= */
async function fetchUrlText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}（页面可能需要登录）`)
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('pdf')) {
    const buf = Buffer.from(await res.arrayBuffer())
    const out = await pdfParse(buf)
    return out.text
  }
  const html = (await res.text()).slice(0, 3_000_000)
  return htmlToText(html)
}
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function safeFileName(name) {
  return String(name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80)
}

/* 前端预览确认后回传的解析诊断：只取已知字段，避免任意 JSON 入库 */
function sanitizeParseMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    source: String(meta.source || 'pdf').slice(0, 20),
    pages: num(meta.pages),
    chars: num(meta.chars),
    charsPerPage: num(meta.charsPerPage),
    level: ['ok', 'thin', 'low', 'empty'].includes(meta.level) ? meta.level : 'ok',
    suspicious: !!meta.suspicious,
    warnings: Array.isArray(meta.warnings) ? meta.warnings.slice(0, 5).map(w => String(w).slice(0, 300)) : [],
    method: String(meta.method || 'text').slice(0, 20),
    fileName: String(meta.fileName || '').slice(0, 200),
    savedPath: String(meta.savedPath || '').slice(0, 300),
  }
}

/* 上传源文件落到 data/uploads（已 gitignore），便于复现解析问题、重跑 OCR */
function saveUpload(name, buf) {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const full = path.join(UPLOAD_DIR, `${stamp}-${safeFileName(name)}`)
  fs.writeFileSync(full, buf)
  return full
}

export async function extractFileText(name, base64, { forceOcr = false } = {}) {
  const buf = Buffer.from(base64, 'base64')
  const ext = path.extname(name || '').toLowerCase()
  if (buf.length > 20 * 1024 * 1024) throw new Error('文件超过20MB')
  if (ext === '.pdf') {
    const saved = saveUpload(name, buf)
    const { text, meta } = await extractPdfSmart(buf, { filePath: saved, forceOcr })
    if (!text || text.trim().length < 10) {
      throw new Error('这份 PDF 提取不到文字（纯图片且本地 OCR 也没成功）：请改用「粘贴文本」，或导出成文字版 PDF / Word 再上传')
    }
    return { text, meta: { ...meta, fileName: name, savedPath: path.relative(__dirname, saved) } }
  }
  if (ext === '.docx') {
    const out = await mammoth.extractRawText({ buffer: buf })
    const text = cleanText(out.value)
    if (text.length < 10) throw new Error('Word 文档里没有可用的文字')
    return { text, meta: { source: 'docx', pages: 0, chars: text.length, level: 'ok', suspicious: false, warnings: [], method: 'docx' } }
  }
  if (ext === '.doc') throw new Error('暂不支持旧版 .doc，请另存为 .docx 或 PDF')
  if (['.txt', '.md', '.markdown', '.json', '.csv'].includes(ext) || ext === '') {
    const text = cleanText(buf.toString('utf-8'))
    return { text, meta: { ...assessText({ text, pages: 0, source: 'text' }), method: 'text-file' } }
  }
  throw new Error(`暂不支持 ${ext || '未知'} 格式，支持 pdf/docx/txt/md`)
}

app.get('/api/documents', (req, res) => {
  const docs = listDocuments().map(d => ({ ...d, contentPreview: (d.content || '').slice(0, 200) }))
  res.json(docs)
})

/* 上传前先解析预览：把「解析到什么 / 缺什么」摆到用户面前，再决定是否入库 */
app.post('/api/documents/parse', async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.fileBase64) return res.status(400).json({ error: '缺少文件内容' })
    const { text, meta } = await extractFileText(b.fileName, b.fileBase64, { forceOcr: !!b.ocr })
    res.json({ text, preview: text.slice(0, 4000), meta })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/documents/:id', (req, res) => {
  const doc = documentById(req.params.id)
  if (!doc) return res.status(404).json({ error: '资料不存在' })
  res.json(doc)
})

app.post('/api/documents', async (req, res) => {
  try {
    const b = req.body || {}
    let content = '', source = b.source || '粘贴文本', sourceUrl = '', parseMeta = null
    if (b.fileBase64) {
      const parsed = await extractFileText(b.fileName, b.fileBase64, { forceOcr: !!b.ocr })
      content = parsed.text
      parseMeta = parsed.meta
      source = '文件上传'
    } else if (b.url) {
      if (!/^https?:\/\//.test(b.url)) return res.status(400).json({ error: '请填写 http/https 链接' })
      content = await fetchUrlText(b.url)
      if (content.length < 50) throw new Error('抓取内容过短，请检查链接或改用粘贴')
      source = '网页链接'; sourceUrl = b.url
    } else if (b.content && b.parseMeta) {
      // 预览确认后入库：文本与解析诊断来自 /api/documents/parse
      content = b.content
      parseMeta = sanitizeParseMeta(b.parseMeta)
      source = b.source || '文件上传'
    } else {
      content = b.content || ''
    }
    if (!content || content.trim().length < 5) return res.status(400).json({ error: '内容为空' })
    const doc = createDocument({ name: b.name || b.fileName || '未命名资料', type: b.type || '其他', source, sourceUrl, content, parseMeta })
    res.json(doc)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.put('/api/documents/:id', (req, res) => {
  const b = req.body || {}
  const fields = {}
  if (b.name !== undefined) fields.name = b.name
  if (b.type !== undefined) fields.type = b.type
  if (b.content !== undefined) fields.content = b.content
  const doc = updateDocument(req.params.id, fields)
  if (!doc) return res.status(404).json({ error: '资料不存在' })
  res.json(doc)
})

app.delete('/api/documents/:id', (req, res) => {
  deleteDocument(req.params.id)
  res.json({ ok: true })
})

/* ================= 分析：JD × 当前简历 × 经历库 ================= */
const hashText = (t) => createHash('sha1').update(String(t || '')).digest('hex').slice(0, 10)

/* 文本相似度（字符二元组 Jaccard），用于跨轮次匹配模型命名不稳定的条目 */
function textSimilarity(a, b) {
  const bigrams = (s) => {
    const t = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    const out = new Set()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

const normalizeQuestion = (s) => String(s || '').replace(/[\s，。？！,.?!：:；;、（）()"“”'']/g, '')

function inputSnapshot({ jobs, resumeDoc, libraryDoc, answers }) {
  return {
    jobs: jobs.map(j => ({
      id: j.id, title: j.title, company: j.company || '', city: j.city || '',
      salaryText: j.salaryText || '', jdLength: (j.description || '').length, jdHash: hashText(j.description),
    })),
    resume: resumeDoc ? { id: resumeDoc.id, name: resumeDoc.name, length: (resumeDoc.content || '').length, hash: hashText(resumeDoc.content) } : null,
    library: libraryDoc ? { id: libraryDoc.id, name: libraryDoc.name, length: (libraryDoc.content || '').length, hash: hashText(libraryDoc.content) } : null,
    answers: (answers || []).map(a => ({ questionId: a.questionId, question: a.question, answer: a.answer })),
    versions: {
      jd: jobs.length === 1 ? `${jobs[0].title}（JD ${(jobs[0].description || '').length}字）` : `${jobs.length} 个岗位JD`,
      resume: resumeDoc ? `${resumeDoc.name}（${(resumeDoc.content || '').length}字）` : '未选择',
      library: libraryDoc ? `${libraryDoc.name}（${(libraryDoc.content || '').length}字）` : '未使用',
    },
  }
}

function blockedAnalysis({ input, quality, useAi }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: useAi ? 'ai' : 'basic',
    status: 'blocked',
    input,
    quality,
    overview: {
      recommendation: '信息不足',
      reason: '输入材料不足，无法给出投递建议。请先补齐下方提示的缺失内容。',
      topStrengths: [], topRisks: [],
      unconfirmed: quality.blockers.map((b, i) => ({ id: `U${i + 1}`, text: b.message, requirementIds: [] })),
      confidence: '低',
      confidenceReason: '关键材料缺失，任何匹配结论都不可靠',
    },
    requirements: [], resumeChanges: [], projects: [], skills: [], questions: [],
    scoring: {
      label: '材料匹配参考分', applicable: false, score: null, dimensions: [],
      coverage: null, known: 0, total: 0, hardBlockers: [],
      method: '输入材料不足，不展示总分。',
      notice: 'JD 或简历内容不足，未进行评分',
    },
    warnings: quality.warnings.map(w => w.message),
  }
}

async function runAnalysis({ jobs, resumeDoc, libraryDoc, answers = [], useAi, tuning, onProgress }) {
  const quality = checkInputs({ jobs, resumeText: resumeDoc?.content, libraryText: libraryDoc?.content })
  const input = inputSnapshot({ jobs, resumeDoc, libraryDoc, answers })
  if (!quality.ok) return blockedAnalysis({ input, quality, useAi })

  if (!useAi) {
    const basic = analyzeBasic({ jobs, resumeText: resumeDoc.content, libraryText: libraryDoc?.content || '', answers })
    if (!basic.requirements.length) {
      return blockedAnalysis({
        input, useAi: false,
        quality: { ...quality, ok: false, blockers: [...quality.blockers, { code: 'JD_UNPARSABLE', severity: 'blocker', message: '无法从 JD 中切分出可判断的要求，请补充完整 JD 正文' }] },
      })
    }
    return { ...basic, input, quality }
  }

  let common = null
  if (jobs.length > 1) {
    onProgress?.('正在提炼多岗位共性要求…', 12)
    try { common = await aiExtractCommon(jobs, tuning) } catch (e) { common = { commonRequirements: [], overallAdvice: '', error: e.message } }
    onProgress?.('共性要求已提炼，开始逐岗分析…', 20)
  }
  try {
    const out = await analyzeWithAi({ jobs, resumeText: resumeDoc.content, libraryText: libraryDoc?.content || '', answers, common, tuning, onProgress })
    if (out.status === 'failed') {
      return {
        schemaVersion: SCHEMA_VERSION, mode: 'ai', status: 'failed',
        input, quality, common: null,
        error: out.error,
        requirements: [], resumeChanges: [], projects: [], skills: [], questions: [],
        overview: null,
        scoring: null,
        warnings: ['AI 分析失败，未生成任何结论。可重试，或先在设置页检查模型配置。'],
      }
    }
    return { ...out, input, quality }
  } catch (e) {
    return {
      schemaVersion: SCHEMA_VERSION, mode: 'ai', status: 'failed',
      input, quality, error: e.message,
      requirements: [], resumeChanges: [], projects: [], skills: [], questions: [],
      overview: null, scoring: null,
      warnings: ['AI 分析失败，未生成任何结论。可重试，或先在设置页检查模型配置。'],
    }
  }
}

/* 解析并校验分析入参：两个接口共用，避免规则漂移 */
function resolveAnalyzeInput(body = {}) {
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.slice(0, 5) : []
  const resumeDocId = body.resumeDocId || body.documentId
  if (!jobIds.length) return { error: '请至少选择一个目标岗位' }
  if (!resumeDocId) return { error: '请选择当前投递使用的简历（用于判断招聘方实际能看到什么）' }
  const jobs = jobIds.map(id => jobById(id)).filter(Boolean)
  if (!jobs.length) return { error: '岗位不存在' }
  const resumeDoc = documentById(resumeDocId)
  if (!resumeDoc) return { error: '简历不存在，请重新选择' }
  const libraryDoc = body.libraryDocId ? documentById(body.libraryDocId) : null
  return { jobs, resumeDoc, libraryDoc, answers: body.answers || [] }
}

function persistAnalysis({ jobs, resumeDoc, libraryDoc, data }) {
  return createAnalysis({
    jobIds: jobs.map(j => j.id),
    jobTitles: jobs.map(j => j.title + (j.company ? `（${j.company}）` : '')).join('、'),
    documentId: resumeDoc.id, documentName: resumeDoc.name,
    resumeDocId: resumeDoc.id, libraryDocId: libraryDoc?.id || null,
    mode: data.mode, status: data.status, answers: data.input?.answers || [],
    data,
  })
}

app.post('/api/analyze', async (req, res) => {
  try {
    const input = resolveAnalyzeInput(req.body)
    if (input.error) return res.status(400).json({ error: input.error })
    const data = await runAnalysis({ ...input, useAi: aiReady(), tuning: analysisTuning() })
    res.json(persistAnalysis({ ...input, data }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* 流式分析：多岗位耗时较长，用 SSE 回传进度，最后一条 done 携带完整结果 */
app.post('/api/analyze/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event, payload) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  let pct = 5
  const startedAt = Date.now()
  // 心跳兼作「仍在分析」进度：单岗调用期间没有中间事件，避免进度条卡住不动
  const heartbeat = setInterval(() => {
    const sec = Math.round((Date.now() - startedAt) / 1000)
    pct = Math.min(92, pct + 3)
    send('progress', { message: `仍在分析…已用 ${sec} 秒`, percent: pct })
  }, 15_000)
  // 注意：不能监听 req 的 close（请求体读完后就会触发），否则正常结束时不会关闭响应
  res.on('close', () => clearInterval(heartbeat))

  try {
    const input = resolveAnalyzeInput(req.body)
    if (input.error) {
      send('error', { error: input.error })
    } else {
      send('progress', { message: '正在校验输入材料…', percent: 5 })
      const data = await runAnalysis({
        ...input, useAi: aiReady(), tuning: analysisTuning(),
        onProgress: (message, percent) => {
          if (Number.isFinite(percent)) pct = percent
          send('progress', { message, percent })
        },
      })
      send('progress', { message: '正在整理并保存分析结果…', percent: 95 })
      const analysis = persistAnalysis({ ...input, data })
      send('done', analysis)
    }
  } catch (e) {
    send('error', { error: e.message })
  } finally {
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  }
})

/* 用户补充回答 → 更新关联分析（不重复追问已有信息） */
app.post('/api/analyses/:id/answers', async (req, res) => {
  try {
    const prev = analysisById(req.params.id)
    if (!prev) return res.status(404).json({ error: '分析记录不存在' })
    const inbound = Array.isArray(req.body?.answers) ? req.body.answers : []
    const answered = inbound
      .map(a => ({ questionId: String(a?.questionId || ''), question: String(a?.question || ''), answer: String(a?.answer || '').trim() }))
      .filter(a => a.answer)
    if (!answered.length) return res.status(400).json({ error: '请至少回答一个问题' })

    // 答案按"问题文本"归属：不同轮次的 Q1/Q2 编号会变化，仅靠 ID 会把答案挂错问题
    const mergedAnswers = [...(prev.answers || [])]
    for (const a of answered) {
      const idx = mergedAnswers.findIndex(x => normalizeQuestion(x.question) === normalizeQuestion(a.question)
        || textSimilarity(x.question, a.question) >= 0.75)
      if (idx >= 0) {
        mergedAnswers[idx] = { ...mergedAnswers[idx], questionId: a.questionId, question: a.question, answer: a.answer, answeredAt: new Date().toISOString() }
      } else {
        mergedAnswers.push({ ...a, answeredAt: new Date().toISOString() })
      }
    }

    const jobs = (prev.jobIds || []).map(id => jobById(id)).filter(Boolean)
    const resumeDoc = documentById(prev.resumeDocId || prev.documentId)
    const libraryDoc = prev.libraryDocId ? documentById(prev.libraryDocId) : null
    if (!jobs.length || !resumeDoc) return res.status(400).json({ error: '原始输入已不存在（岗位或简历被删除），请重新发起分析' })

    const data = await runAnalysis({ jobs, resumeDoc, libraryDoc, answers: mergedAnswers, useAi: aiReady() })

    // 标记本次回答更新了哪些判断：模型每次命名可能不同，用相似度做匹配
    const similarity = textSimilarity
    const prevReqs = prev.data?.requirements || []
    const changed = []
    const used = new Set()
    for (const r of data.requirements || []) {
      let best = null, bestScore = 0
      for (const old of prevReqs) {
        if (used.has(old.id)) continue
        const score = similarity(r.name, old.name)
        if (score > bestScore) { bestScore = score; best = old }
      }
      if (best && bestScore >= 0.5) {
        used.add(best.id)
        if (best.judgment !== r.judgment) changed.push({ id: r.id, name: r.name, from: best.judgment, to: r.judgment })
      }
    }
    // 已回答的问题不再追问：从新问题里剔除与已回答问题表述相近的项，已答内容单独归档展示
    const isAnswered = (q) => mergedAnswers.some(a => textSimilarity(a.question, q.question) >= 0.7)
    data.questions = (data.questions || []).filter(q => !isAnswered(q)).slice(0, 5)
    data.answeredQuestions = mergedAnswers
    data.answerUpdate = { at: new Date().toISOString(), answered: answered.map(a => a.questionId), changed }

    const analysis = updateAnalysis(prev.id, { data, answers: mergedAnswers, status: data.status, mode: data.mode })
    res.json(analysis)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* 采纳/撤销简历修改、学习任务完成状态 */
app.put('/api/analyses/:id/state', (req, res) => {
  const a = analysisById(req.params.id)
  if (!a) return res.status(404).json({ error: '分析记录不存在' })
  const data = a.data || {}
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : null
  const skills = Array.isArray(req.body?.skills) ? req.body.skills : null
  if (changes) {
    const map = new Map(changes.map(c => [String(c.id), c]))
    data.resumeChanges = (data.resumeChanges || []).map(c => {
      const hit = map.get(c.id)
      if (!hit) return c
      return {
        ...c,
        adopted: !!hit.adopted,
        adoptedText: hit.adopted ? String(hit.adoptedText || c.suggested || '') : null,
      }
    })
  }
  if (skills) {
    const map = new Map(skills.map(s => [String(s.id), s]))
    data.skills = (data.skills || []).map(s => {
      const hit = map.get(s.id)
      return hit ? { ...s, done: !!hit.done } : s
    })
  }
  const updated = updateAnalysis(a.id, { data })
  res.json(updated)
})

/* 基于已采纳的修改生成针对性简历（不改动原始简历，可随时撤销/重来） */
app.post('/api/resumes/from-analysis', (req, res) => {
  const a = analysisById(req.body?.analysisId)
  if (!a) return res.status(404).json({ error: '分析记录不存在' })
  const baseDoc = documentById(a.resumeDocId || a.documentId)
  if (!baseDoc) return res.status(400).json({ error: '原始简历已被删除，无法生成' })
  const adopted = (a.data?.resumeChanges || []).filter(c => c.adopted)
  if (!adopted.length) return res.status(400).json({ error: '请先采纳至少一条简历修改' })

  let text = baseDoc.content || ''
  const applied = [], skipped = []
  for (const c of adopted) {
    const finalText = String(c.adoptedText || c.suggested || '').trim()
    if (!finalText) { skipped.push({ id: c.id, reason: '改写内容为空' }); continue }
    if (/【[^】]*(待确认|待补)[^】]*】/.test(finalText)) {
      skipped.push({ id: c.id, reason: '改写中含「待确认」占位符，请确认事实后再采纳' })
      continue
    }
    const orig = String(c.original || '').trim()
    if (!orig) { skipped.push({ id: c.id, reason: '缺少原简历对应原文，需手动改写' }); continue }
    if (!text.includes(orig)) { skipped.push({ id: c.id, reason: '原简历中未找到该原文片段' }); continue }
    text = text.replace(orig, finalText)
    applied.push(c.id)
  }
  if (!applied.length) {
    return res.status(400).json({ error: '没有可安全应用的修改：' + skipped.map(s => s.reason).join('；') })
  }
  const notes = applied.map(id => {
    const c = adopted.find(x => x.id === id)
    return `[${c.type}] ${c.location}：${c.reason || '按岗位要求调整'}（对应要求：${c.requirementName || c.requirementId}）`
  })
  const version = createResumeVersion({
    name: req.body?.name || `针对性简历-${(a.jobTitles || '').slice(0, 30)}`,
    jobIds: a.jobIds, jobTitles: a.jobTitles,
    documentId: baseDoc.id, documentName: baseDoc.name,
    content: text, changeNotes: notes,
    analysisId: a.id, adoptedChangeIds: applied,
  })
  res.json({ version, applied, skipped })
})

app.get('/api/analyses', (req, res) => {
  res.json(listAnalyses())
})
app.get('/api/analyses/:id', (req, res) => {
  const a = analysisById(req.params.id)
  if (!a) return res.status(404).json({ error: '分析记录不存在' })
  res.json(a)
})
app.delete('/api/analyses/:id', (req, res) => {
  deleteAnalysis(req.params.id)
  res.json({ ok: true })
})

app.post('/api/rewrite', async (req, res) => {
  try {
    const { jobIds = [], documentId, extra = '', analysisId } = req.body || {}
    if (!jobIds.length) return res.status(400).json({ error: '请至少选择一个目标岗位' })
    const jobs = jobIds.map(id => jobById(id)).filter(Boolean)
    if (!jobs.length) return res.status(400).json({ error: '岗位不存在' })
    const doc = documentId ? documentById(documentId) : null
    if (!doc || !doc.content) return res.status(400).json({ error: '请先在「信息库」上传基础简历，并在此选择' })

    let common = null
    if (analysisId) {
      const a = analysisById(analysisId)
      if (a?.data?.common) common = a.data.common
    }
    const useAi = aiReady()
    if (useAi && jobs.length > 1 && !common) {
      try { common = await aiExtractCommon(jobs) } catch {}
    }
    if (!useAi) {
      return res.status(400).json({ error: 'AI改简历需要配置 AI API Key（设置页配置后即可使用）' })
    }
    const commonText = common?.commonRequirements?.length
      ? common.commonRequirements.map(r => `【${r.weight}】${r.requirement}（${r.why || ''}）`).join('\n') : ''
    const out = await aiRewriteResume(jobs, doc.content, extra, commonText)
    const version = createResumeVersion({
      name: `定制简历-${jobs.map(j => j.title).join('/').slice(0, 40)}`,
      jobIds: jobs.map(j => j.id),
      jobTitles: jobs.map(j => j.title + (j.company ? `（${j.company}）` : '')).join('、'),
      documentId: doc.id, documentName: doc.name,
      content: out.resumeMarkdown || '', changeNotes: out.changeNotes || [],
    })
    res.json({ version, common })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/resumes', (req, res) => {
  res.json(listResumeVersions())
})
app.get('/api/resumes/:id', (req, res) => {
  const r = resumeVersionById(req.params.id)
  if (!r) return res.status(404).json({ error: '版本不存在' })
  res.json(r)
})
app.put('/api/resumes/:id', (req, res) => {
  const r = updateResumeVersion(req.params.id, { content: req.body?.content, name: req.body?.name })
  if (!r) return res.status(404).json({ error: '版本不存在' })
  res.json(r)
})
app.delete('/api/resumes/:id', (req, res) => {
  deleteResumeVersion(req.params.id)
  res.json({ ok: true })
})

/* ================= 设置 ================= */
app.get('/api/settings', (req, res) => {
  const cfg = aiConfig()
  res.json({
    apiBase: cfg.apiBase, model: cfg.model,
    hasKey: !!cfg.apiKey, ready: aiReady(), keySource: cfg.source,
    defaults: { apiBase: DEFAULT_API_BASE, model: DEFAULT_MODEL },
    analysis: analysisTuning(),
    analysisDefaults: DEFAULT_TUNING,
    analysisRules: TUNING_RULES,
    greeting: greetingConfig(),
    greetingDefaults: DEFAULT_GREETING,
    greetingPlaceholders: GREETING_PLACEHOLDERS,
    scraperDir: SCRAPER_RESULT_DIR,
  })
})
app.put('/api/settings', (req, res) => {
  const body = req.body || {}
  saveAiConfig(body)
  const analysis = body.analysis !== undefined ? saveAnalysisTuning(body.analysis) : analysisTuning()
  const greeting = body.greeting !== undefined ? saveGreetingConfig(body.greeting) : greetingConfig()
  const cfg = aiConfig()
  res.json({
    apiBase: cfg.apiBase, model: cfg.model, hasKey: !!cfg.apiKey, ready: aiReady(), keySource: cfg.source,
    analysis, greeting,
  })
})
app.post('/api/settings/test', async (req, res) => {
  try {
    const r = await testConnection()
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/* ================= 定时采集任务 ================= */
app.get('/api/scheduler', (req, res) => {
  res.json(scheduleStatus())
})
app.put('/api/scheduler', (req, res) => {
  saveScheduleConfig(req.body || {})
  res.json(scheduleStatus())
})
app.post('/api/scheduler/run', async (req, res) => {
  try {
    res.json(await runCollectOnce('manual'))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ================= 静态资源 & 启动 ================= */
const distDir = path.join(__dirname, 'dist')
app.use(express.static(distDir))
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(distDir, 'index.html'))
  }
  next()
})

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || '服务器内部错误' })
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`求职工作台已启动: http://localhost:${PORT}`)
})

/* 启动时：用已有采集详情回填库内缺失的JD正文；启动每日9点定时采集 */
try {
  const bf = backfillDetailsFromScraper()
  if (bf.ok && bf.updated > 0) console.log(`已从采集详情回填 ${bf.updated}/${bf.matched} 个岗位的JD正文`)
} catch (e) { console.error('JD详情回填失败:', e.message) }
startScheduler({
  runImport: () => {
    const imp = runScraperImport(null)
    const backfill = backfillDetailsFromScraper()
    return { ...imp, backfill }
  },
})
