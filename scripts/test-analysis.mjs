/**
 * 分析引擎离线自测（不调用模型）：
 * 用"模拟模型输出"验证结构校验、证据规则、评分公式与降级边界。
 * 运行：node scripts/test-analysis.mjs
 */
import {
  checkInputs, validateAnalysis, computeScore, analyzeBasic, mergeAnalyses, estimateResumeYears,
  normalizeTuning, mapWithConcurrency, DEFAULT_TUNING,
} from '../analysis.js'
import { cleanText, assessText, ocrCleanBetter } from '../pdftext.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const job = {
  id: 900, title: '【样例】B端SaaS产品经理', company: '样例云科技', city: '深圳', salaryText: '20-35K',
  description: `岗位职责：
1、负责企业级 SaaS 产品（客户管理、工单协同）的需求分析与版本规划；
2、输出需求文档、原型，推动研发按期交付。
任职要求：
1、本科及以上学历，3年以上 B 端产品经验；
2、熟练使用 Axure 输出原型，能独立撰写 PRD；
3、具备 SQL 数据分析能力；
4、有 SaaS 多租户权限体系经验者优先。`,
}
const resumeText = `【样例数据】张明 产品经理
工作经历：2022-2024 某某科技，负责内部工单系统需求梳理，输出需求文档与原型，推动 3 个版本上线。
技能：Axure、Xmind、Excel。`
const libraryText = `【样例数据】完整经历库
- 独立负责数据看板模块：梳理 12 个指标口径，用 SQL 取数验证，自助取数占比从 20% 提升到 55%
- 了解 SaaS 多租户权限模型，参与权限体系需求设计
- 本科学历，2022 年毕业，产品工作 2 年`

console.log('\n[1] 输入质量校验')
{
  const bad = checkInputs({ jobs: [{ ...job, description: '产品经理' }], resumeText })
  ok('只有职位名称 → 阻断', bad.ok === false && bad.blockers.some(b => b.code === 'JD_TOO_SHORT'))
  const noResume = checkInputs({ jobs: [job], resumeText: '' })
  ok('无简历 → 阻断', noResume.ok === false && noResume.blockers.some(b => b.code === 'RESUME_MISSING'))
  const shortResume = checkInputs({ jobs: [job], resumeText: '产品经理' })
  ok('简历过短 → 阻断', shortResume.ok === false && shortResume.blockers.some(b => b.code === 'RESUME_TOO_SHORT'))
  const good = checkInputs({ jobs: [job], resumeText, libraryText })
  ok('完整输入 → 通过', good.ok === true, JSON.stringify(good.blockers))
  const noisy = checkInputs({ jobs: [{ ...job, description: job.description + '\n相似职位\n为你推荐\n竞争力分析' }], resumeText })
  ok('页面噪声 → 警告', noisy.warnings.some(w => w.code === 'JD_NOISE'))
}

