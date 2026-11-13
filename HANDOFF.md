# HANDOFF — 求职工作台（job-workbench）

> 交接文档，供新会话直接接手。项目路径：`<项目目录>（如 ~/job-workbench）`
> 最后更新：2026-11-02

## 1. 目标与约束

**产品目标**：四功能的求职工作台
1. 岗位库：捞取 Boss 直聘 JD（产品经理 / 深圳 / 社招3年内 / 15K+），最新在前，收藏、一键投递
2. JD 分析：单选/多选岗位，对比「当前简历 + 经历库」，输出投递建议、要求逐条对照、简历修改、能力补齐、待补充问题
3. AI 改简历：按选定 JD 或共性要求改写，支持手动编辑、版本保留
4. 信息库：上传文件 / 链接 / 文本，作为简历与经历来源

**已完成的三轮重点**
1. 第一轮：岗位库 JD 完整性与示例清理；每日 09:00 定时采集；JD 分析（证据驱动）重构；AI Key 部署
2. 第二轮：多岗位并发 + 流式进度 + 分析参数可调（§2.5）
3. 第三轮：上传解析质量闸门 + 系统 OCR（§2.6）；定时采集失败可诊断 + 手动全量采集与进度（§2.7）

**硬性约束**
- 沿用现有技术栈与设计体系：Express + `node:sqlite` + React/Vite，蓝白风格，不引入新依赖
- 禁止编造经历/数字；所有判断需可溯源；简历没写 ≠ 不会
- 输入不足时不出结论、不报分；无 AI 时降级为「基础文本检查」而非伪分析
- **不覆盖用户原链接**：8787 仍是旧代码进程（PID 59086，未重启）；新版本跑在 **8788**
- 密钥只存本机 `./.env`（已 gitignore），不得写入代码、文档、日志

## 2. 已完成内容

### 2.1 岗位库与采集
- 移除示例 JD 注入与前端「示例」标签；DB 内 10 条 `source=示例数据` 已删除；`seed.js` 仍在磁盘但**无任何引用**（可安全删除）
- JD 完整性：新增 `jobtext.js`——`stripJdNoise()` 清「认证资质 / 人力资源服务许可证 / 相似职位」等噪声，`jdLooksIncomplete()` 用结构判据（去掉 `【福利】` 后看职责/要求段落、编号条目）替代 `<300 字` 阈值
- 导入/回填都做噪声清理；`POST /api/jobs/backfill-details` 用详情文件回填，`{deep:true}` 生成 input 文件调用 `collector/boss-zhipin-scraper/scripts/boss_cdp_raw.py --input <f> --detail --detail-output <f>` 重抓后自动合并；启动时自动回填一次
- 已知永久缺正文的 2 条：job 85/87（招聘方只写了福利标签）

### 2.2 JD 分析（核心，`analysis.js`）
- **输入校验** `checkInputs/checkJdQuality/checkResumeQuality`：JD 只有标题、缺职责要求、含页面噪声、简历缺失/过短 → `status:'blocked'`，只给缺失项，不出结论与分数
- **AI 结构化分析**：严格 JSON Schema + `validateAnalysis` 规范化 + 失败重试一次（第二次关闭思考并附修复指令）；仍失败 → `status:'failed'`，不降级成伪分析
- **证据规则**：每条要求含 `jdQuote/jdLocation/type/priority/prioritySource/judgment/evidence[{quote,source,inResume,inLibrary}]/judgmentReason/gapType/action`；经历库有简历无 → 「表达缺口」，无证据 → 「待确认」，硬性条件明确不满足 → 「硬性条件差距」；后置一致性校正（表达缺口须有 `inResume=false` 证据；「直接匹配 + 证据全在简历」清空矛盾标注）
- **确定性评分** `computeScore`：直接匹配 1 / 可迁移 0.6 / 明确不满足 0 / 待确认不计入；权重 硬性30%·职责25%·能力25%·行业10%·加分10%；输出维度分、覆盖度、未知项、`partial`、`hardBlockers`、`pendingMust`；未知≥60% 或要求<3 条不展示总分
- **年限计算** `estimateResumeYears`：解析 `2022.07-2024.06`、`2023.01-至今` 合并重叠区间；年限类要求若「待确认」且计算值 ≥ 要求 → 升级「直接匹配」并插入「简历-时间汇总（系统计算）」证据；计算值写入 prompt
- **多岗位**：`aiExtractCommon` 提炼共性 + 逐岗分析 + `mergeAnalyses`（要求 ID 前缀 `J<id>-R<n>`、逐岗建议 `overview.byJob`、部分失败 → `status:'partial'` 且可信度降「低」）
- **补充回答** `POST /api/analyses/:id/answers`：答案按**问题文本**归属（相似度 0.75），判断变化按文本相似度 0.5 匹配，已答问题（≥0.7）归档到 `data.answeredQuestions`
- **采纳/撤销** `PUT /api/analyses/:id/state`；**生成简历** `POST /api/resumes/from-analysis`：只应用已采纳修改，`original` 必须在原简历中存在，含「待确认」占位符跳过并回报，生成新版本（记 `analysisId/adoptedChangeIds`），**原简历不改**
- **无 AI 降级** `analyzeBasic`：只做句子切分与词语覆盖，`scoring.applicable=false`，明确标注「基础文本检查」

