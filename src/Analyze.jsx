import React, { useEffect, useMemo, useState } from 'react'
import { api, apiStream, fmtSalary, copyText } from './api.js'
import { Modal, Empty } from './common.jsx'

/* ================= 状态与文案映射 ================= */
const JUDGE_META = {
  直接匹配: { tone: 'ok', label: '直接匹配', icon: '✓' },
  可迁移: { tone: 'partial', label: '可迁移', icon: '≈' },
  待确认: { tone: 'unknown', label: '待确认', icon: '?' },
  明确不满足: { tone: 'bad', label: '明确不满足', icon: '✕' },
}
const REC_META = {
  推荐投递: { tone: 'ok', hint: '关键要求有证据支撑，可直接投递' },
  调整后投递: { tone: 'partial', hint: '先改简历或补齐材料再投' },
  探索投递: { tone: 'unknown', hint: '匹配有限，可试水但不要作为主攻' },
  暂不优先: { tone: 'bad', hint: '硬性条件或核心要求差距明显' },
  信息不足: { tone: 'unknown', hint: '材料不足，结论不可靠' },
}
const GAP_META = {
  表达缺口: { tone: 'partial', text: '表达缺口（经历有，简历未体现）' },
  证据不足: { tone: 'unknown', text: '证据不足' },
  可迁移经验: { tone: 'partial', text: '可迁移经验' },
  能力缺口: { tone: 'bad', text: '能力缺口' },
  硬性条件差距: { tone: 'bad', text: '硬性条件差距' },
}
const CHANGE_TYPE_TONE = { 补充: 'ok', 重写: 'partial', 前置: 'unknown', 精简: 'plain' }
const TABS = [
  { key: 'req', label: '要求对照' },
  { key: 'changes', label: '简历修改' },
  { key: 'skills', label: '能力补齐' },
  { key: 'questions', label: '待补充信息' },
]
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'matched', label: '已匹配' },
  { key: 'unknown', label: '待确认' },
  { key: 'gap', label: '有差距' },
]

const toneClass = (tone) => `st st-${tone || 'plain'}`

