import { listJobs, createJob } from './db.js'

/* 预置示例岗位：均为虚构公司 + 真实感JD文本，用于演示筛选/分析/改简历全流程 */
const SEEDS = [
  {
    title: 'AI产品经理（大模型应用方向）', category: '产品经理', company: '星澜智能', city: '深圳',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '本科',
    salaryText: '20-35K·15薪', salaryMin: 20, salaryMax: 35, salaryNote: '15薪',
    tags: ['大模型', 'AIGC', 'Agent', '提示词', 'B端', '需求分析', 'PRD'],
    source: '示例数据', sourceUrl: '', bossActive: '刚刚活跃',
    publishedAt: '2026-10-31T09:30:00+08:00', favorite: 1,
    description: `【岗位职责】
1、负责大模型应用类产品（智能客服/知识库/Agent工具）的规划与落地，独立完成从需求调研、方案设计到上线迭代的全流程；
2、深入理解大模型能力边界（Prompt工程、RAG、Function Calling、Agent编排），能将能力转化为可落地的产品方案；
3、撰写高质量PRD与原型，与算法、研发、设计团队紧密协作，把控交付质量与节奏；
4、建立数据指标体系（采用率、解决率、满意度），通过A/B测试与数据分析持续优化产品体验；
5、跟踪AIGC行业动态与竞品（Coze、Dify、GPTs生态），输出竞品分析与机会洞察。

【任职要求】
1、本科及以上学历，1-3年产品经验，有大模型/AIGC产品或AI项目落地经验者优先；
2、优秀的需求分析与逻辑拆解能力，能独立产出结构化PRD与原型（Axure/Figma）；
3、熟悉提示词工程与RAG基本原理，能自己动手验证AI方案可行性；
4、数据敏感度高，熟练使用SQL或Excel进行数据分析，具备A/B测试经验；
5、强跨部门沟通与推动能力，结果导向，抗压性强。`,
  },
  {
    title: '产品经理（B端SaaS方向）', category: '产品经理', company: '领川云科技', city: '深圳',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '本科',
    salaryText: '15-25K·14薪', salaryMin: 15, salaryMax: 25, salaryNote: '14薪+期权',
    tags: ['B端', 'SaaS', 'ERP', 'CRM', 'PRD', '客户调研', '项目管理'],
    source: '示例数据', sourceUrl: '', bossActive: '今日活跃',
    publishedAt: '2026-10-30T16:00:00+08:00',
    description: `【岗位职责】
1、负责跨境电商ERP/SaaS产品的核心模块（订单、库存、供应链协同）规划与迭代；
2、深入客户一线（卖家访谈、驻场观察），挖掘业务痛点，输出客户调研报告与需求池管理；
3、撰写PRD与流程图，推动研发按期高质量交付，负责版本发布与灰度管理；
4、搭建B端产品北极星指标体系，关注客户续费率、活跃度与NPS，驱动产品商业化；
5、与销售、客户成功团队协作，参与大客户方案设计与投标支持。

【任职要求】
1、本科及以上学历，1-3年B端产品经验，有SaaS/ERP/CRM/供应链相关经验者优先；
2、逻辑思维清晰，擅长复杂业务流程抽象与结构化拆解，熟练使用Axure/Xmind/Visio；
3、具备优秀的文档撰写与跨部门沟通能力，能独立组织需求评审；
4、了解项目管理方法（敏捷/瀑布），有推动复杂项目落地的实战经验；
5、对跨境电商业态有认知者优先，接受适度出差走访客户。`,
  },
  {
    title: '增长产品经理（出海方向）', category: '产品经理', company: '蓝鲸出海', city: '深圳',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '本科',
    salaryText: '18-30K', salaryMin: 18, salaryMax: 30, salaryNote: '',
    tags: ['增长', '用户增长', 'A/B测试', '数据分析', '转化率', '私域', 'C端'],
    source: '示例数据', sourceUrl: '', bossActive: '刚刚活跃',
    publishedAt: '2026-10-30T10:20:00+08:00', favorite: 1,
    description: `【岗位职责】
1、负责出海工具类App（月活千万级）的增长体系设计：新用户激活、留存、召回全链路；
2、设计并落地增长实验：onboarding优化、裂变活动、Push/弹窗策略，单月可运行10+个A/B实验；
3、搭建增长漏斗看板，定位转化率卡点，用数据驱动优先级决策；
4、与买量、ASO、CRM团队协同，设计LTV与获客成本的平衡策略；
5、沉淀增长方法论与实验库，输出复盘文档。

【任职要求】
1、本科及以上学历，1-3年C端/增长产品经验，有出海或工具类产品经验优先；
2、数据驱动，熟练使用SQL自主取数，深刻理解漏斗、留存、LTV、A/B测试原理；
3、对心理学与用户动机有敏感度，能把洞察转化为可实验的方案；
4、英语可作为工作语言（读写），能直接阅读海外社区与竞品资料；
5、强执行力与快速迭代意识，适应快节奏。`,
  },
  {
    title: '产品经理（AI效率工具）', category: '产品经理', company: '启点工场', city: '深圳',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '本科',
    salaryText: '16-28K·13薪', salaryMin: 16, salaryMax: 28, salaryNote: '13薪',
    tags: ['AI', 'AIGC', 'C端', '0-1', '用户研究', '原型', 'PRD'],
    source: '示例数据', sourceUrl: '', bossActive: '2日内活跃',
    publishedAt: '2026-10-29T14:00:00+08:00',
    description: `【岗位职责】
1、负责AI效率工具（AI写作/笔记/摘要）从0到1的产品定义与冷启动，直接向CEO汇报；
2、通过用户访谈与社区洞察（即刻、小红书、Reddit）捕捉真实需求，快速验证MVP；
3、设计核心体验：Prompt模板体系、多模态输入输出、订阅付费转化路径；
4、小步快跑：两周一个版本，用留存与付费数据验证假设；
5、参与商业化设计：订阅定价、积分体系、渠道投放协同。

【任职要求】
1、本科及以上学历，1-3年产品经验，有0-1项目或个人创业/独立开发作品加分；
2、深度使用主流AI产品（ChatGPT/Claude/Notion AI等），理解AIGC产品设计与局限；
3、具备完整PRD/原型能力（Figma/墨刀），能独立完成小功能闭环设计；
4、有用户研究基本功，能独立完成访谈提纲设计与洞察提炼；
5、创业心态，喜欢不确定性与快节奏，结果导向。`,
  },
  {
    title: '产品经理（内容社区方向）', category: '产品经理', company: '悦芽文化', city: '深圳',
    recruitType: '社招', expMin: 0, expMax: 99, experienceText: '经验不限', education: '本科',
    salaryText: '15-28K', salaryMin: 15, salaryMax: 28, salaryNote: '',
    tags: ['C端', '社区', '内容', '用户画像', '留存', '竞品分析'],
    source: '示例数据', sourceUrl: '', bossActive: '今日活跃',
    publishedAt: '2026-10-28T18:40:00+08:00',
    description: `【岗位职责】
1、负责兴趣社区产品的内容消费与互动链路（Feed、话题、评论体系）的产品设计；
2、基于用户画像与内容池数据优化分发策略，提升人均使用时长与互动率；
3、设计创作者激励机制，建设健康的内容生态，把控社区氛围与安全合规；
4、开展竞品分析（小红书、B站、豆瓣等），输出差异化机会点；
5、与运营协同策划社区活动，提升用户留存与情感连接。

【任职要求】
1、本科及以上学历，经验不限，重度内容社区用户优先；
2、同理心强，善于从用户行为数据与评论中洞察真实动机；
3、逻辑清晰，能独立完成功能方案与原型设计；
4、对内容生态、社区治理有自己的理解与思考；
5、有C端产品实习或工作经验者优先。`,
  },
  {
    title: '产品经理（电商供应链）', category: '产品经理', company: '鹏城汇电商', city: '深圳',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '大专',
    salaryText: '15-24K·13薪', salaryMin: 15, salaryMax: 24, salaryNote: '13薪',
    tags: ['供应链', 'B端', 'ERP', 'WMS', '需求分析', '项目管理'],
    source: '示例数据', sourceUrl: '', bossActive: '3日内活跃',
    publishedAt: '2026-10-27T11:10:00+08:00',
    description: `【岗位职责】
1、负责电商供应链系统（采购、WMS、TMS、库存中台）的产品设计与迭代；
2、与仓配运营团队深度协作，梳理业务流程痛点，输出系统优化方案；
3、撰写PRD、流程图与接口文档，与研发对齐系统边界与数据结构；
4、监控系统健康度指标（库存周转、履约时效、订单异常率），驱动持续改善；
5、支持大促（黑五、Prime Day）备战：容量规划、预案设计、复盘沉淀。

【任职要求】
1、大专及以上学历，1-3年供应链/ERP/WMS相关产品或业务经验；
2、逻辑思维扎实，能把线下复杂作业流程转化为线上系统能力；
3、熟练使用ProcessOn/Xmind等工具输出流程与架构图；
4、沟通推动力强，能协调仓、采、运、研发多方达成一致；
5、有跨境电商或大型仓储物流经验者优先。`,
  },
  {
    title: '高级产品经理（数据平台）', category: '产品经理', company: '深智数科', city: '深圳',
    recruitType: '社招', expMin: 3, expMax: 5, experienceText: '3-5年', education: '本科',
    salaryText: '25-40K·16薪', salaryMin: 25, salaryMax: 40, salaryNote: '16薪',
    tags: ['B端', '数据中台', 'BI', 'SQL', '指标体系', '数据产品'],
    source: '示例数据', sourceUrl: '', bossActive: '今日活跃',
    publishedAt: '2026-10-26T15:30:00+08:00',
    description: `【岗位职责】
1、负责企业级数据中台与BI产品的规划：指标中台、自助分析、数据大屏；
2、定义统一指标体系与口径管理机制，推动跨部门数据标准化落地；
3、设计自助分析体验（拖拽式报表、看板订阅、异动归因），降低业务用数门槛；
4、与数据研发协作治理数据质量，建立SLA与监控告警机制；
5、跟进Data+AI趋势（ChatBI、指标问答），规划智能化路线图。

【任职要求】
1、本科及以上学历，3-5年数据产品经验，有数据中台/BI/指标体系实战案例；
2、SQL熟练，理解数仓分层与维度建模基本原理；
3、优秀的抽象与结构化能力，能驾驭跨团队复杂项目；
4、有ChatBI或大模型+数据场景探索经验者优先。`,
  },
  {
    title: '产品专家（金融科技风控）', category: '产品经理', company: '前海惠金', city: '深圳',
    recruitType: '社招', expMin: 5, expMax: 10, experienceText: '5-10年', education: '本科',
    salaryText: '35-55K·16薪', salaryMin: 35, salaryMax: 55, salaryNote: '16薪',
    tags: ['金融', '风控', '策略', 'B端', '合规'],
    source: '示例数据', sourceUrl: '', bossActive: '今日活跃',
    publishedAt: '2026-10-25T10:00:00+08:00',
    description: `【岗位职责】
1、负责信贷风控产品体系（反欺诈、授信决策、贷中管理）的整体规划；
2、设计决策引擎与规则配置平台，支持策略团队快速上线与回溯；
3、平衡业务增长与风险合规，输出符合监管要求的产品方案；
4、带领3-5人产品小组，负责团队梯队建设与专业辅导。

【任职要求】
1、本科及以上学历，5年以上金融风控/信贷产品经验，有团队管理经验；
2、熟悉消费信贷全生命周期与监管政策；
3、有决策引擎、规则平台相关产品从0到1经验者优先。`,
  },
  {
    title: '产品经理（北京·AI教育）', category: '产品经理', company: '京师云学', city: '北京',
    recruitType: '社招', expMin: 1, expMax: 3, experienceText: '1-3年', education: '本科',
    salaryText: '18-32K·14薪', salaryMin: 18, salaryMax: 32, salaryNote: '14薪',
    tags: ['AI', '教育', 'C端', 'AIGC'],
    source: '示例数据', sourceUrl: '', bossActive: '2日内活跃',
    publishedAt: '2026-10-24T09:00:00+08:00',
    description: `【岗位职责】
1、负责K12 AI学习机的核心功能规划：自适应练习、错题归因、家长端报告；
2、结合AIGC能力设计个性化学习路径，提升学习效果与续费率；
3、与教研、算法团队协作，把教研能力产品化。

【任职要求】
1、本科及以上学历，1-3年产品经验，教育或AI相关背景优先；
2、有C端产品完整迭代经验，数据驱动意识强；
3、熟悉青少年用户心理者优先。`,
  },
  {
    title: '产品运营专员（校招培养生）', category: '产品运营', company: '青柚互娱', city: '深圳',
    recruitType: '校招', expMin: 0, expMax: 0, experienceText: '应届', education: '本科',
    salaryText: '9-13K·14薪', salaryMin: 9, salaryMax: 13, salaryNote: '14薪',
    tags: ['校招', '运营', '活动策划', '新媒体'],
    source: '示例数据', sourceUrl: '', bossActive: '今日活跃',
    publishedAt: '2026-10-20T14:00:00+08:00',
    description: `【岗位职责】
1、参与游戏社区的用户运营与活动策划，执行版本节点运营方案；
2、管理玩家社群（QQ/Discord），收集反馈并输出周报；
3、协助新媒体内容（小红书/B站/抖音）策划与发布。

【任职要求】
1、2026届本科应届毕业生，专业不限；
2、热爱游戏，重度社区用户，文案功底好；
3、有校园社团或新媒体运营经历者优先。`,
  },
]

export function seedIfEmpty() {
  if (listJobs().length > 0) return 0
  let n = 0
  for (const s of SEEDS) { createJob(s); n++ }
  return n
}
