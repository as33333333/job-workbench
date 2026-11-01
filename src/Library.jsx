import React, { useRef, useState } from 'react'
import { api } from './api.js'
import { Modal, Empty } from './common.jsx'

const TYPES = ['简历', '项目文档', '工作成果', '笔记', '链接', '其他']
const TYPE_ICON = { 简历: '📄', 项目文档: '📁', 工作成果: '🏆', 笔记: '🗒', 链接: '🔗', 其他: '📎' }
const TYPE_COLOR = { 简历: 'blue', 项目文档: 'purple', 工作成果: 'green', 笔记: 'orange', 链接: '', 其他: '' }

export default function Library({ docs, reload, toast }) {
  const [typeFilter, setTypeFilter] = useState('全部')
  const [preview, setPreview] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [tab, setTab] = useState('file')

  const filtered = typeFilter === '全部' ? docs : docs.filter(d => d.type === typeFilter)

  const remove = async (d) => {
    if (!confirm(`确定删除「${d.name}」？`)) return
    try { await api(`/documents/${d.id}`, { method: 'DELETE' }); reload(); toast('已删除') }
    catch (e) { toast(e.message, 'err') }
  }

  const changeType = async (d, type) => {
    try { await api(`/documents/${d.id}`, { method: 'PUT', body: { type } }); reload() }
    catch (e) { toast(e.message, 'err') }
  }

  const rename = async (d) => {
    const name = prompt('重命名资料：', d.name)
    if (!name || name === d.name) return
    try { await api(`/documents/${d.id}`, { method: 'PUT', body: { name } }); reload(); toast('已重命名') }
    catch (e) { toast(e.message, 'err') }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">📚 信息库</div>
          <div className="page-sub">上传简历、项目文档、工作成果，供 JD 分析与 AI 改简历使用；支持文件 / 粘贴文本 / 在线链接</div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <AddPanel tab={tab} setTab={setTab} reload={reload} toast={toast} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {['全部', ...TYPES].map(t => (
          <button key={t} className={'chip' + (typeFilter === t ? ' active' : '')} onClick={() => setTypeFilter(t)}>{t}</button>
        ))}
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <Empty icon="📚" title="还没有资料">
            建议先上传 1 份「简历」和几份「项目文档 / 工作成果」——分析得越细，AI 匹配与改简历越准。
          </Empty>
        ) : filtered.map(d => (
          <div key={d.id} className="doc-row">
            <div className="doc-icon" style={{ background: 'var(--primary-weak)' }}>{TYPE_ICON[d.type] || '📎'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="doc-name">{d.name}</div>
              <div className="doc-meta">
                <span className={'tag ' + (TYPE_COLOR[d.type] || '')}>{d.type}</span>{' '}
                {(d.content || '').length} 字 · {d.source}{d.sourceUrl ? ` · ${d.sourceUrl.slice(0, 50)}` : ''} · {new Date(d.createdAt).toLocaleString()}
              </div>
            </div>
            <button className="btn sm" onClick={() => setPreview(d)}>查看</button>
            <button className="btn sm ghost" onClick={() => rename(d)}>重命名</button>
            <select className="select" style={{ width: 100 }} value={d.type} onChange={e => changeType(d, e.target.value)}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="btn sm ghost danger" onClick={() => remove(d)}>删除</button>
          </div>
        ))}
      </div>

      {preview && (
        <Modal title={`${preview.name}（${(preview.content || '').length} 字）`} onClose={() => setPreview(null)} wide>
          <div style={{ maxHeight: '60vh', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.8, color: 'var(--text)' }}>
            {preview.content}
          </div>
        </Modal>
      )}
      {renaming && null}
    </div>
  )
}

function AddPanel({ tab, setTab, reload, toast }) {
  const [type, setType] = useState('简历')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef(null)

  const uploadFiles = async (files) => {
    for (const f of files) {
      setBusy(true)
      try {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader()
          r.onload = () => res(String(r.result).split(',')[1])
          r.onerror = rej
          r.readAsDataURL(f)
        })
        await api('/documents', {
          method: 'POST',
          body: { fileBase64: b64, fileName: f.name, name: name || f.name.replace(/\.[^.]+$/, ''), type },
        })
        toast(`已导入「${f.name}」`)
      } catch (e) { toast(`${f.name}：${e.message}`, 'err') }
      setBusy(false)
    }
    setName(''); reload()
  }

  const submitText = async () => {
    setBusy(true)
    try {
      await api('/documents', { method: 'POST', body: { name: name || '粘贴的文本', type: type === '链接' ? '笔记' : type, source: '粘贴文本', content: text } })
      toast('已保存文本')
      setText(''); setName(''); reload()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  const submitUrl = async () => {
    setBusy(true)
    try {
      const d = await api('/documents', { method: 'POST', body: { url, type: '链接', name: name || undefined } })
      toast(`已抓取「${d.name}」`)
      setUrl(''); setName(''); reload()
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="modal-tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
          {[['file', '📎 上传文件'], ['text', '📋 粘贴文本'], ['url', '🔗 在线链接']].map(([v, l]) => (
            <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>{l}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>资料类型</span>
          <select className="select" style={{ width: 110 }} value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {tab === 'file' && (
        <label
          className={'dropzone' + (drag ? ' drag' : '')}
          style={{ display: 'block' }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]) }}
        >
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.json,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files.length) uploadFiles([...e.target.files]) }} />
          {busy ? <span className="progress-text"><span className="spin dark" /> 正在解析文件…</span> : (
            <>
              <div style={{ fontSize: 15, marginBottom: 4 }}>拖拽文件到这里，或点击选择</div>
              <div style={{ fontSize: 12 }}>支持 PDF / Word(.docx) / TXT / Markdown，单文件 ≤ 20MB；简历建议用 PDF 或 docx</div>
            </>
          )}
        </label>
      )}
      {tab === 'text' && (
        <div>
          <div className="field"><label>名称</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：2023年XX项目复盘" /></div>
          <div className="field"><label>内容</label>
            <textarea className="textarea" style={{ minHeight: 130 }} value={text} onChange={e => setText(e.target.value)}
              placeholder="粘贴项目经历、工作总结、获奖成果等文本" />
          </div>
          <button className="btn primary" disabled={busy || text.trim().length < 5} onClick={submitText}>保存到信息库</button>
        </div>
      )}
      {tab === 'url' && (
        <div>
          <div className="field"><label>网页链接</label><input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…（文章/文档分享链接）" /></div>
          <div className="callout warn" style={{ margin: '0 0 12px' }}>会尽力抓取网页正文；需登录的页面（如飞书私有文档、Boss直聘）建议直接复制文本粘贴。</div>
          <button className="btn primary" disabled={busy || !url} onClick={submitUrl}>{busy ? <span className="spin" /> : '🔗'} 抓取并保存</button>
        </div>
      )}
    </div>
  )
}
