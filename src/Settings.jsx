import React, { useEffect, useState } from 'react'
import { api, fmtTime } from './api.js'
import { DEFAULT_GREETING, GREETING_PLACEHOLDERS, renderGreeting } from '../greeting.js'

/* 预览用的假岗位：只用来展示模板渲染效果，不写入任何数据 */
const DEMO_JOB = { title: 'AI 产品经理', company: '某科技有限公司', city: '深圳', salaryText: '20-35K', tags: ['AI', 'C端'] }

export default function Settings({ settings, reload, toast }) {
  const [form, setForm] = useState({
    apiBase: settings?.apiBase || '', model: settings?.model || '', apiKey: '',
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [sched, setSched] = useState(null)
  const [schedBusy, setSchedBusy] = useState(false)
  const [tuning, setTuning] = useState({
    thinking: 'low', concurrency: 2, maxTokens: 16000, timeoutSec: 120,
    ...(settings?.analysis || {}),
  })
  const [tuningBusy, setTuningBusy] = useState(false)
  const [greeting, setGreeting] = useState({ ...DEFAULT_GREETING, ...(settings?.greeting || {}) })
  const [greetingBusy, setGreetingBusy] = useState(false)

  useEffect(() => {
    api('/scheduler').then(setSched).catch(() => {})
  }, [])

  // 采集期间轮询进度（完成多少条 JD）
  useEffect(() => {
    if (!sched?.running) return undefined
    const timer = setInterval(() => {
      api('/scheduler').then(setSched).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [sched?.running])
  useEffect(() => { if (settings?.analysis) setTuning(settings.analysis) }, [settings])

  const rules = settings?.analysisRules || { concurrency: { min: 1, max: 3 }, maxTokens: { min: 2000, max: 32000 }, timeoutSec: { min: 30, max: 300 } }
  const setTune = (k, v) => setTuning(t => ({ ...t, [k]: v }))

  const saveTuning = async () => {
    setTuningBusy(true)
    try {
      const r = await api('/settings', { method: 'PUT', body: { analysis: tuning } })
      if (r.analysis) setTuning(r.analysis)
      reload(); toast('分析参数已保存，下次分析生效')
    } catch (e) { toast(e.message, 'err') }
    setTuningBusy(false)
  }

  if (!settings) return null
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    try {
      await api('/settings', { method: 'PUT', body: form })
      reload()
      toast('设置已保存')
      setForm(f => ({ ...f, apiKey: '' }))
      setTestResult(null)
    } catch (e) { toast(e.message, 'err') }
  }

  const clearKey = async () => {
    try {
      await api('/settings', { method: 'PUT', body: { clearKey: true } })
      reload(); toast('已清除 API Key')
    } catch (e) { toast(e.message, 'err') }
  }

  const test = async () => {
    setTesting(true); setTestResult(null)
    try {
      const r = await api('/settings/test', { method: 'POST' })
      setTestResult({ ok: true, text: `连接成功，耗时 ${r.latency}ms` })
    } catch (e) {
      setTestResult({ ok: false, text: e.message })
    }
    setTesting(false)
  }

  const setG = (k, v) => setGreeting(g => ({ ...g, [k]: v }))
  const placeholderList = settings?.greetingPlaceholders || GREETING_PLACEHOLDERS
  const saveGreeting = async () => {
    setGreetingBusy(true)
    try {
      const r = await api('/settings', { method: 'PUT', body: { greeting } })
      if (r.greeting) setGreeting(r.greeting)
      reload(); toast('打招呼配置已保存')
    } catch (e) { toast(e.message, 'err') }
    setGreetingBusy(false)
  }
  const resetGreeting = async () => {
    setGreetingBusy(true)
    try {
      const r = await api('/settings', { method: 'PUT', body: { greeting: settings.greetingDefaults || DEFAULT_GREETING } })
      if (r.greeting) setGreeting(r.greeting)
      reload(); toast('已恢复默认打招呼文案')
    } catch (e) { toast(e.message, 'err') }
    setGreetingBusy(false)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">⚙️ 设置</div>
          <div className="page-sub">配置 AI 服务后，JD 分析与简历改写将使用大模型深度语义分析</div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>AI 服务（OpenAI 兼容接口）</div>
        <div className={'callout ' + (settings.ready ? 'ok' : 'warn')} style={{ marginBottom: 16 }}>
          {settings.ready
            ? `当前为「智能模式」：JD解析、匹配分析、共性提炼、简历改写均由大模型驱动。${settings.keySource === 'env' ? '（Key 来自环境变量 AI_API_KEY，优先级高于本页配置）' : ''}`
            : '当前为「基础文本检查」（未配置 Key）：只做 JD 要求提取与词语覆盖，不生成语义匹配结论、能力判断或简历改写。'}
        </div>
        {settings.keySource === 'env' && (
          <div className="callout info" style={{ marginBottom: 12 }}>
            已检测到环境变量 <code className="kbd">AI_API_KEY</code>，Key 不会写入数据库；本页的 Key 输入将被忽略。
            修改环境变量后需重启服务生效。
          </div>
        )}
        <div className="field">
          <label>API Base URL</label>
          <input className="input" value={form.apiBase} onChange={e => set('apiBase', e.target.value)}
            placeholder={settings.defaults.apiBase} />
          <div className="hint">OpenAI 兼容接口均可：智谱 <code className="kbd">https://open.bigmodel.cn/api/paas/v4</code> ·
            Z.AI <code className="kbd">https://api.z.ai/api/paas/v4</code> ·
            DeepSeek <code className="kbd">https://api.deepseek.com</code> ·
            OpenAI <code className="kbd">https://api.openai.com/v1</code> · 本地 Ollama <code className="kbd">http://localhost:11434/v1</code></div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>模型名称</label>
            <input className="input" list="model-options" value={form.model} onChange={e => set('model', e.target.value)}
              placeholder={settings.defaults.model} />
            <datalist id="model-options">
              <option value="deepseek-flash">DeepSeek V4.1 Flash（官方推荐）</option>
              <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
              <option value="glm-4.6">智谱 GLM-4.6</option>
              <option value="gpt-4o-mini">OpenAI gpt-4o-mini</option>
              <option value="qwen-plus">通义 qwen-plus</option>
            </datalist>
            <div className="hint">DeepSeek 官方模型 ID：<code className="kbd">deepseek-flash</code>（即 V4.1-Flash）、<code className="kbd">deepseek-v4-pro</code>。旧的 deepseek-chat / reasoner 已弃用。</div>
          </div>
          <div className="field">
            <label>
              API Key
              {settings.hasKey && <span className="tag green">已配置</span>}
              {settings.keySource === 'env' && <span className="tag blue">环境变量</span>}
            </label>
            <input className="input" type="password" value={form.apiKey}
              disabled={settings.keySource === 'env'}
              onChange={e => set('apiKey', e.target.value)}
              placeholder={settings.keySource === 'env' ? '由环境变量 AI_API_KEY 提供' : (settings.hasKey ? '已保存（留空则不修改）' : 'sk-…')} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={save}>保存设置</button>
          <button className="btn" disabled={testing} onClick={test}>{testing ? <span className="spin" /> : '🔌'} 测试连接</button>
          {settings.hasKey && <button className="btn danger" onClick={clearKey}>清除 Key</button>}
          {testResult && <span className={'tag ' + (testResult.ok ? 'green' : 'red')}>{testResult.text}</span>}
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>分析参数</div>
        <div className="hint" style={{ marginBottom: 14 }}>
          只影响 JD 分析（含多岗位并发与进度）。推理模型会把思考 token 算进输出预算，输出被截断时优先提高「最大输出」或把思考改为「关闭」。
        </div>
        <div className="form-row">
          <div className="field">
            <label>思考强度</label>
            <select className="select" value={tuning.thinking} onChange={e => setTune('thinking', e.target.value)}>
              <option value="low">低（默认，判断质量更好）</option>
              <option value="off">关闭（更快更省，不发送思考）</option>
            </select>
            <div className="hint">关闭后模型直接作答，适合输出容易被思考挤占的模型（如 DeepSeek）。</div>
          </div>
          <div className="field">
            <label>多岗位并发数</label>
            <input className="input" type="number" min={rules.concurrency.min} max={rules.concurrency.max}
              value={tuning.concurrency} onChange={e => setTune('concurrency', +e.target.value || 1)} />
            <div className="hint">范围 {rules.concurrency.min}~{rules.concurrency.max}；2~3 个岗位并发约可缩短一半耗时，但会同时占用模型配额。</div>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>单岗最大输出 token</label>
            <input className="input" type="number" min={rules.maxTokens.min} max={rules.maxTokens.max} step="1000"
              value={tuning.maxTokens} onChange={e => setTune('maxTokens', +e.target.value || rules.maxTokens.min)} />
            <div className="hint">默认 16000。出现「AI 返回内容为空 / finish_reason=length」时可适当提高。</div>
          </div>
          <div className="field">
            <label>单岗超时（秒）</label>
            <input className="input" type="number" min={rules.timeoutSec.min} max={rules.timeoutSec.max} step="10"
              value={tuning.timeoutSec} onChange={e => setTune('timeoutSec', +e.target.value || rules.timeoutSec.min)} />
            <div className="hint">超时后该岗位判为失败，可在分析页重试。</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={tuningBusy} onClick={saveTuning}>{tuningBusy ? <span className="spin" /> : '保存分析参数'}</button>
          <button className="btn" disabled={tuningBusy} onClick={async () => {
            try {
              const r = await api('/settings', { method: 'PUT', body: { analysis: settings.analysisDefaults } })
              if (r.analysis) setTuning(r.analysis)
              reload(); toast('已恢复默认分析参数')
            } catch (e) { toast(e.message, 'err') }
          }}>恢复默认</button>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>👋 打招呼</div>
        <div className="hint" style={{ marginBottom: 14 }}>
          岗位库里的「打招呼」按钮用它生成文案：复制到剪贴板 → 打开原岗位页 → 你点「立即沟通」粘贴发送。
          只拼接下面这些你填的字段和岗位信息，不调用 AI、不臆造经历。
        </div>
        <div className="form-row">
          <div className="field">
            <label>我的称呼</label>
            <input className="input" value={greeting.name} onChange={e => setG('name', e.target.value)} placeholder="如：你的名字" />
          </div>
          <div className="field">
            <label>经验说法</label>
            <input className="input" value={greeting.years} onChange={e => setG('years', e.target.value)} placeholder="如：近2年" />
            <div className="hint">面试官能核实的说法，建议与简历一致（如「近2年」「3年」）。</div>
          </div>
        </div>
        <div className="field">
          <label>一句话亮点（可留空）</label>
          <textarea className="input" rows={2} value={greeting.highlight} onChange={e => setG('highlight', e.target.value)}
            placeholder="如：主导过系统级音频与文件产品，从用户洞察到跨团队落地全流程" />
          <div className="hint">写简历里已经有的成果，不要写没做过的方向。</div>
        </div>
        <div className="field">
          <label>文案模板</label>
          <textarea className="input" rows={5} value={greeting.template} onChange={e => setG('template', e.target.value)} />
          <div className="hint">
            可用占位符（没值的会自动留空，不会出现空的「」或括号）：
            {placeholderList.map(p => (
              <code key={p.key} className="kbd" style={{ marginLeft: 6, cursor: 'pointer' }}
                title={p.label} onClick={() => setG('template', `${greeting.template}${p.key}`)}>{p.key}</code>
            ))}
          </div>
        </div>
        <div className="field">
          <label>渲染预览（示例岗位：{DEMO_JOB.company} · {DEMO_JOB.title}）</label>
          <div className="greet-preview">{renderGreeting(greeting, DEMO_JOB)}</div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>打招呼后状态</label>
            <select className="select" value={greeting.markStatus} onChange={e => setG('markStatus', e.target.value)}>
              <option value="已打招呼">标记为「已打招呼」</option>
              <option value="待投递">标记为「待投递」</option>
              <option value="不修改">不改状态</option>
            </select>
            <div className="hint">只对「未处理 / 不感兴趣」生效，不会覆盖已投递、面试中、offer 等进度。</div>
          </div>
          <div className="field">
            <label>点击后的动作</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 13.5 }}>
              <input type="checkbox" checked={greeting.autoCopy} onChange={e => setG('autoCopy', e.target.checked)} />
              自动复制文案到剪贴板
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 13.5 }}>
              <input type="checkbox" checked={greeting.openPage} onChange={e => setG('openPage', e.target.checked)} />
              同时打开原岗位页面
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 13.5 }}>
              <input type="checkbox" checked={greeting.preview} onChange={e => setG('preview', e.target.checked)} />
              先预览/改文案再发送（关闭为真正一键）
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={greetingBusy} onClick={saveGreeting}>
            {greetingBusy ? <span className="spin" /> : '保存打招呼配置'}
          </button>
          <button className="btn" disabled={greetingBusy} onClick={resetGreeting}>恢复默认文案</button>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>数据存储</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.9 }}>
          所有数据（岗位库、信息库、分析记录、简历版本、设置）都保存在本机项目目录 <code className="kbd">job-workbench/data/</code> 下
          （SQLite 数据库 + uploads 文件），不上传任何第三方服务器。AI 调用时，仅会把你主动选择的岗位JD与资料文本发送给你配置的 AI 服务商。
        </div>
      </div>

      <div className="card card-pad">
        <div className="sec-title" style={{ marginTop: 0 }}>岗位采集</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.9 }}>
          采集结果目录：<code className="kbd">{settings.scraperDir}</code>
          <div style={{ marginTop: 6 }}>
            工作台会自动读取该目录下的 <code className="kbd">boss_jobs_*.json</code> 与 <code className="kbd">boss_details_*.json</code>。
            使用方法见「岗位库 → 采集指南」。
          </div>
        </div>
      </div>

      {sched && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="sec-title" style={{ marginTop: 0 }}>⏰ 每日定时采集（Boss直聘）</div>
          <div className={'callout ' + (sched.enabled ? 'ok' : 'warn')} style={{ marginBottom: 16 }}>
            {sched.enabled
              ? <>已启用：每天 <b>{sched.time}</b> 自动运行采集器抓取最新岗位（含JD详情），完成后自动导入岗位库并补齐缺失正文。需保持本服务在运行，且已完成采集器的 Chrome 登录配置（见「岗位库 → 采集指南」）。若当天 9 点服务未运行，启动后会自动补跑当天任务。</>
              : '当前已停用定时采集，可开启后每天自动刷新岗位库。'}
          </div>
          <div className="form-row">
            <div className="field">
              <label>启用定时采集</label>
              <select className="select" value={sched.enabled ? '1' : '0'}
                onChange={e => setSched({ ...sched, enabled: e.target.value === '1' })}>
                <option value="1">每天定时采集</option>
                <option value="0">停用</option>
              </select>
            </div>
            <div className="field">
              <label>采集时间</label>
              <input className="input" type="time" value={sched.time}
                onChange={e => setSched({ ...sched, time: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>城市</label>
              <input className="input" value={sched.city} onChange={e => setSched({ ...sched, city: e.target.value })} />
            </div>
            <div className="field">
              <label>岗位关键词</label>
              <input className="input" value={sched.keyword} onChange={e => setSched({ ...sched, keyword: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>经验要求代码</label>
              <select className="select" value={sched.experience} onChange={e => setSched({ ...sched, experience: e.target.value })}>
                <option value="101">不限</option>
                <option value="103">1年内</option>
                <option value="104">1-3年</option>
                <option value="105">3-5年</option>
                <option value="106">5-10年</option>
              </select>
            </div>
            <div className="field">
              <label>学历要求代码</label>
              <select className="select" value={sched.degree} onChange={e => setSched({ ...sched, degree: e.target.value })}>
                <option value="202">大专</option>
                <option value="203">本科</option>
                <option value="204">硕士</option>
              </select>
            </div>
            <div className="field">
              <label>抓取页数（最多10）</label>
              <input className="input" type="number" min="1" max="10" value={sched.pages}
                onChange={e => setSched({ ...sched, pages: +e.target.value || 3 })} />
            </div>
            <div className="field">
              <label>定时采集的详情数量</label>
              <input className="input" type="number" min="0" max="50" value={sched.maxDetails ?? 0}
                onChange={e => setSched({ ...sched, maxDetails: +e.target.value || 0 })} />
              <div className="hint">0 = 全部（默认）。每个详情约 25~50 秒；手动「立即运行」始终抓全部详情。</div>
            </div>
          </div>
          {sched.running && (() => {
            const p = sched.progress || {}
            const total = p.total || p.listCount || 0
            const pct = total ? Math.min(100, Math.round((p.done || 0) / total * 100)) : 4
            return (
              <div style={{ margin: '4px 0 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="spin dark" />
                  <b>采集中</b>
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}>{p.message || '准备中…'}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    已完成 {p.done || 0}/{total || '?'} 条 JD
                  </span>
                </div>
                <div className="an-progress-bar" style={{ marginTop: 6 }}>
                  <i style={{ width: `${Math.max(4, pct)}%`, transition: 'width .4s ease' }} />
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  1 条 JD = 列表基础数据 + 详情正文；详情逐条抓取（每条约 25~50 秒），进度每 3 秒刷新。
                </div>
              </div>
            )
          })()}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={schedBusy}
              onClick={async () => {
                setSchedBusy(true)
                try { setSched(await api('/scheduler', { method: 'PUT', body: sched })); toast('定时采集配置已保存') }
                catch (e) { toast(e.message, 'err') }
                setSchedBusy(false)
              }}>保存配置</button>
            <button className="btn" disabled={schedBusy || sched.running}
              onClick={async () => {
                setSchedBusy(true)
                try {
                  const r = await api('/scheduler/run', { method: 'POST' })
                  toast(r.skipped ? r.reason
                    : (r.ok ? `采集完成：${r.progress?.done || 0} 条 JD（含详情），已自动导入岗位库`
                      : `采集失败：${r.collect?.error || r.error || '未知错误'}`), r.ok ? undefined : 'err')
                  setSched(await api('/scheduler'))
                } catch (e) { toast(e.message, 'err') }
                setSchedBusy(false)
              }}>{sched.running
                ? `采集中…（${sched.progress?.done || 0}/${sched.progress?.total || sched.progress?.listCount || '?'} 条 JD）`
                : '▶ 立即运行一次（全量含详情）'}</button>
            {sched.lastRun && (
              <span className="tag" title={JSON.stringify(sched.lastRun.import || {})}>
                上次运行：{fmtTime(sched.lastRun.at)}（{sched.lastRun.reason === 'schedule' ? '定时' : '手动'}，
                {sched.lastRun.ok ? '成功' : '失败'}
                {sched.lastRun.progress?.done ? `，${sched.lastRun.progress.done} 条 JD` : ''}）
              </span>
            )}
          </div>
          {sched.lastRun && !sched.lastRun.ok && (sched.lastRun.error || sched.lastRun.collect?.error) && (
            <div className="callout warn" style={{ marginTop: 10 }}>
              <b>上次失败原因：</b>{sched.lastRun.error || sched.lastRun.collect?.error}
              {(sched.lastRun.collect?.progress || []).length > 0 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  失败前最后输出：<code className="kbd">{(sched.lastRun.collect.progress.slice(-2).join(' ⏎ ')).slice(0, 240)}</code>
                </div>
              )}
            </div>
          )}
          <div className="hint" style={{ marginTop: 10 }}>
            采集依赖登录态：登录过期会明确提示重新执行 <code className="kbd">--setup-chrome</code> 登录。
            采集器输出会实时写入 <code className="kbd">{sched.logFile}</code>；总时长上限 60 分钟，连续 10 分钟无输出会被判定卡死并终止。
          </div>
        </div>
      )}
    </div>
  )
}
