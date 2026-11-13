import { chat, extractJson } from './ai.js'

/* =========================================================================
 * 结构化 JD × 简历 分析引擎
 * - 输入质量校验 → 不达标时不出结论、不报分
 * - AI 模式：严格 JSON 输出 + 结果校验 + 重试；失败不回退成"伪分析"
 * - 基础模式：只做文本提取与词语覆盖，不生成语义结论
 * - 评分：由代码按固定公式计算（模型只给判断，不给总分数值）
 * ========================================================================= */

export const SCHEMA_VERSION = 2

const JUDGMENTS = ['直接匹配', '可迁移', '待确认', '明确不满足']
const TYPES = ['硬性条件', '核心职责', '专业能力', '行业经验', '加分项']
const PRIORITIES = ['必须', '重要', '加分']
const GAP_TYPES = ['表达缺口', '证据不足', '可迁移经验', '能力缺口', '硬性条件差距']
const RECOMMENDATIONS = ['推荐投递', '调整后投递', '探索投递', '暂不优先', '信息不足']
const CONFIDENCE = ['高', '中', '低']
const CHANGE_TYPES = ['补充', '重写', '前置', '精简']
const SKILL_PRIORITIES = ['投递前', '面试前', '长期']

const JUDGMENT_VALUE = { 直接匹配: 1, 可迁移: 0.6, 待确认: null, 明确不满足: 0 }
const PRIORITY_WEIGHT = { 必须: 3, 重要: 2, 加分: 1 }
const TYPE_WEIGHT = { 硬性条件: 0.3, 核心职责: 0.25, 专业能力: 0.25, 行业经验: 0.1, 加分项: 0.1 }

const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback ? String(fallback) : '')
const arr = (v) => (Array.isArray(v) ? v : [])
const uniq = (list) => [...new Set(list.filter(Boolean))]

/* ---------------------------- 分析运行参数 ---------------------------- */
// 推理型模型（DeepSeek）的思考 token 会挤占输出预算，参数按需可调；这里只做纯函数归一化，不依赖 DB
export const DEFAULT_TUNING = { concurrency: 2, maxTokens: 16_000, timeoutSec: 120, thinking: 'low' }
export const TUNING_RULES = {
  concurrency: { min: 1, max: 3, label: '多岗位并发数' },
  maxTokens: { min: 2_000, max: 32_000, label: '单岗最大输出 token' },
  timeoutSec: { min: 30, max: 300, label: '单岗超时（秒）' },
}

