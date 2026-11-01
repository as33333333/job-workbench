# 求职工作台

本地运行的求职全流程工具：**岗位库 → JD匹配分析 → AI智能改简历 → 信息库**。数据全部存本机（SQLite），不上传第三方。

## 快速开始

```bash
cd job-workbench
npm install        # 已安装可跳过
npm run build      # 构建前端（已构建可跳过）
npm start          # 启动，访问 http://localhost:8787
```

首次启动自动载入 10 条示例岗位（虚构公司），可直接体验筛选/分析全流程；正式使用前可删除示例。

## 四大功能

### 1️⃣ 岗位库
- **筛选**：岗位关键词（默认产品经理）、城市（默认深圳）、经验（社招3年内）、薪资下限（默认15K）、最新发布在前
- **导入岗位（4种方式）**：
  - 📋 **粘贴JD**：在 Boss直聘/脉脉 岗位页全选复制，粘贴即自动解析字段（有 AI Key 时语义解析，否则规则解析）
  - 🤖 **采集结果**：一键导入 [boss-zhipin-scraper](https://github.com/eatmoreduck/boss-zhipin-scraper) 的输出（见下文）
  - 📦 **JSON/CSV**：其他采集工具导出文件，字段自动映射，按链接/公司+岗位去重
  - 🔗 **链接导入**：尽力抓取（多数招聘站有登录墙，失败就用粘贴）
- **收藏**（★）、**一键投递**（标记投递状态并跳转原岗位页）、投递状态跟踪（未处理/已投递/面试中/offer）

### 2️⃣ JD匹配分析
- 从岗位库**单选或多选**岗位 + 从信息库选一份你的资料（简历/项目文档）
- 输出：匹配度评分、匹配亮点、差距分析（分级+弥补建议）、**建议补齐的知识**、**简历重点描写方向**、**简历具体修改建议**
- 多选时额外提炼**跨岗位共性要求**（核心/重要/加分权重），作为后续建议与改简历的输入
- 历史分析记录可回看

### 3️⃣ AI智能改简历
- 承接分析页选中的岗位：单选=针对性改写，多选=按共性要求改写
- 以面试官视角重排与润色（严格基于真实经历，不编造），输出 Markdown 简历 + 逐条改动说明
- **手动编辑**：双栏对照（编辑/预览），保存、复制全文、下载 .md、打印成 PDF、版本历史

### 4️⃣ 信息库
- 上传文件（PDF/DOCX/TXT/MD ≤20MB）、粘贴文本、在线链接抓取
- 资料分类（简历/项目文档/工作成果/笔记），供分析与改简历引用

## AI 配置（推荐）

「设置」页配置任意 OpenAI 兼容接口：智谱 / Z.AI / DeepSeek / OpenAI / 本地 Ollama。配置后解锁：JD 语义解析、深度匹配分析、共性提炼、AI 改简历。未配置时为**简易模式**（关键词级匹配，功能可体验但深度有限）。

## 对接 boss-zhipin-scraper 采集 Boss直聘 JD

> 克隆本仓库后，需先把采集器克隆到 `collector/` 目录（本仓库不含第三方采集器代码）：
> ```bash
> mkdir -p collector && git clone --depth 1 https://github.com/eatmoreduck/boss-zhipin-scraper.git collector/boss-zhipin-scraper
> pip3 install -r collector/boss-zhipin-scraper/requirements.txt
> ```

工作台已内置对接（依赖装好后）：

```bash
# ① 首次：创建专用Chrome并登录你的Boss账号（仅一次）
cd collector/boss-zhipin-scraper
python3 scripts/boss_cdp_raw.py --setup-chrome

# ② 采集：深圳·产品经理·1-3年·本科（也可用 npm run collect）
python3 scripts/boss_cdp_raw.py --city 深圳 --keyword 产品经理 --experience 104 --degree 203
# 经验码: 101不限 103<1年 104=1-3年 105=3-5年 106=5-10年；学历码: 202大专 203本科 204硕士

# ③ 回工作台「导入岗位→采集结果」一键入库（自动合并JD详情、按job_id去重）
```

原理：Chrome CDP 复用你本人登录态，被动捕获页面自身 API 响应，输出至 `~/.boss-zhipin-scraper/job-result/`。

**风险与边界**：采集仅供个人求职研究，请控制频率，自行评估平台条款合规性，勿商用转售。脉脉无成熟采集器，用「粘贴JD」导入。真实批量投递可配合 [Ocyss/boss-helper](https://github.com/Ocyss/boss-helper) 浏览器插件；本工作台的「一键投递」做状态登记+跳转。

## 技术栈与结构

- 后端：Node 22（内置 SQLite，零原生依赖）+ Express
- 前端：React 18 + Vite，构建产物由后端静态服务
- `server.js` API与静态服务 ｜ `db.js` 数据层 ｜ `ai.js` AI提示词与调用+简易模式 ｜ `seed.js` 示例数据
- 数据目录：`data/workbench.db`（岗位/资料/分析/简历版本/设置全在里面，删库重置）

## 常用命令

```bash
npm start          # 启动服务 http://localhost:8787
npm run dev        # 前端开发模式（热更新，需另起 npm start）
npm run build      # 构建前端
npm run collect    # 运行采集（CITY/KEYWORD/EXP/DEGREE 环境变量可覆盖）
CITY=北京 KEYWORD=AI产品 npm run collect   # 示例
```