### 2.3 推理模型适配（DeepSeek）
- 真实报错：`finish_reason=length`、`reasoning_tokens=6000`、`content=""`（思考耗尽输出预算）
- `ai.js chat()` 支持 `thinking:'low'|'off'`（仅 deepseek 域名发送 `thinking/reasoning_effort`）
- 分析默认 `thinking:'low'` + `maxTokens:16000` + `timeout 120s`，失败重试 `thinking:'off'`；共性提炼/解析/改写/连通性测试同步调整
- 空内容错误带诊断（`finish_reason/usage/hasReasoning/keys` + 响应片段）；错误可读化：401→「API Key 无效」、模型名错误→提示 `deepseek-flash`、402 额度、429 限流

### 2.4 AI Key 部署
- `aiConfig()` 优先级：环境变量（`AI_API_KEY`/`OPENAI_API_KEY`、`AI_API_BASE`、`AI_MODEL`）> 设置页（DB）> 默认值；`server.js` 启动加载 `./.env`（不覆盖已有变量）
- 默认 DeepSeek：`https://api.deepseek.com` + `deepseek-flash`（Pro 为 `deepseek-v4-pro`；`deepseek-chat/reasoner` 已于 2026-07-24 弃用，`deepseek-4.1flash` 不是有效 ID）
- `GET/PUT /api/settings` 增加 `keySource`（`env`/`settings`/`none`），设置页显示「环境变量」并禁用 Key 输入；新增 `npm run ai:check`

### 2.5 多岗位并发、流式进度与可调参数
- **限流并发** `mapWithConcurrency`（纯函数、无新依赖）：默认 2（可调 1~3），结果顺序与输入一致，单岗失败不影响其他岗位
- **运行参数** `DEFAULT_TUNING`/`normalizeTuning`：`thinking`(low/off)、`concurrency`(1~3)、`maxTokens`(2000~32000)、`timeoutSec`(30~300)，存 `settings.analysisTuning`，越界夹紧；`callStructured` 首次按设置、重试强制 `off`；`aiExtractCommon` 输出上限 ≤8000
- **流式进度** `POST /api/analyze/stream`（SSE）：`progress{message,percent}`（校验 5 → 共性 12/20 → 单岗 25 → 每岗完成 25+60×完成/总数 → 保存 95）→ `done{analysis}` 或 `error`
  - 15 秒心跳也发 `progress`（「仍在分析…已用 N 秒」，percent 每次 +3，上限 92），单岗长调用时进度条不停
  - 前端 `apiStream()`（fetch + ReadableStream）解析；分析页顶部进度条 + 百分比
  - **旧服务端兼容**：8787 无 `/stream`（404）→ 自动回退 `POST /api/analyze`（`fallbackBody` 带旧接口需要的 `documentId`）；`api()` 抛出的错误带 `status`，信息库上传据此回退旧上传路径
- 接口收口：`/api/analyze` 与 `/api/analyze/stream` 共用 `resolveAnalyzeInput()`/`persistAnalysis()`
- 设置页新增「分析参数」卡片（思考强度/并发/最大输出/超时/恢复默认）

### 2.6 上传解析质量闸门 + 系统 OCR
- **问题实证**：真实 PDF 简历（`documents` id=3）只解析到抬头 91 字，正文产品经历全丢却照常入库 → 分析只能判「没证据」。原因是 pdf-parse 对设计/扫描类 PDF 只有图片或字体提取不到（pdf.js 刷 `Ran out of space in font private use area`），旧逻辑只在 `<10 字` 才报错
- 新增 `pdftext.js`
  - `cleanText`：清 `\x01` 等控制字符、合并多余空格空行（旧数据里的 `^A` 即此类）
  - `renderPage`：自定义 pagerender，按 y 聚行（容差 2）→ 行内按 x 排序 → 间距 >1.5pt 补空格
  - `assessText`（纯函数）：按每页字数判 `empty(<10字)` / `low(<120/页)` / `thin(<200/页)` / `ok` 并给可读警告
  - `extractPdfSmart`：文字层非 ok 时自动 OCR，且仅当 OCR 字数 ≥ 文字层 1.3 倍（`ocrCleanBetter`）才替换
  - `ocrPdfFile`：调 `scripts/pdf-ocr.swift`（macOS Vision，`zh-Hans + en-US`，accurate），首次 `swiftc -O` 编译到 `data/bin/pdf-ocr` 复用；最多 15 页；不联网、不引 npm 依赖
