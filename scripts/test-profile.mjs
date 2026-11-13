/* 个人配置档案自测：白名单、边界夹紧、敏感字段不外泄（不依赖 DB / 网络） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROFILE_KEYS, FILTER_KEYS, buildProfile, normalizeProfile, sanitizeFilters, sanitizeSchedule,
  readProfileFile, writeProfileFile,
} from '../profile.js'

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => { if (cond) pass++; else fails.push(`${name}${extra ? ` — ${extra}` : ''}`) }

/* ---------- 白名单 ---------- */
const dirty = normalizeProfile({
  filters: { query: '产品经理', city: '深圳', salary: '20', domains: ['AI', 'AI', 1, 'B端'] },
  greeting: { name: '张三', template: '你好{job}' },
  analysis: { concurrency: 9, maxTokens: 99999, timeoutSec: 1, thinking: 'xxx' },
  schedule: { enabled: true, time: '25:99', city: '深圳', pages: 99, maxDetails: -3 },
  apiKey: 'sk-should-not-export',
  resumeText: '简历正文不该出现',
  jobs: [{ id: 1 }],
  __proto__: { hacked: true },
})
ok('未知键被丢弃（apiKey）', !('apiKey' in dirty))
ok('未知键被丢弃（简历正文）', !('resumeText' in dirty))
ok('未知键被丢弃（岗位库）', !('jobs' in dirty))
ok('只保留白名单 4 个键', Object.keys(dirty).every(k => PROFILE_KEYS.includes(k) || k === 'version' || k === 'exportedAt'))
ok('导出键清单固定', PROFILE_KEYS.join(',') === 'filters,greeting,analysis,schedule')

/* ---------- 边界 ---------- */
ok('并发夹紧到 3', dirty.analysis.concurrency === 3, String(dirty.analysis.concurrency))
ok('maxTokens 夹紧到 32000', dirty.analysis.maxTokens === 32000)
ok('timeout 夹紧到 30', dirty.analysis.timeoutSec === 30)
ok('思考强度非法值回落 low', dirty.analysis.thinking === 'low')
ok('非法时间被丢弃', dirty.schedule.time === undefined)
ok('pages 夹紧到 10', dirty.schedule.pages === 10)
ok('maxDetails 夹紧到 0', dirty.schedule.maxDetails === 0)
ok('筛选薪资转数字', dirty.filters.salary === 20)
ok('筛选 domains 去重且过滤非字符串', JSON.stringify(dirty.filters.domains) === '["AI","B端"]', JSON.stringify(dirty.filters.domains))

/* ---------- 空值/异常 ---------- */
ok('空对象可用', normalizeProfile({}).version === 1)
ok('null 不炸', normalizeProfile(null).version === 1)
ok('字符串输入不炸', normalizeProfile('x').version === 1)
ok('sanitizeFilters 只认白名单', Object.keys(sanitizeFilters({ query: 'a', hack: 1 })).join(',') === 'query')
ok('sanitizeSchedule 空值不产生键', Object.keys(sanitizeSchedule({ city: '   ' })).length === 0)

/* ---------- 组装 ---------- */
const built = buildProfile({
  filters: { query: '产品经理', city: '深圳' },
  greeting: { name: '张三' },
  analysis: { concurrency: 2 },
  schedule: { time: '09:00' },
})
ok('组装含 4 个配置块', ['filters', 'greeting', 'analysis', 'schedule'].every(k => built[k]))
ok('组装带导出时间', typeof built.exportedAt === 'string' && built.exportedAt.length > 10)

/* ---------- 文件读写 ---------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'))
const file = path.join(tmpDir, 'config.local.json')
ok('文件不存在时 exists=false', readProfileFile(file).exists === false)
writeProfileFile(file, built)
const back = readProfileFile(file)
ok('写入后可读回', back.exists && back.profile.greeting.name === '张三')
const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
ok('落盘文件不含 Key 字段', !('apiKey' in raw) && !JSON.stringify(raw).includes('sk-'))
ok('落盘文件带版本号', raw.version === 1)
fs.writeFileSync(file, '{ 坏 JSON')
ok('坏 JSON 不抛错且给可读原因', readProfileFile(file).profile === null && /解析失败/.test(readProfileFile(file).error || ''))
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(fails.length ? '❌ 失败用例：\n' + fails.map(f => ' - ' + f).join('\n') : '✅ 全部通过')
console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
