import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'

import {
  createJob, updateJob, jobById, listJobs, deleteJob, jobExists,
  createDocument, updateDocument, documentById, listDocuments, deleteDocument,
  createAnalysis, analysisById, listAnalyses, deleteAnalysis,
  createResumeVersion, updateResumeVersion, resumeVersionById, listResumeVersions,
  getSetting, setSetting,
} from './db.js'
import {
  aiConfig, aiReady, saveAiConfig, aiParseJd, heuristicParseJd,
  aiAnalyzeJob, aiExtractCommon, aiRewriteResume, testConnection,
  heuristicAnalyzeJob, heuristicCommon, DEFAULT_API_BASE, DEFAULT_MODEL,
} from './ai.js'
import { seedIfEmpty } from './seed.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '40mb' }))

const nowIso = () => new Date().toISOString()

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
  const description = String(pick(row, ['description', 'jd', 'jobDesc', 'postDescription', '描述', '详情', '职位描述', 'content']) || '')
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
  const all = scraperFiles()
  let listFiles = all.filter(f => f.kind === 'list')
  let detailFiles = all.filter(f => f.kind === 'details')
  if (Array.isArray(files) && files.length) {
    listFiles = listFiles.filter(f => files.includes(f.file))
    detailFiles = detailFiles.filter(f => files.includes(f.file))
  }
  if (!listFiles.length) {
    return res.status(400).json({ error: `未找到采集结果。请先运行 boss-zhipin-scraper 采集，确认目录 ${SCRAPER_RESULT_DIR} 下有 boss_jobs_*.json` })
  }

  // job_id -> detail(jd/skills)
  const detailMap = new Map()
  for (const f of detailFiles) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.details || data?.jobs || [])
    for (const r of recs) {
      const id = String(r?.job_id || '')
      if (id && (r.jd || r.skill_tags) && !detailMap.has(id)) detailMap.set(id, r)
    }
  }

  let created = 0, skipped = 0, updated = 0, noDetail = 0
  const createdJobs = []
  for (const f of listFiles) {
    const data = readJsonSafe(f.path)
    const recs = Array.isArray(data) ? data : (data?.jobs || [])
    for (const r of recs) {
      const id = String(r?.job_id || r?.encrypt_job_id || '')
      const d = detailMap.get(id)
      if (!d) noDetail++
      const row = normalizeImportRow({ ...r, ...(d || {}), job_link: r.job_link || d?.job_link }, 'boss-zhipin-scraper')
      if (!row) continue
      const out = upsertImportRow(row)
      if (out.created) { created++; createdJobs.push(out.job) } else if (out.updated) updated++
      else skipped++
    }
  }
  res.json({ ok: true, created, updated, skipped, noDetail: detailFiles.length ? noDetail : 0, createdJobs })
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

async function extractFileText(name, base64) {
  const buf = Buffer.from(base64, 'base64')
  const ext = path.extname(name || '').toLowerCase()
  if (buf.length > 20 * 1024 * 1024) throw new Error('文件超过20MB')
  if (ext === '.pdf') {
    const out = await pdfParse(buf)
    if (!out.text || out.text.trim().length < 10) throw new Error('PDF解析结果为空（可能是扫描件），请改用粘贴文本')
    return out.text
  }
  if (ext === '.docx') {
    const out = await mammoth.extractRawText({ buffer: buf })
    return out.value
  }
  if (ext === '.doc') throw new Error('暂不支持旧版 .doc，请另存为 .docx 或 PDF')
  if (['.txt', '.md', '.markdown', '.json', '.csv'].includes(ext) || ext === '') return buf.toString('utf-8')
  throw new Error(`暂不支持 ${ext || '未知'} 格式，支持 pdf/docx/txt/md`)
}

app.get('/api/documents', (req, res) => {
  const docs = listDocuments().map(d => ({ ...d, contentPreview: (d.content || '').slice(0, 200) }))
  res.json(docs)
})