- **先预览后入库**：`POST /api/documents/parse`（不落库）→ 返回全文 + `meta{pages,chars,charsPerPage,level,suspicious,warnings,method}`；前端显示「多少字 / 几页 / 文字层还是 OCR / 警告 / 全文可编辑」，确认后才 `POST /api/documents`（`content + parseMeta`）
- `documents.parseMeta`（`ensureColumn` 迁移，`normalizeDoc` 读时解析）；原文件存 `data/uploads/<时间戳>-<文件名>`
- 展示：信息库列表对 `suspicious` 或旧「文件上传且 <200 字」打「解析可能不完整」；分析页选中该简历时警告「只提取到 N 字，正文很可能是图片」
- **真实简历复核（2026-11-02，补 §2.6 遗留）**：用一份 2 页真实简历 PDF 走 `/api/documents/parse` → 约 2 千字 / 近 1000 字每页 / `level=ok` / `method=text` / 约 1.2 秒，未触发 OCR；工作经历段落、项目结果与数字均完整保留，`estimateResumeYears` 返回 2.5 年（正则支持「2024年5月-至今」这类中文格式）→ 解析链路对该 PDF 已完整，OCR 只需对扫描件兜底
  - 已入库为一份完整简历文档（`parseMeta` 持久化）；旧的 91 字残缺记录已删除（历史分析的正文快照存在 `data.input.snapshot`，不受影响）
  - 操作前备份：`data/workbench.bak-20261102-0915.db`（`sqlite3 .backup`，含 WAL 内容）
  - 新增只读校验脚本 `scripts/parse-check.mjs <pdf> [baseUrl] [--ocr]`：打印字数/页数/`meta`/章节命中（工作经历/项目经历/教育/技能/年限/公司信号）+ 首尾片段，便于下次换简历先体检再入库

### 2.7 定时采集：失败可诊断 + 手动全量 + 实时进度
- **11-02 09:03 失败的归因**（日志只有「采集超时（45分钟），强制终止 / 退出码 null / 0 个结果文件」）
  - 09:03:06 正常触发，CDP 9222 在线、登录态有效（`boss_jobs_20261102_0903.json` 有 45 条）
  - 没有任何 `boss_details_20261102_09xx.json` → 死在详情阶段（默认抓全部 45 个详情）
  - 详情每个 25~50 秒（加载 5~10s + 3~7 次滚动 + 10~25s 间隔），45 个 ≈20~35 分钟，紧贴 45 分钟上限
  - 墙钟 09:03→10:04 共 61 分钟才触发「45 分钟」超时 → 期间 Mac 休眠过（Node 定时器休眠不走），醒来即判超时并 SIGKILL
  - 采集器 stdout 被丢弃，无法定位卡在第几个岗位
- **改造**（`scheduler.js`）
  - 采集器输出逐行写 `data/scheduler.log`（`  │ ...`，单行截断 300 字，保留最近 60 行）；`describeFail()` 归类为「登录态失效 / 被风控拦截 / 未完成 / 退出码」，落盘 `lastRun.error/progress/lastOutputAt`
  - **卡死看门狗**：连续 10 分钟无输出 → 判 Chrome 无响应/等待登录并终止；总上限 45 → **90 分钟**
  - **`python3 -u`**：spawn 接管道时 python 默认全缓冲，不加 `-u` 输出会成块延迟数分钟（11:46 那次就是因此被看门狗误杀）
  - **语义**：一条 JD = 列表基础数据 + 详情正文；**手动「立即运行」始终抓全部详情**，定时任务按 `maxDetails`（默认 0 = 全部）
  - **实时进度** `progress{stage,done,total,listCount,page,pages,message,startedAt,updatedAt}` 由 `GET /api/scheduler` 返回；`updateProgressFromLine()` 解析 `=== 抓取岗位详情 (N 个) ===`、`[i/N] 公司-职位`、`JD: N 字`（done+1）、`本页…累计 N`；设置页采集期间每 3 秒轮询，显示「已完成 X/Y 条 JD」+ 进度条 + 阶段文案，按钮同步显示进度，结束后 `lastRun.progress` 保留条数
  - **补跑规则**：原逻辑只在 `reason==='schedule'` 时认为当天已跑，导致手动跑过（或失败）后重启会再触发一次 09:00 补跑；改为「当天在定时时间之后跑过（手动或定时）就不再补跑」

