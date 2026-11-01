import React, { useState } from 'react'
import { api } from './api.js'

export default function Settings({ settings, reload, toast }) {
  const [form, setForm] = useState({
    apiBase: settings?.apiBase || '', model: settings?.model || '', apiKey: '',
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

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
            ? '当前为「智能模式」：JD解析、匹配分析、共性提炼、简历改写均由大模型驱动。'
            : '当前为「简易模式」（未配置 Key）：仅提供关键词级匹配分析，JD解析与AI改简历不可用。'}
        </div>
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
            <input className="input" value={form.model} onChange={e => set('model', e.target.value)}
              placeholder={settings.defaults.model} />
          </div>
          <div className="field">
            <label>API Key {settings.hasKey && <span className="tag green">已配置</span>}</label>
            <input className="input" type="password" value={form.apiKey} onChange={e => set('apiKey', e.target.value)}
              placeholder={settings.hasKey ? '已保存（留空则不修改）' : 'sk-…'} />
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
    </div>
  )
}