app.get('/api/documents/:id', (req, res) => {
  const doc = documentById(req.params.id)
  if (!doc) return res.status(404).json({ error: '资料不存在' })
  res.json(doc)
})

app.post('/api/documents', async (req, res) => {
  try {
    const b = req.body || {}
    let content = '', source = b.source || '粘贴文本', sourceUrl = ''
    if (b.fileBase64) {
      content = await extractFileText(b.fileName, b.fileBase64)
      source = '文件上传'
    } else if (b.url) {
      if (!/^https?:\/\//.test(b.url)) return res.status(400).json({ error: '请填写 http/https 链接' })
      content = await fetchUrlText(b.url)
      if (content.length < 50) throw new Error('抓取内容过短，请检查链接或改用粘贴')
      source = '网页链接'; sourceUrl = b.url
    } else {
      content = b.content || ''
    }
    if (!content || content.trim().length < 5) return res.status(400).json({ error: '内容为空' })
    const doc = createDocument({ name: b.name || b.fileName || '未命名资料', type: b.type || '其他', source, sourceUrl, content })
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

/* ================= AI 分析 / 改简历 ================= */
app.post('/api/analyze', async (req, res) => {
  try {
    const { jobIds = [], documentId } = req.body || {}
    if (!jobIds.length) return res.status(400).json({ error: '请至少选择一个岗位' })
    const jobs = jobIds.map(id => jobById(id)).filter(Boolean)
    if (!jobs.length) return res.status(400).json({ error: '岗位不存在' })
    const doc = documentId ? documentById(documentId) : null
    if (!doc || !doc.content) return res.status(400).json({ error: '请先在「信息库」上传简历或经历资料，并在此选择' })

    const useAi = aiReady()
    let common = null
    const results = []
    if (useAi) {
      if (jobs.length > 1) {
        try { common = await aiExtractCommon(jobs) } catch (e) { common = { commonRequirements: [], overallAdvice: '', error: '共性提炼失败：' + e.message } }
      }
      const commonText = common?.commonRequirements?.length
        ? common.commonRequirements.map(r => `【${r.weight}】${r.requirement}（${r.why || ''}）`).join('\n') : ''
      for (const job of jobs) {
        try {
          const r = await aiAnalyzeJob(job, doc.content, commonText)
          results.push({ jobId: job.id, jobTitle: job.title, company: job.company, ...r })
        } catch (e) {
          results.push({ jobId: job.id, jobTitle: job.title, company: job.company, error: e.message })
        }
      }
    } else {
      for (const job of jobs) {
        results.push({ jobId: job.id, jobTitle: job.title, company: job.company, ...heuristicAnalyzeJob(job, doc.content) })
      }
      if (jobs.length > 1) common = heuristicCommon(jobs)
    }

    const analysis = createAnalysis({
      jobIds: jobs.map(j => j.id),
      jobTitles: jobs.map(j => j.title + (j.company ? `（${j.company}）` : '')).join('、'),
      documentId: doc.id, documentName: doc.name,
      mode: useAi ? 'ai' : 'simple',
      data: { common, results },
    })
    res.json(analysis)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
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
    hasKey: !!cfg.apiKey, ready: aiReady(),
    defaults: { apiBase: DEFAULT_API_BASE, model: DEFAULT_MODEL },
    scraperDir: SCRAPER_RESULT_DIR,
  })
})
app.put('/api/settings', (req, res) => {
  saveAiConfig(req.body || {})
  const cfg = aiConfig()
  res.json({ apiBase: cfg.apiBase, model: cfg.model, hasKey: !!cfg.apiKey, ready: aiReady() })
})
app.post('/api/settings/test', async (req, res) => {
  try {
    const r = await testConnection()
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: e.message })
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

const seeded = seedIfEmpty()
const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`求职工作台已启动: http://localhost:${PORT}`)
  if (seeded) console.log(`已载入 ${seeded} 条示例岗位`)
})