export function normalizeTuning(raw = {}) {
  const pick = (key) => {
    const { min, max } = TUNING_RULES[key]
    const n = Number(raw?.[key])
    if (!Number.isFinite(n)) return DEFAULT_TUNING[key]
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  return {
    concurrency: pick('concurrency'),
    maxTokens: pick('maxTokens'),
    timeoutSec: pick('timeoutSec'),
    thinking: ['low', 'off'].includes(raw?.thinking) ? raw.thinking : DEFAULT_TUNING.thinking,
  }
}

/* 限流并发：结果顺序与输入一致；单个任务失败不应中断其他任务（由调用方捕获） */
export async function mapWithConcurrency(items, limit, fn) {
  const list = arr(items)
  const results = new Array(list.length)
  if (!list.length) return results
  const width = Math.max(1, Math.min(Math.round(Number(limit) || 1), list.length))
  let cursor = 0
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++
      results[index] = await fn(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

/* ---------------------------- 输入质量校验 ---------------------------- */
export function checkJdQuality(job) {
  const text = String(job?.description || '').trim()
  const issues = []
  const markers = {
    duties: /(岗位职责|工作职责|职位描述|职位详情|工作内容|你将负责|岗位内容|职责描述|你将会做)/,
    requirements: /(任职要求|岗位要求|任职资格|职位要求|我们希望|能力要求|加分项|以下条件)/,
  }
  const hasDuties = markers.duties.test(text)
  const hasRequirements = markers.requirements.test(text)
  const noiseHits = ['相似职位', '推荐职位', '热门职位', '相关推荐', '为你推荐', '看过该职位的人还看了', '竞争力分析', '举报', '投诉']
    .filter(k => text.includes(k))
  const chars = text.length
  const onlyTitle = chars < 60 || (!hasDuties && !hasRequirements && chars < 160)

  if (onlyTitle) {
    issues.push({
      code: 'JD_TOO_SHORT', severity: 'blocker', scope: job?.id,
      message: `「${job?.title || '未命名岗位'}」JD 正文仅 ${chars} 字，疑似只有职位名称或列表摘要，缺少职责与要求`,
    })
  } else {
    if (!hasDuties) issues.push({ code: 'JD_NO_DUTIES', severity: 'warn', scope: job?.id, message: `「${job?.title || ''}」JD 中未识别到岗位职责段落` })
    if (!hasRequirements) issues.push({ code: 'JD_NO_REQUIREMENTS', severity: 'warn', scope: job?.id, message: `「${job?.title || ''}」JD 中未识别到任职要求段落` })
    if (!hasDuties && !hasRequirements) {
      issues.push({ code: 'JD_NO_STRUCTURE', severity: 'blocker', scope: job?.id, message: `「${job?.title || ''}」JD 缺少职责与要求结构，无法逐条对照` })
    }
  }
  if (noiseHits.length) {
    issues.push({
      code: 'JD_NOISE', severity: 'warn', scope: job?.id,
      message: `「${job?.title || ''}」JD 中疑似混入页面噪声：${noiseHits.slice(0, 3).join('、')}，分析时会忽略这些内容`,
    })
  }
  return { jobId: job?.id, title: job?.title || '', chars, hasDuties, hasRequirements, noise: noiseHits, issues }
}

export function checkResumeQuality(resumeText) {
  const text = String(resumeText || '').trim()
  const issues = []
  if (!text) {
    issues.push({ code: 'RESUME_MISSING', severity: 'blocker', scope: 'resume', message: '未提供当前投递简历，无法判断招聘方实际能看到什么' })
  } else if (text.length < 80) {
    issues.push({ code: 'RESUME_TOO_SHORT', severity: 'blocker', scope: 'resume', message: `简历内容仅 ${text.length} 字，信息量不足以做对照分析` })
  }
  return issues
}

export function checkInputs({ jobs = [], resumeText = '', libraryText = '' }) {
  const perJob = jobs.map(checkJdQuality)
  const issues = [
    ...perJob.flatMap(j => j.issues),
    ...checkResumeQuality(resumeText),
  ]
  const blockers = issues.filter(i => i.severity === 'blocker')
  return {
    ok: blockers.length === 0,
    blockers, warnings: issues.filter(i => i.severity === 'warn'), issues, perJob,
    hasLibrary: String(libraryText || '').trim().length > 0,
  }
}

/* ---------------------------- 简历工作年限（确定性计算） ---------------------------- */
/**
 * 从简历文本中解析工作时间段并汇总年限（合并重叠区间）。
 * 只识别 "2019.07-2021.06"、"2022/03—至今" 这类明确区间，识别不到返回 null。
 */
export function estimateResumeYears(text) {
  const t = String(text || '')
  const ranges = []
  const re = /(20\d{2})\s*[.\-/年]\s*(\d{1,2})?\s*(?:月)?\s*[-–—~至到]+\s*(?:(20\d{2})\s*[.\-/年]\s*(\d{1,2})?\s*(?:月)?|(至今|今|现在|目前))/g
  let m
  while ((m = re.exec(t)) !== null) {
    const sy = +m[1]
    const sm = m[2] ? Math.min(12, Math.max(1, +m[2])) : 1
    let ey, em
    if (m[3]) {
      ey = +m[3]
      em = m[4] ? Math.min(12, Math.max(1, +m[4])) : 12
    } else {
      const now = new Date()
      ey = now.getFullYear()
      em = now.getMonth() + 1
    }
    const start = sy * 12 + (sm - 1)
    const end = ey * 12 + (em - 1)
    if (end > start && end - start <= 12 * 45) ranges.push([start, end])
  }
  if (!ranges.length) return null
  ranges.sort((a, b) => a[0] - b[0])
  const merged = [ranges[0]]
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const months = merged.reduce((sum, [s, e]) => sum + (e - s), 0)
  const years = Math.round((months / 12) * 10) / 10
  return years > 0 ? years : null
}

/* ---------------------------- 评分（确定性公式） ---------------------------- */
export function computeScore(requirements = []) {
  const known = requirements.filter(r => JUDGMENT_VALUE[r.judgment] !== null && JUDGMENT_VALUE[r.judgment] !== undefined)
  const dims = []
  for (const type of TYPES) {
    const items = requirements.filter(r => r.type === type)
    if (!items.length) continue
    const usable = items.filter(r => JUDGMENT_VALUE[r.judgment] !== null)
    const totalW = usable.reduce((s, r) => s + (PRIORITY_WEIGHT[r.priority] || 1), 0)
    const gotW = usable.reduce((s, r) => s + (PRIORITY_WEIGHT[r.priority] || 1) * JUDGMENT_VALUE[r.judgment], 0)
    const unknown = items.length - usable.length
    dims.push({
      key: type,
      name: type,
      weight: TYPE_WEIGHT[type],
      score: totalW ? Math.round((gotW / totalW) * 100) : null,
      requirements: items.length,
      known: usable.length,
      unknown,
      coverage: items.length ? Math.round((usable.length / items.length) * 100) : 0,
      // 含未知项时，该维度分数只代表"已知部分"，不能当作该维度的确定结论
      partial: unknown > 0,
      note: unknown > 0 ? `含 ${unknown} 项待确认，仅按已知项计算` : '',
    })
  }
  const usableDims = dims.filter(d => d.score !== null)
  const dimW = usableDims.reduce((s, d) => s + d.weight, 0)
  const rawScore = dimW ? Math.round(usableDims.reduce((s, d) => s + d.score * d.weight, 0) / dimW) : null

  const totalReq = requirements.length
  const knownReq = requirements.filter(r => JUDGMENT_VALUE[r.judgment] !== null).length
  const coverage = totalReq ? Math.round((knownReq / totalReq) * 100) : 0
  const hardBlockers = requirements
    .filter(r => r.type === '硬性条件' && r.judgment === '明确不满足')
    .map(r => ({ requirementId: r.id, text: r.name }))
  // 必须项待确认：不算差距，但会削弱总分代表性，需单独提示
  const pendingMust = requirements
    .filter(r => r.priority === '必须' && r.judgment === '待确认')
    .map(r => ({ requirementId: r.id, text: r.name }))

  const applicable = rawScore !== null && coverage >= 40 && totalReq >= 3
  return {
    label: '材料匹配参考分',
    applicable,
    score: applicable ? rawScore : null,
    displayedScore: applicable ? rawScore : null,
    dimensions: dims,
    coverage,
    known: knownReq,
    total: totalReq,
    hardBlockers,
    pendingMust,
    // 总分只代表"已知项"，含待确认必须项时需明确标注
    qualified: hardBlockers.length === 0 && pendingMust.length === 0,
    method: '按 JD 要求逐条判断后加权：直接匹配=1、可迁移=0.6、明确不满足=0、待确认不计入；维度权重 硬性条件30%/核心职责25%/专业能力25%/行业经验10%/加分项10%；未知项≥60% 或要求少于3条时不展示总分。该分数仅反映材料匹配程度，不代表面试率或录用率。',
    notice: hardBlockers.length
      ? '存在硬性条件差距，平均分不能反映其影响，请单独查看'
      : (pendingMust.length ? `有 ${pendingMust.length} 条必须项待确认（${pendingMust.map(p => p.text).slice(0, 3).join('、')}），总分仅代表材料已体现的部分` : ''),
  }
}

/* ---------------------------- 结果规范化与校验 ---------------------------- */
function normalizeRequirement(raw, job, index, prefix, defaultSource) {
  const id = `${prefix}${index + 1}`
  const type = TYPES.includes(raw?.type) ? raw.type : '专业能力'
  const priority = PRIORITIES.includes(raw?.priority) ? raw.priority : (type === '硬性条件' ? '必须' : '重要')
  const judgment = JUDGMENTS.includes(raw?.judgment) ? raw.judgment : '待确认'
  const evidence = arr(raw?.evidence)
    .map((e, i) => {
      if (typeof e === 'string') return { id: `${id}E${i + 1}`, quote: e.trim(), source: defaultSource, inResume: true, inLibrary: true }
      const quote = str(e?.quote)
      if (!quote) return null
      return {
        id: `${id}E${i + 1}`,
        quote,
        source: str(e?.source, defaultSource),
        inResume: e?.in_resume !== false,
        inLibrary: e?.in_library !== false,
      }
    })
    .filter(Boolean)
    .slice(0, 4)
  const inResume = evidence.some(e => e.inResume)
  const inLibrary = evidence.some(e => e.inLibrary)

  let gapType = GAP_TYPES.includes(raw?.gap_type) ? raw.gap_type : null
  if (!gapType) {
    if (type === '硬性条件' && judgment === '明确不满足') gapType = '硬性条件差距'
    else if (judgment === '可迁移') gapType = '可迁移经验'
    else if (judgment === '明确不满足') gapType = '能力缺口'
    else if (evidence.length && inLibrary && !inResume) gapType = '表达缺口'
    else if (judgment === '待确认') gapType = '证据不足'
  }
  // 规则校正：经历库有证据但简历没体现 → 表达缺口
  if (evidence.length && inLibrary && !inResume && gapType !== '硬性条件差距') gapType = '表达缺口'
  if (judgment === '待确认' && !evidence.length) gapType = '证据不足'
  // 表达缺口必须至少有一条"简历未体现"的证据，否则清空（避免"直接匹配+全部证据已在简历"的矛盾标注）
  if (gapType === '表达缺口' && !evidence.some(e => !e.inResume)) gapType = null
  if (gapType === '证据不足' && judgment === '直接匹配' && evidence.length > 0) gapType = null

  return {
    id,
    jobId: job.id,
    jobTitle: job.title,
    jobCompany: job.company || '',
    scope: 'job',
    name: str(raw?.name) || str(raw?.requirement) || `要求 ${index + 1}`,
    jdQuote: str(raw?.jd_quote) || str(raw?.quote) || '',
    jdLocation: str(raw?.jd_location) || 'JD正文',
    type,
    priority,
    prioritySource: raw?.priority_source === '推断' ? '推断' : '原文',
    priorityReason: str(raw?.priority_reason) || '',
    judgment,
    evidence,
    inResume,
    inLibrary,
    resumeShown: inResume,
    judgmentReason: str(raw?.judgment_reason) || '',
    uncertainty: str(raw?.uncertainty) || '',
    gapType,
    action: str(raw?.action) || '',
  }
}

export function validateAnalysis(raw, { jobs, resumeText = '', libraryText = '' }) {
  const job = jobs[0]
  const prefix = jobs.length > 1 ? `J${job.id}-R` : 'R'
  const rawReqs = arr(raw?.requirements)
  const mapped = rawReqs.map((r, i) => ({ raw: r, norm: normalizeRequirement(r, job, i, prefix, '简历') }))
  const requirements = mapped.filter(x => x.norm.name).map(x => x.norm)

  const byId = new Map(requirements.map(r => [r.id, r]))
  // 模型使用的原始 requirement_id（如 R1）→ 规范化后的稳定 ID
  const rawToId = new Map()
  for (const { raw: r, norm } of mapped) {
    if (!norm.name) continue
    const rawId = str(r?.requirement_id)
    if (rawId) rawToId.set(rawId, norm.id)
  }
  const pickReqs = (ids) => uniq(arr(ids).map(id => rawToId.get(id) || id)).filter(id => byId.has(id))
  const mapLinked = (list, mapper) => arr(list).map(mapper).filter(Boolean)

  const overview = {
    recommendation: RECOMMENDATIONS.includes(raw?.overview?.recommendation) ? raw.overview.recommendation : '信息不足',
    reason: str(raw?.overview?.reason),
    topStrengths: mapLinked(raw?.overview?.top_strengths, (s, i) => {
      const text = str(typeof s === 'string' ? s : s?.text)
      if (!text) return null
      return { id: `S${i + 1}`, text, requirementIds: pickReqs(typeof s === 'string' ? [] : s?.requirement_ids) }
    }),
    topRisks: mapLinked(raw?.overview?.top_risks, (g, i) => {
      const text = str(typeof g === 'string' ? g : g?.text)
      if (!text) return null
      return { id: `K${i + 1}`, text, type: str(g?.type), requirementIds: pickReqs(typeof g === 'string' ? [] : g?.requirement_ids) }
    }),
    unconfirmed: mapLinked(raw?.overview?.unconfirmed, (u, i) => {
      const text = str(typeof u === 'string' ? u : u?.text)
      if (!text) return null
      return { id: `U${i + 1}`, text, requirementIds: pickReqs(typeof u === 'string' ? [] : u?.requirement_ids) }
    }),
    confidence: CONFIDENCE.includes(raw?.overview?.confidence) ? raw.overview.confidence : '中',
    confidenceReason: str(raw?.overview?.confidence_reason),
  }

  const resumeChanges = mapLinked(raw?.resume_changes, (c, i) => {
    const original = str(c?.original)
    const suggested = str(c?.suggested)
    if (!suggested) return null
    const requirementId = pickReqs([c?.requirement_id])[0] || ''
    const matchInResume = original ? String(resumeText).includes(original.slice(0, 40)) : false
    return {
      id: `C${i + 1}`,
      requirementId,
      requirementName: byId.get(requirementId)?.name || '',
      location: str(c?.location) || '简历正文',
      reason: str(c?.reason),
      original,
      suggested,
      evidence: str(c?.evidence),
      pending: arr(c?.pending).map(p => str(p)).filter(Boolean),
      type: CHANGE_TYPES.includes(c?.type) ? c.type : '重写',
      originalVerified: matchInResume,
      hasPlaceholder: /【[^】]*待确认[^】]*】|\{\{|<待补|XX|xx(?=[^a-z])/.test(suggested) && !String(resumeText).includes(suggested),
      adopted: false,
      adoptedText: null,
    }
  })

  const projects = mapLinked(raw?.projects, (p, i) => {
    const name = str(typeof p === 'string' ? p : p?.name)
    if (!name) return null
    return { id: `P${i + 1}`, name, why: str(p?.why), requirementIds: pickReqs(p?.requirement_ids) }
  })

  const skills = mapLinked(raw?.skills, (s, i) => {
    const gap = str(s?.gap)
    if (!gap) return null
    return {
      id: `L${i + 1}`,
      requirementId: pickReqs([s?.requirement_id])[0] || '',
      gap,
      priority: SKILL_PRIORITIES.includes(s?.priority) ? s.priority : '面试前',
      depth: str(s?.depth) || '了解概念',
      knowledgePoints: arr(s?.knowledge_points).map(x => str(x)).filter(Boolean).slice(0, 8),
      practiceTasks: arr(s?.practice_tasks).map(x => str(x)).filter(Boolean).slice(0, 5),
      estimatedHours: str(s?.estimated_hours) || '估计 4-8 小时',
      deliverable: str(s?.deliverable),
      acceptance: str(s?.acceptance),
      impact: str(s?.impact),
      done: false,
    }
  })

  const questions = mapLinked(raw?.questions, (q, i) => {
    const question = str(typeof q === 'string' ? q : q?.question)
    if (!question) return null
    return {
      id: `Q${i + 1}`,
      question,
      why: str(q?.why),
      updates: pickReqs(q?.updates || q?.requirement_ids),
      answer: '',
      answeredAt: null,
    }
  }).slice(0, 5)

  // 年限类硬性要求：用简历时间段做确定性校验，避免模型把可计算事实判为"待确认"
  const resumeYears = estimateResumeYears(resumeText)
  if (resumeYears) {
    for (const r of requirements) {
      if (r.type !== '硬性条件') continue
      if (!/经验|年限|工作/.test(`${r.name} ${r.jdQuote}`)) continue
      const m = `${r.name} ${r.jdQuote}`.match(/(\d+)\s*(?:[-–~]\s*\d+\s*)?年/)
      const minYears = m ? +m[1] : 0
      if (!minYears) continue
      if (resumeYears >= minYears) {
        if (r.judgment === '待确认') {
          r.judgment = '直接匹配'
          if (r.gapType === '证据不足') r.gapType = null
        }
        r.judgmentReason = `简历工作时间段汇总约 ${resumeYears} 年，满足「${minYears} 年」要求（系统按简历日期计算）`
        r.evidence = [{
          id: `${r.id}E0`,
          quote: `简历工作时间段汇总约 ${resumeYears} 年`,
          source: '简历-时间汇总（系统计算）',
          inResume: true, inLibrary: true,
        }, ...r.evidence].slice(0, 4)
        r.inResume = true
        r.resumeShown = true
      } else if (resumeYears < minYears - 0.3 && r.judgment === '待确认') {
        r.judgmentReason = `简历时间段汇总约 ${resumeYears} 年，低于要求的 ${minYears} 年；如另有相关经历需补充`
        r.uncertainty = r.uncertainty || '简历工作时间段可能不完整'
      }
    }
  }

  const scoring = computeScore(requirements)
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'ai',
    status: 'ok',
    resumeYears,
    requirements,
    overview,
    resumeChanges,
    projects,
    skills,
    questions,
    scoring,
    warnings: [],
  }
}

/* ---------------------------- AI 分析 ---------------------------- */
const SYSTEM_PROMPT = `你是一名资深招聘官兼职业顾问，负责把「目标岗位JD」与候选人的「当前简历」「完整经历库」逐条对照，输出可追溯、可执行的结构化结论。

【最高优先级规则】
1. 不得编造任何公司、职位、项目、职责、技能、业绩、数字或行业经历。所有关键判断必须能在输入中找到依据。
2. 严格区分两份材料：
   - 当前简历：招聘方实际能看到的内容。简历没写的内容，招聘方看不到。
   - 经历库：候选人的完整经历（可能包含简历未体现的内容）。
   - 经历库有、简历没写 → 判断为"表达缺口"，而不是能力不足。
3. 简历没写 ≠ 候选人不会。找不到证据时判断为"待确认"，禁止判定为"明确不满足"。只有 JD 明确要求且材料明确不满足（如学历/年限/资质）才用"明确不满足"。
4. 不得用关键词数量代替语义判断；不得把匹配分解释为面试率或录用率。
5. 用户补充回答（如有）是候选人已确认的事实：只要回答中明确给出了信息（学历、年限、项目范围、结果等），必须据此判断并在 evidence 中引用，source 标注"用户补充回答"，**不得继续标为"待确认"**；但也不能把回答扩展成未提及的经历或数字。

【JD 拆解规则】
- 把 JD 拆成独立、可判断的要求，合并重复项；忽略页面噪声（推荐职位、举报入口、广告等）。
- 每条要求必须保留 JD 原文片段（jd_quote）与大致位置（jd_location，如"任职要求第2条"），区分原文明确要求与你的推断（priority_source）。
- type 只能是：硬性条件 / 核心职责 / 专业能力 / 行业经验 / 加分项。
- priority 只能是：必须 / 重要 / 加分；理由写在 priority_reason。
- judgment 只能是：直接匹配 / 可迁移 / 待确认 / 明确不满足。
- evidence 数组里每条包含 quote（原文摘录）、source（如"简历-工作经历第2条"或"经历库-项目A"）、in_resume（是否出现在当前简历）、in_library（是否出现在经历库）。没有证据时 evidence 为空数组。
- gap_type 只能是：表达缺口 / 证据不足 / 可迁移经验 / 能力缺口 / 硬性条件差距，可留空由系统推断。
- action 写具体可执行的下一步。

【简历修改规则】
- 只针对重要要求给出最多 8 条修改，按影响排序；original 必须是原简历的原文片段（可截取连续片段），suggested 必须是忠实改写。
- 不能把"参与"改成"主导"；不能新增未经确认的职责、范围、结果或数字。
- 缺少数据时，用【待确认：具体数值】占位，并在 pending 中列出需要用户确认的信息。
- 未量化的成果可以准确描述覆盖场景、交付成果、负责范围、评审/上线情况。

【其他】
- 投递建议 recommendation 只能是：推荐投递 / 调整后投递 / 探索投递 / 暂不优先 / 信息不足。
- confidence 只能是：高 / 中 / 低，并说明原因（材料完整度、未知项比例等）。
- skills 只针对重要且确实需要补齐的能力，区分"投递前/面试前/长期"；明确 depth 是"了解概念/能独立应用/形成真实项目经验"，不要暗示几天学习可替代行业资历。
- questions 最多 5 条，只问对结论影响最大的问题，并说明回答后会更新哪些要求。
- 不要输出任何解释文字，只输出一个 JSON 对象。`

const SCHEMA_HINT = `{
  "requirements": [{
    "requirement_id": "R1",
    "name": "要求名称（简短可判断）",
    "jd_quote": "JD原文片段",
    "jd_location": "任职要求第1条",
    "type": "硬性条件|核心职责|专业能力|行业经验|加分项",
    "priority": "必须|重要|加分",
    "priority_source": "原文|推断",
    "priority_reason": "为什么这个优先级",
    "judgment": "直接匹配|可迁移|待确认|明确不满足",
    "evidence": [{"quote": "材料原文摘录", "source": "简历-工作经历第2条", "in_resume": true, "in_library": true}],
    "judgment_reason": "判断依据",
    "uncertainty": "仍不确定的地方，没有则空字符串",
    "gap_type": "表达缺口|证据不足|可迁移经验|能力缺口|硬性条件差距|",
    "action": "具体下一步"
  }],
  "overview": {
    "recommendation": "推荐投递|调整后投递|探索投递|暂不优先|信息不足",
    "reason": "一句话理由",
    "top_strengths": [{"text": "优势（有证据）", "requirement_ids": ["R1"]}],
    "top_risks": [{"text": "风险", "type": "差距类型", "requirement_ids": ["R2"]}],
    "unconfirmed": [{"text": "未确认事项", "requirement_ids": ["R3"]}],
    "confidence": "高|中|低",
    "confidence_reason": "原因"
  },
  "resume_changes": [{
    "change_id": "C1",
    "requirement_id": "R1",
    "location": "工作经历第2条",
    "reason": "为什么要改",
    "original": "简历原文片段",
    "suggested": "建议改写",
    "evidence": "依据来源",
    "pending": ["需要用户确认的信息"],
    "type": "补充|重写|前置|精简"
  }],
  "projects": [{"name": "建议前置的项目", "why": "对应哪些要求", "requirement_ids": ["R1"]}],
  "skills": [{
    "skill_id": "L1",
    "requirement_id": "R2",
    "gap": "能力缺口描述",
    "priority": "投递前|面试前|长期",
    "depth": "了解概念|能独立应用|形成真实项目经验",
    "knowledge_points": ["知识点"],
    "practice_tasks": ["可执行任务"],
    "estimated_hours": "估计 6-10 小时",
    "deliverable": "可检查的产出",
    "acceptance": "验收标准",
    "impact": "对投递/面试的作用"
  }],
  "questions": [{"question_id": "Q1", "question": "问题", "why": "为什么问", "updates": ["R1"]}]
}`

function buildUserMessage({ job, resumeText, libraryText, answers, commonText }) {
  const answerPart = arr(answers).filter(a => str(a?.answer))
    .map((a, i) => `Q${i + 1}. ${str(a.question)}\n答：${str(a.answer)}`).join('\n')
  const years = estimateResumeYears(resumeText)
  return `【目标岗位】
岗位：${job.title}｜公司：${job.company || '未提供'}｜城市：${job.city || '未提供'}｜薪资：${job.salaryText || '未提供'}
JD 正文：
${String(job.description || '').slice(0, 6000)}

【当前投递简历】（招聘方实际能看到的内容）
${String(resumeText || '').slice(0, 6000)}
${years ? `\n【系统计算的简历工作年限】约 ${years} 年（按简历中的工作时间段合并计算，可直接作为年限类要求的证据）\n` : ''}
【完整经历库】（候选人补充材料，可能包含简历未体现的经历；为空表示未提供）
${String(libraryText || '').slice(0, 6000) || '（未提供）'}

【用户补充回答】（候选人已确认的事实，可直接作为证据使用，来源标注为"用户补充回答"）
${answerPart || '（无）'}
${commonText ? `\n【多岗位共性要求（参考）】\n${commonText}\n` : ''}
请严格按 JSON Schema 输出：\n${SCHEMA_HINT}`
}

async function callStructured({ job, resumeText, libraryText, answers, commonText, tuning }) {
  const cfg = normalizeTuning(tuning)
  const timeoutMs = cfg.timeoutSec * 1000
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const user = buildUserMessage({ job, resumeText, libraryText, answers, commonText })
      // 首次按设置页的思考强度；若被思考耗尽输出预算（推理模型常见），重试时直接关闭思考
      const thinking = attempt === 0 ? cfg.thinking : 'off'
      const repair = attempt === 0 ? '' : `\n\n【重要】上一次输出不符合要求：${lastErr?.message?.slice(0, 200) || '格式错误'}。` +
        `本次请直接输出最终 JSON，不要展开推理过程；确保字段使用 Schema 中的枚举值，requirements 至少 3 条。`
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user + repair },
      ]
      const out = await chat(messages, { temperature: 0.2, maxTokens: cfg.maxTokens, timeoutMs, thinking })
      const parsed = extractJson(out)
      const normalized = validateAnalysis(parsed, { jobs: [job], resumeText, libraryText })
      if (!normalized.requirements.length) throw new Error('模型未拆分出任何可判断的要求')
      return normalized
    } catch (e) {
      lastErr = e
      if (attempt === 1) throw e
    }
  }
  throw lastErr
}