/* ================= 主组件 ================= */
export default function Analyze({
  jobs, docs, selectedIds, setSelectedIds, lastAnalysis, setLastAnalysis,
  onGotoResume, toast, settings,
}) {
  const [resumeDocId, setResumeDocId] = useState(null)
  const [libraryDocId, setLibraryDocId] = useState('')
  const [view, setView] = useState(lastAnalysis || null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ message: '', percent: null })
  const [tab, setTab] = useState('req')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState({})
  const [showAllChanges, setShowAllChanges] = useState(false)
  const [editing, setEditing] = useState(null)      // { id, text }
  const [savingId, setSavingId] = useState(null)
  const [answers, setAnswers] = useState({})
  const [answering, setAnswering] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [showInput, setShowInput] = useState(true)

  useEffect(() => { if (lastAnalysis) setView(lastAnalysis) }, [lastAnalysis])
  useEffect(() => { api('/analyses').then(setHistory).catch(() => {}) }, [])
  useEffect(() => {
    if (!resumeDocId && docs.length) {
      const r = docs.find(d => d.type === '简历')
      if (r) setResumeDocId(r.id)
    }
  }, [docs, resumeDocId])

  const data = view?.data || null
  const requirements = data?.requirements || []
  const changes = data?.resumeChanges || []
  const skills = data?.skills || []
  const questions = data?.questions || []
  const overview = data?.overview || null
  const scoring = data?.scoring || null

  const selectedJobs = useMemo(() => jobs.filter(j => selectedIds.includes(j.id)), [jobs, selectedIds])
  const resumeDoc = docs.find(d => d.id === resumeDocId)
  const libraryDoc = docs.find(d => d.id === Number(libraryDocId))
  const multiJob = (data?.input?.jobs?.length || 0) > 1

  /* 结果是否已过期：JD 或简历在分析后被修改 */
  const stale = useMemo(() => {
    if (!data?.input) return null
    const reasons = []
    for (const snap of data.input.jobs || []) {
      const cur = jobs.find(j => j.id === snap.id)
      if (!cur) reasons.push(`岗位「${snap.title}」已从库中删除`)
      else if ((cur.description || '').length !== snap.jdLength) reasons.push(`岗位「${snap.title}」的JD已变化`)
    }
    const rCur = docs.find(d => d.id === data.input.resume?.id)
    if (data.input.resume && !rCur) reasons.push('分析所用简历已删除')
    else if (data.input.resume && (rCur.content || '').length !== data.input.resume.length) reasons.push('简历内容已修改')
    const lCur = docs.find(d => d.id === data.input.library?.id)
    if (data.input.library && lCur && (lCur.content || '').length !== data.input.library.length) reasons.push('经历库内容已修改')
    return reasons.length ? reasons : null
  }, [data, jobs, docs])

  /* 归类：待确认优先；存在差距类型（含表达缺口/证据不足）归为有差距；仅无差距的匹配才算已匹配 */
  const bucketOf = (r) => {
    if (r.judgment === '待确认') return 'unknown'
    if (r.gapType) return 'gap'
    return r.judgment === '直接匹配' ? 'matched' : 'gap'
  }

  const stats = useMemo(() => {
    const s = { matched: 0, unknown: 0, gap: 0, total: requirements.length }
    for (const r of requirements) s[bucketOf(r)]++
    s.adopted = changes.filter(c => c.adopted).length
    s.skillsDone = skills.filter(x => x.done).length
    return s
  }, [requirements, changes, skills])

  const filteredReqs = requirements.filter(r => filter === 'all' || bucketOf(r) === filter)

  const toggleJob = (id) => setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])

  const run = async () => {
    if (!selectedIds.length) return toast('请先选择至少一个目标岗位', 'err')
    if (!resumeDocId) return toast('请先选择当前投递使用的简历', 'err')
    setBusy(true); setProgress({ message: '正在校验输入材料…', percent: 5 })
    try {
      const a = await apiStream('/analyze/stream', {
        jobIds: selectedIds, resumeDocId, libraryDocId: libraryDocId || undefined,
      }, {
        fallbackPath: '/analyze',
        // 旧版服务端只认 documentId
        fallbackBody: { jobIds: selectedIds, documentId: resumeDocId, libraryDocId: libraryDocId || undefined },
        onProgress: (p) => setProgress({ message: p?.message || '', percent: p?.percent ?? null }),
      })
      setView(a); setLastAnalysis(a)
      setTab('req'); setFilter('all'); setExpanded({}); setShowAllChanges(false)
      setAnswers({})
      api('/analyses').then(setHistory).catch(() => {})
      if (a.data?.status === 'blocked') toast('输入材料不足，已列出缺失项，未生成匹配结论', 'err')
      else if (a.data?.status === 'failed') toast('AI 分析失败：' + (a.data?.error || '未知错误'), 'err')
      else toast(a.data?.mode === 'ai' ? '分析完成' : '已完成基础文本检查（未配置 AI Key）')
    } catch (e) { toast(e.message, 'err') }
    setBusy(false); setProgress({ message: '', percent: null })
  }

  const patchState = async (body) => {
    if (!view?.id) return
    const res = await api(`/analyses/${view.id}/state`, { method: 'PUT', body })
    setView(res); setLastAnalysis(res)
  }

  const adopt = async (change, text) => {
    setSavingId(change.id)
    try {
      await patchState({ changes: [{ id: change.id, adopted: true, adoptedText: text }] })
      setEditing(null)
      toast('已采纳该修改（原文不会被改动，可随时撤销）')
    } catch (e) { toast(e.message, 'err') }
    setSavingId(null)
  }

  const unadopt = async (change) => {
    setSavingId(change.id)
    try {
      await patchState({ changes: [{ id: change.id, adopted: false }] })
      toast('已撤销采纳')
    } catch (e) { toast(e.message, 'err') }
    setSavingId(null)
  }

  const submitAnswers = async () => {
    const payload = Object.entries(answers).filter(([, v]) => v && v.trim()).map(([qid, v]) => {
      const q = questions.find(x => x.id === qid)
      return { questionId: qid, question: q?.question || '', answer: v.trim() }
    })
    if (!payload.length) return toast('请至少填写一条回答', 'err')
    setAnswering(true)
    try {
      const res = await api(`/analyses/${view.id}/answers`, { method: 'POST', body: { answers: payload } })
      setView(res); setLastAnalysis(res)
      setAnswers({})
      const changed = res.data?.answerUpdate?.changed || []
      toast(changed.length ? `已更新 ${changed.length} 条判断，见「要求对照」中的更新标记` : '已提交回答，分析已刷新')
      setTab('req')
    } catch (e) { toast(e.message, 'err') }
    setAnswering(false)
  }

  const generateResume = async () => {
    if (!view?.id) return
    if (stats.adopted === 0) { toast('请先在「简历修改」中采纳至少一条修改', 'err'); setTab('changes'); return }
    setGenerating(true)
    try {
      const r = await api('/resumes/from-analysis', { method: 'POST', body: { analysisId: view.id } })
      toast(`已生成针对性简历（应用 ${r.applied.length} 条修改${r.skipped?.length ? `，跳过 ${r.skipped.length} 条` : ''}）`)
      onGotoResume(view.jobIds, r.version.id)
    } catch (e) { toast(e.message, 'err') }
    setGenerating(false)
  }

  const loadHistory = async (id) => {
    try {
      const a = await api(`/analyses/${id}`)
      setView(a); setLastAnalysis(a); setShowHistory(false)
      setTab('req'); setFilter('all'); setExpanded({})
    } catch (e) { toast(e.message, 'err') }
  }

  const blocked = data?.status === 'blocked'
  const failed = data?.status === 'failed'
  const partial = data?.status === 'partial'
  const basic = data?.mode === 'basic'

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">JD 匹配分析</div>
          <div className="page-sub">
            逐条对照 JD 要求与「当前简历 / 经历库」，区分招聘方能看到什么、你还缺什么，并给出可执行的简历与能力改进。
            {settings && !settings.ready && <span className="st st-unknown" style={{ marginLeft: 8 }}>未配置 AI：新分析将降级为基础文本检查</span>}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setShowHistory(true)}>历史分析</button>
          <button className="btn" onClick={() => setShowInput(v => !v)} aria-expanded={showInput}>
            {showInput ? '收起输入' : '修改输入'}
          </button>
          <button className="btn primary" disabled={busy} onClick={run}>
            {busy ? <span className="spin" /> : null} {view ? '重新分析' : '开始分析'}
          </button>
        </div>
      </div>

      {busy && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="spin dark" />
            <b>分析进行中</b>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{progress.message || '正在准备…'}</span>
            {progress.percent != null && (
              <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{progress.percent}%</span>
            )}
          </div>
          <div className="an-progress-bar" style={{ marginTop: 8 }}>
            <i style={{ width: `${progress.percent != null ? Math.max(4, Math.min(100, progress.percent)) : 6}%`, transition: 'width .4s ease' }} />
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            多岗位会并发分析，进度按岗位完成数推进；单岗通常 30~90 秒。中途关闭页面不影响服务端完成并存入历史。
          </div>
        </div>
      )}

      {showInput && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="an-input-grid">
            <div>
              <div className="an-label">① 目标岗位（可多选，最多 5 个）{selectedIds.length > 0 && <span className="tag blue">{selectedIds.length} 个已选</span>}</div>
              <div className="an-jobpick">
                {jobs.length === 0 && <Empty icon="AI" title="岗位库为空">请先去「岗位库」导入岗位</Empty>}
                {jobs.slice(0, 200).map(j => {
                  const jdLen = (j.description || '').length
                  const weak = jdLen < 160
                  return (
                    <label key={j.id} className={'an-jobpick-item' + (selectedIds.includes(j.id) ? ' on' : '')}>
                      <input type="checkbox" checked={selectedIds.includes(j.id)} onChange={() => toggleJob(j.id)} />
                      <span className="an-jobpick-title">{j.title}</span>
                      <span className="an-jobpick-meta">{j.company || '公司未知'} · {fmtSalary(j)}</span>
                      {weak && <span className="st st-bad" title="JD正文过短，可能只有职位名称">JD不完整</span>}
                    </label>
                  )
                })}
              </div>
            </div>
            <div>
              <div className="an-label">② 当前投递简历（必选）</div>
              <select className="select" value={resumeDocId || ''} onChange={e => setResumeDocId(Number(e.target.value) || null)}>
                <option value="">— 选择简历 —</option>
                {docs.filter(d => d.type === '简历').map(d => <option key={d.id} value={d.id}>{d.name}（{(d.content || '').length}字）</option>)}
                {docs.filter(d => d.type !== '简历').map(d => <option key={d.id} value={d.id}>{d.name}（{d.type}）</option>)}
              </select>
              {resumeDoc?.parseMeta?.suspicious && (
                <div className="callout warn" style={{ marginTop: 10 }}>
                  这份简历只从 PDF 里提取到 <b>{resumeDoc.parseMeta.chars || 0}</b> 字
                  （{resumeDoc.parseMeta.pages || 1} 页，约 {resumeDoc.parseMeta.charsPerPage || 0} 字/页），
                  正文很可能是图片或字体无法提取。分析会因材料缺失而误判「没有证据」——
                  建议到「信息库」粘贴简历全文（或重新上传并开启 OCR）后再分析。
                </div>
              )}
              <div className="an-label" style={{ marginTop: 14 }}>③ 完整经历库（可选，用于发现简历漏写的内容）</div>
              <select className="select" value={libraryDocId} onChange={e => setLibraryDocId(e.target.value)}>
                <option value="">— 不使用 —</option>
                {docs.map(d => <option key={d.id} value={d.id}>{d.name}（{d.type}，{(d.content || '').length}字）</option>)}
              </select>
              <div className="hint" style={{ marginTop: 10 }}>
                简历代表招聘方能看到的内容；经历库代表你的完整经历。分析会区分「经历有但简历没写」与「你没有证据」。
              </div>
              {busy && <div className="progress-text" style={{ marginTop: 12 }}><span className="spin dark" /> {progress.message || '分析中，请稍候…'}</div>}
            </div>
          </div>
        </div>
      )}

      {!view && (
        <div className="card">
          <Empty icon="JD" title="还没有分析结果">
            选择目标岗位与当前简历后点击「开始分析」。若 JD 只有职位名称或缺少职责/要求，系统会先提示补充，不会给出虚假分数。
          </Empty>
        </div>
      )}

      {view && data && !data.schemaVersion && (
        <div className="callout warn" style={{ marginBottom: 12 }}>
          这是旧版分析结果（结构不兼容），无法展示证据链与逐条对照。请点击右上角「重新分析」生成新结果。
        </div>
      )}

      {view && data && data.schemaVersion && (
        <>
          {stale && (
            <div className="callout warn" style={{ marginBottom: 12, display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>结果可能已过期：{stale.join('；')}。建议重新分析。</span>
              <button className="btn sm" onClick={run} disabled={busy}>重新分析</button>
            </div>
          )}
          {blocked && (
            <div className="callout warn" style={{ marginBottom: 12 }}>
              <b>输入材料不足，未生成匹配结论。</b>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {(data.quality?.blockers || []).map((b, i) => <li key={i}>{b.message}</li>)}
              </ul>
            </div>
          )}
          {failed && (
            <div className="callout warn" style={{ marginBottom: 12 }}>
              <b>分析失败，未生成任何结论。</b> {data.error}
              <div style={{ marginTop: 8 }}><button className="btn sm" onClick={run} disabled={busy}>重试</button></div>
            </div>
          )}
          {partial && (
            <div className="callout warn" style={{ marginBottom: 12 }}>
              部分岗位分析失败：{(data.failedJobs || []).map(f => `${f.jobTitle}（${f.error}）`).join('；')}。下方仅展示成功部分。
            </div>
          )}
          {basic && (
            <div className="callout info" style={{ marginBottom: 12 }}>
              <b>基础文本检查</b>：未配置 AI Key，只做了 JD 句子切分与词语覆盖，<b>不构成语义匹配结论</b>。下方不展示匹配分与能力判断。
            </div>
          )}
          {(data.quality?.warnings || []).length > 0 && !blocked && (
            <div className="callout info" style={{ marginBottom: 12 }}>
              {data.quality.warnings.map((w, i) => <div key={i}>· {w.message}</div>)}
            </div>
          )}

          {/* ============ 概览头部 ============ */}
          <div className="card card-pad an-header">
            <div className="an-header-main">
              <div className="an-title-row">
                <h2 className="an-title">{data.input?.jobs?.length === 1 ? data.input.jobs[0].title : `${data.input?.jobs?.length || 0} 个目标岗位`}</h2>
                <span className="an-company">{data.input?.jobs?.length === 1 ? (data.input.jobs[0].company || '公司未提供') : (data.input?.jobs || []).map(j => j.company).filter(Boolean).slice(0, 2).join('、')}</span>
                <span className={toneClass(basic ? 'unknown' : 'plain')}>{basic ? '基础文本检查' : 'AI 深度分析'}</span>
                {data.sample && <span className="st st-unknown" title={data.sampleNote || '样例数据'}>样例数据</span>}
                <span className="an-time">更新于 {new Date(view.updatedAt || view.createdAt).toLocaleString()}</span>
              </div>
              <div className="an-version-line">
                {!multiJob && data.input?.jobs?.[0] && (
                  <span>
                    {data.input.jobs[0].city || '地点未提供'}
                    {data.input.jobs[0].salaryText ? ` · ${data.input.jobs[0].salaryText}` : ''}
                  </span>
                )}
                <span>JD：{data.input?.versions?.jd || '—'}</span>
                <span>简历：{data.input?.versions?.resume || '—'}</span>
                <span>经历库：{data.input?.versions?.library || '未使用'}</span>
                {multiJob && <span>多岗位对照</span>}
              </div>
              {overview && (
                <div className="an-verdict">
                  <span className={toneClass(REC_META[overview.recommendation]?.tone)}>
                    {overview.recommendation}
                  </span>
                  <div className="an-verdict-text">
                    <div>{overview.reason || REC_META[overview.recommendation]?.hint}</div>
                    <div className="an-confidence">
                      可信度：{overview.confidence}
                      {overview.confidenceReason ? ` · ${overview.confidenceReason}` : ''}
                    </div>
                  </div>
                </div>
              )}
              {multiJob && overview?.byJob?.length > 0 && (
                <div className="an-byjob">
                  {overview.byJob.map(b => (
                    <span key={b.jobId} className={toneClass(REC_META[b.recommendation]?.tone)} title={b.reason}>
                      {b.title}：{b.recommendation}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {overview && !blocked && (
              <div className="an-summary-grid">
                <SummaryList title="最重要优势" items={overview.topStrengths} tone="ok" empty="暂无有证据的优势" onLink={(rIds) => jumpToReq(rIds, setTab, setExpanded, requirements)} />
                <SummaryList title="最大风险" items={overview.topRisks} tone="bad" empty="未发现明确风险" onLink={(rIds) => jumpToReq(rIds, setTab, setExpanded, requirements)} />
                <SummaryList title="未确认事项" items={overview.unconfirmed} tone="unknown" empty="没有需要确认的事项" onLink={(rIds) => jumpToReq(rIds, setTab, setExpanded, requirements)} />
              </div>
            )}
          </div>

          {/* ============ 主体 + 侧栏 ============ */}
          <div className="an-body">
            <div className="an-main">
              <div className="an-tabs" role="tablist">
                {TABS.map(t => (
                  <button key={t.key} role="tab" aria-selected={tab === t.key}
                    className={'an-tab' + (tab === t.key ? ' on' : '')} onClick={() => setTab(t.key)}>
                    {t.label}
                    {t.key === 'changes' && changes.length > 0 && <span className="an-tab-count">{stats.adopted}/{changes.length}</span>}
                    {t.key === 'skills' && skills.length > 0 && <span className="an-tab-count">{stats.skillsDone}/{skills.length}</span>}
                    {t.key === 'questions' && questions.filter(q => !q.answer).length > 0 && <span className="an-tab-count">{questions.filter(q => !q.answer).length}</span>}
                  </button>
                ))}
              </div>

              {tab === 'req' && data.common?.commonRequirements?.length > 0 && (
                <div className="card card-pad" style={{ marginBottom: 12 }}>
                  <div className="an-side-title" style={{ marginBottom: 8 }}>多岗位共性要求（可作为简历统一对齐方向）</div>
                  <div className="an-links">
                    {data.common.commonRequirements.slice(0, 8).map((r, i) => (
                      <span key={i} className={'tag ' + (r.weight === '核心' ? 'red' : r.weight === '重要' ? 'orange' : '')} title={r.why}>
                        {r.requirement}
                      </span>
                    ))}
                  </div>
                  {data.common.overallAdvice && <div className="an-muted" style={{ marginTop: 8 }}>{data.common.overallAdvice}</div>}
                </div>
              )}

              {tab === 'req' && (
                <div className="card">
                  <div className="an-filterbar">
                    {FILTERS.map(f => (
                      <button key={f.key} className={'chip' + (filter === f.key ? ' active' : '')} onClick={() => setFilter(f.key)}>
                        {f.label}
                        <span className="an-chip-count">
                          {f.key === 'all' ? stats.total : f.key === 'matched' ? stats.matched : f.key === 'unknown' ? stats.unknown : stats.gap}
                        </span>
                      </button>
                    ))}
                    <span className="an-filter-hint">点击行展开 JD 原文与经历证据</span>
                  </div>

                  {filteredReqs.length === 0 ? (
                    <div className="an-empty-row">当前筛选下没有记录</div>
                  ) : (
                    <div className="an-table" role="table">
                      <div className="an-thead" role="row">
                        <span role="columnheader">要求</span>
                        <span role="columnheader">重要程度</span>
                        <span role="columnheader">匹配判断</span>
                        <span role="columnheader">证据摘要</span>
                        <span role="columnheader">下一步</span>
                      </div>
                      {filteredReqs.map(r => {
                        const jm = JUDGE_META[r.judgment] || JUDGE_META.待确认
                        const open = !!expanded[r.id]
                        const updated = (data.answerUpdate?.changed || []).some(c => c.name === r.name)
                        return (
                          <div key={r.id} className={'an-row' + (open ? ' open' : '')}>
                            <button className="an-row-main" onClick={() => setExpanded(s => ({ ...s, [r.id]: !s[r.id] }))}
                              aria-expanded={open}>
                              <span className="an-cell an-cell-name">
                                <span className="an-req-name">{r.name}</span>
                                <span className="an-req-sub">
                                  {multiJob && <span className="tag">{r.jobTitle}</span>}
                                  <span className={'tag ' + (r.type === '硬性条件' ? 'red' : r.type === '加分项' ? '' : 'blue')}>{r.type}</span>
                                  {r.gapType && <span className="tag">{GAP_META[r.gapType]?.text || r.gapType}</span>}
                                  {updated && <span className="st st-ok">回答后已更新</span>}
                                </span>
                              </span>
                              <span className="an-cell">
                                <span className={'tag ' + (r.priority === '必须' ? 'red' : r.priority === '重要' ? 'orange' : '')}>{r.priority}</span>
                                <span className="an-mini">{r.prioritySource === '推断' ? '推断' : '原文'}</span>
                              </span>
                              <span className="an-cell"><span className={toneClass(jm.tone)}>{jm.icon} {jm.label}</span></span>
                              <span className="an-cell an-cell-ev">
                                {r.evidence?.length
                                  ? (r.inResume ? `简历已体现（${r.evidence.length} 处证据）` : (r.inLibrary ? '经历库有，简历未写' : '材料中无直接证据'))
                                  : '无证据'}
                              </span>
                              <span className="an-cell an-cell-act">{r.action || '—'}</span>
                            </button>

                            {open && (
                              <div className="an-detail">
                                <div className="an-detail-block">
                                  <div className="an-detail-label">JD 原文 · {r.jdLocation}</div>
                                  <blockquote>{r.jdQuote || '（模型未提供原文片段）'}</blockquote>
                                </div>
                                <div className="an-detail-block">
                                  <div className="an-detail-label">经历证据</div>
                                  {r.evidence?.length ? (
                                    <ul className="an-evidence">
                                      {r.evidence.map(e => (
                                        <li key={e.id}>
                                          <span className={'tag ' + (e.inResume ? 'green' : 'orange')}>{e.inResume ? '简历可见' : '仅经历库'}</span>
                                          <span className="an-evidence-quote">{e.quote}</span>
                                          <span className="an-evidence-source">{e.source}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : <div className="an-muted">材料中未找到直接证据。这不代表你不具备该能力，只代表当前材料无法证明。</div>}
                                </div>
                                <div className="an-detail-block">
                                  <div className="an-detail-label">判断依据</div>
                                  <div>{r.judgmentReason || '—'}</div>
                                  {r.uncertainty && <div className="an-muted" style={{ marginTop: 4 }}>仍不确定：{r.uncertainty}</div>}
                                  {r.gapType && <div style={{ marginTop: 6 }}><span className={'tag ' + (GAP_META[r.gapType]?.tone === 'bad' ? 'red' : GAP_META[r.gapType]?.tone === 'partial' ? 'orange' : '')}>{GAP_META[r.gapType]?.text || r.gapType}</span></div>}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === 'changes' && (
                <div className="an-changes">
                  {changes.length === 0 ? (
                    <div className="card"><Empty icon="✎" title={basic ? '基础模式不生成简历改写' : '没有需要修改的条目'}>
                      {basic ? '配置 AI Key 后可获得逐条改写建议。' : '当前材料与 JD 的差距可能主要在能力或硬性条件，而非表达。'}
                    </Empty></div>
                  ) : (
                    <>
                      <div className="an-section-head">
                        <div>
                          <b>按影响排序</b>，默认展示最重要的 3 条。
                          <span className="an-muted"> 改写只使用你材料中的事实，不会新增数字或职责。</span>
                        </div>
                        {changes.length > 3 && (
                          <button className="btn sm" onClick={() => setShowAllChanges(v => !v)}>
                            {showAllChanges ? '收起' : `展开全部 ${changes.length} 条`}
                          </button>
                        )}
                      </div>
                      {(showAllChanges ? changes : changes.slice(0, 3)).map((c, i) => {
                        const editingThis = editing?.id === c.id
                        const finalText = c.adoptedText || c.suggested
                        return (
                          <div key={c.id} className={'card card-pad an-change' + (c.adopted ? ' adopted' : '')}>
                            <div className="an-change-head">
                              <span className="an-change-index">#{i + 1}</span>
                              <span className={'tag ' + (CHANGE_TYPE_TONE[c.type] === 'plain' ? '' : CHANGE_TYPE_TONE[c.type])}>{c.type}</span>
                              <span className="tag blue">{c.requirementName || c.requirementId || '关联要求'}</span>
                              <span className="an-muted">{c.location}</span>
                              {c.adopted && <span className="st st-ok">✓ 已采纳</span>}
                              {c.hasPlaceholder && <span className="st st-unknown">含待确认信息</span>}
                            </div>
                            <div className="an-change-why"><b>为什么改：</b>{c.reason || '—'}</div>
                            <div className="an-compare">
                              <div className="an-compare-col">
                                <div className="an-detail-label">原文</div>
                                <div className="an-orig">{(editingThis ? c.original : c.original) || '（新增内容，无原文）'}</div>
                              </div>
                              <div className="an-compare-col">
                                <div className="an-detail-label">建议</div>
                                {editingThis ? (
                                  <textarea className="textarea" value={editing.text}
                                    onChange={e => setEditing({ id: c.id, text: e.target.value })} />
                                ) : (
                                  <div className="an-suggest">{finalText || '—'}</div>
                                )}
                              </div>
                            </div>
                            <div className="an-change-foot">
                              <div className="an-change-ev">
                                {c.evidence && <div><b>依据：</b>{c.evidence}</div>}
                                {c.pending?.length > 0 && <div><b>待确认：</b>{c.pending.join('、')}</div>}
                                {!c.originalVerified && c.original && <div className="an-muted">提示：分析给出的原文片段与当前简历不完全一致，采纳时请人工核对。</div>}
                              </div>
                              <div className="an-change-actions">
                                <button className="btn sm" onClick={async () => { (await copyText(finalText || '')) ? toast('已复制建议文本') : toast('复制失败', 'err') }}>复制</button>
                                {c.adopted ? (
                                  <>
                                    <button className="btn sm" onClick={() => setEditing({ id: c.id, text: c.adoptedText || c.suggested })}>编辑</button>
                                    <button className="btn sm ghost danger" disabled={savingId === c.id} onClick={() => unadopt(c)}>撤销</button>
                                  </>
                                ) : editingThis ? (
                                  <>
                                    <button className="btn sm primary" disabled={savingId === c.id} onClick={() => adopt(c, editing.text)}>保存并采纳</button>
                                    <button className="btn sm ghost" onClick={() => setEditing(null)}>取消</button>
                                  </>
                                ) : (
                                  <>
                                    <button className="btn sm primary" disabled={savingId === c.id} onClick={() => adopt(c, c.suggested)}>采纳</button>
                                    <button className="btn sm" onClick={() => setEditing({ id: c.id, text: c.suggested })}>编辑后采纳</button>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}

                      {data.projects?.length > 0 && (
                        <div className="card card-pad">
                          <div className="an-section-head"><b>建议优先展示的项目</b></div>
                          {data.projects.map(p => (
                            <div key={p.id} className="an-project">
                              <b>{p.name}</b>
                              <div className="an-muted">{p.why}</div>
                              <div className="an-links">
                                {p.requirementIds.map(id => {
                                  const req = requirements.find(r => r.id === id)
                                  return req ? <span key={id} className="tag blue">{req.name}</span> : null
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {tab === 'skills' && (
                <div className="an-skills">
                  {skills.length === 0 ? (
                    <div className="card"><Empty icon="L" title={basic ? '基础模式不做能力判断' : '暂不需要额外补齐'}>
                      {basic ? '配置 AI Key 后可获得针对性的能力补齐建议。' : '当前没有重要且确实需要补齐的能力项。'}
                    </Empty></div>
                  ) : (
                    ['投递前', '面试前', '长期'].map(group => {
                      const items = skills.filter(s => s.priority === group)
                      if (!items.length) return null
                      return (
                        <div key={group} className="an-skill-group">
                          <div className="an-group-title">{group}<span className="an-muted">{group === '投递前' ? ' 影响是否值得投' : group === '面试前' ? ' 影响面试表现' : ' 需要真实项目积累'}</span></div>
                          {items.map(s => {
                            const req = requirements.find(r => r.id === s.requirementId)
                            return (
                              <div key={s.id} className={'card card-pad an-skill' + (s.done ? ' done' : '')}>
                                <div className="an-skill-head">
                                  <label className="an-check">
                                    <input type="checkbox" checked={!!s.done}
                                      onChange={async (e) => {
                                        try {
                                          await patchState({ skills: [{ id: s.id, done: e.target.checked }] })
                                        } catch (err) { toast(err.message, 'err') }
                                      }} />
                                    <span>{s.gap}</span>
                                  </label>
                                  {req && <span className="tag blue">{req.name}</span>}
                                </div>
                                <div className="an-kv"><b>目标深度</b><span>{s.depth}</span></div>
                                {s.knowledgePoints?.length > 0 && <div className="an-kv"><b>知识点</b><span>{s.knowledgePoints.join('、')}</span></div>}
                                {s.practiceTasks?.length > 0 && <div className="an-kv"><b>实践任务</b><span>{s.practiceTasks.join('；')}</span></div>}
                                <div className="an-kv"><b>预计投入</b><span>{s.estimatedHours}（估计值）</span></div>
                                {s.deliverable && <div className="an-kv"><b>可检查产出</b><span>{s.deliverable}</span></div>}
                                {s.acceptance && <div className="an-kv"><b>验收标准</b><span>{s.acceptance}</span></div>}
                                {s.impact && <div className="an-kv"><b>作用</b><span>{s.impact}</span></div>}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {tab === 'questions' && (
                <div className="an-questions">
                  {data.answeredQuestions?.length > 0 && (
                    <div className="card card-pad" style={{ marginBottom: 12 }}>
                      <div className="an-side-title" style={{ marginBottom: 8 }}>已回答（{data.answeredQuestions.length}）</div>
                      {data.answeredQuestions.map((a, i) => (
                        <div key={i} className="an-answered">
                          <div className="an-muted">Q：{a.question}</div>
                          <div className="an-answered-text">A：{a.answer}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {questions.length === 0 ? (
                    <div className="card"><Empty icon="?" title={data.answeredQuestions?.length ? '没有新的待补充问题' : '没有需要补充的信息'} /></div>
                  ) : (
                    <>
                      <div className="an-section-head">
                        <div>只问对结论影响最大的问题；回答后系统会更新对应判断，不会重复追问。</div>
                      </div>
                      {data.answerUpdate?.changed?.length > 0 && (
                        <div className="callout ok" style={{ marginBottom: 12 }}>
                          上次回答后更新了 {data.answerUpdate.changed.length} 条判断：
                          {data.answerUpdate.changed.map(c => `「${c.name}」${c.from}→${c.to}`).join('；')}
                        </div>
                      )}
                      {questions.map((q, i) => (
                        <div key={q.id} className="card card-pad an-question">
                          <div className="an-question-head">
                            <span className="an-change-index">{i + 1}</span>
                            <div>
                              <div className="an-question-text">{q.question}</div>
                              {q.why && <div className="an-muted">{q.why}</div>}
                            </div>
                            {q.answer && <span className="st st-ok">已回答</span>}
                          </div>
                          {q.updates?.length > 0 && (
                            <div className="an-links">
                              {q.updates.map(id => {
                                const req = requirements.find(r => r.id === id)
                                return req ? <span key={id} className="tag">影响：{req.name}</span> : null
                              })}
                            </div>
                          )}
                          <textarea className="textarea" style={{ marginTop: 10, minHeight: 76 }}
                            placeholder={q.answer ? `已答：${q.answer}（可修改）` : '按事实简要回答，越具体越能更新判断'}
                            value={answers[q.id] ?? ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} />
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <button className="btn primary" disabled={answering} onClick={submitAnswers}>
                          {answering ? <span className="spin" /> : null} 提交回答并更新分析
                        </button>
                        <span className="an-muted">提交后会重新运行分析；原有采纳记录会保留。</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 行动侧栏 */}
            <aside className="an-side">
              <div className="card card-pad an-side-card">
                <div className="an-side-title">优先行动</div>
                {overview?.topRisks?.length ? overview.topRisks.slice(0, 3).map((k, i) => (
                  <div key={k.id} className="an-side-item">
                    <span className="an-side-num">{i + 1}</span>
                    <div>
                      <div>{k.text}</div>
                      <div className="an-muted">{k.type || ''}</div>
                    </div>
                  </div>
                )) : <div className="an-muted">暂无</div>}
                <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setTab('changes')}>查看简历修改</button>
              </div>

              <div className="card card-pad an-side-card">
                <div className="an-side-title">完成进度</div>
                <div className="an-progress-row">
                  <span>已采纳修改</span><b>{stats.adopted} / {changes.length}</b>
                </div>
                <div className="an-progress-bar"><i style={{ width: `${changes.length ? (stats.adopted / changes.length) * 100 : 0}%` }} /></div>
                <div className="an-progress-row">
                  <span>能力任务完成</span><b>{stats.skillsDone} / {skills.length}</b>
                </div>
                <div className="an-progress-bar"><i style={{ width: `${skills.length ? (stats.skillsDone / skills.length) * 100 : 0}%` }} /></div>
                <button className="btn primary sm" style={{ marginTop: 12, width: '100%' }} disabled={generating || stats.adopted === 0}
                  onClick={generateResume} title={stats.adopted === 0 ? '先在「简历修改」中采纳修改' : '用已采纳的修改生成新版本，原简历不变'}>
                  {generating ? <span className="spin" /> : null} 生成针对性简历
                </button>
                <div className="an-hint">原简历不会被修改，可随时撤销重来。</div>
              </div>

              <div className="card card-pad an-side-card">
                <div className="an-side-title">材料匹配参考分</div>
                {!scoring || scoring.applicable === false ? (
                  <div className="an-muted">
                    {scoring?.notice || '输入不足，不展示总分'}
                    <div style={{ marginTop: 6 }}>{scoring?.method}</div>
                  </div>
                ) : (
                  <>
                    <div className="an-score-line">
                      <span className="an-score">{scoring.score}</span>
                      <span className="an-muted">/ 100 · 覆盖 {scoring.coverage}%（{scoring.known}/{scoring.total} 条有判断）</span>
                    </div>
                    {scoring.qualified === false && (
                      <div className="callout warn" style={{ marginTop: 8, padding: '8px 10px' }}>
                        {scoring.notice || '存在未确认项，分数仅代表材料已体现的部分'}
                      </div>
                    )}
                    <div className="an-dims">
                      {scoring.dimensions.map(d => (
                        <div key={d.key} className="an-dim" title={d.note || ''}>
                          <span>{d.name}（{Math.round(d.weight * 100)}%）{d.unknown > 0 && <span className="an-muted"> · {d.unknown}项未知</span>}</span>
                          <span>
                            {d.score === null ? '未知' : d.score}
                            {d.partial && <span className="an-muted" title={d.note}>*</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                    {scoring.hardBlockers?.length > 0 && (
                      <div className="callout warn" style={{ marginTop: 10, padding: '8px 10px' }}>
                        硬性条件差距：{scoring.hardBlockers.map(b => b.text).join('、')}
                      </div>
                    )}
                    {scoring.dimensions.some(d => d.partial) && (
                      <div className="an-hint">* 该维度含待确认项，分数仅按已知项计算，不代表整维度结论。</div>
                    )}
                    <div className="an-hint">{scoring.method}</div>
                  </>
                )}
              </div>

              {overview?.unconfirmed?.length > 0 && (
                <div className="card card-pad an-side-card">
                  <div className="an-side-title">待确认事项</div>
                  {overview.unconfirmed.slice(0, 4).map(u => <div key={u.id} className="an-side-item"><span>·</span><div>{u.text}</div></div>)}
                  <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setTab('questions')}>去回答</button>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {showHistory && (
        <Modal title="历史分析记录" onClose={() => setShowHistory(false)}>
          {history.length === 0 ? <Empty icon="H" title="暂无历史分析" /> : history.map(h => (
            <div key={h.id} className="setting-row" style={{ cursor: 'pointer' }} onClick={() => loadHistory(h.id)}>
              <div>
                <div style={{ fontWeight: 600 }}>{h.jobTitles?.slice(0, 60)}{h.jobTitles?.length > 60 ? '…' : ''}</div>
                <div className="doc-meta">
                  {h.mode === 'ai' ? 'AI分析' : '基础检查'}
                  {h.status ? ` · ${h.status}` : ''} · 依据「{h.documentName}」· {new Date(h.updatedAt || h.createdAt).toLocaleString()}
                </div>
              </div>
              <span className="tag blue">查看</span>
            </div>
          ))}
        </Modal>
      )}
    </div>
  )
}

/* 摘要列表（优势/风险/待确认） */
function SummaryList({ title, items = [], tone, empty, onLink }) {
  return (
    <div className="an-summary">
      <div className="an-summary-title">{title}</div>
      {items.length === 0 ? <div className="an-muted">{empty}</div> : items.slice(0, 3).map((it, i) => (
        <button key={it.id || i} className="an-summary-item" onClick={() => onLink?.(it.requirementIds || [])}
          title={it.requirementIds?.length ? '查看对应要求' : ''}>
          <span className={toneClass(tone)}>{tone === 'ok' ? '✓' : tone === 'bad' ? '!' : '?'}</span>
          <span>{it.text}</span>
        </button>
      ))}
    </div>
  )
}

function jumpToReq(ids, setTab, setExpanded, requirements) {
  setTab('req')
  if (!ids?.length) return
  const next = {}
  for (const id of ids) if (requirements.some(r => r.id === id)) next[id] = true
  setExpanded(prev => ({ ...prev, ...next }))
}
