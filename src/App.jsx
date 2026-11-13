import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import Jobs from './Jobs.jsx'
import Analyze from './Analyze.jsx'
import ResumeStudio from './ResumeStudio.jsx'
import Library from './Library.jsx'
import Settings from './Settings.jsx'

const TABS = [
  { key: 'jobs', icon: '🗂', label: '岗位库' },
  { key: 'analyze', icon: '🔍', label: 'JD分析' },
  { key: 'resume', icon: '✨', label: 'AI改简历' },
  { key: 'library', icon: '📚', label: '信息库' },
  { key: 'settings', icon: '⚙️', label: '设置' },
]

let toastTimer = null

export default function App() {
  const [tab, setTab] = useState('jobs')
  const [jobs, setJobs] = useState([])
  const [docs, setDocs] = useState([])
  const [settings, setSettings] = useState(null)
  const [selectedIds, setSelectedIds] = useState([])
  const [resumeTargets, setResumeTargets] = useState([])
  const [pendingVersionId, setPendingVersionId] = useState(null)
  const [lastAnalysis, setLastAnalysis] = useState(null)
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setToast(null), 3200)
  }, [])

  const reloadJobs = useCallback(async () => {
    try { setJobs(await api('/jobs')) } catch (e) { showToast(e.message, 'err') }
  }, [showToast])
  const reloadDocs = useCallback(async () => {
    try { setDocs(await api('/documents')) } catch (e) { showToast(e.message, 'err') }
  }, [showToast])
  const reloadSettings = useCallback(async () => {
    try { setSettings(await api('/settings')) } catch {}
  }, [])

  useEffect(() => { reloadJobs(); reloadDocs(); reloadSettings() }, [])

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">求职工作台<small>岗位 · 分析 · 简历 · 资料</small></div>
        <nav className="nav">
          {TABS.map(t => (
            <button key={t.key} className={'nav-item' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              <span className="icon">{t.icon}</span>
              <span className="label">
                {t.label}
                {t.key === 'jobs' && selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {settings && (
            <span className={'mode-badge ' + (settings.ready ? 'ai' : 'simple')}>
              {settings.ready ? '● 智能模式' : '● 简易模式'}
            </span>
          )}
          <div style={{ marginTop: 8 }}>数据仅存于本机 data/ 目录</div>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {tab === 'jobs' && (
            <Jobs
              jobs={jobs} reload={reloadJobs} toast={showToast}
              selectedIds={selectedIds} setSelectedIds={setSelectedIds}
              onGotoAnalyze={() => setTab('analyze')}
            />
          )}
          {tab === 'analyze' && (
            <Analyze
              jobs={jobs} docs={docs} reloadDocs={reloadDocs}
              selectedIds={selectedIds} setSelectedIds={setSelectedIds}
              lastAnalysis={lastAnalysis} setLastAnalysis={setLastAnalysis}
              onGotoResume={(jobIds, versionId) => {
                setResumeTargets(jobIds || [])
                setPendingVersionId(versionId || null)
                setTab('resume')
              }}
              toast={showToast} settings={settings}
            />
          )}
          {tab === 'resume' && (
            <ResumeStudio
              jobs={jobs} docs={docs}
              resumeTargets={resumeTargets} setResumeTargets={setResumeTargets}
              lastAnalysis={lastAnalysis}
              pendingVersionId={pendingVersionId}
              clearPendingVersion={() => setPendingVersionId(null)}
              toast={showToast} settings={settings}
            />
          )}
          {tab === 'library' && <Library docs={docs} reload={reloadDocs} toast={showToast} />}
          {tab === 'settings' && <Settings settings={settings} reload={reloadSettings} toast={showToast} />}
        </div>
      </main>

      {toast && <div className={'toast' + (toast.type === 'err' ? ' err' : '')}>{toast.msg}</div>}
    </div>
  )
}
