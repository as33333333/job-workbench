import { getSetting, setSetting } from './db.js'

export const DEFAULT_API_BASE = 'https://api.z.ai/api/paas/v4'
export const DEFAULT_MODEL = 'glm-4.6'

export function aiConfig() {
  return {
    apiBase: getSetting('apiBase') || DEFAULT_API_BASE,
    apiKey: getSetting('apiKey') || '',
    model: getSetting('model') || DEFAULT_MODEL,
  }
}
export function aiReady() { return !!aiConfig().apiKey }

export function saveAiConfig({ apiBase, apiKey, model, clearKey } = {}) {
  if (apiBase !== undefined) setSetting('apiBase', apiBase.trim() || DEFAULT_API_BASE)
  if (model !== undefined) setSetting('model', model.trim() || DEFAULT_MODEL)
  if (clearKey) setSetting('apiKey', '')
  else if (apiKey) setSetting('apiKey', apiKey.trim())
}

export async function chat(messages, { temperature = 0.4, maxTokens = 4096, json = true } = {}) {
  const { apiBase, apiKey, model } = aiConfig()
  if (!apiKey) throw new Error('未配置 AI API Key，请在「设置」中填写')
  let url = apiBase.replace(/\/+$/, '')
  if (!url.endsWith('/chat/completions')) url += '/chat/completions'
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (json) body.response_format = { type: 'json_object' }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`AI 接口错误 ${res.status}：${t.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 返回内容为空')
  return content
}

export function extractJson(text) {
  const t = String(text).trim()
  try { return JSON.parse(t) } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1].trim()) } catch {} }
  const start = t.indexOf('{'), end = t.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)) } catch {} }
  throw new Error('AI 返回的内容无法解析为 JSON：' + t.slice(0, 200))
}

/* ================= JD 解析 ================= */
const PARSE_JD_PROMPT = `你是招聘数据解析助手。从用户给出的岗位JD文本中提取结构化信息。
严格只输出一个 JSON 对象，不要输出任何解释，字段如下：
{
  "title": "岗位名称",
  "category": "岗位类别（如：产品经理）",
  "company": "公司名称，未提及则为空字符串",
  "city": "工作城市（如：深圳），未提及为空字符串",
  "recruitType": "社招/校招/实习 之一",
  "experienceText": "经验要求原文（如：3-5年）",
  "expMin": 经验下限年数(数字,不限为0),
  "expMax": 经验上限年数(数字,不限填99,应届填0),
  "education": "学历要求（如：本科）",
  "salaryMin": 薪资下限(K为单位,数字,如15),
  "salaryMax": 薪资上限(K为单位,数字,如25),
  "salaryText": "薪资原文（如：15-25K·14薪）",
  "salaryNote": "薪资补充（如：14薪、股票期权），无则空字符串",
  "tags": ["技能或要求标签", "..."],
  "publishedAt": "发布时间，ISO日期字符串或空字符串"
}
薪资"面议"则 salaryMin/salaryMax 为 null。`

export async function aiParseJd(text) {
  const out = await chat([
    { role: 'system', content: PARSE_JD_PROMPT },
    { role: 'user', content: text.slice(0, 8000) },
  ], { temperature: 0.2 })
  return extractJson(out)
}

/* 无 AI 时的正则兜底解析 */
export function heuristicParseJd(text) {
  const head = text.split('\n').map(s => s.trim()).filter(Boolean)
  const firstLines = head.slice(0, 6).join(' ')
  const out = {
    title: (head.find(l => /经理|专员|总监|专家|工程师|产品|运营|设计/.test(l) && l.length <= 30) || head[0] || '未命名岗位').slice(0, 40),
    category: /产品/.test(firstLines) ? '产品经理' : '',
    company: '', city: '', recruitType: '社招', education: '', salaryText: '', salaryNote: '', publishedAt: '',
    expMin: 0, expMax: 99, tags: [], salaryMin: null, salaryMax: null,
  }
  const sal = text.match(/(\d+)\s*[-–~至]\s*(\d+)\s*([kK千万])/)
  if (sal) {
    const unit = /[万wW]/.test(sal[3]) ? 10 : 1
    out.salaryMin = +sal[1] * unit; out.salaryMax = +sal[2] * unit
    out.salaryText = sal[0]
  } else {
    const single = text.match(/(\d+)\s*[-–~]?\s*[kK千]以上/)
    if (single) { out.salaryMin = +single[1]; out.salaryMax = null; out.salaryText = single[0] }
  }
  const exp = text.match(/(\d+)\s*[-–~]\s*(\d+)\s*年/)
  if (exp) { out.expMin = +exp[1]; out.expMax = +exp[2]; out.experienceText = exp[0] }
  else if (/经验不限|不限经验/.test(text)) { out.expMax = 99; out.experienceText = '经验不限' }
  else if (/应届|校招/.test(text)) { out.expMin = 0; out.expMax = 0; out.recruitType = '校招'; out.experienceText = '应届' }
  else { const m = text.match(/(\d+)\s*年以上/); if (m) { out.expMin = +m[1]; out.expMax = 99; out.experienceText = m[0] } }
  const edu = text.match(/(大专|专科|本科|硕士|研究生|博士|统招)[及以上学历]?/)
  if (edu) out.education = edu[0]
  for (const c of ['北京', '上海', '深圳', '广州', '杭州', '成都', '武汉', '南京', '西安', '苏州', '长沙', '重庆', '厦门', '合肥', '郑州', '东莞', '佛山', '珠海']) {
    if (text.includes(c)) { out.city = c; break }
  }
  return out
}

/* ================= JD 匹配分析 ================= */
const ANALYZE_PROMPT = `你是一位互联网行业资深产品总监，兼具大厂面试官与职业教练视角。
用户会提供「目标岗位JD」与「我的经历资料」，请深度对比分析。
严格只输出 JSON：
{
  "matchScore": 0-100 的整数匹配度,
  "summary": "2-3句总体判断",
  "strengths": ["我的经历中与该岗位匹配的亮点，每条说明对应JD的哪个要求"],
  "gaps": [{"item":"差距点","level":"高/中/低","advice":"如何弥补"}],
  "knowledgeToFill": ["建议补齐的知识/技能，具体可执行"],
  "resumeFocus": ["简历中应重点描写的方向，结合我的真实经历"],
  "resumeEdits": ["简历具体修改建议，如：把xx项目改写为强调yy"]
}
要求：结论必须基于材料本身，不编造经历；差距按对求职影响排序；建议具体、可落地。`

export async function aiAnalyzeJob(job, docText, commonText = '') {
  const user = `【目标岗位JD】
岗位：${job.title}（${job.company || '公司未知'}）${job.salaryText ? '，薪资：' + job.salaryText : ''}
${job.description}

${commonText ? `【多岗位共性要求（供参考）】\n${commonText}\n` : ''}
【我的经历资料】
${docText.slice(0, 9000)}`
  const out = await chat([
    { role: 'system', content: ANALYZE_PROMPT },
    { role: 'user', content: user },
  ], { temperature: 0.4, maxTokens: 3500 })
  return extractJson(out)
}

const COMMON_PROMPT = `你是资深产品招聘专家。用户提供了多个目标岗位JD，请提炼这些岗位的共性要求。
严格只输出 JSON：
{
  "commonRequirements": [{"requirement":"共性要求点","why":"为什么多个岗位都需要","weight":"核心/重要/加分"}],
  "differences": ["各岗位之间的显著差异点"],
  "overallAdvice": "针对这批岗位的综合求职建议（2-4句）",
  "resumeStrategy": "简历应如何围绕共性要求组织（2-3句）"
}`

export async function aiExtractCommon(jobs) {
  const list = jobs.map((job, i) => `--- 岗位${i + 1}：${job.title}（${job.company || ''}）${job.salaryText || ''}\n${(job.description || '').slice(0, 3000)}`).join('\n\n')
  const out = await chat([
    { role: 'system', content: COMMON_PROMPT },
    { role: 'user', content: list },
  ], { temperature: 0.4, maxTokens: 3000 })
  return extractJson(out)
}

/* ================= 简历改写 ================= */
const REWRITE_PROMPT = `你是一位互联网大厂资深面试官兼简历教练。请根据「目标岗位JD」（多个岗位则结合共性要求），
把用户的「基础简历」改写成一份针对性定制简历。

硬性规则：
1. 只能基于基础简历中的真实经历重新组织、量化、润色，绝不编造新的公司、职位、项目或数据；
2. 站在面试官视角：10秒内能看到与JD最相关的信息；
3. 输出规范的 Markdown 简历（含 一级标题"姓名-求职意向：岗位"，个人简介/核心优势、工作经历、项目经历（STAR法则+量化结果）、技能、教育背景）；
4. 关键词对齐JD表述。

严格只输出 JSON：
{
  "resumeMarkdown": "完整简历Markdown文本",
  "changeNotes": ["相对原简历的主要改动点，逐条列出，如：核心优势前置并对齐JD的xx要求"]
}`

export async function aiRewriteResume(jobs, docText, extra = '', commonText = '') {
  const jdPart = jobs.map((job, i) =>
    `--- 目标岗位${i + 1}：${job.title}（${job.company || ''}）${job.salaryText || ''}\n${(job.description || '').slice(0, 4000)}`
  ).join('\n\n')
  const user = `${jdPart}
${commonText ? `\n【多岗位共性要求】\n${commonText}\n` : ''}
${extra ? `\n【用户补充要求】\n${extra}\n` : ''}
【基础简历】
${docText.slice(0, 9000)}`
  const out = await chat([
    { role: 'system', content: REWRITE_PROMPT },
    { role: 'user', content: user },
  ], { temperature: 0.5, maxTokens: 6000 })
  return extractJson(out)
}

export async function testConnection() {
  const t0 = Date.now()
  const out = await chat([
    { role: 'system', content: '你是连通性测试助手，只输出JSON {"pong":true}' },
    { role: 'user', content: 'ping' },
  ], { temperature: 0, maxTokens: 20 })
  return { ok: true, latency: Date.now() - t0, reply: out.slice(0, 100) }
}

/* ================= 无 Key 简易模式（关键词匹配） ================= */
const LEXICON = [
  '产品经理','需求分析','PRD','原型','Axure','Figma','墨刀','Xmind','用户研究','用户画像','竞品分析',
  '数据分析','SQL','Excel','数据驱动','A/B测试','埋点','转化率','留存','增长','漏斗','北极星指标',
  'B端','C端','SaaS','商业化','变现','策略','中台','平台','供应链','交易','支付','风控','CRM','ERP',
  '项目管理','跨部门','沟通协作','推动','落地','迭代','敏捷','OKR','KPI','复盘',
  'AI','大模型','LLM','AIGC','Agent','提示词','Prompt','RAG','智能体','算法',
  '内容','社区','电商','直播','社交','游戏','教育','金融','医疗','物流','出行','本地生活',
  '0-1','从0到1','矩阵','私域','用户增长','活动策划','品牌','新媒体','英文','英语','本科','硕士',
  '撰写','文档','汇报','逻辑思维','结构化','拆解','优先级','版本管理','上线','灰度','监控',
]
const countHits = (text) => {
  const t = text || ''
  const hits = []
  for (const w of LEXICON) if (t.includes(w)) hits.push(w)
  return hits
}

export function heuristicAnalyzeJob(job, docText) {
  const jdHits = countHits(job.description)
  const resumeHits = countHits(docText)
  const matched = jdHits.filter(k => resumeHits.includes(k))
  const missing = jdHits.filter(k => !resumeHits.includes(k))
  const coverage = jdHits.length ? Math.round((matched.length / jdHits.length) * 100) : 50
  const score = Math.max(20, Math.min(90, coverage))
  return {
    matchScore: score,
    summary: `【简易模式】基于关键词匹配：JD中共识别出 ${jdHits.length} 个关键要求词，简历命中 ${matched.length} 个（覆盖 ${coverage}%）。配置 AI Key 后可获得深度语义分析。`,
    strengths: matched.slice(0, 8).map(k => `简历中体现了「${k}」相关内容`),
    gaps: missing.slice(0, 10).map(k => ({
      item: `JD要求中的「${k}」在简历中未体现`, level: '中',
      advice: `若有相关经历请补充进简历；若没有，可作为面试前补课重点`,
    })),
    knowledgeToFill: missing.slice(0, 8).map(k => `学习/实践「${k}」相关知识与案例`),
    resumeFocus: matched.slice(0, 5).map(k => `围绕「${k}」扩充项目细节与量化结果`),
    resumeEdits: ['把与JD关键词重合度最高的项目前置到项目经历第一位', '工作经历中补充量化数据（转化率、规模、增长）'],
  }
}

export function heuristicCommon(jobs) {
  const counts = new Map()
  for (const job of jobs) {
    for (const k of new Set(countHits(job.description))) {
      counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  const n = jobs.length
  const common = [...counts.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.ceil(n / 2)))
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
  return {
    commonRequirements: common.map(([k, c]) => ({
      requirement: k, why: `${c}/${n} 个岗位均提及`, weight: c === n ? '核心' : '重要',
    })),
    differences: [],
    overallAdvice: '【简易模式】以上为跨岗位高频关键词，建议优先在简历中补齐。配置 AI Key 可获得真正的语义级共性提炼。',
    resumeStrategy: '按高频要求组织核心优势与项目描述，让每一句都命中至少一个共性关键词。',
  }
}