### 2.8 前端
- `src/Analyze.jsx`：顶部概览（岗位/公司/地点/薪资/JD·简历·经历库版本/模式/更新时间/建议+理由/优势·风险·待确认/可信度/样例标识）、四页签（要求对照默认、简历修改、能力补齐、待补充信息）、桌面行动侧栏、筛选（全部/已匹配/待确认/有差距）、展开证据、采纳/编辑后采纳/撤销/复制、批量回答、历史记录；状态覆盖加载/空/blocked/failed/partial/基础模式/旧结构/结果过期；新增顶部分析进度条与「简历解析不完整」警告
- `src/Library.jsx`：上传改「解析预览 → 确认入库」，显示字数/页数/解析方式/警告，全文可编辑，可疑时「用系统 OCR 重新识别」；列表打「解析可能不完整」标签
- `src/api.js`：`apiStream()`（含 404 回退、非 SSE 响应兜底）、`api()` 错误带 `status`
- `src/Settings.jsx`：分析参数卡片、采集进度与失败原因、详情数量、「模型候选 datalist」、Key 来源提示
- `src/App.jsx` / `src/ResumeStudio.jsx`：分析生成版本跳转并载入（`pendingVersionId`），显示「原始简历未被改动」；`src/Jobs.jsx`：去示例标签、待投递 + 确认已投递、分类多选、补齐 JD 按钮；`src/styles.css`：表格/卡片/状态色（颜色+文字+符号）、侧栏、响应式 1080/760、`:focus-visible`

### 2.9 一键打招呼（2026-11-05）
- 位置：岗位卡片「🚀 去投递」右边「👋 打招呼」，点击后 **渲染文案 → 复制剪贴板 → 打开原岗位页 → 记录 `greetedAt/greetingText` → 状态按配置推进**
- `greeting.js`（纯函数，无依赖）：`DEFAULT_GREETING` / `GREETING_PLACEHOLDERS` / `normalizeGreeting()` / `renderGreeting()`
  - 占位符：`{name}{years}{highlight}`（设置里填）+ `{job}{company}{city}{salary}{tags}`（岗位数据）
  - 落空清理：字段为空时不会留下空的「」（）；未知占位符直接剔除；重复标点、悬空标点、连续空行归并；模板上限 1000 字
  - **不调用 AI、不生成任何经历或数字**：文案只由用户填写的字段 + 岗位字段拼接
- 设置页「👋 打招呼」卡片：称呼 / 经验说法 / 一句话亮点 / 模板（点占位符可追加）/ 实时渲染预览（示例岗位）/ 三个开关（自动复制、打开原岗位页、先预览再发送）/ 打招呼后状态（已打招呼、待投递、不修改）/ 保存、恢复默认
- 状态规则：只有「未处理 / 不感兴趣」会被推进，已投递、面试中、offer 不会被覆盖；岗位卡显示「👋 已打招呼 + 时间」
- 已打招呼的岗位按钮变「重新打招呼」；「投递跟踪」筛选已包含「已打招呼」
- **能力边界（刻意的）**：Boss 无稳定聊天深链，最后一步「粘贴发送」由人在 Boss 页面完成；本项目不做自动发消息（风控与平台条款），也不假装已发送——点一次只代表「文案已复制 + 页面已打开」

### 2.10 个人配置档案（`profile.js`，2026-11-13）
- 目的：把「搜索条件 / 打招呼 / 分析参数 / 采集配置」抽成可版本化 JSON，放进用户**自己的私有仓库**；公开仓库只留代码
- 存储：项目根 `config.local.json`（已 `.gitignore`）；DB 里对应 `settings{scheduleConfig, greetingConfig, analysisTuning, profileFilters}`
- 白名单：`PROFILE_KEYS = filters, greeting, analysis, schedule`；`normalizeProfile` 丢弃一切未知键 → **Key / 简历正文 / 岗位库 / 分析结果绝不会被导出**（`test:profile` 有断言）
- 归一化：`sanitizeFilters`（query/city/exp/view/sort 字符串、salary 0~100、domains 去重≤30）、`sanitizeSchedule`（time 严格 `HH:MM` 且 00-23:00-59、pages 1~10、maxDetails 0~50）、greeting/analysis 复用 `normalizeGreeting`/`normalizeTuning`
- 同步策略：
  - 启动时若存在 `config.local.json` → `applyProfile()` 覆盖 DB（日志打印「已应用 config.local.json」）
  - 之后界面里改设置（analysis/greeting/profileFilters）→ `syncProfileFile()` 写回文件，两边不漂移
  - `PUT /api/profile` 默认落盘（`persist:false` 只改 DB）
- 前端：设置页「📦 我的配置」卡片（导出下载 / 导入文件 / 把当前筛选存进配置 / 文件状态）；岗位库筛选优先级 = `localStorage` > `profile.filters` > 内置默认（`App` 传 `profileFilters`，`Jobs` 用 `useRef` 只合并一次，避免覆盖本机手动筛选）

## 3. 修改的文件

