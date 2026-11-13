import React, { useEffect, useMemo, useState } from 'react'
import { api, download, copyText } from './api.js'
import { Empty, Modal } from './common.jsx'
import { marked } from 'marked'

export default function ResumeStudio({
  jobs, docs, resumeTargets, setResumeTargets, lastAnalysis,
  pendingVersionId, clearPendingVersion, toast, settings,
}) {
  const [docId, setDocId] = useState(null)
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(null)   // 当前编辑的版本（含 id/content/changeNotes）
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState('split')      // edit | preview | split
  const [versions, setVersions] = useState([])
  const [viewNotes, setViewNotes] = useState(null)

  useEffect(() => {
    api('/resumes').then(setVersions).catch(() => {})
  }, [])
  useEffect(() => {
    if (!docId && docs.length) {
      const r = docs.find(d => d.type === '简历')
      if (r) setDocId(r.id)
    }
  }, [docs])

  const toggleJob = (id) => {
    setResumeTargets(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  const generate = async () => {
    if (!resumeTargets.length) return toast('请先选择目标岗位（可单选或多个）', 'err')
    if (!docId) return toast('请先在「信息库」上传基础简历，再在这里选择', 'err')
    setBusy(true)
    try {
      const r = await api('/rewrite', {
        method: 'POST',
        body: { jobIds: resumeTargets, documentId: docId, extra, analysisId: lastAnalysis?.id },
      })
      setVersion(r.version)
      setContent(r.version.content)
      setDirty(false)
      api('/resumes').then(setVersions).catch(() => {})
      toast('定制简历已生成，可在下方编辑器手动修改并保存')
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  const save = async () => {
    if (!version) return
    try {
      await api(`/resumes/${version.id}`, { method: 'PUT', body: { content, name: version.name } })
      setDirty(false)
      toast('已保存修改')
    } catch (e) { toast(e.message, 'err') }
  }

  const loadVersion = async (id) => {
    try {
      const v = await api(`/resumes/${id}`)
      setVersion(v); setContent(v.content); setDirty(false)
    } catch (e) { toast(e.message, 'err') }
  }

  // 从「JD分析」采纳修改后跳转过来：直接载入刚生成的版本
  useEffect(() => {
    if (!pendingVersionId) return
    loadVersion(pendingVersionId)
    clearPendingVersion?.()
  }, [pendingVersionId])

  const removeVersion = async (id) => {
    if (!confirm('确定删除该简历版本？')) return
    try {
      await api(`/resumes/${id}`, { method: 'DELETE' })
      if (version?.id === id) { setVersion(null); setContent('') }
      api('/resumes').then(setVersions).catch(() => {})
      toast('已删除')
    } catch (e) { toast(e.message, 'err') }
  }

  const html = useMemo(() => marked.parse(content || '', { breaks: true }), [content])
  const targetJobs = jobs.filter(j => resumeTargets.includes(j.id))
  const common = lastAnalysis?.data?.common?.commonRequirements

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">✨ AI 智能改简历</div>
          <div className="page-sub">
            以面试官视角，按目标岗位（单选=针对性改写 / 多选=按共性要求改写）重写简历；生成后支持手动编辑。
            {settings && !settings.ready && <span style={{ color: 'var(--warn)' }}>（需在「设置」配置 AI Key）</span>}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 5fr) minmax(280px, 4fr)', gap: 16, alignItems: 'start' }}>
        <div className="card card-pad">
          <div className="sec-title" style={{ marginTop: 0 }}>① 目标岗位（已选 {resumeTargets.length}）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
            {jobs.map(j => (
              <label key={j.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px',
                border: '1px solid ' + (resumeTargets.includes(j.id) ? 'var(--primary)' : 'var(--border)'),
                borderRadius: 8, cursor: 'pointer', background: resumeTargets.includes(j.id) ? 'var(--primary-weak)' : '#fff',
              }}>
                <input type="checkbox" checked={resumeTargets.includes(j.id)} onChange={() => toggleJob(j.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{j.title} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12.5 }}>{j.company}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--faint)' }}>{j.city || '未知城市'} · {j.salaryText || ''}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="card card-pad">
          <div className="sec-title" style={{ marginTop: 0 }}>② 基础简历与要求</div>
          <div className="field">
            <label>基础简历（来自信息库）</label>
            <select className="select" value={docId || ''} onChange={e => setDocId(+e.target.value)}>
              <option value="">— 请选择 —</option>
              {docs.map(d => <option key={d.id} value={d.id}>{d.name}（{d.type}，{(d.content || '').length}字）</option>)}
            </select>
            {!docs.length && <div className="hint">还没有资料，请先到「信息库」上传简历</div>}
          </div>
          <div className="field">
            <label>补充要求（选填）</label>
            <textarea className="textarea" value={extra} onChange={e => setExtra(e.target.value)}
              placeholder="例如：突出数据增长类成果；篇幅控制在一页；避免提及xx" />
          </div>
          {common?.length > 0 && (
            <div className="callout info" style={{ marginBottom: 12 }}>
              <b>将参考上次分析的共性要求：</b>{common.slice(0, 5).map(r => r.requirement).join('、')}{common.length > 5 ? ' 等' : ''}
            </div>
          )}
          <button className="btn primary" disabled={busy} onClick={generate}>
            {busy ? <><span className="spin" /> 生成中（约1-2分钟）…</> : '🪄 生成定制简历'}
          </button>
        </div>
      </div>

      {targetJobs.length > 0 && version && (
        <div className="card card-pad" style={{ marginTop: 16, background: 'linear-gradient(180deg,#f6f9ff,#fff)' }}>
          <b>本版本依据：</b>{version.jobTitles || targetJobs.map(j => j.title).join('、')}
          <span style={{ color: 'var(--faint)', fontSize: 12 }}>（基础简历：{version.documentName} · {new Date(version.createdAt).toLocaleString()}）</span>
        </div>
      )}

      {version?.analysisId && (
        <div className="callout info" style={{ marginTop: 10 }}>
          该版本由「JD 匹配分析」中采纳的 {version.adoptedChangeIds?.length || 0} 条修改生成；<b>原始简历未被改动</b>。
          如需回到原版，可在下方版本历史载入其它版本，或回分析页撤销采纳后重新生成。
        </div>
      )}

      {version?.changeNotes?.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <div className="sec-title" style={{ marginTop: 0 }}>📝 主要改动说明
            <button className="btn sm ghost" onClick={() => setViewNotes(version)}>放大查看</button>
          </div>
          <div className="suggestion-list">
            {version.changeNotes.map((n, i) => (
              <div key={i} className="suggestion-item" style={i > 2 ? { display: 'none' } : null}>
                <span className="dot">{i + 1}.</span><div>{n}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {content ? (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {[['edit', '只看编辑'], ['split', '双栏对照'], ['preview', '只看预览']].map(([v, l]) => (
                <button key={v} className={'chip' + (mode === v ? ' active' : '')} onClick={() => setMode(v)}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {dirty && <span className="tag orange" style={{ alignSelf: 'center' }}>有未保存修改</span>}
              <button className="btn sm" onClick={save}>💾 保存修改</button>
              <button className="btn sm" onClick={async () => { (await copyText(content)) ? toast('已复制到剪贴板') : toast('复制失败', 'err') }}>📋 复制全文</button>
              <button className="btn sm" onClick={() => download(`${version?.name || '定制简历'}.md`, content)}>⬇ 下载 .md</button>
              <button className="btn sm" onClick={() => window.print()}>🖨 打印/PDF</button>
              <button className="btn sm" disabled={busy} onClick={generate}>🔄 重新生成</button>
            </div>
          </div>
          <div className={'editor-wrap' + (mode === 'split' ? '' : ' single')}>
            {mode !== 'preview' && (
              <div className="editor-pane">
                <div className="pane-head"><span>Markdown 编辑（可直接修改）</span><span>{content.length} 字</span></div>
                <textarea value={content} onChange={e => { setContent(e.target.value); setDirty(true) }} />
              </div>
            )}
            {mode !== 'edit' && (
              <div className="editor-pane">
                <div className="pane-head"><span>预览（面试官视角排版）</span></div>
                <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <Empty icon="✨" title="还没有生成定制简历">
            选择目标岗位和基础简历后点击「生成定制简历」。生成后可在编辑器中手动微调，所有版本都会保留在下方。
          </Empty>
        </div>
      )}

      {versions.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ padding: '14px 18px 0', fontWeight: 700 }}>📚 版本历史（{versions.length}）</div>
          {versions.map(v => (
            <div key={v.id} className="doc-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="doc-name">{v.name} {version?.id === v.id && <span className="tag green">当前</span>}</div>
                <div className="doc-meta">{v.jobTitles?.slice(0, 80)} · {new Date(v.createdAt).toLocaleString()}</div>
              </div>
              <button className="btn sm" onClick={() => loadVersion(v.id)}>载入</button>
              <button className="btn sm ghost danger" onClick={() => removeVersion(v.id)}>删除</button>
            </div>
          ))}
        </div>
      )}

      {viewNotes && (
        <Modal title="📝 相对原简历的主要改动" onClose={() => setViewNotes(null)} wide>
          <div className="suggestion-list">
            {viewNotes.changeNotes.map((n, i) => (
              <div key={i} className="suggestion-item"><span className="dot">{i + 1}.</span><div>{n}</div></div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
