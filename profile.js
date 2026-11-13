/* 个人配置档案（profile）
 * 目的：把「搜索条件 / 打招呼 / 分析参数 / 采集配置」抽成一份可版本化的 JSON，
 * 放进自己的私有仓库同步，公开仓库里只留代码。
 *
 * 白名单原则：只认下面这 4 个键，其余一律丢弃——API Key、简历正文、岗位库、分析结果
 * 永远不会出现在导出文件里。 */
import fs from 'node:fs'
import { normalizeGreeting } from './greeting.js'
import { normalizeTuning } from './analysis.js'

export const PROFILE_VERSION = 1
export const PROFILE_KEYS = ['filters', 'greeting', 'analysis', 'schedule']
export const PROFILE_FILENAME = 'config.local.json'

const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
const int = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

/* 岗位库筛选（与 src/Jobs.jsx 的 DEFAULT_FILTERS 对齐；只留可移植字段） */
export const FILTER_KEYS = ['query', 'city', 'exp', 'salary', 'view', 'sort', 'domains']

export function sanitizeFilters(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const k of ['query', 'city', 'exp', 'view', 'sort']) {
    if (typeof src[k] === 'string') out[k] = str(src[k], 40)
  }
  if (src.salary !== undefined) out.salary = int(src.salary, 0, 100, 0)
  if (Array.isArray(src.domains)) out.domains = [...new Set(src.domains.filter(d => typeof d === 'string').map(d => str(d, 20)))].slice(0, 30)
  return out
}

/* 采集配置：与 scheduler.js 的 saveScheduleConfig 同样的边界 */
export function sanitizeSchedule(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  if (src.enabled !== undefined) out.enabled = bool(src.enabled, false)
  const hm = typeof src.time === 'string' ? src.time.trim().match(/^(\d{2}):(\d{2})$/) : null
  if (hm && +hm[1] < 24 && +hm[2] < 60) out.time = `${hm[1]}:${hm[2]}`
  for (const k of ['city', 'keyword', 'experience', 'degree']) {
    const v = str(src[k], 40)
    if (v) out[k] = v
  }
  if (src.pages !== undefined) out.pages = int(src.pages, 1, 10, 3)
  if (src.maxDetails !== undefined) out.maxDetails = int(src.maxDetails, 0, 50, 0)
  return out
}

/* 归一化一份 profile：未知键丢弃，已知键走各自的 normalize */
export function normalizeProfile(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const profile = { version: PROFILE_VERSION }
  if (src.exportedAt) profile.exportedAt = str(src.exportedAt, 40)
  if (src.filters !== undefined) profile.filters = sanitizeFilters(src.filters)
  if (src.greeting !== undefined) profile.greeting = normalizeGreeting(src.greeting)
  if (src.analysis !== undefined) profile.analysis = normalizeTuning(src.analysis)
  if (src.schedule !== undefined) profile.schedule = sanitizeSchedule(src.schedule)
  return profile
}

/* 从当前运行状态组装 profile（导出用） */
export function buildProfile({ filters, greeting, analysis, schedule } = {}) {
  return normalizeProfile({
    exportedAt: new Date().toISOString(),
    filters: filters ?? {},
    greeting: greeting ?? {},
    analysis: analysis ?? {},
    schedule: schedule ?? {},
  })
}

export function readProfileFile(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, profile: null }
    const raw = fs.readFileSync(file, 'utf8')
    return { exists: true, profile: normalizeProfile(JSON.parse(raw)) }
  } catch (e) {
    return { exists: true, profile: null, error: `配置文件解析失败：${e.message}` }
  }
}

export function writeProfileFile(file, profile) {
  const clean = normalizeProfile(profile)
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return file
}
