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
                {(d.parseMeta?.suspicious || (d.source === '文件上传' && (d.content || '').length < 200)) && (
                  <span className="tag red" title={(d.parseMeta?.warnings || []).join('；') || '正文可能没解析完整'} style={{ marginLeft: 6 }}>
                    解析可能不完整
                  </span>
                )}
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
  const [pending, setPending] = useState([])
  const fileRef = useRef(null)

  const readBase64 = (f) => new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1])
    r.onerror = rej
    r.readAsDataURL(f)
  })

  /* 先解析预览，用户确认「提取到什么」之后再入库，避免把 91 字的残缺简历当完整材料用 */
  const uploadFiles = async (files) => {
    setBusy(true)
    const list = []
    for (const f of files) {
      const docName = name || f.name.replace(/\.[^.]+$/, '')
      try {
        const b64 = await readBase64(f)
        const r = await api('/documents/parse', { method: 'POST', body: { fileBase64: b64, fileName: f.name } })
        list.push({ fileName: f.name, name: docName, b64, ...r })
      } catch (e) {
        if (e.status === 404) {
          // 旧版服务端没有预览接口（8787 尚未重启）：退回直接入库
          try {
            const b64 = await readBase64(f)
            await api('/documents', { method: 'POST', body: { fileBase64: b64, fileName: f.name, name: docName, type } })
            toast(`已导入「${f.name}」（旧版服务端，无解析预览）`)
          } catch (e2) { toast(`${f.name}：${e2.message}`, 'err') }
        } else toast(`${f.name}：${e.message}`, 'err')
      }
    }
    setPending(list)
    setName('')
    setBusy(false)
  }

  const retryOcr = async (idx) => {
    const item = pending[idx]
    if (!item) return
    setBusy(true)
    try {
      const r = await api('/documents/parse', { method: 'POST', body: { fileBase64: item.b64, fileName: item.fileName, ocr: true } })
      setPending(list => list.map((x, i) => i === idx ? { ...x, ...r } : x))
      toast(r.meta?.method === 'ocr' ? `OCR 完成，提取到 ${r.meta.chars} 字` : 'OCR 未明显改善，建议改用粘贴文本')
    } catch (e) { toast(e.message, 'err') }
    setBusy(false)
  }

  const savePending = async () => {
    setBusy(true)
    let ok = 0
    for (const p of pending) {
      try {
        await api('/documents', {
          method: 'POST',
          body: { name: p.name, type, source: '文件上传', content: p.text, parseMeta: p.meta },
        })
        ok++
      } catch (e) { toast(`${p.fileName}：${e.message}`, 'err') }
    }
    setBusy(false)
    if (ok) toast(`已保存 ${ok} 份资料`)
    setPending([])
    reload()
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
      {tab === 'file' && pending.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {pending.map((p, i) => {
            const meta = p.meta || {}
            const methodLabel = meta.method === 'ocr' ? '系统 OCR' : meta.method === 'docx' ? 'Word 文字' : 'PDF 文字层'
            return (
              <div key={p.fileName + i} className="card card-pad" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14 }}>{p.fileName}</b>
                  <span className="tag">{meta.chars || 0} 字</span>
                  {meta.pages > 0 && <span className="tag">{meta.pages} 页 · 约 {meta.charsPerPage} 字/页</span>}
                  <span className={'tag ' + (meta.method === 'ocr' ? 'blue' : '')}>{methodLabel}</span>
                  {meta.suspicious && <span className="tag red">解析不完整</span>}
                  {meta.suspicious && (
                    <button className="btn sm" disabled={busy} onClick={() => retryOcr(i)}>用系统 OCR 重新识别</button>
                  )}
                  <button className="btn sm" onClick={() => setPending(list => list.filter((_, x) => x !== i))}>移除</button>
                </div>
                {(meta.warnings || []).map((w, k) => (
                  <div key={k} className="callout warn" style={{ margin: '8px 0 0' }}>{w}</div>
                ))}
                <textarea className="textarea" value={p.text || ''} style={{ marginTop: 8, minHeight: 110, fontSize: 12.5 }}
                  onChange={e => setPending(list => list.map((x, k) => k === i ? { ...x, text: e.target.value } : x))} />
                <div className="hint" style={{ marginTop: 6 }}>
                  以上是实际入库的全文，可直接修改后再保存（例如 OCR 个别错字）。保存的是这份文本，不是原文件。
                </div>
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" disabled={busy} onClick={savePending}>确认保存 {pending.length} 份</button>
            <button className="btn" disabled={busy} onClick={() => setPending([])}>取消</button>
          </div>
        </div>
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