**新增**
- `analysis.js` — 分析引擎（校验/提示词/规范化/评分/年限/多岗合并/基础模式/限流并发/参数归一化）
- `greeting.js` — 打招呼配置归一化与模板渲染（纯函数）
- `profile.js` — 个人配置档案（白名单归一化 + `config.local.json` 读写）
- `scripts/test-profile.mjs` — 配置档案自测（26 断言）
- `scripts/test-greeting.mjs` — 打招呼自测（30 断言）
- `jobtext.js` — JD 噪声清理与完整性判定
- `pdftext.js` — PDF 版面重排提取、解析质量判定、OCR 编排
- `scripts/pdf-ocr.swift` — macOS Vision 逐页 OCR（编译缓存 `data/bin/pdf-ocr`）
- `scheduler.js` — 定时/手动采集、日志落盘、看门狗、进度解析
- `scripts/ai-check.mjs`、`scripts/test-analysis.mjs`（65 断言）、`scripts/seed-sample-analysis.mjs`、`scripts/ui-check.mjs`、`scripts/ui-flow-check.mjs`、`scripts/export-jobs.mjs`
- `scripts/parse-check.mjs` — 只读体检：把本地 PDF 送 `/api/documents/parse`，输出字数/页数/`meta`/章节命中/首尾片段（换简历先跑它再入库）
- `.env.example` — 环境变量模板
- 验收截图 `data/ui-check.png`、`data/ui-flow-check.png`、`data/ui-answered.png`（`data/` 已 gitignore）

**修改**
- `server.js` — 分析/回答/采纳/生成简历、JD 回填与深度补齐、调度接口、`.env` 加载、settings（keySource + analysis 参数）、`/api/analyze/stream`（含 `resolveAnalyzeInput`/`persistAnalysis` 收口）、`/api/documents/parse`、文档上传与 `parseMeta`
- `ai.js` — chat 超时/thinking/maxTokens、错误映射、默认 DeepSeek、空内容诊断、`aiExtractCommon` 可传 `{maxTokens,timeoutSec}`
- `db.js` — 迁移列 `analyses.updatedAt/answers/status/resumeDocId/libraryDocId`、`resume_versions.analysisId/adoptedChangeIds`、`documents.parseMeta`、`jobs.greetedAt/greetingText`；`normalizeDoc`
- `src/Analyze.jsx`、`src/Library.jsx`、`src/Settings.jsx`、`src/api.js`、`src/App.jsx`、`src/ResumeStudio.jsx`、`src/Jobs.jsx`、`src/styles.css`
- 打招呼相关：`server.js`（配置读写 + 两个接口）、`src/Jobs.jsx`（按钮/GreetModal/状态标签）、`src/Settings.jsx`（打招呼卡片 + 实时预览）、`src/styles.css`（`.greet-preview`）
- `package.json` — `test:analysis` / `test:greeting` / `seed:sample-analysis` / `ai:check`
- `README.md`、`.gitignore`（追加 `.env`）

**未改动但相关**
- `collector/`（第三方采集器，已 gitignore；`scripts/boss_cdp_raw.py` 参数：`--detail` 默认开启、`--max-details`、`--no-detail`）
- `data/workbench.db`（真实岗位/分析/简历版本）、`data/scheduler.log`、`data/uploads/`、`data/bin/pdf-ocr`

## 4. 接口与数据变更

| 接口 | 说明 |
|---|---|
| `POST /api/analyze` | `jobIds(≤5), resumeDocId, libraryDocId?, answers?` → analysis（`data.schemaVersion=2`） |
| `POST /api/analyze/stream` | 同 body，SSE：`progress{message,percent}` / `done{analysis}` / `error{error}`；前端默认走这个 |
| `POST /api/analyses/:id/answers` | 提交回答 → 重算 → 更新同一条记录 |
| `PUT /api/analyses/:id/state` | `{changes:[{id,adopted,adoptedText}], skills:[{id,done}]}` |
| `POST /api/resumes/from-analysis` | `{analysisId}` → 新版本（跳过占位符/找不到原文的条目） |
| `POST /api/jobs/backfill-details` / `GET` | 合并现有详情；`{deep:true}` 重抓；GET 返回 `{running,last,lackingNow}` |
| `GET/PUT /api/scheduler`、`POST /api/scheduler/run` | 配置 + 手动触发；GET 额外返回 `running/progress{stage,done,total,listCount,page,pages,message}/lastRun`；PUT 支持 `maxDetails` |
| `GET/PUT /api/settings` | `PUT {analysis:{thinking,concurrency,maxTokens,timeoutSec}}`；GET 额外返回 `analysis/analysisDefaults/analysisRules` |
| `POST /api/jobs/:id/greeting/preview` | 只渲染不落库 → `{text, config, job}`；`{text}` 可作为临时改写覆盖 |
| `POST /api/jobs/:id/greeting` | 记录文案与时间 → `{text, config, job}`；状态按 `config.markStatus` 推进（仅未处理/不感兴趣） |
| `GET/PUT /api/settings`（打招呼） | `PUT {greeting:{name,years,highlight,template,autoCopy,openPage,preview,markStatus}}`；GET 额外返回 `greeting/greetingDefaults/greetingPlaceholders` |
| 岗位字段 | `jobs` 新增 `greetedAt`、`greetingText`（`ensureColumn` 迁移，已实测写入/还原） |
| `GET /api/profile` | 返回 `profile{filters,greeting,analysis,schedule}` + `keys` + `filePath/fileExists`；不含 Key |
| `PUT /api/profile` | `{profile, persist?}` → 应用并（默认）写 `config.local.json`；返回 `written` |
| `POST /api/documents/parse` | 上传预览（不落库）：`{fileBase64,fileName,ocr?}` → `{text,preview,meta{...}}` |
| `POST /api/documents` | ①`{fileBase64,fileName}`（服务端解析，源文件存 `data/uploads`）②`{content,parseMeta,...}`（预览确认后入库） |