/* 多岗位：逐岗结构化分析（限流并发）+ 汇总 */
export async function analyzeWithAi({ jobs, resumeText, libraryText = '', answers = [], common = null, tuning, onProgress }) {
  const cfg = normalizeTuning(tuning)
  const commonText = common?.commonRequirements?.length
    ? common.commonRequirements.map(r => `【${r.weight}】${r.requirement}（${r.why || ''}）`).join('\n')
    : ''
  const total = jobs.length
  const width = Math.min(cfg.concurrency, total)
  let done = 0
  const results = await mapWithConcurrency(jobs, cfg.concurrency, async (job, i) => {
    onProgress?.(total > 1
      ? `正在分析「${job.title}」（第 ${i + 1}/${total} 个，并发 ${width}）…`
      : `正在分析「${job.title}」，通常需要 30~90 秒…`, 25)
    try {
      const one = await callStructured({ job, resumeText, libraryText, answers, commonText, tuning: cfg })
      done += 1
      if (total > 1) onProgress?.(`「${job.title}」已完成（${done}/${total}）…`, 25 + Math.round(60 * done / total))
      return one
    } catch (e) {
      done += 1
      if (total > 1) onProgress?.(`「${job.title}」分析失败（${done}/${total}），继续其余岗位…`, 25 + Math.round(60 * done / total))
      return { error: e.message, jobId: job.id, jobTitle: job.title }
    }
  })
  const okOnes = results.filter(r => !r.error)
  const failed = results.filter(r => r.error)
  if (!okOnes.length) {
    return { status: 'failed', error: failed[0]?.error || '模型分析失败', results }
  }

  const merged = mergeAnalyses(okOnes, { jobs, failed })
  merged.common = common || null
  return merged
}

