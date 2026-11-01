import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const dataDir = path.join(__dirname, 'data')
export const uploadsDir = path.join(dataDir, 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

const db = new DatabaseSync(path.join(dataDir, 'workbench.db'))
db.exec('PRAGMA journal_mode = WAL;')

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '',
  category TEXT DEFAULT '',
  company TEXT DEFAULT '',
  city TEXT DEFAULT '',
  recruitType TEXT DEFAULT '社招',
  expMin REAL DEFAULT 0,
  expMax REAL DEFAULT 99,
  experienceText TEXT DEFAULT '',
  salaryMin REAL,
  salaryMax REAL,
  salaryText TEXT DEFAULT '',
  salaryNote TEXT DEFAULT '',
  education TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  description TEXT DEFAULT '',
  source TEXT DEFAULT '手动添加',
  sourceUrl TEXT DEFAULT '',
  bossActive TEXT DEFAULT '',
  publishedAt TEXT,
  importedAt TEXT,
  favorite INTEGER DEFAULT 0,
  status TEXT DEFAULT '未处理',
  appliedAt TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  type TEXT DEFAULT '其他',
  source TEXT DEFAULT '粘贴文本',
  sourceUrl TEXT DEFAULT '',
  content TEXT DEFAULT '',
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobIds TEXT DEFAULT '[]',
  jobTitles TEXT DEFAULT '',
  documentId INTEGER,
  documentName TEXT DEFAULT '',
  mode TEXT DEFAULT 'ai',
  data TEXT DEFAULT '{}',
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  jobIds TEXT DEFAULT '[]',
  jobTitles TEXT DEFAULT '',
  documentId INTEGER,
  documentName TEXT DEFAULT '',
  content TEXT DEFAULT '',
  changeNotes TEXT DEFAULT '[]',
  createdAt TEXT,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

const now = () => new Date().toISOString()
const j = (v, d = '[]') => { try { return JSON.parse(v ?? d) } catch { return d } }

/* ---------- settings ---------- */
export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : null
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
}

/* ---------- jobs ---------- */
const JOB_FIELDS = ['title','category','company','city','recruitType','expMin','expMax',
  'experienceText','salaryMin','salaryMax','salaryText','salaryNote','education','tags',
  'description','source','sourceUrl','bossActive','publishedAt','favorite','status','appliedAt']

function normalizeJob(row) {
  return { ...row, tags: j(row.tags, []), favorite: !!row.favorite }
}

export function createJob(fields = {}) {
  const data = { importedAt: now(), ...fields }
  const keys = JOB_FIELDS.filter(k => data[k] !== undefined)
  const placeholders = keys.map(() => '?').join(',')
  const info = db.prepare(
    `INSERT INTO jobs (${keys.join(',')}) VALUES (${placeholders})`
  ).run(...keys.map(k => {
    const v = data[k]
    return k === 'tags' ? JSON.stringify(Array.isArray(v) ? v : []) : v
  }))
  return jobById(info.lastInsertRowid)
}

export function updateJob(id, fields = {}) {
  const keys = JOB_FIELDS.filter(k => fields[k] !== undefined)
  if (keys.length) {
    const sets = keys.map(k => `${k} = ?`).join(',')
    db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(
      ...keys.map(k => {
        const v = fields[k]
        return k === 'tags' ? JSON.stringify(Array.isArray(v) ? v : []) : v
      }),
      id
    )
  }
  return jobById(id)
}

export function jobById(id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  return row ? normalizeJob(row) : null
}

export function listJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC').all().map(normalizeJob)
}

export function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
}

export function jobExists({ sourceUrl, title, company, city }) {
  if (sourceUrl) {
    const r = db.prepare('SELECT id FROM jobs WHERE sourceUrl = ?').get(sourceUrl)
    if (r) return r.id
  }
  const r = db.prepare(
    'SELECT id FROM jobs WHERE title = ? AND company = ? AND city = ?'
  ).get(title || '', company || '', city || '')
  return r ? r.id : null
}

/* ---------- documents ---------- */
export function createDocument(fields = {}) {
  const info = db.prepare(
    'INSERT INTO documents (name, type, source, sourceUrl, content, createdAt) VALUES (?,?,?,?,?,?)'
  ).run(fields.name || '未命名', fields.type || '其他', fields.source || '粘贴文本',
        fields.sourceUrl || '', fields.content || '', now())
  return documentById(info.lastInsertRowid)
}
export function updateDocument(id, fields = {}) {
  const sets = [], vals = []
  for (const k of ['name', 'type', 'content']) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]) }
  }
  if (sets.length) db.prepare(`UPDATE documents SET ${sets.join(',')} WHERE id = ?`).run(...vals, id)
  return documentById(id)
}
export function documentById(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) || null
}
export function listDocuments() {
  return db.prepare('SELECT * FROM documents ORDER BY id DESC').all()
}
export function deleteDocument(id) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

/* ---------- analyses ---------- */
export function createAnalysis(a) {
  const info = db.prepare(
    'INSERT INTO analyses (jobIds, jobTitles, documentId, documentName, mode, data, createdAt) VALUES (?,?,?,?,?,?,?)'
  ).run(JSON.stringify(a.jobIds || []), a.jobTitles || '', a.documentId || null,
        a.documentName || '', a.mode || 'ai', JSON.stringify(a.data || {}), now())
  return analysisById(info.lastInsertRowid)
}
export function analysisById(id) {
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id)
  return row ? { ...row, jobIds: j(row.jobIds), data: j(row.data, '{}') } : null
}
export function listAnalyses() {
  return db.prepare(
    'SELECT id, jobIds, jobTitles, documentName, mode, createdAt FROM analyses ORDER BY id DESC'
  ).all().map(r => ({ ...r, jobIds: j(r.jobIds) }))
}
export function deleteAnalysis(id) {
  db.prepare('DELETE FROM analyses WHERE id = ?').run(id)
}

/* ---------- resume versions ---------- */
export function createResumeVersion(r) {
  const info = db.prepare(
    'INSERT INTO resume_versions (name, jobIds, jobTitles, documentId, documentName, content, changeNotes, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(r.name || '定制简历', JSON.stringify(r.jobIds || []), r.jobTitles || '',
        r.documentId || null, r.documentName || '', r.content || '',
        JSON.stringify(r.changeNotes || []), now(), now())
  return resumeVersionById(info.lastInsertRowid)
}
export function updateResumeVersion(id, fields = {}) {
  if (fields.content !== undefined || fields.name !== undefined) {
    const sets = ['updatedAt = ?']; const vals = [now()]
    if (fields.content !== undefined) { sets.push('content = ?'); vals.push(fields.content) }
    if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name) }
    db.prepare(`UPDATE resume_versions SET ${sets.join(',')} WHERE id = ?`).run(...vals, id)
  }
  return resumeVersionById(id)
}
export function resumeVersionById(id) {
  const row = db.prepare('SELECT * FROM resume_versions WHERE id = ?').get(id)
  return row ? { ...row, jobIds: j(row.jobIds), changeNotes: j(row.changeNotes) } : null
}
export function listResumeVersions() {
  return db.prepare(
    'SELECT id, name, jobIds, jobTitles, documentName, createdAt, updatedAt FROM resume_versions ORDER BY id DESC'
  ).all().map(r => ({ ...r, jobIds: j(r.jobIds) }))
}
export function deleteResumeVersion(id) {
  db.prepare('DELETE FROM resume_versions WHERE id = ?').run(id)
}