分析数据结构：`schemaVersion/mode/status/input(snapshot)/quality/overview/requirements/resumeChanges/projects/skills/questions/answeredQuestions/scoring/resumeYears/answerUpdate`

## 5. 验证结果

| 项 | 命令/方式 | 结果 |
|---|---|---|
| 引擎离线自测 | `npm run test:analysis` | **65/65 通过**（输入校验、证据规则、ID 映射、评分、多岗合并、年限、基础模式、参数归一化、限流并发、PDF 清洗与质量判定） |
| 分析参数接口 | `GET /api/settings` | `analysis{concurrency:2,maxTokens:16000,timeoutSec:120,thinking:low}` + rules 边界；越界值夹紧（断言覆盖） |
| 流式分析（真实双岗） | `POST /api/analyze/stream {jobIds:[163,161],resumeDocId:4,libraryDocId:5}` | analysis 21：**56 秒**（改动前串行 185 秒），6 条 progress + done，23 条要求、65 分、覆盖 61%、两岗各自建议、共性 10 条 |
| 流式分析（真实单岗） | `POST /api/analyze/stream {jobIds:[163]}` | analysis 23：82 秒，15 条要求，覆盖 33%，未知≥60% 不展示总分；收到 done 后连接 0 秒内关闭（curl exit 0） |
| 进度百分比 | 同上（analysis 27） | `5 → 25 →(心跳) 28 → 31 → 34 → 95 → done` |
| 流式错误分支 | 空 `jobIds` / 岗位不存在 / job 85 | 前两者 `event: error` + 可读提示；job 85 `progress → done{status:blocked}`；均无 500 且立即结束连接 |
| PDF 解析预览 | `POST /api/documents/parse`（真实 6 页 PDF） | 文字层 854 字（142/页 → thin）→ 自动 OCR → **5712 字 / 952 每页 / ok / method=ocr**，8.1 秒 |
| 真实简历复核（11-02） | `node scripts/parse-check.mjs "<简历>.pdf"` → 8788 | 约 2 千字 / 2 页 / 989 字每页 / ok / method=text / 1.2 秒，无 OCR；命中工作经历与至今年限；`estimateResumeYears` = 2.5 年；新文档入库，残缺旧记录已删 |
| 预览确认入库 | `POST /api/documents {content,parseMeta}` | `parseMeta` 持久化并在 `GET /api/documents` 原样返回 |
| 定时采集（诊断后） | `data/scheduler.log` + `scheduleLastRun` | 见 §2.7：输出实时入日志、看门狗 10 分钟、上限 90 分钟、失败原因可读 |
| 手动全量采集（真实） | `POST /api/scheduler/run` | 12:22→12:48 **26 分钟**，进度 `已完成 45/45 条 JD（含详情）`，导入 **新增 6 / 更新 109 / 跳过 290**，`lastRun.ok=true` |
| 看门狗生效 | 11:46 那次（旧代码缓冲导致无输出） | 10 分钟无输出被终止并记录可读原因；随后加 `python3 -u` 修复 |
| 旧服务端兼容 | 8787 | `/analyze/stream`、`/documents/parse` 均 404；前端自动回退到 `/api/analyze`（旧接口需 `documentId`）与旧上传路径 |
| UI | `node scripts/ui-check.mjs` | 各状态记录正常渲染，桌面表格/移动单列（390px→1 列）；**控制台 0 错误** |
| 流程 | `node scripts/ui-flow-check.mjs` | 采纳 → 生成 → 跳转简历页全链路成功 |
| AI 连通性 | `npm run ai:check` | 可用模型 `deepseek-flash`、`deepseek-v4-pro`；对话 ~1.2s；JSON 模式可用 |
| 早期真实分析 | `POST /api/analyze {jobIds:[165]}` / `{[165,163]}` | analysis 18：35s/10 条要求/84 分；analysis 16：185s/25 条要求/逐岗建议，部分失败合并正常 |
| 补充回答 | `POST /api/analyses/17/answers` | 学历证据来源变「用户补充回答-Q1」，3 条判断被标记更新，已答问题归档不重复问 |
| 输入不足/质量门禁 | `jobIds:[164]`、`jobIds:[165,19]` | blocked 无分数；job 19（1394 字但只有福利+公司介绍）判 `JD_NO_STRUCTURE` 阻断 |
| 打招呼自测 | `npm run test:greeting` | **30/30 通过**（默认值/截断/非法枚举/空公司不留空引号/标签 3 个/薪资兜底/未知占位符剔除/标点清理/空行归并） |
| 打招呼字段迁移 | 导入 `db.js` 触发 `ensureColumn` | `jobs.greetedAt`、`jobs.greetingText` 已加列；job 175 写入「已打招呼 + 文案」后立即还原为「未处理 + null」，真实数据未被污染 |
| 前端构建 | `npm run build` | 40 modules，1.4s 通过（`greeting.js` 从 `src/` 外引用正常） |
| 分析回归 | `npm run test:analysis` | 65/65 仍通过 |
| 配置档案自测 | `npm run test:profile` | **26/26 通过**（未知键丢弃、Key/简历不导出、并发与 token 夹紧、非法时间丢弃、domains 去重、坏 JSON 可读报错） |
| 配置档案链路 | `GET/PUT /api/profile` | 生成 `config.local.json`（4 块配置、无 Key），重启日志出现「已应用 config.local.json」，文件未被 git 跟踪 |

