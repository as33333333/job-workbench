import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime, fmtSalary, expLabel, copyText } from './api.js'
import { Modal, Empty } from './common.jsx'

const DEFAULT_FILTERS = { query: '产品经理', city: '深圳', exp: 'social3', salary: 15, view: 'all', sort: 'published', domains: [] }
const EXP_OPTIONS = [
  { v: 'any', label: '经验不限' },
  { v: 'social3', label: '社招 · 3年内' },
  { v: 'social5', label: '社招 · 5年内' },
  { v: 'socialAny', label: '社招 · 不限' },
  { v: 'fresh', label: '应届 / 校招' },
  { v: 'intern', label: '实习' },
]
const SALARY_OPTIONS = [0, 10, 15, 20, 25, 30, 40]
const STATUS_TAG = { 未处理: '', 已打招呼: 'green', 待投递: 'orange', 已投递: 'blue', 面试中: 'purple', offer: 'green', 不感兴趣: '' }
const APPLIED_STATUS = ['已打招呼', '待投递', '已投递', '面试中', 'offer']

/* 岗位业务分类：按 标题/标签/JD前段 关键词规则匹配，一个岗位可命中多个分类 */
const DOMAIN_RULES = [
  ['AI/大模型', /(\bai\b|人工智能|大模型|llm|gpt|aigc|agent|智能体|机器学习|deepseek|chatgpt)/i],
  ['电商/跨境', /(电商|跨境|亚马逊|amazon|shopee|tiktok shop|店铺|卖家|listing)/i],
  ['用户产品', /(用户产品|c端|社区|内容|增长|会员|直播|短视频|feed|小程序)/i],
  ['B端/SaaS', /(b端|saas|erp|crm|中台|企业服务|tob|工作台|oa|数字化)/i],
  ['硬件', /(硬件|3c|充电|手机|穿戴|数码|耳机|音箱|摄像头|机器人|电子)/i],
  ['物联网', /(物联网|iot|智能家居|传感|智能设备)/i],
  ['金融', /(金融|支付|风控|信贷|保险|证券|银行|基金|理财|交易系统)/i],
  ['教育', /(教育|k12|学习机|课程|教研|职教|考试|青少)/i],
  ['供应链/物流', /(供应链|物流|仓储|wms|tms|采购|履约|货代|海外仓)/i],
  ['医疗健康', /(医疗|健康|医药|问诊|医生|康复|营养|口腔)/i],
  ['游戏', /(游戏|电竞|玩法|发行|mmo|rpg)/i],
  ['数据产品', /(数据产品|商业智能|数仓|报表|指标平台|数据分析平台|bi)/i],
  ['出海', /(出海|海外|国际化|global|多语言|localization)/i],
]

function jobDomains(job) {
  const text = `${job.title || ''} ${(job.tags || []).join(' ')} ${job.category || ''} ${(job.description || '').slice(0, 300)}`
  return DOMAIN_RULES.filter(([, re]) => re.test(text)).map(([name]) => name)
}