console.log('\n[2] 模拟模型输出 → 规范化与规则校正')
const mockRaw = {
  requirements: [
    {
      requirement_id: 'R1', name: '3年以上 B 端产品经验', jd_quote: '本科及以上学历，3年以上 B 端产品经验',
      jd_location: '任职要求第1条', type: '硬性条件', priority: '必须', priority_source: '原文',
      priority_reason: '明确年限要求', judgment: '明确不满足',
      evidence: [{ quote: '产品工作 2 年', source: '经历库-教育背景', in_resume: false, in_library: true }],
      judgment_reason: '材料显示 2 年经验，未达 3 年', uncertainty: '是否包含实习期不确定', action: '确认年限口径或优先投其他岗位',
    },
    {
      requirement_id: 'R2', name: 'SQL 数据分析能力', jd_quote: '具备 SQL 数据分析能力',
      jd_location: '任职要求第3条', type: '专业能力', priority: '重要', priority_source: '原文',
      priority_reason: '出现在任职要求', judgment: '直接匹配',
      evidence: [{ quote: '用 SQL 取数验证', source: '经历库-数据看板', in_resume: false, in_library: true }],
      judgment_reason: '经历库有明确证据，但当前简历未体现', uncertainty: '', action: '把数据看板经历补进简历',
    },
    {
      requirement_id: 'R3', name: 'SaaS 多租户权限体系经验', jd_quote: '有 SaaS 多租户权限体系经验者优先',
      jd_location: '任职要求第4条', type: '加分项', priority: '加分', priority_source: '原文',
      priority_reason: '明确写了优先', judgment: '待确认',
      evidence: [], judgment_reason: '材料只有"了解"，未说明是否落地过', uncertainty: '是否实际参与设计', action: '补充具体参与范围',
    },
    {
      requirement_id: 'R4', name: '需求文档与原型能力', jd_quote: '熟练使用 Axure 输出原型，能独立撰写 PRD',
      jd_location: '任职要求第2条', type: '专业能力', priority: '必须', priority_source: '原文',
      priority_reason: '任职要求明确', judgment: '直接匹配',
      evidence: [{ quote: '输出需求文档与原型', source: '简历-工作经历', in_resume: true, in_library: true }],
      judgment_reason: '简历已体现', uncertainty: '', action: '',
    },
  ],
  overview: {
    recommendation: '调整后投递', reason: '核心能力匹配，但年限与一项加分项存在差距',
    top_strengths: [{ text: '需求文档与原型能力有简历证据', requirement_ids: ['R4'] }],
    top_risks: [{ text: '年限差 1 年，可能被简历筛选卡住', type: '硬性条件差距', requirement_ids: ['R1'] }],
    unconfirmed: [{ text: 'SaaS 权限体系是否实际落地不明确', requirement_ids: ['R3'] }],
    confidence: '中', confidence_reason: '经历库信息较完整，但年限口径不确定',
  },
  resume_changes: [
    {
      change_id: 'C1', requirement_id: 'R2', location: '工作经历第1条', reason: 'SQL 数据能力在经历库有证据但简历未写',
      original: '负责内部工单系统需求梳理，输出需求文档与原型',
      suggested: '负责内部工单系统需求梳理，输出需求文档与原型；独立负责数据看板模块，梳理 12 个指标口径并用 SQL 取数验证，自助取数占比从 20% 提升到 55%',
      evidence: '经历库-数据看板', pending: [], type: '补充',
    },
    {
      change_id: 'C2', requirement_id: 'R3', location: '项目经历', reason: '补齐权限体系相关经历',
      original: '技能：Axure、Xmind、Excel。',
      suggested: '技能：Axure、Xmind、Excel、SQL 基础；【待确认：权限体系参与深度】',
      evidence: '经历库-权限体系', pending: ['权限体系参与深度'], type: '补充',
    },
  ],
  projects: [{ name: '数据看板模块', why: '对应 SQL 数据分析能力', requirement_ids: ['R2'] }],
  skills: [{
    skill_id: 'L1', requirement_id: 'R3', gap: 'SaaS 多租户权限模型缺少落地经验',
    priority: '面试前', depth: '能独立应用', knowledge_points: ['RBAC/ABAC', '租户隔离'],
    practice_tasks: ['画一版权限模型并说明取舍'], estimated_hours: '估计 6-10 小时',
    deliverable: '一份权限模型设计说明', acceptance: '能讲清角色、资源、租户三层关系', impact: '应对加分类问题',
  }],
  questions: [{ question_id: 'Q1', question: '权限体系需求你参与到什么程度？', why: '决定加分项能否算匹配', updates: ['R3'] }],
}

const norm = validateAnalysis(mockRaw, { jobs: [job], resumeText, libraryText })
ok('要求数量正确', norm.requirements.length === 4)
ok('经历库有、简历无 → 表达缺口', norm.requirements.find(r => r.name.includes('SQL'))?.gapType === '表达缺口')
ok('无证据 → 待确认（不判为不会）', norm.requirements.find(r => r.name.includes('多租户'))?.judgment === '待确认')
ok('硬性条件不满足 → 硬性条件差距', norm.requirements.find(r => r.name.includes('3年以上'))?.gapType === '硬性条件差距')
ok('关联ID有效', norm.resumeChanges.every(c => norm.requirements.some(r => r.id === c.requirementId)))
ok('占位符被标记', norm.resumeChanges.some(c => c.hasPlaceholder === true))
ok('未采纳初始状态', norm.resumeChanges.every(c => c.adopted === false))
ok('要求ID前缀稳定', norm.requirements.every(r => /^(R\d+|J\d+-R\d+)$/.test(r.id)), norm.requirements.map(r => r.id).join(','))

console.log('\n[3] 评分公式（代码计算，非模型报分）')
{
  const s = norm.scoring
  ok('有硬性条件差距时单独提示', s.hardBlockers.length === 1)
  ok('分数为 0-100 整数或 null', s.score === null || (Number.isInteger(s.score) && s.score >= 0 && s.score <= 100))
  ok('展示覆盖度与未知项', s.coverage !== null && s.total === 4 && s.known === 3)
  ok('待确认不计入分母', s.dimensions.every(d => d.unknown >= 0))
  const poor = computeScore([
    { id: 'a', type: '核心职责', priority: '必须', judgment: '待确认' },
    { id: 'b', type: '核心职责', priority: '必须', judgment: '待确认' },
  ])
  ok('未知过多 → 不展示总分', poor.applicable === false && poor.score === null)
}