**已修复的真实报错**
- `AI 返回内容为空（{"finish_reason":"length",...,"reasoning_tokens":6000}）` → 思考耗尽输出预算；thinking 控制 + 提高 maxTokens + 重试
- `Q1..Q5` ID 跨轮次不稳定导致答案挂错问题 → 改按问题文本归属（历史错配 analysis 15 已删）
- `resumeYears` 多岗合并时丢失 → `mergeAnalyses` 透传
- 定时任务重启重复补跑 → 开始即落盘当天标记；手动跑过也不再补跑
- **SSE 响应永不结束**：原用 `req.on('close')` 判断断开（请求体读完即触发），`finally` 跳过 `res.end()`，curl 实测挂死无 exit → 改 `res.on('close')` 只清心跳 + `finally` 无条件 `res.end()`
- 采集日志全丢 + python 缓冲 → `python3 -u` + 逐行落盘

## 6. 尚未解决 / 已知限制

1. **模型输出方差**：同一岗位两次分析分数 84~98 波动，要求命名与拆分粒度会变；判断变化匹配依赖相似度阈值（0.5），偶有漏判
2. **并发与进度边界**：默认 2 并发（2 岗约 1 分钟），3 并发更依赖配额可能 429；共性提炼仍是前置串行；SSE 无断线续传，刷新页面丢进度（服务端仍会跑完并落库）；单岗进度只有心跳递增（非真实百分比）
3. **2 个岗位 JD 永久缺失**（job 85/87）
4. **Mac 休眠会冻结定时器**：11-02 的 45 分钟超时被拖到 61 分钟墙钟；长时间采集建议保持不休眠（已加 90 分钟上限 + 10 分钟无输出看门狗兜底）
5. `seed.js` 为无引用死文件（用户曾取消删除）
6. 旧接口 `POST /api/rewrite` 保留（AI 整篇改写），与新「采纳后生成」并行，未统一
7. 基础模式对无小标题长 JD 切分较粗；`JD_NO_STRUCTURE` 对「只有公司介绍」的 JD 是刻意阻断
8. 分析历史仅存本地 SQLite，无导出；`data/` 不入库
9. 端口 8787 仍是旧代码（用户要求不覆盖原链接）：没有 `/analyze/stream`、`/documents/parse`，前端已做 404 回退（能用但无进度/无预览）
10. **OCR 限制**：仅 macOS（Swift + Vision）；首次编译约 7 秒（之后走 `data/bin/pdf-ocr`），实测 6 页约 8 秒、上限 15 页；文字层「有字但串码/顺序错」时字符数够多不会自动 OCR，需人工看预览；扫描件表格/图注顺序可能错乱
11. **旧残缺简历记录（91 字）已于 11-02 删除并重新入库完整版本**；该文档上的历史分析结果仅供参考
12. **`/api/documents/parse` 每次预览都会把原文件落到 `data/uploads/`**，用户放弃入库也会留副本（多次预览会堆重复文件，需人工清理）
13. 采集耗时长：全量 45 条详情约 26 分钟，期间专用 Chrome 不能关；页面加载/风控随机性会让耗时波动
14. **11-05 09:00 定时采集失败（0 条，新增 0）**：定时器被 Mac 休眠冻结 → 10:27 才真正启动；之后 3 页各卡满 60 分钟（`未捕获到页面自身的搜索响应`）→ 触发 90 分钟上限被杀。日志时间戳 10:44/11:44/12:44 即三次页级超时。判断为专用 Chrome 休眠/无响应而非代码问题：事后 12:50 查 CDP 9222 正常返回 Chrome 156。**下次遇到先看 Chrome 是否被系统挂起（合盖/睡眠）**
15. **打招呼功能需重启 8788 才生效**（本次只改了代码并构建 `dist/`，旧进程仍跑旧代码）；且按设计不自动发消息，最后一步靠人在 Boss 页面粘贴发送

