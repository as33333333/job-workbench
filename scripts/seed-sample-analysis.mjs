/**
 * 生成一份"样例数据"分析记录（结构与真实 AI 分析一致），
 * 用于在没有配置 AI Key 时演示/验收：要求对照、简历修改、采纳、生成简历等状态。
 * 运行：node scripts/seed-sample-analysis.mjs
 */
import { createAnalysis, jobById, documentById } from '../db.js'
import { validateAnalysis, checkInputs } from '../analysis.js'

const job = jobById(165)
const resumeDoc = documentById(4)
const libraryDoc = documentById(5)
if (!job || !resumeDoc) {
  console.error('缺少样例岗位(165)或样例简历(4)，请先运行 /tmp/mk-samples.mjs 或手工创建')
  process.exit(1)
}

const mockRaw = {
  requirements: [
    {
      requirement_id: 'R1', name: '本科及以上学历，1-3年 B 端产品经验', jd_quote: '本科及以上学历，1-3年 B 端产品经验',
      jd_location: '任职要求第1条', type: '硬性条件', priority: '必须', priority_source: '原文',
      priority_reason: '学历与年限同时限定', judgment: '直接匹配',
      evidence: [{ quote: '2022.07-2024.06 某某科技 产品经理', source: '简历-工作经历', in_resume: true, in_library: true }],
      judgment_reason: '简历显示 2 年 B 端产品经历，学历本科', uncertainty: '', action: '',
    },
    {
      requirement_id: 'R2', name: '需求分析与版本规划能力', jd_quote: '负责企业级 SaaS 产品（客户管理、工单协同）的需求分析与版本规划',
      jd_location: '岗位职责第1条', type: '核心职责', priority: '必须', priority_source: '原文',
      priority_reason: '岗位第一职责', judgment: '直接匹配',
      evidence: [{ quote: '负责内部工单系统的需求收集与流程梳理，输出需求文档与原型', source: '简历-工作经历', in_resume: true, in_library: true }],
      judgment_reason: '简历已有工单系统需求与版本迭代经历', uncertainty: 'SaaS 商业化场景经验有限', action: '面试准备：讲清版本优先级取舍',
    },
    {
      requirement_id: 'R3', name: 'SQL 数据分析能力', jd_quote: '具备数据分析能力，能使用 SQL 完成基础取数',
      jd_location: '任职要求第3条', type: '专业能力', priority: '重要', priority_source: '原文',
      priority_reason: '任职要求明确列出', judgment: '直接匹配',
      evidence: [{ quote: '梳理 12 个业务指标口径，用 SQL 取数验证，自助取数占比从 20% 提升到 55%', source: '经历库-数据看板模块', in_resume: false, in_library: true }],
      judgment_reason: '经历库有明确数据看板与 SQL 取数证据，但当前简历只写了「SQL 基础查询」', uncertainty: '', action: '把数据看板经历写进简历，量化覆盖范围',
    },
    {
      requirement_id: 'R4', name: 'SaaS 多租户 / 权限体系经验（加分）', jd_quote: '有 SaaS 多租户或权限体系相关经验者优先',
      jd_location: '任职要求第4条', type: '加分项', priority: '加分', priority_source: '原文',
      priority_reason: '明确标注"优先"，非硬性', judgment: '待确认',
      evidence: [{ quote: '了解 SaaS 多租户权限模型，参与过权限体系需求设计', source: '经历库-补充经历', in_resume: false, in_library: true }],
      judgment_reason: '经历库只写"了解/参与"，无法确认是否独立设计过', uncertainty: '参与深度与产出不明确', action: '确认参与范围后再写入简历，避免夸大',
    },
    {
      requirement_id: 'R5', name: '跨部门沟通与推动能力', jd_quote: '具备良好的跨部门沟通与推动能力',
      jd_location: '任职要求第5条', type: '专业能力', priority: '重要', priority_source: '原文',
      priority_reason: '任职要求列出，但表述较通用', judgment: '直接匹配',
      evidence: [{ quote: '组织跨部门需求评审，维护需求池', source: '简历-工作经历', in_resume: true, in_library: true }],
      judgment_reason: '简历有跨部门评审与推动上线的事实', uncertainty: '', action: '',
    },
    {
      requirement_id: 'R6', name: '原型与 PRD 输出能力', jd_quote: '熟练使用 Axure/Figma 输出原型，能独立撰写 PRD',
      jd_location: '任职要求第2条', type: '专业能力', priority: '必须', priority_source: '原文',
      priority_reason: '任职要求明确工具与产出', judgment: '直接匹配',
      evidence: [{ quote: '技能：Axure、Xmind、SQL 基础查询、Excel', source: '简历-技能', in_resume: true, in_library: true }],
      judgment_reason: '简历技能与工作经历均有体现', uncertainty: '', action: '',
    },
  ],
  overview: {
    recommendation: '调整后投递',
    reason: '核心职责与工具能力匹配，主要问题是一条强证据（SQL 数据看板）没写进简历，且加分项深度不明。补齐表达后值得投递。',
    top_strengths: [
      { text: '工单系统需求与版本迭代经历直接对应岗位核心职责', requirement_ids: ['R2'] },
      { text: 'Axure/PRD 能力有简历明确证据', requirement_ids: ['R6'] },
      { text: '跨部门评审与推动上线有事实支撑', requirement_ids: ['R5'] },
    ],
    top_risks: [
      { text: 'SQL 数据分析能力只在经历库，简历没体现，招聘方看不到', type: '表达缺口', requirement_ids: ['R3'] },
      { text: 'SaaS 多租户/权限体系深度不明，属于加分项但可能被追问', type: '证据不足', requirement_ids: ['R4'] },
    ],
    unconfirmed: [
      { text: '权限体系需求的参与深度（是否独立设计）', requirement_ids: ['R4'] },
    ],
    confidence: '中',
    confidence_reason: '简历与经历库信息较完整，但有 1 条加分项证据深度不明确',
  },
  resume_changes: [
    {
      change_id: 'C1', requirement_id: 'R3', location: '工作经历第1条',
      reason: 'JD 明确要求 SQL 数据分析，经历库有数据看板证据但简历未写',
      original: '负责内部工单系统的需求收集与流程梳理，输出需求文档与原型',
      suggested: '负责内部工单系统的需求收集与流程梳理，输出需求文档与原型；主导数据看板模块，梳理 12 个业务指标口径并用 SQL 取数验证，上线后业务自助取数占比由 20% 提升至 55%',
      evidence: '经历库-数据看板模块（12 个指标、20%→55%）',
      pending: [], type: '补充',
    },
    {
      change_id: 'C2', requirement_id: 'R6', location: '技能栏',
      reason: '把与 JD 直接相关的工具能力前置，便于 10 秒内被看到',
      original: '技能：Axure、Xmind、SQL 基础查询、Excel',
      suggested: '技能：Axure / Xmind 原型与流程图、PRD 撰写、SQL 基础取数；Excel 数据分析',
      evidence: '简历-技能', pending: [], type: '前置',
    },
    {
      change_id: 'C3', requirement_id: 'R4', location: '项目经历（新增一条）',
      reason: '对应加分项，但参与深度需要你确认后再写',
      original: '项目经历\n内部工单系统重构：负责流程梳理与验收，覆盖 5 个业务部门',
      suggested: '项目经历\n内部工单系统重构：负责流程梳理与验收，覆盖 5 个业务部门\n权限体系需求设计：【待确认：你在其中的具体角色与产出，例如负责角色/资源模型梳理并输出需求文档】',
      evidence: '经历库-补充经历（仅"了解/参与"）',
      pending: ['权限体系中的具体角色', '是否有可展示的权限模型文档'],
      type: '补充',
    },
  ],
  projects: [
    { name: '数据看板模块', why: '直接对应 JD 的 SQL 数据分析要求，且已有量化结果', requirement_ids: ['R3'] },
    { name: '内部工单系统重构', why: '对应核心职责中的流程梳理与版本交付', requirement_ids: ['R2'] },
  ],
  skills: [
    {
      skill_id: 'L1', requirement_id: 'R4', gap: 'SaaS 多租户权限模型缺少落地经验',
      priority: '面试前', depth: '能独立应用',
      knowledge_points: ['RBAC 与 ABAC 的区别', '多租户隔离的常见方案', '权限模型的角色/资源/操作三要素'],
      practice_tasks: ['用一张图画出你理解的多租户权限模型，并写出 2 个取舍理由'],
      estimated_hours: '估计 6-10 小时',
      deliverable: '一页纸权限模型说明 + 面试口述稿',
      acceptance: '能在 2 分钟内讲清租户、角色、资源的关系，并说明你参与过的部分',
      impact: '把"了解"变成"能讲清楚"，应对加分项追问',
    },
    {
      skill_id: 'L2', requirement_id: 'R3', gap: '数据分析表达不够体系化（有证据但缺方法论）',
      priority: '投递前', depth: '能独立应用',
      knowledge_points: ['指标口径与维度拆解', '漏斗与留存分析基础'],
      practice_tasks: ['把数据看板项目改写成"问题-口径-验证-结果"四段式'],
      estimated_hours: '估计 2-4 小时',
      deliverable: '简历中一条完整的数据项目描述',
      acceptance: '能被追问指标口径与验证方式而不露怯',
      impact: '直接提升简历通过率',
    },
    {
      skill_id: 'L3', requirement_id: 'R2', gap: '缺少 SaaS 商业化与续费相关认知',
      priority: '长期', depth: '了解概念',
      knowledge_points: ['SaaS 关键指标：ARR/续费率/NRR', '客户成功与产品迭代的关系'],
      practice_tasks: ['阅读 2 篇 SaaS 指标科普并整理自己的理解'],
      estimated_hours: '估计 8-12 小时',
      deliverable: '一份 SaaS 指标笔记',
      acceptance: '能解释续费率下降时产品侧可做的 3 件事',
      impact: '面试中体现业务理解，长期用于实际工作',
    },
  ],
  questions: [
    {
      question_id: 'Q1', question: 'SaaS 多租户/权限体系的需求，你参与到什么程度（是否独立设计过）？',
      why: '决定这条加分项能否算匹配，也决定简历里能不写', updates: ['R4'],
    },
    {
      question_id: 'Q2', question: '数据看板项目中，指标口径是你梳理的还是别人给的口径？',
      why: '决定 SQL/数据能力是"执行"还是"设计"，影响简历写法', updates: ['R3'],
    },
    {
      question_id: 'Q3', question: '你是否有过面向外部客户（而非内部系统）的产品经验？',
      why: 'JD 是企业级 SaaS，若只有内部系统经验需要在简历中做可迁移说明', updates: ['R2'],
    },
  ],
}