console.log('\n[4] 基础文本检查（无 AI）')
{
  const basic = analyzeBasic({ jobs: [job], resumeText, libraryText })
  ok('标注为基础模式', basic.mode === 'basic')
  ok('不输出匹配分', basic.scoring.applicable === false && basic.scoring.score === null)
  ok('不生成简历改写与能力计划', basic.resumeChanges.length === 0 && basic.skills.length === 0)
  ok('有请求式的简单说明', basic.overview.reason.includes('基础文本检查'))
  ok('产出可判断的要求', basic.requirements.length > 0)
}

console.log('\n[5] 多岗位合并（ID 映射、概览汇总、部分失败）')
{
  const job2 = {
    id: 901, title: '【样例】电商产品经理', company: '样例电商', city: '深圳', salaryText: '18-28K',
    description: `岗位职责：
1、负责电商交易链路的产品设计与优化；
2、分析用户行为数据，制定增长方案。
任职要求：
1、本科及以上学历，2年以上电商产品经验；
2、熟悉交易、订单、履约流程；
3、有数据分析能力者优先。`,
  }
  const one = validateAnalysis(mockRaw, { jobs: [job], resumeText, libraryText })
  const two = validateAnalysis({
    ...mockRaw,
    overview: { ...mockRaw.overview, recommendation: '推荐投递', reason: '电商经验匹配' },
  }, { jobs: [job2], resumeText, libraryText })

  const okOnes = [one, two]
  const merged = mergeAnalyses(okOnes, { jobs: [job, job2], failed: [{ jobId: 902, jobTitle: '失败岗位', error: '超时' }] })
  const ids = merged.requirements.map(r => r.id)
  ok('合并后要求ID唯一', new Set(ids).size === ids.length)
  ok('合并后要求带岗位前缀', ids.every(id => /^J\d+-\d+$/.test(id)), ids.slice(0, 4).join(','))
  ok('多岗要求数=各岗之和', merged.requirements.length === one.requirements.length + two.requirements.length)
  ok('修改项关联到合并后的要求', merged.resumeChanges.every(c => merged.requirements.some(r => r.id === c.requirementId)))
  ok('修改项ID不重复', new Set(merged.resumeChanges.map(c => c.id)).size === merged.resumeChanges.length)
  ok('逐岗投递建议存在', merged.overview.byJob.length === 2 && merged.overview.byJob.every(b => !!b.recommendation))
  ok('全局建议取最有利岗位', merged.overview.recommendation === '推荐投递', merged.overview.recommendation)
  ok('部分失败状态=partial', merged.status === 'partial' && merged.failedJobs.length === 1)
  ok('失败时可信度降低', merged.overview.confidence === '低')
  ok('合并后评分仍然可算', merged.scoring && (merged.scoring.score === null || Number.isInteger(merged.scoring.score)))
  ok('学习任务关联有效', merged.skills.every(s => !s.requirementId || merged.requirements.some(r => r.id === s.requirementId)))
  ok('提问关联有效', merged.questions.every(q => q.updates.every(id => merged.requirements.some(r => r.id === id))))
}

console.log('\n[6] 简历工作年限（确定性计算）')
{
  ok('单段区间', estimateResumeYears('2020.01-2022.01 某公司') === 2, String(estimateResumeYears('2020.01-2022.01 某公司')))
  ok('重叠区间合并', estimateResumeYears('2019.01-2021.06\n2020.07-2022.12') === 3.9, String(estimateResumeYears('2019.01-2021.06\n2020.07-2022.12')))
  ok('识别不到返回 null', estimateResumeYears('某公司 产品经理') === null)
  ok('识别"至今"', (estimateResumeYears('2023.01-至今 A公司') || 0) > 0)

  const resumeWithDates = resumeText + '\n工作经历：2019.01-2023.06 某某公司 产品经理'
  const reqWithYears = {
    ...mockRaw,
    requirements: [{
      requirement_id: 'R1', name: '2年以上B端产品经验', jd_quote: '任职要求：2年以上B端产品经验',
      jd_location: '任职要求第1条', type: '硬性条件', priority: '必须', priority_source: '原文',
      priority_reason: '明确年限', judgment: '待确认', evidence: [], judgment_reason: '简历未写明总年限',
      uncertainty: '', action: '',
    }],
  }
  const normed = validateAnalysis(reqWithYears, { jobs: [job], resumeText: resumeWithDates })
  const hard = normed.requirements.find(r => r.type === '硬性条件')
  ok('可计算年限 → 待确认升级为直接匹配', hard.judgment === '直接匹配', hard.judgment)
  ok('年限证据来自系统计算', hard.evidence.some(e => e.source.includes('系统计算')))
  ok('返回 resumeYears', normed.resumeYears > 0)
}