## 7. 下一步建议（按优先级）

> 原第 1 项「复核真实简历解析」已于 2026-11-02 完成（见 §2.6 末尾），id=3 已删。

1. 用真实 Key 多跑 5~10 个岗位，抽样核对「证据引用是否正确 / 是否有编造数字 / 表达缺口判定是否准确」，必要时调提示词与相似度阈值；建议统一用新的 `resumeDocId=7` 跑
2. 清理 `seed.js` 与样例数据（文档 4/5、样例分析 6；岗位 164/165 已不在库），或提供「一键清除样例数据」
3. 归并两套改简历入口：`/api/rewrite` 与 `/api/resumes/from-analysis`
4. 增加「分析结果导出 Markdown/PDF」「按岗位筛选历史分析」
5. 补充回答（`/api/analyses/:id/answers`）多岗重算同样数分钟，可复用 SSE 进度方案
6. 采集侧可选增强：定时任务固定「全量详情」后若岗位数增长到 60+，考虑分批（每批 20 条 + 断点续抓）或把详情抓取放到独立进程
7. `/api/documents/parse` 改为「确认入库时才落盘原文件」，避免预览阶段堆副本
8. 打招呼可加「按 JD 关键词微调一句」的可选 AI 能力（需明确标注为 AI 生成、且只引用简历已有事实）；也可考虑把「已打招呼」与投递状态合并成统一时间线

## 8. 常用命令

```bash
cd <项目目录>

# 启动（当前使用 8788，避免覆盖 8787 原链接）
PORT=8788 node server.js

# 构建前端（改 src/ 后必须执行）+ 后端改动需重启 8788
npm run build

# 测试 / 自检
npm run test:analysis        # 65 条离线断言
npm run ai:check             # 校验 Key、模型、JSON 模式

# 采集（手动 = 全量含详情；进度看 /api/scheduler 的 progress）
curl -X POST localhost:8788/api/scheduler/run
curl -s localhost:8788/api/scheduler | python3 -m json.tool   # running/progress/lastRun
tail -f data/scheduler.log                                    # 采集器实时输出

# JD 回填
curl -X POST localhost:8788/api/jobs/backfill-details -H 'Content-Type: application/json' -d '{"deep":true}'

# 上传解析自测（PDF 文字层→OCR）
curl -X POST localhost:8788/api/documents/parse -H 'Content-Type: application/json' -d '{"fileBase64":"...","fileName":"x.pdf"}'

# UI 验收（需本地 Chrome）
node scripts/ui-check.mjs
node scripts/ui-flow-check.mjs

# 重新编译 OCR 二进制（脚本改动后会自动重编译，手动验证用）
swiftc -O scripts/pdf-ocr.swift -o data/bin/pdf-ocr
```

## 9. 接手注意

- **密钥**：`./.env`（`AI_API_KEY` / `AI_API_BASE` / `AI_MODEL`），已 gitignore；不要在文档、日志、提交中输出，对外分享前轮换
- **数据库**：`data/workbench.db`（真实岗位/分析/简历版本；今日采集后岗位数已增长）；`data/` 不入库，迁移需手动拷贝
- **服务进程**：8788 为当前版本且 `dist` 已同步；8787 是用户原链接（旧代码，PID 59086），重启前先确认意图
- **改动后**：前端 `npm run build`；后端改 `server.js/scheduler.js/analysis.js/pdftext.js` 必须重启 8788
- **采集依赖**：专用 Chrome 已登录 zhipin.com（CDP 9222，profile `~/.boss-zhipin-scraper/chrome-profile`）；登录过期会在设置页显示「登录态失效」；`python3 -u` 不可去掉（否则进度与日志延迟、会被看门狗误杀）
- **分析落点**：提示词/规则 `analysis.js`（`SYSTEM_PROMPT`、`SCHEMA_HINT`、`validateAnalysis`、`computeScore`）；运行参数 `DEFAULT_TUNING/normalizeTuning`（`settings.analysisTuning`）；接口 `server.js`（`resolveAnalyzeInput`/`persistAnalysis`）；展示 `src/Analyze.jsx`；流解析 `src/api.js#apiStream`
- **前端分析调用**：必须走 `apiStream('/analyze/stream')`，直接调 `/api/analyze` 会退回无进度的长时间等待
- **上传解析落点**：`pdftext.js`（阈值 `assessText`：<120 字/页 → low，<200 → thin；OCR 替换条件 `ocrCleanBetter` ≥1.3 倍）+ `scripts/pdf-ocr.swift`
- **采集落点**：`scheduler.js`（`runCollectOnce` / `spawnCollect` / `updateProgressFromLine` / `describeFail` / `tick` 的补跑判定）；设置页 `src/Settings.jsx` 采集卡片
- **本地文件**：`data/uploads/` 存上传原文件（可删）；`data/bin/pdf-ocr` 为 swiftc 产物（源码更新会自动重编译）