export default function Jobs({ jobs, reload, toast, selectedIds, setSelectedIds, onGotoAnalyze, profileFilters }) {
  // 优先级：本机 localStorage（你在这里改过的）> 个人配置档案 filters > 内置默认
  const [filters, setFilters] = useState(() => {
    try { return { ...DEFAULT_FILTERS, ...(profileFilters || {}), ...JSON.parse(localStorage.getItem('jobFilters') || '{}') } }
    catch { return { ...DEFAULT_FILTERS, ...(profileFilters || {}) } }
  })
  const profileApplied = useRef(!!profileFilters)
  useEffect(() => {
    if (profileApplied.current || !profileFilters) return
    profileApplied.current = true
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('jobFilters') || 'null') } catch { saved = null }
    if (!saved) setFilters(f => ({ ...f, ...profileFilters }))
  }, [profileFilters])
  const [expanded, setExpanded] = useState({})
  const [showImport, setShowImport] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [editing, setEditing] = useState(null) // null | 'new' | job对象
  const [applying, setApplying] = useState(null)
  const [greetingBusy, setGreetingBusy] = useState(null)
  const [greetingDraft, setGreetingDraft] = useState(null) // {job, text} 预览/编辑后发送

  useEffect(() => { localStorage.setItem('jobFilters', JSON.stringify(filters)) }, [filters])

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }))

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase()
    const city = filters.city.trim()
    const selDomains = filters.domains || []
    let list = jobs.filter(j => {
      if (q && !(`${j.title} ${j.category} ${(j.tags || []).join(' ')} ${j.company}`.toLowerCase().includes(q))) return false
      if (city && !(j.city || '').includes(city)) return false
      if (filters.exp === 'social3' && !(j.expMax <= 3 && j.recruitType === '社招')) return false
      if (filters.exp === 'social5' && !(j.expMax <= 5 && j.recruitType === '社招')) return false
      if (filters.exp === 'socialAny' && j.recruitType !== '社招') return false
      if (filters.exp === 'fresh' && j.recruitType !== '校招') return false
      if (filters.exp === 'intern' && j.recruitType !== '实习') return false
      if (filters.salary > 0 && !((j.salaryMin || 0) >= filters.salary)) return false
      if (filters.view === 'fav' && !j.favorite) return false
      if (filters.view === 'applied' && !APPLIED_STATUS.includes(j.status)) return false
      if (selDomains.length && !selDomains.some(d => jobDomains(j).includes(d))) return false
      return true
    })
    list = [...list].sort((a, b) => {
      if (filters.sort === 'imported') return (b.importedAt || '').localeCompare(a.importedAt || '')
      return (b.publishedAt || b.importedAt || '').localeCompare(a.publishedAt || a.importedAt || '')
    })
    return list
  }, [jobs, filters])

  /* 分类列表（全库统计命中数），用于多选筛选 */
  const domainStats = useMemo(() => {
    const counts = new Map()
    for (const j of jobs) for (const d of jobDomains(j)) counts.set(d, (counts.get(d) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [jobs])

  const toggleDomain = (d) => {
    setFilters(f => ({
      ...f,
      domains: (f.domains || []).includes(d) ? (f.domains || []).filter(x => x !== d) : [...(f.domains || []), d],
    }))
  }

  const toggleSelect = (id) => {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  const toggleFav = async (job) => {
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: { favorite: !job.favorite } })
      reload()
    } catch (e) { toast(e.message, 'err') }
  }

  const apply = async (job) => {
    if (!job.sourceUrl) { toast('该岗位没有原链接，无法跳转投递页'); return }
    setApplying(job.id)
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: { status: '待投递' } })
      window.open(job.sourceUrl, '_blank')
      toast('已打开原岗位页面。真实投递需你在Boss页面完成（含登录）；完成后回到这里点「✓ 已投递」。')
      reload()
    } catch (e) { toast(e.message, 'err') }
    setApplying(null)
  }

  const markApplied = async (job) => {
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: { status: '已投递' } })
      toast('已确认投递「' + job.title + '」')
      reload()
    } catch (e) { toast(e.message, 'err') }
  }

  /* 一键打招呼：渲染文案 → 复制到剪贴板 → 打开原岗位页 → 记录状态
   * 平台不提供可靠的聊天深链，最后一步「粘贴发送」需在 Boss 页面完成；开启「先预览」时弹窗可改文案 */
  const greet = async (job) => {
    setGreetingBusy(job.id)
    try {
      const preview = await api(`/jobs/${job.id}/greeting/preview`, { method: 'POST' })
      if (preview.config?.preview) { setGreetingDraft({ job, text: preview.text }); return }
      const sent = await api(`/jobs/${job.id}/greeting`, { method: 'POST' })
      const copied = sent.config?.autoCopy === false ? false : await copyText(sent.text)
      if (sent.config?.openPage !== false && job.sourceUrl) window.open(job.sourceUrl, '_blank')
      if (!copied) { setGreetingDraft({ job, text: sent.text }); toast('文案已生成，请手动复制（浏览器未授予剪贴板权限）', 'err'); return }
      toast(copied
        ? `已复制打招呼文案${sent.config?.openPage !== false && job.sourceUrl ? '，并打开原岗位页：点「立即沟通」后粘贴发送（⌘V）' : '，去 Boss 聊天框粘贴发送即可'}`
        : '文案已生成')
      reload()
    } catch (e) { toast(e.message, 'err') }
    finally { setGreetingBusy(null) }
  }

  const remove = async (job) => {
    if (!confirm(`确定删除岗位「${job.title} - ${job.company}」？`)) return
    try { await api(`/jobs/${job.id}`, { method: 'DELETE' }); setSelectedIds(ids => ids.filter(i => i !== job.id)); reload() }
    catch (e) { toast(e.message, 'err') }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">🗂 岗位库</div>
          <div className="page-sub">筛选 · 收藏 · 一键投递 · 勾选多个岗位去做JD匹配分析（{jobs.length} 个岗位在库）</div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setShowGuide(true)}>📖 采集指南</button>
          <button className="btn" onClick={() => setShowImport(true)}>＋ 导入岗位</button>
          <button className="btn primary" onClick={() => setEditing('new')}>✎ 手动添加</button>
        </div>
      </div>

      <div className="card filter-bar">
        <span className="filter-label">岗位</span>
        <input className="input" style={{ width: 150 }} value={filters.query} placeholder="岗位关键词"
          onChange={e => setF('query', e.target.value)} />
        <span className="filter-label">城市</span>
        <input className="input" style={{ width: 90 }} value={filters.city} placeholder="城市"
          onChange={e => setF('city', e.target.value)} />
        <span className="filter-label">经验</span>
        <select className="select" style={{ width: 130 }} value={filters.exp} onChange={e => setF('exp', e.target.value)}>
          {EXP_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <span className="filter-label">薪资≥</span>
        <select className="select" style={{ width: 100 }} value={filters.salary} onChange={e => setF('salary', +e.target.value)}>
          {SALARY_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? '不限' : `${v}K`}</option>)}
        </select>
        <select className="select" style={{ width: 130 }} value={filters.sort} onChange={e => setF('sort', e.target.value)}
          title="「最新发布」按Boss页面上的发布/更新时间排（采集数据多缺失该字段，缺失时退回按导入时间）；「最新导入」按岗位进入本岗位库的时间排">
          <option value="published">最新发布在前</option>
          <option value="imported">最新导入在前</option>
        </select>
        <button className="btn sm" onClick={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}>重置</button>
        <div style={{ display: 'flex', gap: 8, marginLeft: 4 }}>
          {[{ v: 'all', l: '全部' }, { v: 'fav', l: '⭐ 收藏' }, { v: 'applied', l: '投递跟踪' }].map(o => (
            <button key={o.v} className={'chip' + (filters.view === o.v ? ' active' : '')} onClick={() => setF('view', o.v)}>{o.l}</button>
          ))}
        </div>
        <span className="result-count">{filtered.length} 条结果</span>
      </div>

      {domainStats.length > 0 && (
        <div className="card filter-bar" style={{ marginTop: 10 }}>
          <span className="filter-label">分类</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {domainStats.map(([name, count]) => (
              <button key={name} className={'chip' + ((filters.domains || []).includes(name) ? ' active' : '')}
                onClick={() => toggleDomain(name)} title="可多选，命中任一所选分类即展示">
                {name} <span style={{ opacity: 0.65 }}>{count}</span>
              </button>
            ))}
            {(filters.domains || []).length > 0 && (
              <button className="btn sm" onClick={() => setF('domains', [])}>清除分类</button>
            )}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card">
          <Empty icon="🔍" title="没有符合条件的岗位">
            试试放宽筛选条件，或通过「导入岗位」把 Boss直聘/脉脉 的 JD 粘贴进来、
            <button className="link-btn" onClick={() => setShowImport(true)}> 立即导入</button>
          </Empty>
        </div>
      ) : (
        filtered.map(job => (
          <div key={job.id} className={'card job-card' + (selectedIds.includes(job.id) ? ' selected' : '')}>
            <div className="job-top">
              <input type="checkbox" className="job-check" checked={selectedIds.includes(job.id)}
                onChange={() => toggleSelect(job.id)} title="选中用于JD分析" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="job-title-row">
                  <span className="job-title">{job.title}</span>
                  <span className="job-company">[{job.company || '公司未知'}]</span>
                  <button className={'star-btn' + (job.favorite ? ' on' : '')} onClick={() => toggleFav(job)} title="收藏">
                    {job.favorite ? '★' : '☆'}
                  </button>
                  {job.status !== '未处理' && <span className={'tag ' + (STATUS_TAG[job.status] || '')}>{job.status}</span>}
                  {job.sourceUrl && <a className="tag blue" href={job.sourceUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>原链接 ↗</a>}
                </div>
                <div className="job-meta">
                  <span className="tag salary">💰 {fmtSalary(job)}</span>
                  <span className="tag">📍 {job.city || '未知'}</span>
                  <span className="tag">💼 {expLabel(job)}</span>
                  {job.education && <span className="tag">🎓 {job.education}</span>}
                  {job.bossActive && <span className="tag green">🟢 {job.bossActive}</span>}
                  {job.greetedAt && <span className="tag green" title={job.greetingText || ''}>👋 已打招呼 {fmtTime(job.greetedAt)}</span>}
                  <span className="tag">{job.publishedAt ? `发布 ${fmtTime(job.publishedAt)}` : `导入 ${fmtTime(job.importedAt)}`}</span>
                  <span className="tag">{job.source}</span>
                </div>
                {job.tags?.length > 0 && (
                  <div className="job-tags">
                    {jobDomains(job).slice(0, 2).map(d => <span key={d} className="tag purple">🏷 {d}</span>)}
                    {job.tags.slice(0, 8).map(t => <span key={t} className="tag blue">{t}</span>)}
                  </div>
                )}
                {job.description && (
                  <div className={'job-desc' + (expanded[job.id] ? '' : ' collapsed')}>
                    {job.description}
                  </div>
                )}
                <div className="job-actions">
                  {job.description && (
                    <button className="link-btn" onClick={() => setExpanded(s => ({ ...s, [job.id]: !s[job.id] }))}>
                      {expanded[job.id] ? '收起 ▲' : '展开JD全文 ▼'}
                    </button>
                  )}
                  <button className="btn sm" disabled={applying === job.id} onClick={() => apply(job)}
                    title="打开Boss原岗位页面完成投递（不会自动标记为已投递）">
                    {applying === job.id ? <span className="spin" style={{ width: 12, height: 12 }} /> : '🚀'} 去投递
                  </button>
                  <button className="btn sm" disabled={greetingBusy === job.id} onClick={() => greet(job)}
                    title={job.greetedAt ? '重新生成打招呼文案并复制' : '一键生成打招呼文案并复制到剪贴板，打开原岗位页后粘贴发送'}>
                    {greetingBusy === job.id ? <span className="spin" style={{ width: 12, height: 12 }} /> : '👋'} {job.greetedAt ? '重新打招呼' : '打招呼'}
                  </button>
                  {job.status === '待投递' && (
                    <button className="btn sm primary" onClick={() => markApplied(job)} title="在Boss页面实际完成投递后点此确认">
                      ✓ 确认已投递
                    </button>
                  )}
                  <button className="btn sm" onClick={() => toggleSelect(job.id)}>
                    {selectedIds.includes(job.id) ? '取消选择' : '☑ 加入分析'}
                  </button>
                  <button className="btn sm ghost" onClick={() => setEditing(job)}>编辑</button>
                  <button className="btn sm ghost danger" onClick={() => remove(job)}>删除</button>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      {selectedIds.length > 0 && (
        <div className="selection-bar">
          <span>已选 <b>{selectedIds.length}</b> 个岗位</span>
          <button className="btn primary sm" onClick={onGotoAnalyze}>去 JD 匹配分析 →</button>
          <button className="btn sm" style={{ background: 'transparent', color: '#cbd3e1', borderColor: '#344054' }}
            onClick={() => setSelectedIds([])}>清空</button>
        </div>
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} reload={reload} toast={toast} />}
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      {editing && <JobFormModal job={editing === 'new' ? null : editing} onClose={() => setEditing(null)} reload={reload} toast={toast} />}
      {greetingDraft && (
        <GreetModal job={greetingDraft.job} text={greetingDraft.text}
          onClose={() => setGreetingDraft(null)} reload={reload} toast={toast} />
      )}
    </div>
  )
}

/* ================= 打招呼弹窗（先预览/改文案再发送） ================= */
function GreetModal({ job, text, onClose, reload, toast }) {
  const [draft, setDraft] = useState(text)
  const [busy, setBusy] = useState(false)

  const send = async (record) => {
    setBusy(true)
    try {
      const body = { text: draft }
      if (record) {
        const r = await api(`/jobs/${job.id}/greeting`, { method: 'POST', body })
        if (job.sourceUrl) window.open(job.sourceUrl, '_blank')
        toast(`已记录「${job.title}」的打招呼文案${job.sourceUrl ? '，并打开原岗位页，粘贴发送即可' : ''}`)
        reload()
      } else {
        const ok = await copyText(draft)
        toast(ok ? '文案已复制' : '复制失败，请手动选中复制', ok ? '' : 'err')
      }
      onClose()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  return (
    <Modal title={`👋 打招呼 · ${job.title}`} onClose={onClose}>
      <div className="callout info" style={{ marginBottom: 12 }}>
        文案由「设置 → 打招呼」的模板生成，可在这里临时修改（只影响本次，不改模板）。
        平台没有稳定的聊天深链，复制后到 Boss 页面点「立即沟通」粘贴发送。
      </div>
      <div className="field">
        <label>打招呼文案（{draft.length} 字）</label>
        <textarea className="input" rows={7} value={draft} onChange={e => setDraft(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => send(true)}>
          {busy ? <span className="spin" /> : '📋'} 复制并打开岗位页
        </button>
        <button className="btn" disabled={busy || !draft.trim()} onClick={() => send(false)}>仅复制</button>
        <button className="btn ghost" disabled={busy} onClick={onClose}>取消</button>
      </div>
    </Modal>
  )
}

/* ================= 导入弹窗 ================= */
function ImportModal({ onClose, reload, toast }) {
  const [tab, setTab] = useState('paste')
  return (
    <Modal title="导入岗位" onClose={onClose} wide>
      <div className="modal-tabs">
        {[['paste', '📋 粘贴JD'], ['scraper', '🤖 采集结果'], ['batch', '📦 JSON / CSV'], ['url', '🔗 链接导入']].map(([v, l]) => (
          <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      {tab === 'paste' && <PasteTab reload={reload} toast={toast} onClose={onClose} />}
      {tab === 'scraper' && <ScraperTab reload={reload} toast={toast} />}
      {tab === 'batch' && <BatchTab reload={reload} toast={toast} />}
      {tab === 'url' && <UrlTab reload={reload} toast={toast} onClose={onClose} />}
    </Modal>
  )
}

function PasteTab({ reload, toast, onClose }) {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const r = await api('/jobs/import', { method: 'POST', body: { mode: 'text', content: text, sourceUrl: url } })
      const j = r.job
      toast(`导入成功（${r.parsedBy === 'ai' ? 'AI解析' : '规则解析'}）：${j.title}｜${j.company || '公司未知'}｜${j.salaryText || '薪资未识别'}`)
      setText(''); setUrl(''); reload(); onClose()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }
  return (
    <div>
      <div className="callout info" style={{ marginBottom: 12 }}>
        在 Boss直聘/脉脉 的岗位页面 <b>全选复制 JD 文本</b>，粘贴到下面即可，系统会自动解析岗位名、公司、薪资、经验等字段。
      </div>
      <div className="field">
        <label>岗位链接（选填，便于一键投递回原页面）</label>
        <input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.zhipin.com/job_detail/xxxx.html" />
      </div>
      <div className="field">
        <label>JD 文本</label>
        <textarea className="textarea" style={{ minHeight: 200 }} value={text} onChange={e => setText(e.target.value)}
          placeholder={'粘贴完整的岗位描述，例如：\nAI产品经理（大模型应用） 20-35K·15薪\n深圳·南山区  经验1-3年  本科\n【岗位职责】…\n【任职要求】…'} />
      </div>
      <button className="btn primary" disabled={busy || text.trim().length < 20} onClick={submit}>
        {busy ? <span className="spin" /> : '＋'} 解析并入库
      </button>
    </div>
  )
}

function ScraperTab({ reload, toast }) {
  const [status, setStatus] = useState(null)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filling, setFilling] = useState(false)
  const [fillMsg, setFillMsg] = useState('')
  const load = async () => {
    try { setStatus(await api('/scraper/status')) } catch (e) { toast(e.message, 'err') }
  }
  useEffect(() => { load() }, [])
  const doImport = async () => {
    setBusy(true)
    try {
      const files = picked === 'all' || !picked
        ? null
        : (picked ? [picked] : null)
      const r = await api('/jobs/import-scraper', { method: 'POST', body: files ? { files } : {} })
      toast(`导入完成：新增 ${r.created} 个，更新JD详情 ${r.updated || 0} 个，跳过重复 ${r.skipped} 个${r.noDetail ? `（${r.noDetail} 个岗位无详情JD，建议采集时开启详情抓取）` : ''}`)
      reload()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }
  /* 深度补齐：先合并已有详情文件，仍有缺JD岗位时自动用采集器重抓这些岗位的详情页 */
  const doBackfill = async () => {
    setFilling(true)
    try {
      const st0 = await api('/jobs/backfill-details')
      if (st0.lackingNow === 0) {
        toast('库内岗位JD均已完整，无需补齐')
        setFilling(false)
        return
      }
      const merge = await api('/jobs/backfill-details', { method: 'POST', body: {} })
      if (merge.ok && merge.updated > 0) {
        toast(`已从现有详情文件回填 ${merge.updated} 个岗位的JD`)
        reload()
      }
      const st1 = await api('/jobs/backfill-details')
      if (st1.lackingNow === 0) { setFilling(false); return }
      const r = await api('/jobs/backfill-details', { method: 'POST', body: { deep: true } })
      if (r.skipped) { toast(`无法启动深度补齐：${r.reason}`, 'err'); setFilling(false); return }
      setFillMsg(`正在重抓 ${r.pending} 个岗位的详情页（约需几分钟，请勿关闭页面）…`)
      const timer = setInterval(async () => {
        try {
          const st = await api('/jobs/backfill-details')
          if (!st.running) {
            clearInterval(timer)
            setFilling(false); setFillMsg('')
            const last = st.last
            if (last?.ok) {
              toast(`深度补齐完成：回填JD ${last.backfill?.updated || 0}/${last.backfill?.matched || 0} 个，剩余缺失 ${st.lackingNow} 个`)
            } else {
              toast(`深度补齐失败：${last?.error || '未知错误'}`, 'err')
            }
            reload()
          }
        } catch (e) { /* 轮询失败忽略，下轮重试 */ }
      }, 4000)
    } catch (e) { toast(e.message, 'err'); setFilling(false); setFillMsg('') }
  }
  if (!status) return <div className="progress-text"><span className="spin dark" /> 正在检查采集结果目录…</div>
  return (
    <div>
      <div className="callout info" style={{ marginBottom: 12 }}>
        自动读取 <code className="kbd">{status.dir}</code> 目录下 boss-zhipin-scraper 的采集结果（boss_jobs_*.json + boss_details_*.json），按 job_id 合并详情JD后入库，自动按链接去重。
      </div>
      {!status.exists || status.files.length === 0 ? (
        <Empty icon="🤖" title="暂未发现采集结果">
          先运行一次采集（见「采集指南」），生成结果文件后回来点击「刷新」。
        </Empty>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {status.files.map(f => (
              <label key={f.file} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={picked === f.file} onChange={e => setPicked(e.target.checked ? f.file : null)} />
                <span className={'tag ' + (f.kind === 'list' ? 'blue' : 'purple')}>{f.kind === 'list' ? '列表' : '详情'}</span>
                <span style={{ fontFamily: 'Menlo, monospace', fontSize: 12.5 }}>{f.file}</span>
                <span className="doc-meta">{f.total != null ? `${f.total} 条` : ''} · {new Date(f.mtime).toLocaleString()}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={doImport}>{busy ? <span className="spin" /> : '📥'} 导入选中的文件</button>
            <button className="btn" onClick={load}>↻ 刷新目录</button>
            <button className="btn" disabled={filling} onClick={doBackfill}
              title="先合并已有详情文件；仍有JD不全的岗位时，自动用采集器重新抓取这些岗位的详情页（需已完成Chrome登录配置）">
              {filling ? <span className="spin" /> : '🩹'} 补齐JD详情
            </button>
            {fillMsg && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{fillMsg}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function BatchTab({ reload, toast }) {
  const [busy, setBusy] = useState(false)
  const handleFile = async (file) => {
    setBusy(true)
    try {
      const content = await file.text()
      const r = await api('/jobs/import-batch', { method: 'POST', body: { content, filename: file.name } })
      toast(`导入完成：共 ${r.total} 条，新增 ${r.created}，跳过重复 ${r.skipped}`)
      reload()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }
  return (
    <div>
      <div className="callout info" style={{ marginBottom: 12 }}>
        支持其他采集工具导出的 <b>JSON / CSV</b> 文件，字段自动映射（岗位名/薪资/城市/经验/JD正文/链接等常见命名均可识别），按链接或「岗位+公司+城市」去重。
      </div>
      <label className="dropzone" style={{ display: 'block' }}>
        <input type="file" accept=".json,.csv" style={{ display: 'none' }}
          onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]) }} />
        {busy ? <span className="progress-text"><span className="spin dark" /> 正在导入…</span> : <>📦 点击选择 .json / .csv 文件，或把文件拖到这里</>}
      </label>
    </div>
  )
}

function UrlTab({ reload, toast, onClose }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const r = await api('/jobs/import', { method: 'POST', body: { mode: 'url', sourceUrl: url } })
      toast(`导入成功：${r.job.title}`)
      reload(); onClose()
    } catch (e) {
      toast(e.message + '（Boss直聘等站点有登录墙，推荐用「粘贴JD」或「采集结果」导入）', 'err')
    }
    setBusy(false)
  }
  return (
    <div>
      <div className="callout warn" style={{ marginBottom: 12 }}>
        尽力而为模式：多数招聘站点（Boss直聘、脉脉）有登录墙与反爬，直接抓取常会失败。失败时请在页面上复制 JD 文本改用「粘贴JD」。
      </div>
      <div className="field">
        <label>岗位链接</label>
        <input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" />
      </div>
      <button className="btn primary" disabled={busy || !url} onClick={submit}>{busy ? <span className="spin" /> : '🔗'} 抓取并入库</button>
    </div>
  )
}

/* ================= 采集指南 ================= */
function GuideModal({ onClose }) {
  return (
    <Modal title="📖 JD 采集指南（boss-zhipin-scraper）" onClose={onClose} wide>
      <p style={{ marginBottom: 10 }}>
        本工作台已内置对接开源采集器 <a href="https://github.com/eatmoreduck/boss-zhipin-scraper" target="_blank" rel="noreferrer"><b>eatmoreduck/boss-zhipin-scraper</b></a>
        （MIT，Chrome CDP 复用你自己的登录态，被动捕获页面 API，不注入请求）。共 3 步：
      </p>
      <h4 style={{ margin: '14px 0 6px' }}>① 首次配置（只需一次）</h4>
      <pre className="cmd">{`cd collector/boss-zhipin-scraper
pip3 install -r requirements.txt
python3 scripts/boss_cdp_raw.py --setup-chrome   # 会打开一个专用Chrome窗口`}</pre>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: '6px 0 14px' }}>
        在弹出的专用 Chrome 里<b>登录你的 Boss直聘账号</b>（只需一次，登录态会保存在独立配置目录，不影响日常浏览器）。
      </p>
      <h4 style={{ margin: '14px 0 6px' }}>② 采集岗位（按你的筛选条件）</h4>
      <pre className="cmd">{`# 深圳 · 产品经理 · 1-3年经验 · 本科，并抓取JD详情
python3 scripts/boss_cdp_raw.py --city 深圳 --keyword 产品经理 \\
  --experience 104 --degree 203`}</pre>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: '6px 0 14px' }}>
        经验代码：103=1年内 104=1-3年 105=3-5年；学历代码：202=大专 203=本科。结果默认写入
        <code className="kbd"> ~/.boss-zhipin-scraper/job-result/</code>。也可用一键脚本：<code className="kbd">npm run collect</code>
      </p>
      <h4 style={{ margin: '14px 0 6px' }}>③ 回到工作台导入</h4>
      <p>打开「导入岗位 → 🤖 采集结果」，工具会自动发现结果文件，一键合并入库（自动去重、自动合并JD详情）。</p>
      <div className="callout warn" style={{ marginTop: 16 }}>
        <b>风险与边界说明：</b>自动采集请控制频率与数量（官方工具默认即较温和）；采集仅供个人求职研究使用，请自行评估与平台条款的合规性，不要商用或转售数据。脉脉暂无成熟采集器，用「粘贴JD」导入即可。真实批量投递推荐配合
        <a href="https://github.com/Ocyss/boss-helper" target="_blank" rel="noreferrer"> Ocyss/boss-helper</a> 插件（在你的浏览器内操作）；本工作台的「一键投递」负责登记投递状态并跳转原岗位页。
      </div>
    </Modal>
  )
}

/* ================= 手动添加 / 编辑 ================= */
function JobFormModal({ job, onClose, reload, toast }) {
  const isEdit = !!job
  const [form, setForm] = useState(() => isEdit ? { ...job, tags: (job.tags || []).join(' ') } : {
    title: '', company: '', city: '深圳', category: '产品经理', experienceText: '', education: '本科',
    salaryText: '', sourceUrl: '', description: '', tags: '', recruitType: '社招',
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const submit = async () => {
    const body = {
      ...form,
      tags: form.tags.split(/[ ,，、|]+/).map(s => s.trim()).filter(Boolean),
    }
    try {
      if (isEdit) await api(`/jobs/${job.id}`, { method: 'PUT', body })
      else await api('/jobs', { method: 'POST', body })
      toast(isEdit ? '已保存' : '已添加岗位')
      reload(); onClose()
    } catch (e) { toast(e.message, 'err') }
  }
  return (
    <Modal title={isEdit ? `编辑：${job.title}` : '手动添加岗位'} onClose={onClose} wide>
      <div className="form-row">
        <div className="field"><label>岗位名称 *</label><input className="input" value={form.title} onChange={e => set('title', e.target.value)} /></div>
        <div className="field"><label>公司</label><input className="input" value={form.company || ''} onChange={e => set('company', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="field"><label>城市</label><input className="input" value={form.city || ''} onChange={e => set('city', e.target.value)} /></div>
        <div className="field"><label>经验要求</label><input className="input" value={form.experienceText || ''} onChange={e => set('experienceText', e.target.value)} placeholder="如：1-3年" /></div>
        <div className="field"><label>学历</label><input className="input" value={form.education || ''} onChange={e => set('education', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="field"><label>薪资（如 15-25K·14薪）</label><input className="input" value={form.salaryText || ''} onChange={e => set('salaryText', e.target.value)} /></div>
        <div className="field"><label>岗位链接（选填）</label><input className="input" value={form.sourceUrl || ''} onChange={e => set('sourceUrl', e.target.value)} /></div>
      </div>
      <div className="field"><label>标签（空格分隔）</label><input className="input" value={form.tags || ''} onChange={e => set('tags', e.target.value)} placeholder="B端 SaaS SQL" /></div>
      <div className="field"><label>JD 正文</label><textarea className="textarea" style={{ minHeight: 160 }} value={form.description || ''} onChange={e => set('description', e.target.value)} /></div>
      <button className="btn primary" disabled={!form.title} onClick={submit}>{isEdit ? '保存修改' : '添加岗位'}</button>
    </Modal>
  )
}