const quality = checkInputs({ jobs: [job], resumeText: resumeDoc.content, libraryText: libraryDoc.content })
const data = {
  ...validateAnalysis(mockRaw, { jobs: [job], resumeText: resumeDoc.content, libraryText: libraryDoc.content }),
  status: 'ok',
  sample: true,
  sampleNote: '样例数据：用模拟模型输出生成，用于演示分析结构，不代表真实 AI 结论',
  quality,
  input: {
    jobs: [{ id: job.id, title: job.title, company: job.company, city: job.city, salaryText: job.salaryText, jdLength: (job.description || '').length }],
    resume: { id: resumeDoc.id, name: resumeDoc.name, length: (resumeDoc.content || '').length },
    library: { id: libraryDoc.id, name: libraryDoc.name, length: (libraryDoc.content || '').length },
    answers: [],
    versions: {
      jd: `${job.title}（JD ${(job.description || '').length}字）`,
      resume: `${resumeDoc.name}（${(resumeDoc.content || '').length}字）`,
      library: `${libraryDoc.name}（${(libraryDoc.content || '').length}字）`,
    },
  },
}

const a = createAnalysis({
  jobIds: [job.id], jobTitles: `【样例数据】${job.title}（${job.company}）`,
  documentId: resumeDoc.id, documentName: resumeDoc.name,
  resumeDocId: resumeDoc.id, libraryDocId: libraryDoc.id,
  mode: 'ai', status: 'ok', data,
})
console.log('已生成样例分析 ID:', a.id)