console.log('\n[7] 运行参数与限流并发')
{
  const d = normalizeTuning()
  ok('缺省参数回到默认值', d.concurrency === DEFAULT_TUNING.concurrency && d.maxTokens === DEFAULT_TUNING.maxTokens
    && d.timeoutSec === DEFAULT_TUNING.timeoutSec && d.thinking === 'low')

  const clamped = normalizeTuning({ concurrency: 99, maxTokens: 1, timeoutSec: 9999, thinking: 'crazy' })
  ok('并发数上限 3', clamped.concurrency === 3, String(clamped.concurrency))
  ok('输出下限 2000', clamped.maxTokens === 2000, String(clamped.maxTokens))
  ok('超时上限 300 秒', clamped.timeoutSec === 300, String(clamped.timeoutSec))
  ok('非法思考强度回落默认', clamped.thinking === 'low')

  const floaty = normalizeTuning({ concurrency: '2', maxTokens: 15000.7, timeoutSec: 90, thinking: 'off' })
  ok('字符串/小数参数取整', floaty.concurrency === 2 && floaty.maxTokens === 15001 && floaty.timeoutSec === 90)
  ok('关闭思考被保留', floaty.thinking === 'off')
  ok('负数并发被抬到 1', normalizeTuning({ concurrency: -5 }).concurrency === 1)
  ok('不修改传入对象', (() => { const raw = { concurrency: 9 }; normalizeTuning(raw); return raw.concurrency === 9 })())

  const order = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    await new Promise(r => setTimeout(r, (6 - n) * 4))
    return n * 10
  })
  ok('并发结果保持输入顺序', JSON.stringify(order) === JSON.stringify([10, 20, 30, 40, 50]))

  let running = 0, peak = 0
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
    running++; peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
  })
  ok('并发数不超过上限', peak === 3, String(peak))

  const single = await mapWithConcurrency([1, 2, 3], 1, async (n) => n)
  ok('并发=1 时串行且完整', JSON.stringify(single) === JSON.stringify([1, 2, 3]))
  ok('空列表直接返回空数组', (await mapWithConcurrency([], 2, async () => 1)).length === 0)

  let rejected = false
  try {
    await mapWithConcurrency([1, 2], 2, async (n) => {
      if (n === 1) throw new Error('boom')
      return n
    })
  } catch { rejected = true }
  ok('任务异常向上抛出（由调用方捕获）', rejected)
}

console.log('\n[8] PDF 文本质量判定')
{
  const dirty = '张三\u0001产品经理\u0001\u0001\n\n\n\n工作经历  \u0001 2022-2024'
  const cleaned = cleanText(dirty)
  ok('清除控制字符', !/[\u0000-\u0008]/.test(cleaned), JSON.stringify(cleaned))
  ok('合并多余空行', !/\n{3,}/.test(cleaned))

  const empty = assessText({ text: '', pages: 3 })
  ok('无文字 → empty', empty.level === 'empty' && empty.suspicious)

  const low = assessText({ text: '张'.repeat(91), pages: 1 })
  ok('每页 <120 字 → low（正是完整简历只解析到抬头的情况）', low.level === 'low' && low.charsPerPage === 91)

  const thin = assessText({ text: '张'.repeat(300), pages: 2 })
  ok('每页 120~200 字 → thin', thin.level === 'thin')

  const good = assessText({ text: '张'.repeat(900), pages: 2 })
  ok('每页 ≥200 字 → ok 且不告警', good.level === 'ok' && good.warnings.length === 0)

  ok('OCR 结果明显更多才替换', ocrCleanBetter('经'.repeat(400), '历'.repeat(91)) === true)
  ok('OCR 结果更少则不替换', ocrCleanBetter('经'.repeat(50), '历'.repeat(900)) === false)
  ok('OCR 内容过短不替换', ocrCleanBetter('经'.repeat(10), '历'.repeat(5)) === false)
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