/* 合并多岗位结果：要求加岗位前缀，概览做确定性汇总 */
export function mergeAnalyses(okOnes, { jobs = [], failed = [] } = {}) {
  const requirements = []
  const resumeChanges = []
  const projects = []
  const skills = []
  const questions = []
  const byJob = []
  let sid = 0, cid = 0, pid = 0, lid = 0, qid = 0

  for (const one of okOnes) {
    const job = jobs.find(j => j.id === one.requirements[0]?.jobId) || {}
    const map = new Map()
    for (const r of one.requirements) {
      const newId = `J${job.id || 'x'}-${++sid}`
      map.set(r.id, newId)
      requirements.push({ ...r, id: newId, jobId: job.id || r.jobId, jobTitle: job.title || r.jobTitle, jobCompany: job.company || r.jobCompany })
    }
    for (const c of one.resumeChanges) {
      resumeChanges.push({ ...c, id: `C${++cid}`, requirementId: map.get(c.requirementId) || c.requirementId })
    }
    for (const p of one.projects) {
      projects.push({ ...p, id: `P${++pid}`, requirementIds: p.requirementIds.map(x => map.get(x) || x) })
    }
    for (const s of one.skills) {
      skills.push({ ...s, id: `L${++lid}`, requirementId: map.get(s.requirementId) || s.requirementId })
    }
    for (const q of one.questions) {
      questions.push({ ...q, id: `Q${++qid}`, updates: q.updates.map(x => map.get(x) || x) })
    }
    byJob.push({
      jobId: job.id, title: job.title || '', company: job.company || '',
      recommendation: one.overview.recommendation, reason: one.overview.reason,
      confidence: one.overview.confidence,
      strengths: one.overview.topStrengths, risks: one.overview.topRisks, unconfirmed: one.overview.unconfirmed,
    })
  }

  const recOrder = ['信息不足', '暂不优先', '探索投递', '调整后投递', '推荐投递']
  const counts = {}
  for (const b of byJob) counts[b.recommendation] = (counts[b.recommendation] || 0) + 1
  const best = [...byJob].sort((a, b) => recOrder.indexOf(b.recommendation) - recOrder.indexOf(a.recommendation))[0]
  const recommendation = byJob.length > 1
    ? (recOrder.includes(best?.recommendation) ? best.recommendation : '信息不足')
    : (byJob[0]?.recommendation || '信息不足')

  const overview = {
    recommendation,
    reason: byJob.length > 1
      ? `共 ${byJob.length} 个岗位：${Object.entries(counts).map(([k, v]) => `${k} ${v} 个`).join('、')}。本建议按最有利岗位给出，逐岗结论见下方岗位切换。`
      : (byJob[0]?.reason || ''),
    topStrengths: okOnes.flatMap(o => o.overview.topStrengths).slice(0, 3),
    topRisks: okOnes.flatMap(o => o.overview.topRisks).slice(0, 3),
    unconfirmed: okOnes.flatMap(o => o.overview.unconfirmed).slice(0, 5),
    confidence: failed.length ? '低' : (byJob.every(b => b.confidence === '高') ? '高' : '中'),
    confidenceReason: failed.length
      ? `有 ${failed.length} 个岗位分析失败，整体结论不完整`
      : (okOnes[0]?.overview.confidenceReason || ''),
    byJob,
  }

  const scoring = computeScore(requirements)
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'ai',
    status: failed.length ? 'partial' : 'ok',
    resumeYears: okOnes[0]?.resumeYears ?? null,
    requirements, overview, resumeChanges, projects,
    skills: skills.slice(0, 8),
    questions: questions.slice(0, 5),
    scoring,
    failedJobs: failed.map(f => ({ jobTitle: f.jobTitle, error: f.error })),
  }
}

