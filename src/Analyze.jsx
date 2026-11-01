import React, { useEffect, useState } from 'react'
import { api, fmtSalary } from './api.js'
import { Modal, ScoreRing, Empty } from './common.jsx'

export default function Analyze({ jobs, docs, selectedIds, setSelectedIds, lastAnalysis, setLastAnalysis, onGotoResume, toast, settings }) {
  const [docId, setDocId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [view, setView] = useState(lastAnalysis) // 当前展示的分析

  useEffect(() => { setView(lastAnalysis) }, [lastAnalysis])
  useEffect(() => {
    api('/analyses').then(setHistory).catch(() => {})
  }, [])
  useEffect(() => {
    if (!docId && docs.length) {
      const r = docs.find(d => d.type === '简历')
      if (r) setDocId(r.id)
    }
  }, [docs])

  const toggleJob = (id) => {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  const run = async () => {
    if (!selectedIds.length) return toast('请先勾选至少一个岗位', 'err')
    if (!docId) return toast('请先在「信息库」上传简历/经历资料，再在这里选择', 'err')
    setBusy(true)
    try {
      const a = await api('/analyze', { method: 'POST', body: { jobIds: selectedIds, documentId: docId } })
      setView(a)
      setLastAnalysis(a)
      api('/analyses').then(setHistory).catch(() => {})
      toast(`分析完成（${a.mode === 'ai' ? 'AI智能分析' : '简易关键词模式'}）`)
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  const loadHistory = async (id) => {
    try { setView(await api(`/analyses/${id}`)); setShowHistory(false) } catch (e) { toast(e.message, 'err') }
  }

  const selectedJobs = jobs.filter(j => selectedIds.includes(j.id))
  const doc = docs.find(d => d.id === docId)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">🔍 JD 匹配分析</div>
          <div className="page-sub">
            选择岗位（可多选）与你的经历资料，AI 对比分析匹配度与差距；多选时自动提炼<b>共性要求</b>作为建议输入。
            {settings && !settings.ready && <span style={{ color: 'var(--warn)' }}>（当前为简易模式，配置 AI Key 后解锁深度分析）</span>}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setShowHistory(true)}>🕘 历史分析</button>
          <button className="btn primary" disabled={busy} onClick={run}>
            {busy ? <span className="spin" /> : '⚡'} 开始分析{selectedIds.length > 1 ? `（${selectedIds.length}个岗位）` : ''}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 5fr) minmax(280px, 4fr)', gap: 16, alignItems: 'start' }}>
        <div className="card card-pad">
          <div className="sec-title" style={{ marginTop: 0 }}>① 选择岗位（已选 {selectedIds.length}）</div>
          {jobs.length === 0 && <Empty icon="🗂" title="岗位库为空">请先去「岗位库」导入岗位</Empty>}
          <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map(j => (
              <label key={j.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px',
                border: '1px solid ' + (selectedIds.includes(j.id) ? 'var(--primary)' : 'var(--border)'),
                borderRadius: 8, cursor: 'pointer', background: selectedIds.includes(j.id) ? 'var(--primary-weak)' : '#fff',
              }}>
                <input type="checkbox" checked={selectedIds.includes(j.id)} onChange={() => toggleJob(j.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{j.title} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12.5 }}>{j.company}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--faint)' }}>{j.city || '未知城市'} · {fmtSalary(j)}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="card card-pad">
          <div className="sec-title" style={{ marginTop: 0 }}>② 选择我的资料</div>
          {docs.length === 0 ? (
            <Empty icon="📚" title="信息库为空">先去「信息库」上传简历或项目经历</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}>
              {docs.map(d => (
                <label key={d.id} style={{
                  display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px',
                  border: '1px solid ' + (docId === d.id ? 'var(--primary)' : 'var(--border)'),
                  borderRadius: 8, cursor: 'pointer', background: docId === d.id ? 'var(--primary-weak)' : '#fff',
                }}>
                  <input type="radio" name="doc" checked={docId === d.id} onChange={() => setDocId(d.id)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{d.name} <span className="tag blue" style={{ marginLeft: 6 }}>{d.type}</span></div>
                    <div style={{ fontSize: 12, color: 'var(--faint)' }}>{(d.content || '').length} 字 · {d.source}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
          {busy && (
            <div className="progress-text" style={{ marginTop: 14 }}>
              <span className="spin dark" />
              {selectedIds.length > 1 ? `正在提炼共性要求 + 逐岗分析（共 ${selectedIds.length} 个），约需1-2分钟…` : '正在深度分析 JD 与你的经历，约需30秒…'}
            </div>
          )}
        </div>
      </div>

      {view && (
        <div style={{ marginTop: 20 }}>
          <div className="card card-pad" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <span className={'tag ' + (view.mode === 'ai' ? 'green' : 'orange')}>{view.mode === 'ai' ? 'AI智能分析' : '简易模式'}</span>
              <b style={{ marginLeft: 8 }}>{view.jobTitles}</b>
              <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 4 }}>
                依据资料：{view.documentName} · {new Date(view.createdAt).toLocaleString()}
              </div>
            </div>
            <button className="btn primary" onClick={() => onGotoResume(view.jobIds)}>✨ 基于本次分析去生成简历 →</button>
          </div>

          {view.data?.common?.commonRequirements?.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 14, background: 'linear-gradient(180deg, #f6f9ff, #fff)' }}>
              <div className="sec-title" style={{ marginTop: 0 }}>🧩 多岗位共性要求提炼</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {view.data.common.commonRequirements.map((r, i) => (
                  <div key={i} className="suggestion-item">
                    <span className={'tag ' + (r.weight === '核心' ? 'red' : r.weight === '重要' ? 'orange' : '')}>{r.weight || '要求'}</span>
                    <div><b>{r.requirement}</b>{r.why ? <span style={{ color: 'var(--muted)' }}> — {r.why}</span> : null}</div>
                  </div>
                ))}
              </div>
              {view.data.common.overallAdvice && (
                <div className="callout info" style={{ marginTop: 12 }}>
                  <b>综合建议：</b>{view.data.common.overallAdvice}
                  {view.data.common.resumeStrategy && <div style={{ marginTop: 6 }}><b>简历策略：</b>{view.data.common.resumeStrategy}</div>}
                </div>
              )}
            </div>
          )}

          {view.data?.results?.map(r => (
            <div key={r.jobId} className="card card-pad" style={{ marginBottom: 14 }}>
              {r.error ? (
                <div className="callout warn">「{r.jobTitle}」分析失败：{r.error}</div>
              ) : (
                <>
                  <div className="analysis-head">
                    <ScoreRing score={r.matchScore} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{r.jobTitle} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{r.company}</span></div>
                      <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{r.summary}</div>
                    </div>
                  </div>
                  {r.strengths?.length > 0 && (
                    <>
                      <div className="sec-title">💪 匹配亮点</div>
                      <div className="suggestion-list">
                        {r.strengths.map((s, i) => <div key={i} className="suggestion-item"><span className="dot">✓</span><div>{s}</div></div>)}
                      </div>
                    </>
                  )}
                  {r.gaps?.length > 0 && (
                    <>
                      <div className="sec-title">⚠️ 差距分析</div>
                      <table className="gap-table">
                        <thead><tr><th style={{ width: 200 }}>差距点</th><th style={{ width: 60 }}>影响</th><th>弥补建议</th></tr></thead>
                        <tbody>
                          {r.gaps.map((g, i) => (
                            <tr key={i}>
                              <td>{g.item}</td>
                              <td><span className={'tag ' + (g.level === '高' ? 'red' : g.level === '中' ? 'orange' : '')}>{g.level || '中'}</span></td>
                              <td style={{ color: 'var(--muted)' }}>{g.advice}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {(r.knowledgeToFill?.length || r.resumeFocus?.length || r.resumeEdits?.length) ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 6 }}>
                      {r.knowledgeToFill?.length > 0 && (
                        <div>
                          <div className="sec-title">📚 建议补齐的知识</div>
                          <div className="suggestion-list">
                            {r.knowledgeToFill.map((s, i) => <div key={i} className="suggestion-item"><span className="dot">·</span><div>{s}</div></div>)}
                          </div>
                        </div>
                      )}
                      {r.resumeFocus?.length > 0 && (
                        <div>
                          <div className="sec-title">🎯 简历重点描写</div>
                          <div className="suggestion-list">
                            {r.resumeFocus.map((s, i) => <div key={i} className="suggestion-item"><span className="dot">·</span><div>{s}</div></div>)}
                          </div>
                        </div>
                      )}
                      {r.resumeEdits?.length > 0 && (
                        <div>
                          <div className="sec-title">✏️ 简历具体修改</div>
                          <div className="suggestion-list">
                            {r.resumeEdits.map((s, i) => <div key={i} className="suggestion-item"><span className="dot">·</span><div>{s}</div></div>)}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {showHistory && (
        <Modal title="🕘 历史分析记录" onClose={() => setShowHistory(false)}>
          {history.length === 0 ? <Empty icon="🕘" title="暂无历史分析" /> : history.map(h => (
            <div key={h.id} className="setting-row" style={{ cursor: 'pointer' }} onClick={() => loadHistory(h.id)}>
              <div>
                <div style={{ fontWeight: 600 }}>{h.jobTitles?.slice(0, 60)}{h.jobTitles?.length > 60 ? '…' : ''}</div>
                <div className="doc-meta">{h.mode === 'ai' ? 'AI分析' : '简易模式'} · 依据「{h.documentName}」· {new Date(h.createdAt).toLocaleString()}</div>
              </div>
              <span className="tag blue">查看</span>
            </div>
          ))}
        </Modal>
      )}
    </div>
  )
}