/* ---------------------------- 基础文本检查（无 AI / 模型失败） ---------------------------- */
const HARD_PATTERNS = /(本科|硕士|博士|大专|统招|年以上|应届|专业不限|年龄|证书|雅思|托福|英语)/

const STOPWORDS = new Set(['负责', '参与', '协助', '相关', '进行', '以及', '具有', '具备', '熟悉', '了解', '掌握', '能力', '经验', '要求', '优先', '以上', '工作', '项目', '产品', '岗位', '职责', '公司', '团队', '业务'])

function extractKeywords(line) {
  const out = []
  const tokens = String(line).match(/[A-Za-z][A-Za-z0-9+#.-]{1,20}|[\u4e00-\u9fa5]{2,8}/g) || []
  for (const t of tokens) {
    if (/^\d+$/.test(t)) continue
    if (STOPWORDS.has(t)) continue
    out.push(t)
  }
  return uniq(out).slice(0, 6)
}

function splitJdLines(text) {
  return String(text || '')
    .split(/\n|(?<=[。；;])/)
    .map(s => s.replace(/^[\s•·\-–—*0-9.、)）]+/, '').trim())
    .filter(s => s.length >= 6)
    .filter(s => !/相似职位|推荐职位|热门职位|为你推荐|举报|投诉|竞争力分析/.test(s))
}

export function analyzeBasic({ jobs, resumeText = '', libraryText = '', answers = [] }) {
  const requirements = []
  let rid = 0
  for (const job of jobs) {
    const lines = splitJdLines(job.description)
    const dutyStart = lines.findIndex(l => /(岗位职责|工作职责|职位描述|工作内容|你将负责)/.test(l))
    const reqStart = lines.findIndex(l => /(任职要求|岗位要求|任职资格|职位要求|我们希望)/.test(l))
    const picked = lines.filter((l, i) => {
      if (i === dutyStart || i === reqStart) return false
      if (dutyStart < 0 && reqStart < 0) return l.length >= 12
      if (reqStart >= 0 && i > reqStart) return true
      if (dutyStart >= 0 && reqStart >= 0) return i > dutyStart && i < reqStart
      return i > dutyStart
    }).slice(0, 14)

    for (const line of picked) {
      const hard = HARD_PATTERNS.test(line)
      const type = hard ? '硬性条件' : (reqStart >= 0 && lines.indexOf(line) > reqStart ? '专业能力' : '核心职责')
      const keywords = extractKeywords(line)
      const hitResume = keywords.filter(k => String(resumeText).includes(k))
      const hitLibrary = keywords.filter(k => String(libraryText).includes(k))
      const missingInResume = keywords.filter(k => !String(resumeText).includes(k))
      const onlyInLibrary = missingInResume.filter(k => String(libraryText).includes(k))
      const coverage = keywords.length ? Math.round((hitResume.length / keywords.length) * 100) : 0
      const judgment = coverage >= 60 ? '直接匹配' : '待确认'
      const evidence = []
      if (hitResume.length) {
        evidence.push({ id: `E${rid + 1}-1`, quote: `简历中出现：${hitResume.join('、')}`, source: '当前简历（词语匹配）', inResume: true, inLibrary: true })
      }
      if (onlyInLibrary.length) {
        evidence.push({ id: `E${rid + 1}-2`, quote: `经历库中出现：${onlyInLibrary.join('、')}`, source: '经历库（词语匹配）', inResume: false, inLibrary: true })
      }
      requirements.push({
        id: `B${++rid}`,
        jobId: job.id, jobTitle: job.title, jobCompany: job.company || '', scope: 'job',
        name: line.slice(0, 60),
        jdQuote: line, jdLocation: 'JD正文（按句子切分）',
        type, priority: hard ? '必须' : '重要', prioritySource: '推断',
        priorityReason: '基础模式按句式推断，未经语义判断',
        judgment, evidence, inResume: hitResume.length > 0, inLibrary: hitLibrary.length > 0,
        resumeShown: hitResume.length > 0,
        judgmentReason: `关键词命中 ${hitResume.length}/${keywords.length}（${keywords.join('、') || '无可用关键词'}）`,
        uncertainty: '基础模式只做词语覆盖检查，不代表能力匹配',
        gapType: onlyInLibrary.length ? '表达缺口' : (judgment === '待确认' ? '证据不足' : null),
        action: onlyInLibrary.length
          ? `经历库提到「${onlyInLibrary.join('、')}」，可考虑在简历中补充对应事实（需你确认后写入）`
          : (judgment === '待确认' ? '请人工确认是否有相关经历，并在简历中补充证据' : ''),
      })
    }
  }

  const overview = {
    recommendation: '信息不足',
    reason: '当前为「基础文本检查」模式：只做了 JD 句子切分与词语覆盖，未进行语义匹配，因此不给出投递建议。配置 AI Key 后可获得完整判断。',
    topStrengths: [],
    topRisks: [],
    unconfirmed: requirements.filter(r => r.judgment === '待确认').slice(0, 5).map((r, i) => ({ id: `U${i + 1}`, text: `「${r.name}」在简历中没有足够词语证据，需人工确认`, requirementIds: [r.id] })),
    confidence: '低',
    confidenceReason: '基础模式未使用语义模型，结论仅反映词语是否出现',
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'basic',
    status: 'ok',
    requirements,
    overview,
    resumeChanges: [],
    projects: [],
    skills: [],
    questions: requirements.filter(r => r.judgment === '待确认').slice(0, 3).map((r, i) => ({
      id: `Q${i + 1}`,
      question: `「${r.name}」你有相关经历吗？能描述你实际负责的范围和结果吗？`,
      why: '该要求目前在简历中没有足够证据，回答后可更新对应判断',
      updates: [r.id], answer: '', answeredAt: null,
    })),
    scoring: {
      label: '材料匹配参考分',
      applicable: false,
      score: null,
      dimensions: [],
      coverage: null,
      known: 0,
      total: requirements.length,
      hardBlockers: requirements.filter(r => r.type === '硬性条件' && r.judgment === '明确不满足').map(r => ({ requirementId: r.id, text: r.name })),
      method: '基础文本检查模式不计算匹配分：仅展示 JD 被切分出的要求与词语覆盖情况。',
      notice: '未配置 AI Key，无法进行语义匹配判断',
    },
    warnings: ['基础文本检查：仅提取要求与词语覆盖，不构成匹配度结论'],
  }
}
